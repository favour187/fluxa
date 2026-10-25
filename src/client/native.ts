/** Capacitor Android/iOS adapter. Unlike the old blob.arrayBuffer() + base64
 * implementation, this reads and writes at most 64 KiB at a time. A random
 * export directory per user action avoids implicit overwrites and preserves
 * relative folder paths. The user can then use the OS share sheet / Files app.
 * The verified receive copy remains in OPFS if the platform supports it.
 */
import { randomToken } from '../shared/crypto.js';
import { sanitizeRelPath } from '../shared/filename.js';
import { Sha256 } from './sha256.js';

export interface NativeAvailability { available: boolean; platform: string }

interface FilesystemModule {
  Filesystem: {
    writeFile: (options: { path: string; data: string; directory: string; recursive?: boolean }) => Promise<unknown>;
    appendFile: (options: { path: string; data: string; directory: string }) => Promise<unknown>;
    deleteFile: (options: { path: string; directory: string }) => Promise<unknown>;
    getUri: (options: { path: string; directory: string }) => Promise<{ uri: string }>;
  };
  Directory: { Documents: string };
}
interface ShareModule {
  Share: {
    canShare: () => Promise<{ value: boolean }>;
    share: (options: { title?: string; text?: string; url?: string; dialogTitle?: string }) => Promise<unknown>;
  };
}

let capacitor: { isNativePlatform: () => boolean; getPlatform: () => string } | null = null;
async function core() {
  if (capacitor) return capacitor;
  const mod = (await import('@capacitor/core')) as unknown as {
    Capacitor: { isNativePlatform: () => boolean; getPlatform: () => string };
  };
  capacitor = mod.Capacitor;
  return capacitor;
}

export async function nativeAvailability(): Promise<NativeAvailability> {
  try {
    const cap = await core();
    return { available: cap.isNativePlatform(), platform: cap.getPlatform() };
  } catch { return { available: false, platform: 'web' }; }
}

function toBase64(bytes: Uint8Array): string {
  // Chunk size is strictly bounded by the caller: do not concatenate a Blob.
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export interface NativeSaveResult {
  ok: boolean;
  uri?: string;
  path?: string;
  shared?: boolean;
  error?: string;
}

export async function saveFileNative(
  relPath: string, blob: Blob, transferId: string,
  options: { share?: boolean; sha256?: string } = {},
): Promise<NativeSaveResult> {
  let path: string | null = null;
  let module: FilesystemModule | null = null;
  try {
    const cap = await core();
    if (!cap.isNativePlatform()) return { ok: false, error: 'not a native platform' };
    const name = relPath.split('/').at(-1) ?? '';
    const safe = sanitizeRelPath(name, relPath);
    if (!safe || safe.relPath !== relPath || !/^[0-9a-f]{32}$/.test(transferId)) {
      return { ok: false, error: 'invalid export path' };
    }
    module = (await import('@capacitor/filesystem')) as unknown as FilesystemModule;
    const { Filesystem, Directory } = module;
    // Each save action has its own never-before-used directory, even if an older
    // export of the same file is already in Documents. No silent overwrite.
    path = `Fluxa/${transferId}-${randomToken(8)}/${safe.relPath}`;
    const reader = blob.stream().getReader();
    const hasher = new Sha256();
    let written = 0;
    let created = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        for (let at = 0; at < value.byteLength; at += 64 * 1024) {
          const chunk = value.subarray(at, at + 64 * 1024);
          hasher.update(chunk);
          const data = toBase64(chunk);
          if (!created) {
            await Filesystem.writeFile({ path, data, directory: Directory.Documents, recursive: true });
            created = true;
          } else await Filesystem.appendFile({ path, data, directory: Directory.Documents });
          written += chunk.byteLength;
        }
      }
      if (!created) await Filesystem.writeFile({ path, data: '', directory: Directory.Documents, recursive: true });
      if (written !== blob.size || (options.sha256 && options.sha256 !== hasher.digestHex())) {
        throw new Error('Saved file failed size or SHA-256 validation');
      }
    } finally { reader.releaseLock(); }
    const { uri } = await Filesystem.getUri({ path, directory: Directory.Documents });
    let shared = false;
    if (options.share !== false) {
      try {
        const { Share } = (await import('@capacitor/share')) as unknown as ShareModule;
        if ((await Share.canShare()).value) {
          await Share.share({ title: safe.name, url: uri, dialogTitle: `Export ${safe.name}` });
          shared = true;
        }
      } catch { /* no share target or the user cancelled; the file remains in Documents */ }
    }
    return { ok: true, uri, path, shared };
  } catch (error) {
    if (module && path) {
      await module.Filesystem.deleteFile({ path, directory: module.Directory.Documents }).catch(() => undefined);
    }
    return { ok: false, error: (error as Error).message };
  }
}

export async function canShareNatively(): Promise<boolean> {
  try {
    if (!(await core()).isNativePlatform()) return false;
    const { Share } = (await import('@capacitor/share')) as unknown as ShareModule;
    return (await Share.canShare()).value;
  } catch { return false; }
}

export async function shareSavedFile(name: string, uri: string): Promise<boolean> {
  try {
    const { Share } = (await import('@capacitor/share')) as unknown as ShareModule;
    await Share.share({ title: name, url: uri, dialogTitle: `Export ${name}` });
    return true;
  } catch { return false; }
}
