/** Receive-side storage. Every OPFS chunk is committed before acknowledgement;
 * after a crash, actual file length and prefix SHA-256 (never a saved counter)
 * determine the resume offset. Partial files stay inside an origin-private,
 * transfer-id-scoped directory and are never presented as verified downloads.
 */
import { LIMITS, type FileDescriptor } from '../../shared/protocol.js';

export interface ReceivedFile {
  descriptor: FileDescriptor;
  blob: Blob | null;
  opfsPath: string | null;
  sha256: string;
  size: number;
}

export interface Sink {
  write(offset: number, data: Uint8Array): Promise<void>;
  finalize(): Promise<void>;
  abort(reason: string): Promise<void>;
  toReceivedFile(sha256: string): Promise<ReceivedFile>;
}

const ROOT_DIR = 'fluxa-received';

export function opfsAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory;
}

async function transferDir(transferId: string, create: boolean): Promise<FileSystemDirectoryHandle | null> {
  if (!opfsAvailable() || !/^[0-9a-f]{32}$/.test(transferId)) return null;
  const root = await navigator.storage.getDirectory();
  try {
    const base = await root.getDirectoryHandle(ROOT_DIR, { create });
    return await base.getDirectoryHandle(transferId, { create });
  } catch (error) {
    if (!create && (error as DOMException).name === 'NotFoundError') return null;
    throw error;
  }
}

async function parentOf(root: FileSystemDirectoryHandle, relPath: string, create: boolean): Promise<{
  dir: FileSystemDirectoryHandle; name: string;
} | null> {
  const parts = relPath.split('/');
  const name = parts.pop()!;
  let dir = root;
  try {
    for (const part of parts) dir = await dir.getDirectoryHandle(part, { create });
    return { dir, name };
  } catch (error) {
    if (!create && (error as DOMException).name === 'NotFoundError') return null;
    throw error;
  }
}

export async function readPartial(transferId: string, descriptor: FileDescriptor): Promise<File | null> {
  const root = await transferDir(transferId, false);
  if (!root) return null;
  const parent = await parentOf(root, descriptor.relPath, false);
  if (!parent) return null;
  try {
    return await (await parent.dir.getFileHandle(parent.name)).getFile();
  } catch (error) {
    if ((error as DOMException).name === 'NotFoundError') return null;
    throw error;
  }
}

export async function clearTransferFiles(transferId: string): Promise<void> {
  if (!opfsAvailable() || !/^[0-9a-f]{32}$/.test(transferId)) return;
  const root = await navigator.storage.getDirectory();
  try {
    const base = await root.getDirectoryHandle(ROOT_DIR);
    await base.removeEntry(transferId, { recursive: true });
  } catch (error) {
    if ((error as DOMException).name !== 'NotFoundError') throw error;
  }
}

export class MemorySink implements Sink {
  private chunks: Uint8Array[] = [];
  private received = 0;
  private aborted = false;

  constructor(readonly descriptor: FileDescriptor) {}

  async write(offset: number, data: Uint8Array): Promise<void> {
    if (this.aborted) throw new Error('sink aborted');
    if (offset !== this.received) throw new Error(`out-of-order write: expected ${this.received}, got ${offset}`);
    if (this.received + data.byteLength > LIMITS.memorySinkMaxBytes) throw new Error('browser memory storage limit reached');
    this.received += data.byteLength;
    this.chunks.push(data.slice());
  }

  async finalize(): Promise<void> {
    if (this.aborted || this.received !== this.descriptor.size) throw new Error('incomplete memory sink');
  }

  async abort(): Promise<void> {
    this.aborted = true;
    this.chunks = [];
    this.received = 0;
  }

  async toReceivedFile(sha256: string): Promise<ReceivedFile> {
    const blob = new Blob(this.chunks as BlobPart[], { type: this.descriptor.mime || 'application/octet-stream' });
    this.chunks = [];
    return { descriptor: this.descriptor, blob, opfsPath: null, sha256, size: blob.size };
  }
}

export class OpfsSink implements Sink {
  private handle: FileSystemFileHandle | null = null;
  private received = 0;
  private aborted = false;
  private readonly path: string;

  constructor(readonly descriptor: FileDescriptor, private readonly transferId: string) {
    this.path = `${ROOT_DIR}/${transferId}/${descriptor.relPath}`;
  }

  /** Read-back is the authority for the offset; metadata cannot invent bytes. */
  async recover(file: File): Promise<void> {
    if (file.size > this.descriptor.size) throw new Error('partial file exceeds declared size');
    const root = await transferDir(this.transferId, false);
    const parent = root && await parentOf(root, this.descriptor.relPath, false);
    if (!parent) throw new Error('partial file disappeared');
    this.handle = await parent.dir.getFileHandle(parent.name);
    this.received = file.size;
  }

  private async open(): Promise<FileSystemFileHandle> {
    if (this.handle) return this.handle;
    const root = await transferDir(this.transferId, true);
    if (!root) throw new Error('origin-private storage is unavailable');
    const parent = await parentOf(root, this.descriptor.relPath, true);
    if (!parent) throw new Error('destination path unavailable');
    // New transfer ids are random; never truncate an existing file accidentally.
    try {
      await parent.dir.getFileHandle(parent.name);
      throw new Error('destination already exists without a matching recovery journal');
    } catch (error) {
      if ((error as DOMException).name !== 'NotFoundError') throw error;
    }
    this.handle = await parent.dir.getFileHandle(parent.name, { create: true });
    return this.handle;
  }

  async write(offset: number, data: Uint8Array): Promise<void> {
    if (this.aborted) throw new Error('sink aborted');
    if (offset !== this.received) throw new Error(`out-of-order write: expected ${this.received}, got ${offset}`);
    const handle = await this.open();
    // createWritable writes to a temporary file; close() commits that chunk.
    // If the app dies between chunks, recovery uses the last COMMITTED file size.
    const writable = await handle.createWritable({ keepExistingData: true });
    try {
      await writable.write({ type: 'write', position: offset, data: data as unknown as BufferSource });
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => undefined);
      throw error;
    }
    this.received += data.byteLength;
  }

  async finalize(): Promise<void> {
    if (this.aborted || this.received !== this.descriptor.size) throw new Error('incomplete OPFS sink');
    const handle = await this.open(); // zero-byte file must actually exist on disk
    if ((await handle.getFile()).size !== this.received) throw new Error('committed file size mismatch');
  }

  async abort(): Promise<void> {
    this.aborted = true;
    this.handle = null;
    const root = await transferDir(this.transferId, false);
    const parent = root && await parentOf(root, this.descriptor.relPath, false);
    if (!parent) return;
    try {
      await parent.dir.removeEntry(parent.name);
    } catch (error) {
      if ((error as DOMException).name !== 'NotFoundError') throw error;
    }
  }

  async toReceivedFile(sha256: string): Promise<ReceivedFile> {
    const handle = await this.open();
    const file = await handle.getFile();
    if (file.size !== this.descriptor.size) throw new Error('file changed after verification');
    return { descriptor: this.descriptor, blob: file, opfsPath: this.path, sha256, size: file.size };
  }
}

export async function createSink(descriptor: FileDescriptor, transferId: string, preferMemory: boolean): Promise<Sink> {
  // Hashed manifests are resumable when OPFS + IndexedDB work. Even zero-byte
  // files are stored in OPFS so a restart cannot lose a verified file.
  const useMemory = preferMemory || !opfsAvailable() || (!descriptor.sha256 && descriptor.size <= 8 * 1024 * 1024);
  if (useMemory) {
    if (descriptor.size > LIMITS.memorySinkMaxBytes) throw new Error('file is too large for this browser without OPFS');
    return new MemorySink(descriptor);
  }
  return new OpfsSink(descriptor, transferId);
}

/** Quota is a best-effort estimate; a later write can still fail (e.g. ENOSPC). */
export async function checkStorage(bytesNeeded: number): Promise<{ ok: boolean; available: number | null }> {
  if (!opfsAvailable() && bytesNeeded > LIMITS.memorySinkMaxBytes) return { ok: false, available: LIMITS.memorySinkMaxBytes };
  try {
    if (!navigator.storage?.estimate) return { ok: true, available: null };
    const { quota, usage } = await navigator.storage.estimate();
    if (typeof quota !== 'number') return { ok: true, available: null };
    const available = Math.max(0, quota - (usage ?? 0));
    return { ok: available > bytesNeeded * 1.05, available };
  } catch {
    return { ok: true, available: null };
  }
}

export async function clearReceivedFiles(): Promise<void> {
  if (!opfsAvailable()) return;
  const root = await navigator.storage.getDirectory();
  try {
    await root.removeEntry(ROOT_DIR, { recursive: true });
  } catch (error) {
    if ((error as DOMException).name !== 'NotFoundError') throw error;
  }
}
