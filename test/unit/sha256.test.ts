import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { Sha256, sha256Hex } from '../../src/client/sha256.js';

const nodeHash = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex');

test('matches known SHA-256 vectors', () => {
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(
    sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  );
});

test('matches node crypto across boundary sizes', () => {
  const sizes = [0, 1, 55, 56, 63, 64, 65, 127, 128, 129, 1000, 65536, 65537];
  for (const size of sizes) {
    const data = randomBytes(size);
    assert.equal(sha256Hex(new Uint8Array(data)), nodeHash(data), `size ${size}`);
  }
});

test('incremental updates equal a single-shot hash', () => {
  const data = randomBytes(300_000);
  const single = nodeHash(data);
  const hasher = new Sha256();
  let offset = 0;
  // Deliberately irregular chunk boundaries.
  const steps = [1, 63, 64, 65, 1000, 7, 4096, 33_000, 70_000];
  for (const step of steps) {
    hasher.update(new Uint8Array(data.subarray(offset, offset + step)));
    offset += step;
  }
  hasher.update(new Uint8Array(data.subarray(offset)));
  assert.equal(hasher.digestHex(), single);
});

test('digest cannot be taken twice and update after digest throws', () => {
  const hasher = new Sha256();
  hasher.update(new TextEncoder().encode('fluxa'));
  hasher.digestHex();
  assert.throws(() => hasher.digestHex());
  assert.throws(() => hasher.update(new Uint8Array([1])));
});

test('a single flipped bit changes the digest', () => {
  const data = randomBytes(1024);
  const copy = new Uint8Array(data);
  copy[500] = (copy[500] ?? 0) ^ 0x01;
  assert.notEqual(sha256Hex(new Uint8Array(data)), sha256Hex(copy));
});
