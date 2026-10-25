/**
 * Direct (server-less) pairing.
 *
 * Fluxa's normal pairing path needs a signalling server to exchange SDP. That is
 * fine when one exists (the desktop app embeds one, the web build is served by
 * one) but on a phone with nothing else running there is no server at all — the
 * app could not produce a pairing code, which is exactly the dead end users hit.
 *
 * Here the two devices exchange the same information out of band instead: the
 * host shows a *ticket* (compressed, base64url) containing its SDP plus its
 * identity, the guest pastes it and produces a reply ticket with its own SDP and
 * identity, and the host pastes that back. After that the WebRTC connection and
 * the normal 6-digit verification carry on unchanged — no server ever sees the
 * session, and identity pinning works in both directions because each side
 * learns the other's key from the ticket before the channel opens.
 *
 * Tickets are plain text so they can travel by QR code, clipboard or the OS
 * share sheet. They are *not* secret: they contain SDP and public keys only.
 */

const TICKET_PREFIX = 'FLX1';
const MAX_TICKET_CHARS = 64 * 1024;

/**
 * Compact form (marker `c`): only what the other device cannot work out itself.
 * Session description lines are rebuilt from these fields, ICE candidates that
 * are already in the candidate list are not repeated inside the SDP, and
 * values that are derivable from the public key (device id, fingerprint) are
 * dropped. That is what turns a ~1000-character code into a short one.
 */
interface CompactTicket {
  k: 'o' | 'a';
  n: string;
  nm: string;
  /** Public key: the 64-byte P-256 point only (the SPKI header is constant). */
  pk: string;
  u: string;
  w: string;
  /** DTLS certificate fingerprint as 32 raw bytes. */
  f: string;
  st?: string;
  sp?: number;
  /** Candidates packed as `address|port|type`. */
  c: string[];
}

/** Standard Chromium priorities, one per candidate type. */
const PRIORITY: Record<string, number> = { host: 2113937151, srflx: 1686052607, prflx: 1677729535, relay: 41885439 };
const TYPE_CODE: Record<string, string> = { host: 'h', srflx: 's', prflx: 'p', relay: 'r' };
const CODE_TYPE: Record<string, string> = { h: 'host', s: 'srflx', p: 'prflx', r: 'relay' };
const SPKI_PREFIX = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE';

const SDP_DEFAULTS = {
  session:
    'v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0\r\na=msid-semantic: WMS',
  media: 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\nc=IN IP4 0.0.0.0\r\na=ice-options:trickle',
};

export interface DirectIdentity {
  deviceId: string;
  name: string;
  platform: string;
  publicKey: string;
  fingerprint: string;
}

export interface DirectTicket {
  v: 1;
  kind: 'offer' | 'answer';
  /** Shared session nonce; both sides must agree on it (it is signed in the hello). */
  nonce: string;
  sdp: { type: 'offer' | 'answer'; sdp: string };
  identity: DirectIdentity;
  /** ICE candidates gathered before the ticket was produced (non-trickle). */
  candidates: RTCIceCandidateInit[];
}

/* ------------------------------------------------------------------ */
/* Encoding                                                            */
/* ------------------------------------------------------------------ */

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream !== 'function') return null;
  try {
    const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof DecompressionStream !== 'function') return null;
  try {
    const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

/** First value of an `a=<name>:value` line in a session description. */
function sdpValue(sdp: string, name: string): string {
  const match = new RegExp(`^a=${name}:(.+)$`, 'm').exec(sdp.replace(/\r/g, ''));
  return match?.[1]?.trim() ?? '';
}

/** `candidate:… <address> <port> typ <type> …` -> `address|port|type`. */
function packCandidate(candidate: string): string {
  const tokens = candidate.trim().split(/\s+/);
  const typIndex = tokens.indexOf('typ');
  if (typIndex < 6) return '';
  const address = tokens[typIndex - 2] ?? '';
  const port = tokens[typIndex - 1] ?? '';
  const type = tokens[typIndex + 1] ?? '';
  if (!address || !port || !TYPE_CODE[type]) return '';
  return `${address}|${port}|${TYPE_CODE[type] ?? 'h'}`;
}

/** Rebuilds a full candidate line from the packed form. */
function unpackCandidate(packed: string, index: number): RTCIceCandidateInit | null {
  const [address, port, code] = packed.split('|');
  if (!address || !port) return null;
  const type = CODE_TYPE[code ?? 'h'] ?? 'host';
  const priority = PRIORITY[type] ?? PRIORITY.host!;
  return {
    candidate: `candidate:${index + 1} 1 udp ${priority} ${address} ${port} typ ${type}`,
    sdpMid: '0',
    sdpMLineIndex: 0,
  };
}

/** 64-byte P-256 point -> full SPKI base64url, and back. */
function packPublicKey(publicKey: string): string {
  const bytes = fromBase64Url(publicKey);
  if (bytes.length === 65 && bytes[0] === 0x04) return toBase64Url(bytes.slice(1));
  return publicKey;
}

function unpackPublicKey(packed: string): string {
  if (packed.startsWith(SPKI_PREFIX)) return packed;
  const point = fromBase64Url(packed);
  if (point.length !== 64) throw new Error('Pairing code has no device identity');
  return `${SPKI_PREFIX}${toBase64Url(new Uint8Array([0x04, ...point]))}`;
}

/** Rebuilds a data-channel-only session description from the compact fields. */
function rebuildSdp(kind: 'offer' | 'answer', ticket: CompactTicket): string {
  const fingerprint = (ticket.f.match(/.{2}/g)?.join(':') ?? ticket.f).toUpperCase();
  return [
    SDP_DEFAULTS.session,
    SDP_DEFAULTS.media,
    `a=ice-ufrag:${ticket.u}`,
    `a=ice-pwd:${ticket.w}`,
    `a=fingerprint:sha-256 ${fingerprint}`,
    `a=setup:${ticket.st || (kind === 'offer' ? 'actpass' : 'active')}`,
    'a=mid:0',
    `a=sctp-port:${ticket.sp || 5000}`,
    'a=max-message-size:262144',
    '',
  ].join('\r\n');
}

function toCompact(ticket: DirectTicket): CompactTicket {
  const sdp = ticket.sdp.sdp;
  const fingerprintHex = sdpValue(sdp, 'fingerprint').replace('sha-256 ', '').replace(/:/g, '');
  const candidates: string[] = [];
  for (const entry of ticket.candidates) {
    const packed = entry?.candidate ? packCandidate(entry.candidate) : '';
    if (packed && !candidates.includes(packed)) candidates.push(packed);
  }
  const setup = sdpValue(sdp, 'setup');
  const sctp = Number(sdpValue(sdp, 'sctp-port'));
  return {
    k: ticket.kind === 'offer' ? 'o' : 'a',
    n: ticket.nonce,
    nm: ticket.identity.name.slice(0, 24),
    pk: packPublicKey(ticket.identity.publicKey),
    u: sdpValue(sdp, 'ice-ufrag'),
    w: sdpValue(sdp, 'ice-pwd'),
    f: toBase64Url(hexToBytes(fingerprintHex)),
    ...(setup ? { st: setup } : {}),
    ...(Number.isFinite(sctp) && sctp > 0 && sctp !== 5000 ? { sp: sctp } : {}),
    c: candidates,
  };
}

function hexToBytes(hex: string): Uint8Array {
  const pairs = hex.match(/.{2}/g) ?? [];
  return new Uint8Array(pairs.map((pair) => parseInt(pair, 16)));
}

async function fromCompact(compact: CompactTicket): Promise<DirectTicket> {
  if (!compact.pk || !compact.u || !compact.w || !compact.f) throw new Error('Pairing code is incomplete');
  const { deriveDeviceId, b64urlDecode, sha256, toHex } = await import('../shared/crypto.js');
  const publicKey = unpackPublicKey(compact.pk);
  const hex = toHex(await sha256(b64urlDecode(publicKey))).toUpperCase();
  const kind = compact.k === 'o' ? 'offer' : 'answer';
  const rebuilt: CompactTicket = { ...compact, f: toHex(fromBase64Url(compact.f)) };
  return {
    v: 1,
    kind,
    nonce: compact.n,
    sdp: { type: kind, sdp: rebuildSdp(kind, rebuilt) },
    identity: {
      deviceId: await deriveDeviceId(publicKey),
      publicKey,
      fingerprint: hex.match(/.{2}/g)?.join(':') ?? hex,
      name: compact.nm || 'device',
      platform: 'unknown',
    },
    candidates: compact.c.map(unpackCandidate).filter((c): c is RTCIceCandidateInit => c !== null),
  };
}

/**
 * Serialises a ticket. The compact form is always used (marker `c`); `z` and
 * `p` are still accepted when decoding so codes from older builds keep working.
 */
export async function encodeTicket(ticket: DirectTicket): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(toCompact(ticket)));
  const packed = await deflate(json);
  if (packed) return `${TICKET_PREFIX}c.${toBase64Url(packed)}`;
  return `${TICKET_PREFIX}p.${toBase64Url(json)}`;
}

/** Human-tolerant parsing: ignores whitespace/newlines introduced by copy/paste. */
export async function decodeTicket(input: string): Promise<DirectTicket> {
  const cleaned = input.replace(/\s+/g, '');
  if (!cleaned.startsWith(`${TICKET_PREFIX}`)) {
    throw new Error('That does not look like a Fluxa pairing code (it should start with FLX1)');
  }
  if (cleaned.length > MAX_TICKET_CHARS) throw new Error('Pairing code is too long');
  const marker = cleaned.slice(TICKET_PREFIX.length, TICKET_PREFIX.length + 1);
  const body = cleaned.slice(TICKET_PREFIX.length + 2);
  let payload: Uint8Array | null = null;
  if (marker === 'c' || marker === 'z') payload = await inflate(fromBase64Url(body));
  else if (marker === 'p') payload = fromBase64Url(body);
  if (!payload) throw new Error('This pairing code could not be read — copy the whole code and try again');

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;
  } catch {
    throw new Error('This pairing code is damaged — copy it again from the other device');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('Pairing code is incomplete');

  // Compact codes carry `pk`; older ones carried a full `sdp`/`identity` object.
  if (typeof parsed.pk === 'string' && !parsed.sdp) {
    return fromCompact(parsed as unknown as CompactTicket);
  }
  const ticket = parsed as unknown as DirectTicket;
  if (ticket.v !== 1) throw new Error('This pairing code comes from an unsupported version of Fluxa');
  if (ticket.kind !== 'offer' && ticket.kind !== 'answer') throw new Error('Pairing code has no usable session');
  if (!ticket.sdp?.sdp || !ticket.nonce) throw new Error('Pairing code is incomplete');
  if (!ticket.identity?.publicKey || !ticket.identity.deviceId) throw new Error('Pairing code has no device identity');
  return ticket;
}

/* ------------------------------------------------------------------ */
/* Relay                                                               */
/* ------------------------------------------------------------------ */

export interface Relay {
  relay(connId: string, type: string, payload: unknown): void;
}

/**
 * Collects what would otherwise go to the signalling server so it can be folded
 * into a ticket. ICE candidates are only kept until the ticket is built; once
 * gathering is complete the SDP already carries them.
 */
export class ManualRelay implements Relay {
  readonly outbox: { type: string; payload: unknown }[] = [];

  relay(_connId: string, type: string, payload: unknown): void {
    this.outbox.push({ type, payload });
  }

  take(type: string): unknown[] {
    return this.outbox.filter((m) => m.type === type).map((m) => m.payload);
  }

  clear(): void {
    this.outbox.length = 0;
  }
}

/** Waits for ICE gathering to finish so the ticket carries every candidate. */
export function waitForIceGathering(pc: RTCPeerConnection, timeoutMs = 5000): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      pc.removeEventListener('icegatheringstatechange', check);
      clearTimeout(timer);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };
    // A slow or blocked network should not hang the flow: whatever has been
    // gathered by the deadline is enough for a same-LAN pair.
    const timer = setTimeout(finish, timeoutMs);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

export function ticketCandidates(relay: ManualRelay): RTCIceCandidateInit[] {
  const candidates: RTCIceCandidateInit[] = [];
  for (const payload of relay.take('ice')) {
    const { candidate } = payload as { candidate?: RTCIceCandidateInit };
    if (candidate?.candidate) candidates.push(candidate);
  }
  return candidates;
}

/** Short, human-readable form of a ticket for logs and toasts (never the SDP). */
export function describeTicket(ticket: string): string {
  return `${ticket.slice(0, 12)}… (${ticket.length} characters)`;
}
