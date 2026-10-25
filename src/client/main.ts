declare const FLUXA_VERSION: string; // replaced from package.json by the browser bundler
import { FluxaApp } from './app.js';
import { FluxaUI } from './ui.js';

declare global {
  interface Window {
    __fluxa?: {
      identity: () => { deviceId: string; fingerprint: string; name: string; platform: string } | null;
      snapshot: () => unknown;
      transfers: () => { id: string; role: string; state: string; error: string | null; files: { name: string; size: number }[] }[];
      received: () => { transferId: string; name: string; size: number; sha256: string }[];
      pairCode: () => string | null;
      version: string;
    };
  }
}

async function boot(): Promise<void> {
  const root = document.getElementById('app');
  if (!root) throw new Error('#app is missing');

  const app = new FluxaApp();
  const ui = new FluxaUI(app, root);
  ui.mount();

  try {
    const reduced = localStorage.getItem('fluxa:reduced-motion');
    if (reduced) document.documentElement.dataset.reducedMotion = reduced;
  } catch {
    /* private mode without storage: fall back to the OS-level preference */
  }

  try {
    await app.init();
  } catch (err) {
    const message = document.createElement('div');
    message.className = 'fatal';
    message.textContent = `Fluxa could not start: ${(err as Error).message}`;
    document.body.append(message);
    return;
  }

  // Debug/automation surface. Read-only: it cannot inject files or bypass verification.
  window.__fluxa = {
    version: FLUXA_VERSION,
    identity: () => {
      const id = app.identity;
      return id ? { deviceId: id.deviceId, fingerprint: id.fingerprint, name: id.name, platform: id.platform } : null;
    },
    snapshot: () => app.snapshot(),
    transfers: () =>
      app.snapshot().transfers.map((t) => ({
        id: t.id,
        role: t.role,
        state: t.state,
        error: t.error,
        files: t.files.map((f) => ({ name: f.name, size: f.size })),
      })),
    received: () => {
      const snapshot = app.snapshot();
      const out: { transferId: string; name: string; size: number; sha256: string }[] = [];
      for (const transfer of snapshot.transfers) {
        for (const file of app.receivedFiles(transfer.id)) {
          out.push({
            transferId: transfer.id,
            name: file.descriptor.name,
            size: file.size,
            sha256: file.sha256,
          });
        }
      }
      return out;
    },
    pairCode: () => app.snapshot().pairing?.code ?? null,
  };

  // QR/deep links: /?pair=ABC123 claims the code as soon as the device is ready.
  const param = new URL(location.href).searchParams.get('pair');
  if (param && /^[A-Za-z0-9]{6}$/.test(param)) {
    app.joinWithCode(param);
    history.replaceState({}, '', location.pathname);
  }

  // Real Android/iOS project URL schemes let an external camera or share sheet
  // open a short pairing link in the installed app. SAS comparison remains
  // mandatory; opening a URL alone never trusts a device.
  try {
    const { Capacitor } = await import('@capacitor/core');
    if (Capacitor.isNativePlatform()) {
      const { App } = await import('@capacitor/app');
      const claim = (raw: string) => {
        try {
          const url = new URL(raw);
          if (url.protocol !== 'fluxa:' || url.host !== 'pair') return;
          const code = url.searchParams.get('code');
          if (code && /^[A-Za-z0-9]{6}$/.test(code)) app.joinWithCode(code);
        } catch { /* ignore malformed external links */ }
      };
      await App.addListener('appUrlOpen', ({ url }) => claim(url));
      const launch = await App.getLaunchUrl();
      if (launch?.url) claim(launch.url);
    }
  } catch { /* packaged app plugin unavailable; manual pairing still works */ }
}

void boot();
