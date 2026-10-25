import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { directoryPickerAvailable, exportToDirectory } from '../../src/client/transfer/export.js';
import type { ReceivedFile } from '../../src/client/transfer/sink.js';

class FakeFile {
  content: Buffer;
  constructor(content: Buffer = Buffer.alloc(0)) { this.content = content; }
  async createWritable() {
    const parts: Buffer[] = [];
    return {
      write: async (bytes: Uint8Array) => { parts.push(Buffer.from(bytes)); },
      close: async () => { this.content = Buffer.concat(parts); },
      abort: async () => { parts.length = 0; },
    };
  }
}
class FakeDir {
  children = new Map<string, FakeFile | FakeDir>();
  async getDirectoryHandle(name: string, { create = false } = {}): Promise<FakeDir> {
    const found = this.children.get(name);
    if (found instanceof FakeDir) return found;
    if (found || !create) throw new DOMException('not found', 'NotFoundError');
    const dir = new FakeDir(); this.children.set(name, dir); return dir;
  }
  async getFileHandle(name: string, { create = false } = {}): Promise<FakeFile> {
    const found = this.children.get(name);
    if (found instanceof FakeFile) return found;
    if (found || !create) throw new DOMException('not found', 'NotFoundError');
    const file = new FakeFile(); this.children.set(name, file); return file;
  }
  async removeEntry(name: string): Promise<void> { this.children.delete(name); }
}

const hash = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');
function received(path: string, buffer: Buffer, sha256 = hash(buffer)): ReceivedFile {
  const name = path.split('/').at(-1)!;
  return { descriptor: { streamId: 1, name, relPath: path, size: buffer.length,
    mime: 'application/octet-stream', sha256 }, size: buffer.length,
    sha256, blob: new Blob([new Uint8Array(buffer)]), opfsPath: null };
}

test('directory export preserves nested paths and verified bytes without overwriting an old save', async () => {
  assert.equal(directoryPickerAvailable(), false); // no browser picker during Node tests
  const root = new FakeDir();
  const nested = await (await root.getDirectoryHandle('folder', { create: true }))
    .getDirectoryHandle('nested', { create: true });
  nested.children.set('note.txt', new FakeFile(Buffer.from('keep-original')));
  const content = Buffer.from('new verified content');
  const files = [received('folder/nested/note.txt', content), received('other.bin', Buffer.from([0, 1, 2]))];
  const paths = await exportToDirectory(files, root as unknown as FileSystemDirectoryHandle);
  assert.deepEqual(paths, ['folder/nested/note (1).txt', 'other.bin']);
  assert.equal((nested.children.get('note.txt') as FakeFile).content.toString(), 'keep-original');
  assert.equal(hash((nested.children.get('note (1).txt') as FakeFile).content), hash(content));
  assert.deepEqual((root.children.get('other.bin') as FakeFile).content, Buffer.from([0, 1, 2]));
});

test('directory export rejects corrupt source and removes the incomplete destination', async () => {
  const root = new FakeDir();
  await assert.rejects(() => exportToDirectory(
    [received('broken.bin', Buffer.from('tampered'), '0'.repeat(64))],
    root as unknown as FileSystemDirectoryHandle,
  ), /SHA-256 failed/);
  assert.equal(root.children.has('broken.bin'), false);
});
