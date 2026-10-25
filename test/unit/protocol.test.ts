import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHUNK_HEADER_BYTES,
  CONTROL_HEADER_BYTES,
  MAX_CHUNK_SIZE,
  decodeFrame,
  encodeChunk,
  encodeControl,
  validateManifest,
  formatBytes,
  formatDuration,
  type ManifestMsg,
} from '../../src/shared/protocol.js';
import { sanitizeRelPath } from '../../src/shared/filename.js';

const manifest = (over: Partial<ManifestMsg> = {}): ManifestMsg => ({
  t: 'manifest',
  v: 2,
  transferId: 'a'.repeat(32),
  files: [{ streamId: 1, name: 'note.txt', relPath: 'note.txt', size: 5, mime: 'text/plain' }],
  totalBytes: 5,
  senderName: 'Test',
  createdAt: Date.now(),
  ...over,
});

test('control frames round-trip', () => {
  const frame = encodeControl({ t: 'accept', transferId: 'a'.repeat(32) });
  const decoded = decodeFrame(frame);
  assert.equal(decoded.kind, 'control');
  if (decoded.kind !== 'control') return;
  assert.deepEqual(decoded.message, { t: 'accept', transferId: 'a'.repeat(32) });
  const payloadLength = new TextEncoder().encode(JSON.stringify({ t: 'accept', transferId: 'a'.repeat(32) })).byteLength;
  assert.equal(new Uint8Array(frame).byteLength, CONTROL_HEADER_BYTES + payloadLength);
});

test('chat control messages round-trip with delivery acknowledgements', () => {
  const message = { t: 'chat' as const, id: '0123456789abcdef0123456789abcdef', text: 'Hello from Fluxa 👋', sentAt: 1_798_000_000_000 };
  const decoded = decodeFrame(encodeControl(message));
  assert.equal(decoded.kind, 'control');
  if (decoded.kind !== 'control') return;
  assert.deepEqual(decoded.message, message);
  const ack = { t: 'chatAck' as const, id: message.id, ok: true, receivedAt: message.sentAt + 20 };
  const ackDecoded = decodeFrame(encodeControl(ack));
  assert.equal(ackDecoded.kind, 'control');
  if (ackDecoded.kind === 'control') assert.deepEqual(ackDecoded.message, ack);
});

test('chat control rejects malformed IDs, blank text, and oversized messages', () => {
  assert.throws(() => decodeFrame(encodeControl({ t: 'chat', id: 'too-short', text: 'hello', sentAt: 1 } as never)), /invalid chat control message/);
  assert.throws(() => decodeFrame(encodeControl({ t: 'chat', id: 'a'.repeat(32), text: '   ', sentAt: 1 } as never)), /invalid chat control message/);
  assert.throws(() => decodeFrame(encodeControl({ t: 'chat', id: 'a'.repeat(32), text: 'x'.repeat(4001), sentAt: 1 } as never)), /invalid chat control message/);
  const emoji = '😀'.repeat(1000); // 2,000 JS code units, exactly 4,000 UTF-8 bytes
  const atLimit = { t: 'chat' as const, id: 'a'.repeat(32), text: emoji, sentAt: 1 };
  const decoded = decodeFrame(encodeControl(atLimit));
  assert.equal(decoded.kind, 'control');
  if (decoded.kind === 'control') assert.deepEqual(decoded.message, atLimit);
  assert.throws(() => decodeFrame(encodeControl({ ...atLimit, text: emoji + '😀' })), /invalid chat control message/);
});

test('chunk frames round-trip with exact bytes', () => {
  const payload = new Uint8Array([0, 1, 2, 250, 251, 255]);
  const frame = encodeChunk(7, 123456, payload);
  assert.equal(new Uint8Array(frame).byteLength, CHUNK_HEADER_BYTES + payload.byteLength);
  const decoded = decodeFrame(frame);
  assert.equal(decoded.kind, 'chunk');
  if (decoded.kind !== 'chunk') return;
  assert.equal(decoded.streamId, 7);
  assert.equal(decoded.offset, 123456);
  assert.deepEqual([...decoded.data], [...payload]);
});

test('decode accepts a Uint8Array view with a non-zero byteOffset', () => {
  const frame = new Uint8Array(encodeChunk(1, 0, new Uint8Array([9, 9, 9])));
  const padded = new Uint8Array(frame.byteLength + 4);
  padded.set(frame, 4);
  const view = padded.subarray(4);
  const decoded = decodeFrame(view);
  assert.equal(decoded.kind, 'chunk');
  if (decoded.kind === 'chunk') assert.deepEqual([...decoded.data], [9, 9, 9]);
});

test('malformed frames are rejected rather than guessed at', () => {
  assert.throws(() => decodeFrame(new Uint8Array([0xf1, 0x01])), /shorter than header/);

  const badMagic = new Uint8Array(16);
  badMagic[0] = 0x00;
  assert.throws(() => decodeFrame(badMagic), /bad magic/);

  const badType = new Uint8Array(16);
  badType[0] = 0xf1;
  badType[1] = 0x09;
  assert.throws(() => decodeFrame(badType), /unknown frame type/);

  const badJson = new Uint8Array(encodeControl({ t: 'ping', ts: 1 }));
  badJson.set(new TextEncoder().encode('{nope!!}'), CONTROL_HEADER_BYTES);
  assert.throws(() => decodeFrame(badJson), /not valid JSON/);

  const truncated = new Uint8Array(encodeControl({ t: 'ping', ts: 1 })).subarray(0, 10);
  assert.throws(() => decodeFrame(truncated), /length mismatch|too short/);
});

test('unknown control message types are rejected', () => {
  const frame = new Uint8Array(encodeControl({ t: 'ping', ts: 1 }));
  frame.set(new TextEncoder().encode('{"t":"evil"}'), CONTROL_HEADER_BYTES);
  const view = new DataView(frame.buffer);
  view.setUint32(4, new TextEncoder().encode('{"t":"evil"}').byteLength);
  const trimmed = frame.subarray(0, CONTROL_HEADER_BYTES + new TextEncoder().encode('{"t":"evil"}').byteLength);
  assert.throws(() => decodeFrame(trimmed), /unknown control message type/);
});

test('oversized chunks and negative offsets are refused by the encoder', () => {
  assert.throws(() => encodeChunk(1, 0, new Uint8Array(MAX_CHUNK_SIZE + 1)), /chunk too large/);
  assert.throws(() => encodeChunk(1, -1, new Uint8Array(1)), /invalid offset/);
  assert.throws(() => encodeChunk(1.5, 0, new Uint8Array(1)), /invalid streamId/);
});

test('manifest validation accepts a well-formed manifest', () => {
  const result = validateManifest(manifest(), sanitizeRelPath);
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.equal(result.totalBytes, 5);
  assert.equal(result.files.length, 1);
});

test('manifest validation rejects path traversal, duplicates and bad totals', () => {
  const traversal = validateManifest(
    manifest({ files: [{ streamId: 1, name: 'passwd', relPath: '../../etc/passwd', size: 5, mime: 'text/plain' }] }),
    sanitizeRelPath,
  );
  assert.equal(traversal.ok, false);

  const duplicateStream = validateManifest(
    manifest({
      files: [
        { streamId: 1, name: 'a.txt', relPath: 'a.txt', size: 1, mime: 'text/plain' },
        { streamId: 1, name: 'b.txt', relPath: 'b.txt', size: 1, mime: 'text/plain' },
      ],
      totalBytes: 2,
    }),
    sanitizeRelPath,
  );
  assert.equal(duplicateStream.ok, false);

  const mismatchedTotal = validateManifest(manifest({ totalBytes: 999 }), sanitizeRelPath);
  assert.equal(mismatchedTotal.ok, false);

  const negative = validateManifest(
    manifest({ files: [{ streamId: 1, name: 'a', relPath: 'a', size: -1, mime: 'text/plain' }] }),
    sanitizeRelPath,
  );
  assert.equal(negative.ok, false);

  const empty = validateManifest(manifest({ files: [], totalBytes: 0 }), sanitizeRelPath);
  assert.equal(empty.ok, false);

  const badVersion = validateManifest({ ...manifest(), v: 99 }, sanitizeRelPath);
  assert.equal(badVersion.ok, false);
});

test('formatting helpers are stable', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(formatDuration(0.4), 'less than a second');
  assert.equal(formatDuration(12), '12s');
  assert.equal(formatDuration(125), '2m 5s');
});
