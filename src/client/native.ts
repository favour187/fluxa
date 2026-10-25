/**
 * Native (Android) file handling.
 *
 * Inside the Capacitor WebView an anchor download does nothing, so a received
 * file used to exist only in the app's memory: "Save" was a no-op. Here the bytes
 * are written through the native filesystem plugin into the app's Documents
 * directory (no storage permission needed on any supported API level), and then
 * handed to the Android share sheet so they can go straight into another app.
 *
 * Kept in its own module and imported lazily so the browser and desktop bundles
 * never pay for the Capacitor plugins.
 */

export interface NativeAvailability {
  available: boolean;
  platform: string;
}

interface FilesystemModule {
  Filesystem: {
    writeFile: (options: {
      path: string;
      data: string;
      directory: string;
      recursive?: boolean;
    }) => Promise<{ uri: string }>;
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
  } catch {
    return { available: false, platform: 'web' };
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Filesystem-safe name: no separators, no traversal, no control characters. */
function safeName(name: string): string {
  const cleaned = name
    .replace(/[/\\]/g, '_')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/^\.+/, '')
    .trim();
  return cleaned.slice(0, 120) || 'fluxa-file';
}

export interface NativeSaveResult {
  ok: boolean;
  uri?: string;
  path?: string;
  shared?: boolean;
  error?: string;
}

/**
 * Writes the file into the app's Documents directory and offers it to the share
 * sheet. Returns the URI so the UI can tell the user exactly where it went.
 */
export async function saveFileNative(
  name: string,
  blob: Blob,
  options: { share?: boolean } = {},
): Promise<NativeSaveResult> {
  try {
    const [{ Filesystem, Directory }, cap] = await Promise.all([
      import('@capacitor/filesystem') as unknown as Promise<FilesystemModule>,
      core(),
    ]);
    if (!cap.isNativePlatform()) return { ok: false, error: 'not a native platform' };

    const path = safeName(name);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await Filesystem.writeFile({
      path,
      data: toBase64(bytes),
      directory: Directory.Documents,
      recursive: true,
    });
    const { uri } = await Filesystem.getUri({ path, directory: Directory.Documents });

    let shared = false;
    if (options.share !== false) {
      try {
        const { Share } = (await import('@capacitor/share')) as unknown as ShareModule;
        const can = await Share.canShare();
        if (can.value) {
          await Share.share({ title: name, url: uri, dialogTitle: `Share ${name}` });
          shared = true;
        }
      } catch {
        /* no share target installed — the file is still on disk */
      }
    }
    return { ok: true, uri, path, shared };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/** Lets the UI decide whether to show a "Share" affordance. */
export async function canShareNatively(): Promise<boolean> {
  try {
    const cap = await core();
    if (!cap.isNativePlatform()) return false;
    const { Share } = (await import('@capacitor/share')) as unknown as ShareModule;
    return (await Share.canShare()).value;
  } catch {
    return false;
  }
}

/** Opens the OS share sheet for an already-saved file. */
export async function shareSavedFile(name: string, uri: string): Promise<boolean> {
  try {
    const { Share } = (await import('@capacitor/share')) as unknown as ShareModule;
    await Share.share({ title: name, url: uri, dialogTitle: `Share ${name}` });
    return true;
  } catch {
    return false;
  }
}
