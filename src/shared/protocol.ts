/**
 * Fluxa wire protocol — shared by browser clients and the Node test-suite.
 *
 * Everything that crosses a network boundary is defined here so that sender,
 * receiver and tests can never drift apart.
 *
 * DataChannel framing (little endian, DataView):
 *
 *   control frame:  [0]  magic 0xF1
 *                   [1]  type 0x01
 *                   [2..3] reserved (0)
 *                   [4..7] payload length (uint32, big endian)
 *                   [8..]  UTF-8 JSON
 *
 *   chunk frame:    [0]  magic 0xF1
 *                   [1]  type 0x02
 *                   [2..5] streamId (uint32, big endian)
 *                   [6..13] byte offset (float64, big endian — exact for < 2^53)
 *                   [14..] raw file bytes
 *
 * The header is intentionally small (14 bytes) and self-describing: a chunk can
 * be routed to the right file without any shared mutable state, and a corrupted
 * or unexpected frame is rejected rather than guessed at.
 */

export const MAGIC = 0xf1;
export const FrameType = { Control: 0x01, Chunk: 0x02 } as const;

export const CHUNK_HEADER_BYTES = 14;
export const CONTROL_HEADER_BYTES = 8;

export const DEFAULT_CHUNK_SIZE = 64 * 1024; // 64 KiB
export const MAX_CHUNK_SIZE = 256 * 1024;
export const MAX_CONTROL_BYTES = 256 * 1024;

/** Sender stops writing to the channel above this buffered amount (bytes). */
export const SEND_HIGH_WATER = 1 * 1024 * 1024;
export const SEND_LOW_WATER = 256 * 1024;
/** Receiver acknowledges at least every N bytes / ms; sender keeps this much in flight. */
export const ACK_INTERVAL_BYTES = 256 * 1024;
export const ACK_INTERVAL_MS = 100;
export const MAX_UNACKED_BYTES = 8 * 1024 * 1024;

export const PROTOCOL_VERSION = 2; // v1 cannot acknowledge durable, whole-transfer completion

export const LIMITS = {
  maxFilesPerTransfer: 2000,
  maxFileBytes: 64 * 1024 * 1024 * 1024, // 64 GiB per file
  maxTransferBytes: 128 * 1024 * 1024 * 1024,
  maxNameBytes: 255,
  maxRelPathDepth: 16,
  /** Files above this size require a streaming (OPFS / File System Access) sink. */
  memorySinkMaxBytes: 64 * 1024 * 1024,
} as const;

export class ProtocolError extends Error {
  constructor(
    message: string,
    readonly code: string = 'protocol_error',
  ) {
    super(message);
    this.name = 'ProtocolError';
  }
}

/* ------------------------------------------------------------------ *
 * Control messages (JSON inside a control frame)
 * ------------------------------------------------------------------ */

export interface FileDescriptor {
  streamId: number;
  name: string;
  relPath: string;
  size: number;
  mime: string;
  /** SHA-256 of the whole file, committed before offering a resumable transfer. */
  sha256?: string;
}

export interface ResumeOffset {
  streamId: number;
  offset: number;
  prefixSha256: string;
}

export interface SharedContent {
  t: 'share';
  id: string;
  kind: 'clipboard' | 'link' | 'session';
  text: string;
  title?: string;
  url?: string;
}


export interface ManifestMsg {
  t: 'manifest';
  v: number;
  transferId: string;
  files: FileDescriptor[];
  totalBytes: number;
  senderName: string;
  createdAt: number;
}

export type ControlMessage =
  | { t: 'hello'; v: number; deviceId: string; publicKey: string; fingerprint: string; dtls: string; nonce: string; ephPub: string; sig: string }
  | { t: 'helloAck'; v: number }
  | ManifestMsg
  | { t: 'accept'; transferId: string; resume?: ResumeOffset[] }
  | { t: 'decline'; transferId: string; reason?: string }
  | { t: 'chunkAck'; transferId: string; streamId: number; bytes: number }
  | { t: 'fileEnd'; transferId: string; streamId: number; sha256: string; size: number }
  | { t: 'fileResult'; transferId: string; streamId: number; ok: boolean; sha256?: string; error?: string }
  | { t: 'done'; transferId: string }
  | { t: 'doneAck'; transferId: string; ok: boolean; error?: string }
  | SharedContent
  | { t: 'shareResult'; id: string; ok: boolean; reason?: string }
  | { t: 'cancel'; transferId: string; reason: string }
  | { t: 'error'; transferId?: string; code: string; message: string }
  | { t: 'ping'; ts: number }
  | { t: 'pong'; ts: number };

/* ------------------------------------------------------------------ *
 * Frame encoding
 * ------------------------------------------------------------------ */

export function encodeControl(msg: ControlMessage): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify(msg));
  if (json.byteLength > MAX_CONTROL_BYTES) {
    throw new ProtocolError(`control message too large (${json.byteLength})`, 'control_too_large');
  }
  const buf = new ArrayBuffer(CONTROL_HEADER_BYTES + json.byteLength);
  const view = new DataView(buf);
  view.setUint8(0, MAGIC);
  view.setUint8(1, FrameType.Control);
  view.setUint16(2, 0);
  view.setUint32(4, json.byteLength);
  new Uint8Array(buf, CONTROL_HEADER_BYTES).set(json);
  return buf;
}

export function encodeChunk(streamId: number, offset: number, data: Uint8Array): ArrayBuffer {
  if (!Number.isInteger(streamId) || streamId < 0 || streamId > 0xffffffff) {
    throw new ProtocolError('invalid streamId', 'bad_stream_id');
  }
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new ProtocolError('invalid offset', 'bad_offset');
  }
  if (data.byteLength > MAX_CHUNK_SIZE) {
    throw new ProtocolError('chunk too large', 'chunk_too_large');
  }
  const buf = new ArrayBuffer(CHUNK_HEADER_BYTES + data.byteLength);
  const view = new DataView(buf);
  view.setUint8(0, MAGIC);
  view.setUint8(1, FrameType.Chunk);
  view.setUint32(2, streamId);
  view.setFloat64(6, offset);
  new Uint8Array(buf, CHUNK_HEADER_BYTES).set(data);
  return buf;
}

export type DecodedFrame =
  | { kind: 'control'; message: ControlMessage }
  | { kind: 'chunk'; streamId: number; offset: number; data: Uint8Array };

export function decodeFrame(raw: ArrayBuffer | Uint8Array): DecodedFrame {
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  if (bytes.byteLength < CONTROL_HEADER_BYTES) {
    throw new ProtocolError('frame shorter than header', 'short_frame');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== MAGIC) throw new ProtocolError('bad magic byte', 'bad_magic');
  const type = view.getUint8(1);
  if (type === FrameType.Control) {
    const len = view.getUint32(4);
    if (len > MAX_CONTROL_BYTES) throw new ProtocolError('control frame too large', 'control_too_large');
    if (CONTROL_HEADER_BYTES + len !== bytes.byteLength) {
      throw new ProtocolError('control frame length mismatch', 'bad_length');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes.subarray(CONTROL_HEADER_BYTES)));
    } catch {
      throw new ProtocolError('control frame is not valid JSON', 'bad_json');
    }
    return { kind: 'control', message: assertControlMessage(parsed) };
  }
  if (type === FrameType.Chunk) {
    if (bytes.byteLength < CHUNK_HEADER_BYTES) throw new ProtocolError('chunk frame too short', 'short_frame');
    const streamId = view.getUint32(2);
    const offset = view.getFloat64(6);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new ProtocolError('invalid chunk offset', 'bad_offset');
    const data = bytes.subarray(CHUNK_HEADER_BYTES);
    if (data.byteLength > MAX_CHUNK_SIZE) throw new ProtocolError('chunk too large', 'chunk_too_large');
    return { kind: 'chunk', streamId, offset, data };
  }
  throw new ProtocolError(`unknown frame type ${type}`, 'bad_frame_type');
}

const CONTROL_TYPES = new Set([
  'hello', 'helloAck', 'manifest', 'accept', 'decline', 'chunkAck', 'fileEnd',
  'fileResult', 'done', 'doneAck', 'share', 'shareResult', 'cancel', 'error', 'ping', 'pong',
]);

const transferId = (x: unknown): boolean => typeof x === 'string' && /^[0-9a-f]{32}$/.test(x);
const digest = (x: unknown): boolean => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x);
const stream = (x: unknown): boolean => Number.isInteger(x) && Number(x) > 0 && Number(x) <= 0xffffffff;
const offset = (x: unknown): boolean => Number.isSafeInteger(x) && Number(x) >= 0 && Number(x) <= LIMITS.maxFileBytes;
const string = (x: unknown, max: number): boolean => typeof x === 'string' && x.length <= max;

/** Validation BEFORE dispatch: a malformed authenticated peer must not mutate
 * task state, acknowledge phantom bytes, or crash an event handler. */
export function assertControlMessage(value: unknown): ControlMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProtocolError('control payload is not an object');
  const msg = value as Record<string, unknown>;
  const t = msg['t'];
  if (typeof t !== 'string' || !CONTROL_TYPES.has(t)) {
    throw new ProtocolError(`unknown control message type: ${String(t)}`, 'unknown_control');
  }
  let ok = true;
  switch (t) {
    case 'hello':
      ok = msg['v'] === PROTOCOL_VERSION &&
        string(msg['deviceId'], 80) && string(msg['publicKey'], 400) &&
        string(msg['fingerprint'], 100) && string(msg['dtls'], 100) &&
        string(msg['nonce'], 100) && string(msg['ephPub'], 400) && string(msg['sig'], 200);
      break;
    case 'helloAck': ok = msg['v'] === PROTOCOL_VERSION; break;
    case 'manifest':
      ok = transferId(msg['transferId']) && msg['v'] === PROTOCOL_VERSION &&
        Array.isArray(msg['files']) && msg['files'].length <= LIMITS.maxFilesPerTransfer &&
        Number.isSafeInteger(msg['totalBytes']) && Number(msg['totalBytes']) >= 0 && Number(msg['totalBytes']) <= LIMITS.maxTransferBytes &&
        string(msg['senderName'], 100) && Number.isSafeInteger(msg['createdAt']);
      // The size/paths/streams/hashes of each descriptor are checked by the manager.
      break;
    case 'accept':
      ok = transferId(msg['transferId']) && (msg['resume'] === undefined || (
        Array.isArray(msg['resume']) && msg['resume'].length <= LIMITS.maxFilesPerTransfer &&
        msg['resume'].every((r: unknown) => {
          const v = r as Record<string, unknown>;
          return v && stream(v['streamId']) && offset(v['offset']) && digest(v['prefixSha256']);
        })
      ));
      break;
    case 'decline': ok = transferId(msg['transferId']) && (msg['reason'] === undefined || string(msg['reason'], 512)); break;
    case 'chunkAck': ok = transferId(msg['transferId']) && stream(msg['streamId']) && offset(msg['bytes']); break;
    case 'fileEnd': ok = transferId(msg['transferId']) && stream(msg['streamId']) && offset(msg['size']) && digest(msg['sha256']); break;
    case 'fileResult':
      ok = transferId(msg['transferId']) && stream(msg['streamId']) && typeof msg['ok'] === 'boolean' &&
        (msg['sha256'] === undefined || digest(msg['sha256'])) &&
        (msg['error'] === undefined || string(msg['error'], 512));
      break;
    case 'done': ok = transferId(msg['transferId']); break;
    case 'doneAck': ok = transferId(msg['transferId']) && typeof msg['ok'] === 'boolean' &&
      (msg['error'] === undefined || string(msg['error'], 512)); break;
    case 'share': ok = validateSharedContent(msg).ok; break;
    case 'shareResult': ok = transferId(msg['id']) && typeof msg['ok'] === 'boolean' &&
      (msg['reason'] === undefined || string(msg['reason'], 512)); break;
    case 'cancel': ok = transferId(msg['transferId']) && string(msg['reason'], 512); break;
    case 'error': ok = (msg['transferId'] === undefined || transferId(msg['transferId'])) &&
      string(msg['code'], 80) && string(msg['message'], 512); break;
    case 'ping': case 'pong': ok = Number.isSafeInteger(msg['ts']); break;
  }
  if (!ok) throw new ProtocolError(`invalid ${t} control message`, 'bad_control');
  return value as ControlMessage;
}

export function validateSharedContent(value: unknown): { ok: boolean; reason?: string } {
  if (!value || typeof value !== 'object') return { ok: false, reason: 'invalid payload' };
  const v = value as Record<string, unknown>;
  if (!transferId(v['id']) || !['clipboard', 'link', 'session'].includes(String(v['kind']))) {
    return { ok: false, reason: 'invalid content identity or kind' };
  }
  if (!string(v['text'], 16_384) || new TextEncoder().encode(v['text'] as string).length > 16_384 ||
      !string(v['title'] ?? '', 256) || !string(v['url'] ?? '', 2048)) {
    return { ok: false, reason: 'content exceeds limit' };
  }
  if (v['kind'] !== 'clipboard') {
    try {
      const url = new URL(String(v['url']));
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error();
    } catch {
      return { ok: false, reason: 'only public http(s) links without credentials are allowed' };
    }
  } else if (!v['text']) return { ok: false, reason: 'empty clipboard' };
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * Manifest validation (defensive: the sender is untrusted)
 * ------------------------------------------------------------------ */

export interface ManifestValidation {
  ok: boolean;
  errors: string[];
  files: FileDescriptor[];
  totalBytes: number;
}

export function validateManifest(
  msg: ManifestMsg,
  sanitize: (name: string, relPath: string) => { name: string; relPath: string } | null,
): ManifestValidation {
  const errors: string[] = [];
  if (msg.t !== 'manifest') errors.push('not a manifest');
  if (msg.v !== PROTOCOL_VERSION) errors.push(`unsupported protocol version ${String(msg.v)}`);
  if (typeof msg.transferId !== 'string' || !/^[0-9a-f]{32}$/.test(msg.transferId)) {
    errors.push('invalid transferId');
  }
  if (typeof msg.senderName !== 'string' || msg.senderName.length > 100) errors.push('invalid senderName');
  if (!Number.isSafeInteger(msg.createdAt)) errors.push('invalid createdAt');
  if (!Number.isSafeInteger(msg.totalBytes) || msg.totalBytes < 0) errors.push('invalid totalBytes');
  if (!Array.isArray(msg.files) || msg.files.length === 0) errors.push('manifest has no files');
  if (Array.isArray(msg.files) && msg.files.length > LIMITS.maxFilesPerTransfer) {
    errors.push(`too many files (${msg.files.length})`);
  }

  const files: FileDescriptor[] = [];
  const seenStreams = new Set<number>();
  const seenPaths = new Set<string>();
  let total = 0;

  for (const raw of Array.isArray(msg.files) ? msg.files : []) {
    const f = raw as Partial<FileDescriptor>;
    if (
      !f || typeof f.streamId !== 'number' || !Number.isInteger(f.streamId) ||
      f.streamId < 1 || f.streamId > 0xffffffff
    ) {
      errors.push('file with invalid streamId');
      continue;
    }
    if (seenStreams.has(f.streamId)) {
      errors.push(`duplicate streamId ${f.streamId}`);
      continue;
    }
    seenStreams.add(f.streamId);
    if (typeof f.size !== 'number' || !Number.isSafeInteger(f.size) || f.size < 0) {
      errors.push(`file ${f.name ?? '?'} has invalid size`);
      continue;
    }
    if (f.size > LIMITS.maxFileBytes) {
      errors.push(`file ${f.name ?? '?'} exceeds the per-file size limit`);
      continue;
    }
    total += f.size;
    const safe = sanitize(String(f.name ?? ''), String(f.relPath ?? f.name ?? ''));
    if (!safe) {
      errors.push(`file name rejected: ${String(f.name ?? '').slice(0, 64)}`);
      continue;
    }
    if (typeof f.name !== 'string' || typeof f.relPath !== 'string' || safe.name !== f.name || safe.relPath !== f.relPath) {
      errors.push('non-canonical file name or path');
      continue;
    }
    if (f.sha256 !== undefined && !digest(f.sha256)) {
      errors.push('invalid file SHA-256 commitment');
      continue;
    }
    if (seenPaths.has(safe.relPath.toLowerCase())) {
      errors.push(`duplicate path ${safe.relPath}`);
      continue;
    }
    seenPaths.add(safe.relPath.toLowerCase());
    files.push({
      streamId: f.streamId,
      name: safe.name,
      relPath: safe.relPath,
      size: f.size,
      mime: typeof f.mime === 'string' && f.mime.length <= 255 ? f.mime : 'application/octet-stream',
      ...(f.sha256 ? { sha256: f.sha256 } : {}),
    });
  }

  if (total > LIMITS.maxTransferBytes) errors.push('transfer exceeds the total size limit');
  if (files.some((f) => Boolean(f.sha256)) && files.some((f) => !f.sha256)) errors.push('mixed hashed and unhashed files');
  if (typeof msg.totalBytes === 'number' && msg.totalBytes !== total) {
    errors.push(`manifest totalBytes (${msg.totalBytes}) does not match file sizes (${total})`);
  }
  if (files.length !== (Array.isArray(msg.files) ? msg.files.length : 0)) {
    errors.push('some file entries were rejected');
  }

  return { ok: errors.length === 0, errors, files, totalBytes: total };
}

/* ------------------------------------------------------------------ *
 * Small helpers shared by both sides
 * ------------------------------------------------------------------ */

export function formatBytes(n: number, digits = 1): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : digits)} ${units[i]}`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 1) return 'less than a second';
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
