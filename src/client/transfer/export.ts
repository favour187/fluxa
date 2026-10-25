/** User-selected browser/Chromium directory export. Preserves nested folders,
 * dedupes names without overwriting, and re-hashes the bytes written from the
 * verified receive Blob. Only invoked in direct response to Save.
 */
import { dedupeName, sanitizeRelPath } from '../../shared/filename.js';
import { Sha256 } from '../sha256.js';
import type { ReceivedFile } from './sink.js';

export function directoryPickerAvailable(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext && !navigator.webdriver &&
    typeof (window as Window & { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
}

export async function exportToDirectory(files: ReceivedFile[], root: FileSystemDirectoryHandle): Promise<string[]> {
  const exported: string[] = [];
  for (const file of files) {
    if (!file.blob) throw new Error('Verified file is no longer available');
    const path = sanitizeRelPath(file.descriptor.name, file.descriptor.relPath);
    if (!path || path.relPath !== file.descriptor.relPath || path.name !== file.descriptor.name) throw new Error('Invalid path');
    let dir = root;
    const segments = path.relPath.split('/');
    const name = segments.pop()!;
    for (const segment of segments) dir = await dir.getDirectoryHandle(segment, { create: true });
    const used = new Set<string>();
    let unique = name;
    // create:true by itself silently overwrites; first check for collisions and
    // choose a new name. A racing external filesystem write can still occur.
    for (let n = 0; n < 10_000; n++) {
      try {
        await dir.getFileHandle(unique);
        used.add(unique.toLowerCase());
        unique = dedupeName(name, used);
      } catch (err) {
        if ((err as DOMException).name === 'NotFoundError') break;
        throw err;
      }
    }
    const handle = await dir.getFileHandle(unique, { create: true });
    const writable = await handle.createWritable({ keepExistingData: false });
    const reader = file.blob.stream().getReader();
    let bytes = 0;
    const digest = new Sha256();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        await writable.write(value as unknown as BufferSource);
        digest.update(value);
        bytes += value.byteLength;
      }
      if (bytes !== file.size || digest.digestHex() !== file.sha256) throw new Error(`Export SHA-256 failed for ${path.relPath}`);
      await writable.close();
      exported.push([...segments, unique].join('/'));
    } catch (error) {
      await writable.abort().catch(() => undefined);
      await dir.removeEntry(unique).catch(() => undefined);
      throw error;
    } finally { reader.releaseLock(); }
  }
  return exported;
}
