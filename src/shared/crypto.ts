/**
 * Cryptographic helpers shared by the browser client and the Node server.
 * Only WebCrypto primitives are used so both runtimes execute identical code.
 */

const enc = new TextEncoder();

/**
 * TS 5.9's DOM lib distinguishes Uint8Array<ArrayBuffer> from
 * Uint8Array<ArrayBufferLike>; WebCrypto only accepts the former. These views are
 * always backed by a plain ArrayBuffer, so the assertion is accurate.
 */
const buf = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

export function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

export function randomToken(n = 16): string {
  return b64url(randomBytes(n));
}

export async function sha256(data: Uint8Array | ArrayBuffer): Promise<Uint8Array> {
  const view = data instanceof Uint8Array ? data : new Uint8Array(data);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', buf(view)));
}

export async function sha256Hex(data: Uint8Array | ArrayBuffer | string): Promise<string> {
  const bytes = typeof data === 'string' ? enc.encode(data) : data;
  return toHex(await sha256(bytes as Uint8Array));
}

/** Device identity = SHA-256 of the DER-encoded SPKI public key. Unforgeable without the private key. */
export async function deriveDeviceId(publicKeySpkiB64: string): Promise<string> {
  return b64url(await sha256(b64urlDecode(publicKeySpkiB64)));
}

export async function importVerifyKey(spkiB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'spki',
    buf(b64urlDecode(spkiB64)),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
}

export async function verifySignature(
  spkiB64: string,
  signatureB64: string,
  message: string,
): Promise<boolean> {
  try {
    const key = await importVerifyKey(spkiB64);
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      buf(b64urlDecode(signatureB64)),
      buf(enc.encode(message)),
    );
  } catch {
    return false;
  }
}

/** ECDSA P-256 identity keypair. The private key is non-extractable and stays in IndexedDB. */
export async function generateIdentityKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  ) as Promise<CryptoKeyPair>;
}

export async function exportPublicKeySpki(key: CryptoKey): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.exportKey('spki', key)));
}

export async function signWithIdentity(privateKey: CryptoKey, message: string): Promise<string> {
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, buf(enc.encode(message)));
  return b64url(new Uint8Array(sig));
}

/* ------------------------------------------------------------------ *
 * Domain-separated signing strings
 * ------------------------------------------------------------------ */

export function signalingHelloSignInput(nonce: string, deviceId: string): string {
  return `fluxa/1/signaling|${nonce}|${deviceId}`;
}

export function relaySignInput(
  roomId: string,
  from: string,
  to: string,
  type: string,
  dataSha256Hex: string,
): string {
  return `fluxa/1/relay|${roomId}|${from}|${to}|${type}|${dataSha256Hex}`;
}

export function channelHelloSignInput(fields: {
  deviceId: string;
  peerDeviceId: string;
  sessionNonce: string;
  fingerprint: string;
  dtlsFingerprint: string;
  nonce: string;
  ephPub: string;
}): string {
  return [
    'fluxa/1/hello',
    fields.deviceId,
    fields.peerDeviceId,
    fields.sessionNonce,
    fields.fingerprint,
    fields.dtlsFingerprint,
    fields.nonce,
    fields.ephPub,
  ].join('|');
}

/* ------------------------------------------------------------------ *
 * Ephemeral ECDH + short authentication string
 * ------------------------------------------------------------------ */

export async function generateEcdhKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, [
    'deriveBits',
  ]) as Promise<CryptoKeyPair>;
}

export async function deriveSharedSecret(privateKey: CryptoKey, peerPublicSpkiB64: string): Promise<Uint8Array> {
  const peerKey = await crypto.subtle.importKey(
    'spki',
    buf(b64urlDecode(peerPublicSpkiB64)),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: peerKey }, privateKey, 256);
  return new Uint8Array(bits);
}

export async function hkdf(secret: Uint8Array, salt: string, info: string, length = 32): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', buf(secret), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: buf(enc.encode(salt)), info: buf(enc.encode(info)) },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

export async function hmac(secret: Uint8Array, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    buf(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, buf(enc.encode(message)))));
}

/** Deterministic transcript so both peers compute the same value regardless of who is "A". */
export function buildSasTranscript(fields: {
  sessionNonce: string;
  deviceA: string;
  deviceB: string;
  fingerprintA: string;
  fingerprintB: string;
  ephA: string;
  ephB: string;
  nonceA: string;
  nonceB: string;
}): string {
  const a = { id: fields.deviceA, fp: fields.fingerprintA, eph: fields.ephA, nonce: fields.nonceA };
  const b = { id: fields.deviceB, fp: fields.fingerprintB, eph: fields.ephB, nonce: fields.nonceB };
  const [first, second] = a.id < b.id ? [a, b] : [b, a];
  return [
    'fluxa/1/sas',
    fields.sessionNonce,
    `${first.id}:${first.fp}:${first.eph}:${first.nonce}`,
    `${second.id}:${second.fp}:${second.eph}:${second.nonce}`,
  ].join('|');
}

/** Six digits derived from the transcript — shown on both screens for out-of-band comparison. */
export function sasDigits(transcriptHash: Uint8Array): string {
  const view = new DataView(transcriptHash.buffer, transcriptHash.byteOffset, transcriptHash.byteLength);
  const n = view.getUint32(0) % 1_000_000;
  return n.toString().padStart(6, '0');
}

export function fingerprintFromSdp(sdp: string): string | null {
  const match = /a=fingerprint:sha-256\s+([0-9A-Fa-f:]+)/.exec(sdp);
  return match ? match[1]!.toUpperCase() : null;
}
