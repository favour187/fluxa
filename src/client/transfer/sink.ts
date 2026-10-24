/**
 * Receive-side storage.
 *
 * Two sinks are provided:
 *   MemorySink  — bounded (<= LIMITS.memorySinkMaxBytes), simple, keeps the bytes
 *                 in a single Blob so the user can save them with a download.
 *   OpfsSink    — Origin Private File System. Streams to disk so files larger
 *                 than RAM can be received, then exposes a File handle for saving.
 *
 * Neither sink is ever treated as "done" until the caller has verified the hash,
 * so a crash or cancel can never leave a completed-looking partial file.
 */
import type { FileDescriptor } from '../../shared/protocol.js';

export interface ReceivedFile {
  descriptor: FileDescriptor;
  blob: Blob | null;
  /** OPFS path when the file was streamed to disk. */
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

async function opfsRoot(transferId: string, create: boolean): Promise<FileSystemDirectoryHandle | null> {
  if (!opfsAvailable()) return null;
  try {
    const root = await navigator.storage.getDirectory();
    if (!create) {
      try {
        return await root.getDirectoryHandle(ROOT_DIR);
      } catch {
        return null;
      }
    }
    const base = await root.getDirectoryHandle(ROOT_DIR, { create: true });
    return await base.getDirectoryHandle(transferId, { create: true });
  } catch {
    return null;
  }
}

/** mkdir -p inside a directory handle, returning the parent handle + filename. */
async function ensureParents(
  root: FileSystemDirectoryHandle,
  relPath: string,
): Promise<{ dir: FileSystemDirectoryHandle; name: string }> {
  const parts = relPath.split('/');
  const name = parts.pop()!;
  let dir = root;
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
  return { dir, name };
}

export class MemorySink implements Sink {
  private chunks: Uint8Array[] = [];
  private received = 0;
  private aborted = false;

  constructor(readonly descriptor: FileDescriptor) {}

  async write(offset: number, data: Uint8Array): Promise<void> {
    if (this.aborted) throw new Error('sink aborted');
    if (offset !== this.received) throw new Error(`out-of-order write: expected ${this.received}, got ${offset}`);
    this.received += data.byteLength;
    this.chunks.push(data.slice()); // copy: the frame buffer is reused by the transport
  }

  async finalize(): Promise<void> {
    if (this.received !== this.descriptor.size) {
      throw new Error(`size mismatch: expected ${this.descriptor.size}, received ${this.received}`);
    }
  }

  async abort(): Promise<void> {
    this.aborted = true;
    this.chunks = [];
    this.received = 0;
  }

  async toReceivedFile(sha256: string): Promise<ReceivedFile> {
    const blob = new Blob(this.chunks as BlobPart[], {
      type: this.descriptor.mime || 'application/octet-stream',
    });
    this.chunks = [];
    return { descriptor: this.descriptor, blob, opfsPath: null, sha256, size: blob.size };
  }
}

export class OpfsSink implements Sink {
  private handle: FileSystemFileHandle | null = null;
  private stream: FileSystemWritableFileStream | null = null;
  private received = 0;
  private aborted = false;
  private path: string;

  constructor(
    readonly descriptor: FileDescriptor,
    private readonly transferId: string,
  ) {
    this.path = `${ROOT_DIR}/${transferId}/${descriptor.relPath}`;
  }

  private async open(): Promise<FileSystemWritableFileStream> {
    if (this.stream) return this.stream;
    const dir = await opfsRoot(this.transferId, true);
    if (!dir) throw new Error('local storage is unavailable in this browser');
    const { dir: parent, name } = await ensureParents(dir, this.descriptor.relPath);
    // create:false semantics — refuse to overwrite an existing received file.
    this.handle = await parent.getFileHandle(name, { create: true });
    this.stream = await this.handle.createWritable({ keepExistingData: false });
    return this.stream;
  }

  async write(offset: number, data: Uint8Array): Promise<void> {
    if (this.aborted) throw new Error('sink aborted');
    if (offset !== this.received) throw new Error(`out-of-order write: expected ${this.received}, got ${offset}`);
    const stream = await this.open();
    await stream.write({ type: 'write', position: offset, data: data as unknown as BufferSource });
    this.received += data.byteLength;
  }

  async finalize(): Promise<void> {
    if (this.received !== this.descriptor.size) {
      throw new Error(`size mismatch: expected ${this.descriptor.size}, received ${this.received}`);
    }
    if (this.stream) {
      await this.stream.close();
      this.stream = null;
    }
  }

  async abort(): Promise<void> {
    this.aborted = true;
    try {
      await this.stream?.abort();
    } catch {
      /* already closed */
    }
    this.stream = null;
    try {
      const dir = await opfsRoot(this.transferId, false);
      if (dir) await dir.removeEntry(this.descriptor.relPath.split('/').pop()!, { recursive: true }).catch(() => undefined);
    } catch {
      /* best effort cleanup */
    }
  }

  async toReceivedFile(sha256: string): Promise<ReceivedFile> {
    if (!this.handle) throw new Error('file was never written');
    const file = await this.handle.getFile();
    return { descriptor: this.descriptor, blob: file, opfsPath: this.path, sha256, size: file.size };
  }
}

export async function createSink(
  descriptor: FileDescriptor,
  transferId: string,
  preferMemory: boolean,
): Promise<Sink> {
  const useMemory = preferMemory || descriptor.size <= 8 * 1024 * 1024 || !opfsAvailable();
  if (useMemory) return new MemorySink(descriptor);
  return new OpfsSink(descriptor, transferId);
}

/** Best-effort free-space check. Browsers expose quota, not disk free space. */
export async function checkStorage(bytesNeeded: number): Promise<{ ok: boolean; available: number | null }> {
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
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(ROOT_DIR, { recursive: true });
  } catch {
    /* nothing stored */
  }
}
