import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { AndroidInboxFile, classifyAndroidText, validAndroidShare, type AndroidSharedItem } from '../../src/client/android-share.js';
import { sha256OfBlob } from '../../src/client/sha256.js';

const ID = 'a'.repeat(32);
const item: AndroidSharedItem = {
  id: ID, createdAt: 1700000000000, text: '', title: '',
  files: [{ index: 0, name: 'photo.jpg', mime: 'image/jpeg', size: 180_000 }],
};

test('native share metadata is validated before display or sending', () => {
  assert.equal(validAndroidShare(item), true);
  assert.equal(validAndroidShare({ ...item, id: '../elsewhere' }), false);
  assert.equal(validAndroidShare({ ...item, text: 'x'.repeat(20_000) }), false);
  assert.equal(validAndroidShare({ ...item, files: [{ ...item.files[0]!, index: 19 }] }), false);
  assert.equal(validAndroidShare({ ...item, files: [{ ...item.files[0]!, size: Infinity }] }), false);
  assert.equal(validAndroidShare({ ...item, files: [], text: '' }), false);
  assert.equal(validAndroidShare({ ...item, files: [], text: 'https://example.com' }), true);
});

test('Chrome Share URL is parsed without cookies or browser access; credential-bearing links are rejected', () => {
  assert.deepEqual(classifyAndroidText('https://example.com/a?q=1#part', 'Article'), {
    kind: 'link', text: '', url: 'https://example.com/a?q=1#part', title: 'Article',
  });
  assert.deepEqual(classifyAndroidText('a note\nhttps://example.org', ''), {
    kind: 'link', text: 'a note', url: 'https://example.org/',
  });
  assert.deepEqual(classifyAndroidText('Copied from another app', ''), {
    kind: 'clipboard', text: 'Copied from another app',
  });
  assert.throws(() => classifyAndroidText('https://alice:secret@example.com', ''), /credentials/);
  assert.throws(() => classifyAndroidText(' \n ', ''), /no text/);
});

test('Android shared File hashes and slices in <=64 KiB native reads; no whole-file base64', async () => {
  const payload = randomBytes(180_000);
  const calls: { offset: number; length: number }[] = [];
  const plugin = {
    readChunk: async ({ id, index, offset, length }: { id: string; index: number; offset: number; length: number }) => {
      assert.equal(id, ID);
      assert.equal(index, 0);
      calls.push({ offset, length });
      return { data: payload.subarray(offset, offset + length).toString('base64') };
    },
  };
  const file = new AndroidInboxFile(plugin, ID, item.files[0]!);
  assert.equal(file instanceof File, true);
  assert.equal(file.size, payload.length);
  assert.equal(file.type, 'image/jpeg');
  assert.equal(await sha256OfBlob(file), createHash('sha256').update(payload).digest('hex'));
  assert.deepEqual(calls.map((c) => c.length), [65536, 65536, 48928]);
  const bytes = Buffer.from(await file.slice(65_530, 65_545).arrayBuffer());
  assert.deepEqual(bytes, payload.subarray(65_530, 65_545));
  assert.equal(calls.at(-1)?.length, 15);
  assert.equal(file.slice(999_999).size, 0);
  assert.equal(file.slice(-10).size, 10);
});

test('a file revoked from the native inbox errors rather than transmitting truncated data', async () => {
  const plugin = { readChunk: async () => ({ data: 'AA==' }) };
  const file = new AndroidInboxFile(plugin, ID, item.files[0]!);
  await assert.rejects(() => sha256OfBlob(file), /changed while reading/);
});
