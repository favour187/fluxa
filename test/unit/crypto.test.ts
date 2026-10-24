import test from 'node:test';
import assert from 'node:assert/strict';
import {
  b64url,
  b64urlDecode,
  buildSasTranscript,
  channelHelloSignInput,
  deriveDeviceId,
  deriveSharedSecret,
  exportPublicKeySpki,
  generateEcdhKeyPair,
  generateIdentityKeyPair,
  relaySignInput,
  sasDigits,
  sha256,
  signWithIdentity,
  signalingHelloSignInput,
  toHex,
  verifySignature,
} from '../../src/shared/crypto.js';

test('base64url helpers round-trip binary data', () => {
  const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
  assert.deepEqual([...b64urlDecode(b64url(bytes))], [...bytes]);
});

test('device ids are derived from the public key and cannot be spoofed', async () => {
  const pair = await generateIdentityKeyPair();
  const spki = await exportPublicKeySpki(pair.publicKey);
  const id = await deriveDeviceId(spki);
  assert.equal(id, await deriveDeviceId(spki));

  const other = await generateIdentityKeyPair();
  const otherSpki = await exportPublicKeySpki(other.publicKey);
  assert.notEqual(await deriveDeviceId(otherSpki), id);
});

test('signatures verify only for the signed message and the right key', async () => {
  const pair = await generateIdentityKeyPair();
  const spki = await exportPublicKeySpki(pair.publicKey);
  const message = signalingHelloSignInput('nonce-1', 'device-1');
  const sig = await signWithIdentity(pair.privateKey, message);
  assert.equal(await verifySignature(spki, sig, message), true);
  assert.equal(await verifySignature(spki, sig, message + 'x'), false);

  const attacker = await generateIdentityKeyPair();
  const attackerSpki = await exportPublicKeySpki(attacker.publicKey);
  assert.equal(await verifySignature(attackerSpki, sig, message), false);
});

test('signing strings are domain-separated', () => {
  assert.notEqual(signalingHelloSignInput('n', 'd'), relaySignInput('room', 'a', 'b', 'offer', 'hash'));
  assert.equal(signalingHelloSignInput('n', 'd'), 'fluxa/1/signaling|n|d');
  assert.match(channelHelloSignInput({
    deviceId: 'a', peerDeviceId: 'b', sessionNonce: 's', fingerprint: 'f',
    dtlsFingerprint: 'd', nonce: 'n', ephPub: 'e',
  }), /^fluxa\/1\/hello\|a\|b\|s\|f\|d\|n\|e$/);
});

test('ECDH peers derive the same secret, a third party does not', async () => {
  const a = await generateEcdhKeyPair();
  const b = await generateEcdhKeyPair();
  const c = await generateEcdhKeyPair();
  const aPub = await exportPublicKeySpki(a.publicKey);
  const bPub = await exportPublicKeySpki(b.publicKey);
  const cPub = await exportPublicKeySpki(c.publicKey);

  const ab = await deriveSharedSecret(a.privateKey, bPub);
  const ba = await deriveSharedSecret(b.privateKey, aPub);
  const ac = await deriveSharedSecret(a.privateKey, cPub);
  assert.equal(toHex(ab), toHex(ba));
  assert.notEqual(toHex(ab), toHex(ac));
});

test('the SAS transcript is order-independent but identity-bound', async () => {
  const base = {
    sessionNonce: 'session-1',
    deviceA: 'AAA',
    deviceB: 'BBB',
    fingerprintA: 'FP-A',
    fingerprintB: 'FP-B',
    ephA: 'EPH-A',
    ephB: 'EPH-B',
    nonceA: 'N-A',
    nonceB: 'N-B',
  };
  const forward = buildSasTranscript(base);
  const reversed = buildSasTranscript({
    ...base,
    deviceA: 'BBB',
    deviceB: 'AAA',
    fingerprintA: 'FP-B',
    fingerprintB: 'FP-A',
    ephA: 'EPH-B',
    ephB: 'EPH-A',
    nonceA: 'N-B',
    nonceB: 'N-A',
  });
  assert.equal(forward, reversed, 'both peers must compute the same transcript');

  const swappedKey = buildSasTranscript({ ...base, fingerprintB: 'FP-EVIL' });
  assert.notEqual(forward, swappedKey);

  const swappedDevice = buildSasTranscript({ ...base, deviceB: 'CCC' });
  assert.notEqual(forward, swappedDevice);

  const digitsForward = sasDigits(await sha256(new TextEncoder().encode(forward)));
  const digitsSwapped = sasDigits(await sha256(new TextEncoder().encode(swappedKey)));
  assert.match(digitsForward, /^\d{6}$/);
  assert.notEqual(digitsForward, digitsSwapped);
});

test('SAS digits are uniformly formatted', async () => {
  for (let i = 0; i < 100; i++) {
    const digest = await sha256(new TextEncoder().encode(`sample-${i}`));
    const digits = sasDigits(digest);
    assert.match(digits, /^\d{6}$/);
  }
});
