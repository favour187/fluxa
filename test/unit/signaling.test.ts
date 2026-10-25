/**
 * Signalling-server integration tests.
 *
 * These exercise the real WebSocket server over a real socket, including the
 * identity proof, single-use pairing codes and relay authorisation rules.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { PROTOCOL_VERSION } from '../../src/shared/protocol.js';
import { startServer, type FluxaServer } from '../../src/server/index.js';
import {
  deriveDeviceId,
  publicKeyFingerprint,
  exportPublicKeySpki,
  generateIdentityKeyPair,
  signalingHelloSignInput,
  signWithIdentity,
} from '../../src/shared/crypto.js';

interface Wire {
  [key: string]: unknown;
  t: string;
}

class TestClient {
  private queue: Wire[] = [];
  private waiters: ((msg: Wire) => void)[] = [];
  challenge = '';
  connId = '';
  ready!: Promise<void>;

  constructor(readonly socket: WebSocket) {
    this.ready = new Promise((resolve, reject) => {
      socket.on('message', (data) => {
        const msg = JSON.parse(String(data)) as Wire;
        if (msg.t === 'challenge') {
          this.challenge = String(msg.nonce);
          resolve();
          return;
        }
        if (msg.t === 'ready') this.connId = String(msg.connId);
        const waiter = this.waiters.shift();
        if (waiter) waiter(msg);
        else this.queue.push(msg);
      });
      socket.on('error', reject);
    });
  }

  send(payload: unknown): void {
    this.socket.send(JSON.stringify(payload));
  }

  next(type?: string, timeoutMs = 4000): Promise<Wire> {
    const find = (msg: Wire): boolean => !type || msg.t === type;
    const queued = this.queue.findIndex(find);
    if (queued >= 0) return Promise.resolve(this.queue.splice(queued, 1)[0]!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type ?? 'any message'}`)), timeoutMs);
      const waiter = (msg: Wire) => {
        if (!find(msg)) {
          this.queue.push(msg);
          this.waiters.push(waiter);
          return;
        }
        clearTimeout(timer);
        resolve(msg);
      };
      this.waiters.push(waiter);
    });
  }

  close(): void {
    this.socket.close();
  }
}

interface TestIdentity {
  deviceId: string;
  publicKey: string;
  fingerprint: string;
  name: string;
  platform: string;
  sign: (message: string) => Promise<string>;
}

async function makeIdentity(name: string): Promise<TestIdentity> {
  const pair = await generateIdentityKeyPair();
  const publicKey = await exportPublicKeySpki(pair.publicKey);
  return {
    deviceId: await deriveDeviceId(publicKey),
    publicKey,
    fingerprint: await publicKeyFingerprint(publicKey),
    name,
    platform: 'test',
    sign: (message: string) => signWithIdentity(pair.privateKey, message),
  };
}

async function connect(port: number, identity?: TestIdentity, opts: { corrupt?: boolean; turnAccessKey?: string } = {}): Promise<TestClient> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const client = new TestClient(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  await client.ready;
  if (identity) {
    const signature = await identity.sign(signalingHelloSignInput(client.challenge, identity.deviceId));
    client.send({
      t: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      ...(opts.turnAccessKey ? { turnAccessKey: opts.turnAccessKey } : {}),
      deviceId: opts.corrupt ? 'A'.repeat(43) : identity.deviceId,
      publicKey: identity.publicKey,
      fingerprint: identity.fingerprint,
      name: identity.name,
      platform: identity.platform,
      nonce: client.challenge,
      sig: opts.corrupt ? 'AAAA' : signature,
    });
  }
  return client;
}

let server: FluxaServer;

test.before(async () => {
  server = await startServer({ port: 0, host: '127.0.0.1', log: () => {}, pairingTtlMs: 150 });
});

test.after(async () => {
  await server.close();
});

test('a device that has not proven its identity cannot act', async () => {
  const client = await connect(server.port);
  client.send({ t: 'createCode' });
  const error = await client.next('error');
  assert.equal(error.code, 'not_authenticated');
  client.close();
});

test('hello with a forged signature or mismatched device id is rejected', async () => {
  const identity = await makeIdentity('forger');

  const badSig = await connect(server.port);
  badSig.send({
    t: 'hello',
    protocolVersion: PROTOCOL_VERSION,
    deviceId: identity.deviceId,
    publicKey: identity.publicKey,
    fingerprint: 'X',
    name: 'x',
    platform: 'test',
    nonce: badSig.challenge,
    sig: 'AAAA',
  });
  const sigError = await badSig.next('error');
  assert.equal(sigError.code, 'bad_signature');
  badSig.close();

  const mismatched = await connect(server.port);
  mismatched.send({
    t: 'hello',
    protocolVersion: PROTOCOL_VERSION,
    deviceId: 'B'.repeat(43),
    publicKey: identity.publicKey,
    fingerprint: 'X',
    name: 'x',
    platform: 'test',
    nonce: mismatched.challenge,
    sig: await identity.sign(signalingHelloSignInput(mismatched.challenge, identity.deviceId)),
  });
  const idError = await mismatched.next('error');
  assert.equal(idError.code, 'bad_identity');
  mismatched.close();
});

test('hello signed over the wrong challenge is rejected', async () => {
  const identity = await makeIdentity('replayer');
  const client = await connect(server.port);
  // Sign a *previous* challenge, as a replay attack would.
  const sig = await identity.sign(signalingHelloSignInput('some-old-challenge', identity.deviceId));
  client.send({
    t: 'hello',
    protocolVersion: PROTOCOL_VERSION,
    deviceId: identity.deviceId,
    publicKey: identity.publicKey,
    fingerprint: 'X',
    name: 'x',
    platform: 'test',
    nonce: client.challenge,
    sig,
  });
  const error = await client.next('error');
  assert.equal(error.code, 'bad_signature');
  client.close();
});

test('a valid hello is acknowledged with the negotiated configuration', async () => {
  const client = await connect(server.port, await makeIdentity('valid'));
  const ready = await client.next('ready');
  assert.equal(typeof ready.connId, 'string');
  assert.equal(ready.protocolVersion, PROTOCOL_VERSION);
  assert.ok(typeof ready.chunkSize === 'number');
  client.close();
});

test('pairing, verification and relay work end to end', async () => {
  const a = await connect(server.port, await makeIdentity('Device A'));
  await a.next('ready');
  const b = await connect(server.port, await makeIdentity('Device B'));
  await b.next('ready');

  a.send({ t: 'createCode' });
  const code = await a.next('code');
  const pairingCode = String(code.code);

  b.send({ t: 'claimCode', code: pairingCode });
  const claimed = await b.next('claimed');
  const codeClaimed = await a.next('codeClaimed');
  const peerForB = claimed.peer as Record<string, string>;
  const peerForA = codeClaimed.peer as Record<string, string>;
  assert.equal(peerForB.connId, a.connId);
  assert.equal(peerForA.connId, b.connId);
  assert.equal(peerForB.sessionNonce, peerForA.sessionNonce);
  assert.ok(String(peerForB.sessionNonce).length >= 20);

  // Relay is only allowed after pairing, and only for signalling types.
  b.send({ t: 'relay', to: a.connId, type: 'offer', payload: { sdp: { type: 'offer', sdp: 'v=0' } } });
  const relayed = await a.next('relay');
  assert.equal(relayed.type, 'offer');
  assert.equal(relayed.from, b.connId);

  b.send({ t: 'relay', to: a.connId, type: 'exec', payload: {} });
  const badType = await b.next('error');
  assert.equal(badType.code, 'bad_relay_type');

  b.send({ t: 'relay', to: 'c999', type: 'offer', payload: {} });
  const unknown = await b.next('error');
  assert.equal(unknown.code, 'unknown_peer');

  // Both sides confirm the out-of-band code.
  a.send({ t: 'verify', targetConnId: b.connId, ok: true });
  b.send({ t: 'verify', targetConnId: a.connId, ok: true });
  const verifiedAtB = await b.next('verified');
  assert.equal((verifiedAtB.peer as Record<string, unknown>).confirmed, true);

  a.close();
  b.close();
});

test('pairing codes are single use', async () => {
  const a = await connect(server.port, await makeIdentity('Owner'));
  await a.next('ready');
  const b = await connect(server.port, await makeIdentity('Claimant 1'));
  await b.next('ready');
  const c = await connect(server.port, await makeIdentity('Claimant 2'));
  await c.next('ready');

  a.send({ t: 'createCode' });
  const code = String((await a.next('code')).code);
  b.send({ t: 'claimCode', code });
  await b.next('claimed');

  c.send({ t: 'claimCode', code });
  const reused = await c.next('error');
  assert.equal(reused.code, 'pairing_failed');
  assert.match(String(reused.message), /not recognised/i);

  a.close();
  b.close();
  c.close();
});

test('pairing codes expire', async () => {
  const a = await connect(server.port, await makeIdentity('Owner'));
  await a.next('ready');
  const b = await connect(server.port, await makeIdentity('Late'));
  await b.next('ready');

  a.send({ t: 'createCode' });
  const code = String((await a.next('code')).code);
  await new Promise((resolve) => setTimeout(resolve, 260)); // TTL in this suite is 150 ms
  b.send({ t: 'claimCode', code });
  const expired = await b.next('error');
  assert.equal(expired.code, 'pairing_failed');
  assert.match(String(expired.message), /expired/i);

  a.close();
  b.close();
});

test('owners cannot claim their own code', async () => {
  const a = await connect(server.port, await makeIdentity('Owner'));
  await a.next('ready');
  a.send({ t: 'createCode' });
  const code = String((await a.next('code')).code);
  a.send({ t: 'claimCode', code });
  const error = await a.next('error');
  assert.match(String(error.message), /your own/i);
  a.close();
});

test('rejecting verification tears down the link', async () => {
  const a = await connect(server.port, await makeIdentity('A'));
  await a.next('ready');
  const b = await connect(server.port, await makeIdentity('B'));
  await b.next('ready');

  a.send({ t: 'createCode' });
  const code = String((await a.next('code')).code);
  b.send({ t: 'claimCode', code });
  await b.next('claimed');
  await a.next('codeClaimed');

  b.send({ t: 'verify', targetConnId: a.connId, ok: false });
  const failed = await a.next('verifyFailed');
  assert.equal(typeof failed.peer, 'object');

  b.send({ t: 'relay', to: a.connId, type: 'offer', payload: {} });
  const blocked = await b.next('error');
  assert.equal(blocked.code, 'unknown_peer');

  a.close();
  b.close();
});

test('peers are told when the other device disconnects', async () => {
  const a = await connect(server.port, await makeIdentity('A'));
  await a.next('ready');
  const b = await connect(server.port, await makeIdentity('B'));
  await b.next('ready');
  a.send({ t: 'createCode' });
  const code = String((await a.next('code')).code);
  b.send({ t: 'claimCode', code });
  await b.next('claimed');
  await a.next('codeClaimed');

  b.close();
  const left = await a.next('peerLeft');
  assert.equal((left.peer as Record<string, string>).connId, b.connId);
  a.close();
});

test('old clients cannot authenticate a v2 signalling session', async () => {
  const identity = await makeIdentity('old build');
  const client = await connect(server.port);
  client.send({
    t: 'hello', protocolVersion: 1, deviceId: identity.deviceId, publicKey: identity.publicKey,
    fingerprint: identity.fingerprint, name: identity.name, platform: identity.platform,
    nonce: client.challenge, sig: await identity.sign(signalingHelloSignInput(client.challenge, identity.deviceId)),
  });
  assert.equal((await client.next('error')).code, 'incompatible_protocol');
  client.close();
});

test('cross-origin signalling is LAN-only on an explicitly opted-in desktop broker', async () => {
  async function attempt(port: number, origin: string): Promise<boolean> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin });
    return new Promise((resolve) => {
      socket.on('open', () => { socket.close(); resolve(true); });
      socket.on('error', () => resolve(false));
    });
  }
  // The normal server rejects another localhost port and *all* public sites.
  assert.equal(await attempt(server.port, 'http://127.0.0.1:9102'), false);
  assert.equal(await attempt(server.port, 'https://evil.example'), false);
  const desktop = await startServer({ port: 0, host: '127.0.0.1', allowLanOrigins: true, log: () => {} });
  try {
    assert.equal(await attempt(desktop.port, 'http://127.0.0.1:9102'), true);
    assert.equal(await attempt(desktop.port, 'http://192.168.1.23:9102'), true);
    assert.equal(await attempt(desktop.port, 'https://evil.example'), false);
    assert.equal(await attempt(desktop.port, 'http://8.8.8.8:9102'), false);
  } finally { await desktop.close(); }
});

test('TURN credentials are expiring, per-session and hidden from public and unauthorised clients', async () => {
  const { createHmac } = await import('node:crypto');
  const secret = 'different-secret-from-the-access-key-0123456789';
  const accessKey = 'operator-issued-relay-access-key-0123456789';
  const relay = await startServer({
    port: 0, host: '127.0.0.1', log: () => {},
    iceServers: [{ urls: 'stun:example.com:3478' }],
    turn: { urls: ['turn:example.com:3478'], secret, accessKey, ttlSeconds: 600 },
  });
  try {
    const response = await fetch(`http://127.0.0.1:${relay.port}/api/config`);
    const publicConfig = await response.json() as Record<string, unknown>;
    assert.ok(!JSON.stringify(publicConfig).includes(secret));
    assert.ok(!JSON.stringify(publicConfig).includes(accessKey));
    assert.ok(!JSON.stringify(publicConfig).includes('turn:example'));

    const unauthorised = await connect(relay.port, await makeIdentity('no key'));
    const without = await unauthorised.next('ready');
    assert.equal(without.turnRequired, true);
    assert.equal((without.iceServers as unknown[]).length, 1);
    unauthorised.close();
    const incorrect = await connect(relay.port, await makeIdentity('wrong key'), { turnAccessKey: 'Z'.repeat(40) });
    assert.equal((await incorrect.next('ready')).turnRequired, true);
    incorrect.close();

    const authorised = await connect(relay.port, await makeIdentity('member'), { turnAccessKey: accessKey });
    const ready = await authorised.next('ready');
    assert.equal(ready.turnRequired, false);
    const servers = ready.iceServers as { urls: string | string[]; username?: string; credential?: string }[];
    assert.equal(servers.length, 2);
    const turn = servers[1]!;
    assert.deepEqual(turn.urls, ['turn:example.com:3478']);
    assert.equal(turn.credential, createHmac('sha1', secret).update(turn.username!).digest('base64'));
    assert.ok(Number(turn.username!.split(':')[0]) > Date.now() / 1000);
    assert.ok(!JSON.stringify(ready).includes(secret));
    assert.ok(!JSON.stringify(ready).includes(accessKey));
    authorised.close();
  } finally { await relay.close(); }
});

test('server refuses reusable static TURN credentials', async () => {
  await assert.rejects(() => startServer({ port: 0, host: '127.0.0.1',
    iceServers: [{ urls: 'turn:example.com', username: 'shared', credential: 'shared-password' }],
  }), /Static ICE credentials/);
});
