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

/**
 * Serialises a ticket. Compressed when the platform supports CompressionStream
 * (every current Chromium/WebView), with a plain base64 fallback marked by a
 * different prefix so an old client can still read it.
 */
export async function encodeTicket(ticket: DirectTicket): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(ticket));
  const packed = await deflate(json);
  if (packed) return `${TICKET_PREFIX}z.${toBase64Url(packed)}`;
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
  let json: Uint8Array | null = null;
  if (marker === 'z') json = await inflate(fromBase64Url(body));
  else if (marker === 'p') json = fromBase64Url(body);
  if (!json) throw new Error('This pairing code could not be read — copy the whole code and try again');

  let parsed: DirectTicket;
  try {
    parsed = JSON.parse(new TextDecoder().decode(json)) as DirectTicket;
  } catch {
    throw new Error('This pairing code is damaged — copy it again from the other device');
  }
  if (!parsed || parsed.v !== 1) throw new Error('This pairing code comes from an unsupported version of Fluxa');
  if (parsed.kind !== 'offer' && parsed.kind !== 'answer') throw new Error('Pairing code has no usable session');
  if (!parsed.sdp?.sdp || !parsed.nonce) throw new Error('Pairing code is incomplete');
  if (!parsed.identity?.publicKey || !parsed.identity.deviceId) throw new Error('Pairing code has no device identity');
  return parsed;
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
