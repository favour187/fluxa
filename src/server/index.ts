/**
 * Fluxa signalling + static host.
 *
 * Responsibilities (and deliberately nothing more):
 *   - serve the client application
 *   - authenticate devices (proof-of-possession of their identity key)
 *   - issue and redeem single-use pairing codes
 *   - relay opaque WebRTC signalling between two *paired* devices
 *
 * It never sees file bytes. Media flows peer-to-peer over WebRTC, or through the
 * (separately configured) TURN relay; see docs/NETWORKING.md.
 */
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { PairingStore, type PairingEntry } from './pairing.js';
import { RateLimiter } from './ratelimit.js';
import {
  b64urlDecode,
  deriveDeviceId,
  randomToken,
  toHex,
  verifySignature,
} from '../shared/crypto.js';
import { DEFAULT_CHUNK_SIZE, LIMITS, PROTOCOL_VERSION } from '../shared/protocol.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../../public');

export interface ServerConfig {
  port: number;
  host: string;
  /** Public base URL used to build pairing links (e.g. https://fluxa.example). */
  publicUrl?: string;
  allowedOrigins?: string[];
  pairingTtlMs?: number;
  heartbeatMs?: number;
  /** ICE servers handed to clients. Empty => host candidates only. */
  iceServers?: { urls: string | string[]; username?: string; credential?: string }[];
  log?: (line: string) => void;
}

interface TargetLink {
  connId: string;
  deviceId: string;
  publicKey: string;
  fingerprint: string;
  name: string;
  platform: string;
  sessionNonce: string;
  confirmed: boolean;
  createdAt: number;
}

interface Client {
  connId: string;
  socket: WebSocket;
  ip: string;
  deviceId?: string;
  publicKey?: string;
  fingerprint?: string;
  name?: string;
  platform?: string;
  challenge: string;
  authenticated: boolean;
  alive: boolean;
  connectedAt: number;
  targets: Map<string, TargetLink>;
}

const RELAY_TYPES = new Set(['offer', 'answer', 'ice', 'bye', 'renegotiate']);
const MAX_RELAY_PAYLOAD = 64 * 1024;

export interface FluxaServer {
  server: http.Server;
  wss: WebSocketServer;
  port: number;
  close: () => Promise<void>;
  stats: () => { clients: number; authenticated: number; pairings: number };
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json; charset=utf-8',
};

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self'",
    // ws:/wss: for signalling; stun/turn are handled by the ICE stack, not fetch.
    "connect-src 'self' ws: wss:",
    "form-action 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join('; '),
};

export async function startServer(config: ServerConfig): Promise<FluxaServer> {
  const log = config.log ?? ((line: string) => console.log(`[fluxa] ${line}`));
  const pairing = new PairingStore(config.pairingTtlMs);
  const clients = new Map<string, Client>();
  let nextId = 1;

  // Keyed per connection, not per IP: many devices legitimately share one NAT
  // address, and opening a TCP connection is itself the expensive step.
  const helloLimiter = new RateLimiter(4, 4 / 60);
  // Pairing is rate limited per authenticated device first (that is the unit an
  // attacker must control) with a much higher per-IP backstop, because whole
  // households/offices legitimately pair several devices from one NAT address.
  const codeLimiterPerDevice = new RateLimiter(6, 6 / 60);
  const codeLimiterPerIp = new RateLimiter(60, 1);
  const claimLimiter = new RateLimiter(60, 1);
  const relayLimiter = new RateLimiter(400, 200);

  const httpServer = http.createServer((req, res) => {
    void handleHttp(req, res).catch((err) => {
      log(`http error: ${(err as Error).message}`);
      if (!res.headersSent) res.writeHead(500, SECURITY_HEADERS);
      res.end('internal error');
    });
  });

  async function handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const send = (status: number, body: string, type = 'text/plain; charset=utf-8') => {
      res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(body);
    };

    if (url.pathname === '/api/health') {
      send(200, JSON.stringify({ ok: true, clients: clients.size }), MIME['.json']!);
      return;
    }
    if (url.pathname === '/api/config') {
      send(
        200,
        JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          chunkSize: DEFAULT_CHUNK_SIZE,
          limits: LIMITS,
          iceServers: config.iceServers ?? [],
          publicUrl: config.publicUrl ?? null,
        }),
        MIME['.json']!,
      );
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(405, 'method not allowed');
      return;
    }

    const rawPath = decodeURIComponent(url.pathname);
    const rel = rawPath === '/' ? 'index.html' : rawPath.replace(/^\/+/, '');
    const target = path.resolve(PUBLIC_DIR, rel);
    if (!target.startsWith(PUBLIC_DIR + path.sep) && target !== path.join(PUBLIC_DIR, 'index.html')) {
      send(403, 'forbidden');
      return;
    }
    let filePath = target;
    try {
      const info = await stat(filePath);
      if (info.isDirectory()) filePath = path.join(filePath, 'index.html');
    } catch {
      // Unknown path: fall back to the app shell so deep links work.
      filePath = path.join(PUBLIC_DIR, 'index.html');
    }
    const ext = path.extname(filePath);
    const headers: Record<string, string> = {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
    };
    try {
      const info = await stat(filePath);
      res.writeHead(200, { ...headers, 'Content-Length': String(info.size) });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      createReadStream(filePath).pipe(res);
    } catch {
      send(404, 'not found');
    }
  }

  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws',
    maxPayload: 128 * 1024,
    // Origin checks are enforced in the connection handler so that deployments
    // behind a proxy can allow-list their own origins.
    verifyClient: (info: { req: http.IncomingMessage }) => {
      const origin = info.req.headers.origin;
      if (!origin) return true; // non-browser client (tests, native shells)
      if (!config.allowedOrigins || config.allowedOrigins.length === 0) return true;
      return config.allowedOrigins.includes(origin);
    },
  });

  wss.on('connection', (socket, req) => {
    const connId = `c${nextId++}`;
    const ip = clientIp(req, config);
    const client: Client = {
      connId,
      socket,
      ip,
      challenge: randomToken(24),
      authenticated: false,
      alive: true,
      connectedAt: Date.now(),
      targets: new Map(),
    };
    clients.set(connId, client);
    socket.send(JSON.stringify({ t: 'challenge', nonce: client.challenge, protocolVersion: PROTOCOL_VERSION }));

    socket.on('pong', () => {
      client.alive = true;
    });
    socket.on('message', (data) => {
      client.alive = true;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(data)) as Record<string, unknown>;
      } catch {
        sendErr(client, 'bad_json', 'message is not valid JSON');
        return;
      }
      try {
        handleSignal(client, msg);
      } catch (err) {
        sendErr(client, 'internal', (err as Error).message);
      }
    });
    socket.on('close', () => {
      clients.delete(connId);
      if (client.deviceId) pairing.cancel(connId);
      // Tell peers this link is gone so they never hold a stale target.
      for (const target of client.targets.values()) {
        const peer = clients.get(target.connId);
        if (peer) {
          peer.targets.delete(connId);
          send(peer, { t: 'peerLeft', peer: { connId, deviceId: client.deviceId ?? null } });
        }
      }
      log(`disconnect ${connId}${client.deviceId ? ` (${client.deviceId.slice(0, 8)})` : ''}`);
    });
    socket.on('error', () => socket.close());
  });

  function send(client: Client, payload: unknown): void {
    if (client.socket.readyState === 1) client.socket.send(JSON.stringify(payload));
  }
  function sendErr(client: Client, code: string, message: string): void {
    send(client, { t: 'error', code, message });
  }

  function handleSignal(client: Client, msg: Record<string, unknown>): void {
    const type = String(msg['t'] ?? '');

    if (type === 'hello') {
      if (!helloLimiter.take(client.connId)) return sendErr(client, 'rate_limited', 'too many attempts');
      const deviceId = String(msg['deviceId'] ?? '');
      const publicKey = String(msg['publicKey'] ?? '');
      const nonce = String(msg['nonce'] ?? '');
      const sig = String(msg['sig'] ?? '');
      const fingerprint = String(msg['fingerprint'] ?? '');
      if (nonce !== client.challenge) return sendErr(client, 'bad_challenge', 'unknown connection challenge');
      // Base64url SPKI for P-256 is 122 characters; allow headroom for other curves.
      if (!/^[A-Za-z0-9_-]{40,400}$/.test(publicKey)) return sendErr(client, 'bad_key', 'malformed public key');
      void (async () => {
        const derived = await deriveDeviceId(publicKey);
        if (derived !== deviceId) {
          return sendErr(client, 'bad_identity', 'device id does not match public key');
        }
        const ok = await verifySignature(publicKey, sig, `fluxa/1/signaling|${client.challenge}|${deviceId}`);
        if (!ok) return sendErr(client, 'bad_signature', 'identity signature rejected');
        client.deviceId = deviceId;
        client.publicKey = publicKey;
        client.fingerprint = fingerprint || await keyFingerprint(publicKey);
        client.name = sanitizeLabel(msg['name'], 'Unknown device');
        client.platform = sanitizeLabel(msg['platform'], 'web');
        client.authenticated = true;
        send(client, {
          t: 'ready',
          connId: client.connId,
          iceServers: config.iceServers ?? [],
          protocolVersion: PROTOCOL_VERSION,
          limits: LIMITS,
          chunkSize: DEFAULT_CHUNK_SIZE,
          publicUrl: config.publicUrl ?? null,
        });
        log(`hello ${client.connId} ${deviceId.slice(0, 8)} ${client.name} (${client.platform})`);
      })();
      return;
    }

    if (!client.authenticated) {
      return sendErr(client, 'not_authenticated', 'send hello first');
    }
    if (!relayLimiter.take(client.connId)) {
      return sendErr(client, 'rate_limited', 'too many messages');
    }

    switch (type) {
      case 'createCode': {
        if (!codeLimiterPerDevice.take(client.connId) || !codeLimiterPerIp.take(client.ip)) {
          return sendErr(client, 'rate_limited', 'too many pairing codes');
        }
        if (client.targets.size >= 8) return sendErr(client, 'too_many_links', 'close an existing session first');
        const entry = pairing.create(client.connId, client.deviceId!);
        send(client, {
          t: 'code',
          code: entry.code,
          expiresAt: entry.expiresAt,
          link: config.publicUrl ? `${config.publicUrl.replace(/\/$/, '')}/?pair=${entry.code}` : null,
        });
        log(`pairing code issued for ${client.deviceId?.slice(0, 8)}`);
        return;
      }
      case 'profile': {
        // Display names are cosmetic; peers pin the device id/public key.
        client.name = sanitizeLabel(msg['name'], client.name ?? 'Unknown device');
        send(client, { t: 'profileUpdated', name: client.name });
        return;
      }
      case 'cancelCode': {
        pairing.cancel(client.connId);
        send(client, { t: 'codeCancelled' });
        return;
      }
      case 'claimCode': {
        if (!claimLimiter.take(client.ip)) return sendErr(client, 'rate_limited', 'too many attempts');
        const result = pairing.claim(String(msg['code'] ?? ''), client.connId);
        if (!result.ok) {
          sendErr(client, 'pairing_failed', pairingFailureMessage(result.reason));
          return;
        }
        const entry: PairingEntry = result.entry;
        const owner = clients.get(entry.ownerId);
        if (!owner || !owner.authenticated) {
          sendErr(client, 'pairing_failed', 'that pairing code is no longer available');
          return;
        }
        if (client.targets.size >= 8 || owner.targets.size >= 8) {
          sendErr(client, 'too_many_links', 'too many active sessions');
          return;
        }
        const sessionNonce = randomToken(24);
        const linkForClaimant: TargetLink = {
          connId: owner.connId,
          deviceId: owner.deviceId!,
          publicKey: owner.publicKey!,
          fingerprint: owner.fingerprint!,
          name: owner.name ?? 'Unknown device',
          platform: owner.platform ?? 'web',
          sessionNonce,
          confirmed: false,
          createdAt: Date.now(),
        };
        const linkForOwner: TargetLink = {
          connId: client.connId,
          deviceId: client.deviceId!,
          publicKey: client.publicKey!,
          fingerprint: client.fingerprint!,
          name: client.name ?? 'Unknown device',
          platform: client.platform ?? 'web',
          sessionNonce,
          confirmed: false,
          createdAt: Date.now(),
        };
        client.targets.set(owner.connId, linkForClaimant);
        owner.targets.set(client.connId, linkForOwner);
        send(client, { t: 'claimed', peer: publicLink(linkForClaimant) });
        send(owner, { t: 'codeClaimed', peer: publicLink(linkForOwner) });
        log(`pairing claimed: ${client.deviceId?.slice(0, 8)} <-> ${owner.deviceId?.slice(0, 8)}`);
        return;
      }
      case 'verify': {
        const targetConn = String(msg['targetConnId'] ?? '');
        const ok = Boolean(msg['ok']);
        const link = client.targets.get(targetConn);
        if (!link) return sendErr(client, 'unknown_peer', 'no such session');
        if (link.confirmed && ok) {
          // Both devices usually confirm within the same second; a repeated
          // confirmation must be idempotent rather than an error.
          send(client, { t: 'verified', peer: publicLink(link) });
          return;
        }
        const peer = clients.get(targetConn);
        if (!peer) return sendErr(client, 'peer_left', 'the other device disconnected');
        if (!ok) {
          client.targets.delete(targetConn);
          peer.targets.delete(client.connId);
          send(peer, { t: 'verifyFailed', peer: { connId: client.connId, deviceId: client.deviceId } });
          send(client, { t: 'verifyFailed', peer: { connId: targetConn, deviceId: link.deviceId } });
          return;
        }
        link.confirmed = true;
        send(client, { t: 'verified', peer: publicLink(link) });
        const peerLink = peer.targets.get(client.connId);
        if (peerLink) {
          peerLink.confirmed = true;
          send(peer, { t: 'verified', peer: publicLink(peerLink) });
        }
        return;
      }
      case 'relay': {
        const to = String(msg['to'] ?? '');
        const relayType = String(msg['type'] ?? '');
        const link = client.targets.get(to);
        if (!link) return sendErr(client, 'unknown_peer', 'relay to an unpaired device is not allowed');
        if (!RELAY_TYPES.has(relayType)) return sendErr(client, 'bad_relay_type', 'unsupported relay type');
        const peer = clients.get(to);
        if (!peer) return sendErr(client, 'peer_left', 'the other device disconnected');
        // Signalling (SDP/ICE) must flow before the peers can even compute the
        // 6-digit verification code, so it is allowed on a claimed pairing.
        // File data never crosses the server at all.
        void link.confirmed;
        const payload = msg['payload'];
        const serialized = JSON.stringify(payload ?? null);
        if (serialized.length > MAX_RELAY_PAYLOAD) return sendErr(client, 'payload_too_large', 'payload exceeds limit');
        send(peer, {
          t: 'relay',
          from: client.connId,
          fromDeviceId: client.deviceId,
          type: relayType,
          payload,
        });
        return;
      }
      case 'ping': {
        send(client, { t: 'pong', ts: msg['ts'] ?? null });
        return;
      }
      case 'bye': {
        const to = String(msg['to'] ?? '');
        const link = client.targets.get(to);
        if (link) {
          client.targets.delete(to);
          const peer = clients.get(to);
          if (peer) {
            peer.targets.delete(client.connId);
            send(peer, { t: 'peerLeft', peer: { connId: client.connId, deviceId: client.deviceId } });
          }
        }
        return;
      }
      default:
        sendErr(client, 'unknown_message', `unexpected message type: ${type}`);
    }
  }

  const heartbeat = setInterval(() => {
    for (const client of clients.values()) {
      if (!client.alive) {
        client.socket.terminate();
        continue;
      }
      client.alive = false;
      try {
        client.socket.ping();
      } catch {
        /* socket already gone */
      }
    }
    pairing.sweep();
  }, config.heartbeatMs ?? 30_000);
  heartbeat.unref?.();

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.port, config.host, () => resolve());
  });
  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  log(`listening on http://${config.host}:${port}`);

  return {
    server: httpServer,
    wss,
    port,
    stats: () => ({
      clients: clients.size,
      authenticated: [...clients.values()].filter((c) => c.authenticated).length,
      pairings: pairing.size,
    }),
    close: async () => {
      clearInterval(heartbeat);
      for (const client of clients.values()) client.socket.terminate();
      clients.clear();
      wss.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

function publicLink(link: TargetLink) {
  return {
    connId: link.connId,
    deviceId: link.deviceId,
    publicKey: link.publicKey,
    fingerprint: link.fingerprint,
    name: link.name,
    platform: link.platform,
    sessionNonce: link.sessionNonce,
    confirmed: link.confirmed,
  };
}

async function keyFingerprint(publicKeyB64: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', b64urlDecode(publicKeyB64) as unknown as ArrayBuffer);
  const hex = toHex(new Uint8Array(digest)).toUpperCase().match(/.{2}/g) ?? [];
  return hex.join(':');
}

function sanitizeLabel(value: unknown, fallback: string): string {
  const s = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 48);
  return s || fallback;
}

function pairingFailureMessage(reason: string): string {
  switch (reason) {
    case 'expired':
      return 'That pairing code has expired';
    case 'self':
      return 'That is your own pairing code';
    case 'too_many_attempts':
      return 'Too many incorrect attempts — ask for a new code';
    default:
      return 'Pairing code not recognised';
  }
}

function clientIp(req: http.IncomingMessage, config: ServerConfig): string {
  const trustProxy = process.env.FLUXA_TRUST_PROXY === '1';
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    if (first) return first.split(',')[0]!.trim();
  }
  void config;
  return req.socket.remoteAddress ?? 'unknown';
}

/* ------------------------------------------------------------------ *
 * CLI entrypoint
 * ------------------------------------------------------------------ */

const isMain = process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`;
if (isMain) {
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? '0.0.0.0';
  const iceEnv = process.env.FLUXA_ICE_SERVERS;
  await startServer({
    port,
    host,
    publicUrl: process.env.FLUXA_PUBLIC_URL,
    allowedOrigins: process.env.FLUXA_ALLOWED_ORIGINS?.split(',').map((s) => s.trim()).filter(Boolean),
    iceServers: iceEnv ? (JSON.parse(iceEnv) as ServerConfig['iceServers']) : [],
  }).catch((err) => {
    console.error('failed to start fluxa server:', err);
    process.exit(1);
  });
}
