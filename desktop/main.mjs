/**
 * Fluxa Desktop — Electron main process.
 *
 * The desktop app is a genuine shell around the same verified transfer engine the
 * browser build uses, plus capabilities a web page cannot have:
 *
 *  - an embedded signalling server, so two Fluxa devices on the same network can
 *    pair with no external infrastructure at all
 *  - mDNS discovery (`_fluxa._tcp`) so nearby devices appear without typing URLs
 *  - native notifications and native save dialogs
 *
 * Security posture: context isolation on, node integration off, sandbox on, a
 * narrow preload bridge, navigation locked to the local origin, and every
 * external link handed to the OS browser.
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, screen, shell } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bonjour } from 'bonjour-service';
import { startServer } from '../dist/server/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..');

/* ------------------------------------------------------------------ *
 * CLI switches (used by tests and by people running two instances)
 * ------------------------------------------------------------------ */
const argv = process.argv.slice(1);
const flag = (name) => {
  const withEquals = argv.find((a) => a.startsWith(`--${name}=`));
  if (withEquals) return withEquals.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};

// electron-builder sets productName at package time; do it here too so the dev
// run, the menus and the notifications all say "Fluxa".
app.setName('Fluxa');

const userDataDir = flag('fluxa-user-data');
if (userDataDir) app.setPath('userData', path.resolve(userDataDir));
const forcedPort = Number(flag('fluxa-port') ?? 0) || 0;
const externalSignalUrl = flag('fluxa-signal-url') ?? process.env.FLUXA_SIGNAL_URL ?? '';
const headlessGuard = Boolean(flag('fluxa-test'));

/**
 * Small persisted UI state (window bounds). Stored next to the app's other data
 * so a window the user resized to fit their screen stays that way.
 */
const preferences = loadPreferences();

function preferencesPath() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadPreferences() {
  try {
    return JSON.parse(readFileSync(preferencesPath(), 'utf8'));
  } catch {
    return {};
  }
}

function savePreferences() {
  try {
    mkdirSync(path.dirname(preferencesPath()), { recursive: true });
    writeFileSync(preferencesPath(), JSON.stringify(preferences, null, 2));
  } catch {
    /* a read-only profile must not break the app */
  }
}

let mainWindow = null;
let signalling = null;
let localUrl = '';
let bonjour = null;
let published = null;
let nearby = new Map();
const logLines = [];

function log(...args) {
  const line = `${new Date().toISOString()} ${args.join(' ')}`;
  logLines.push(line);
  if (logLines.length > 500) logLines.shift();
  if (!app.isPackaged) console.log(line);
}

/* ------------------------------------------------------------------ *
 * Embedded signalling + static server
 * ------------------------------------------------------------------ */
async function startEmbeddedServer() {
  const attempt = async (port) =>
    startServer({
      port,
      host: forcedPort || port === 0 ? '127.0.0.1' : '0.0.0.0',
      publicUrl: null,
      log: (line) => log(`[server] ${line}`),
    });

  // Prefer the well-known port so two instances and the browser build can pair
  // against one process; fall back to an ephemeral port if it is taken.
  for (const port of forcedPort ? [forcedPort] : [8787, 0]) {
    try {
      signalling = await attempt(port);
      localUrl = `http://127.0.0.1:${signalling.port}`;
      log(`embedded signalling server listening on ${localUrl}`);
      return;
    } catch (err) {
      log(`port ${port} unavailable: ${err.message}`);
    }
  }
  throw new Error('could not start the embedded signalling server');
}

/* ------------------------------------------------------------------ *
 * mDNS discovery
 * ------------------------------------------------------------------ */
function startDiscovery() {
  try {
    bonjour = new Bonjour();
    bonjour.find({ type: 'fluxa' }, (service) => {
      if (!service.host || service.port === signalling?.port) {
        // Our own advertisement (or a duplicate) — ignore it.
        if (service.txt?.instance === instanceId) return;
      }
      const entry = {
        instanceId: service.txt?.instance ?? service.fqdn,
        name: service.txt?.name ?? service.name ?? service.host,
        platform: service.txt?.platform ?? 'desktop',
        host: service.referer?.address ?? service.host,
        port: service.port,
        url: `ws://${service.referer?.address ?? service.host}:${service.port}/ws`,
        version: service.txt?.version ?? '',
        seenAt: Date.now(),
      };
      nearby.set(entry.instanceId, entry);
      broadcastNearby();
    });
    bonjour.on('down', (service) => {
      if (service.type !== 'fluxa') return;
      const id = service.txt?.instance;
      if (id && nearby.delete(id)) broadcastNearby();
    });
    setInterval(() => {
      const cutoff = Date.now() - 60_000;
      let changed = false;
      for (const [id, peer] of nearby) {
        if (peer.seenAt < cutoff) {
          nearby.delete(id);
          changed = true;
        }
      }
      if (changed) broadcastNearby();
    }, 15_000).unref?.();
    log('mDNS discovery started');
  } catch (err) {
    log(`mDNS unavailable: ${err.message}`);
  }
}

const instanceId = `fluxa-${Math.random().toString(36).slice(2, 10)}`;

function publishAdvertisement({ name, deviceId, platform, version }) {
  if (!bonjour) return;
  try {
    published?.stop?.();
    published = bonjour.publish({
      name: `${name} (${platform || 'desktop'})`.slice(0, 60),
      type: 'fluxa',
      port: signalling?.port ?? 0,
      txt: {
        instance: instanceId,
        name: name ?? 'Fluxa device',
        deviceId: deviceId ?? '',
        platform: platform ?? 'desktop',
        version: version ?? '',
      },
    });
    log(`advertising as ${name} on port ${signalling?.port}`);
  } catch (err) {
    log(`could not advertise: ${err.message}`);
  }
}

function broadcastNearby() {
  const list = [...nearby.values()].filter((peer) => peer.instanceId !== instanceId);
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('desktop:nearby', list);
  }
}

/* ------------------------------------------------------------------ *
 * Window
 * ------------------------------------------------------------------ */
function createWindow() {
  // Fit the window to the display instead of assuming a large screen: on a small
  // laptop a 1280×860 window opened taller than the screen, which is why the app
  // looked oversized. Remember whatever size the user settles on.
  const work = screen.getPrimaryDisplay().workAreaSize;
  const saved = preferences.window;
  const width = Math.min(saved?.width ?? 1280, work.width);
  const height = Math.min(saved?.height ?? 860, work.height);
  mainWindow = new BrowserWindow({
    width,
    height,
    x: saved?.x,
    y: saved?.y,
    minWidth: Math.min(420, work.width),
    minHeight: Math.min(420, work.height),
    useContentSize: true,
    backgroundColor: '#06070c',
    show: false,
    title: 'Fluxa',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webSecurity: true,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  const rememberBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
    preferences.window = { ...mainWindow.getNormalBounds(), maximized: mainWindow.isMaximized() };
    savePreferences();
  };
  mainWindow.on('resized', rememberBounds);
  mainWindow.on('moved', rememberBounds);
  mainWindow.on('maximize', rememberBounds);
  mainWindow.on('unmaximize', rememberBounds);
  if (saved?.maximized) mainWindow.maximize();
  mainWindow.loadURL(localUrl);

  // Keep the renderer on the local origin; anything else goes to the real browser.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(localUrl)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log(`renderer gone: ${details.reason}`);
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function buildMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Copy this device’s address',
          click: () => {
            const { clipboard } = require('electron');
            const address = signalling?.port ? `${localUrl}` : '';
            clipboard.writeText(address);
          },
        },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      role: 'help',
      submenu: [
        { label: 'Fluxa documentation', click: () => void shell.openExternal('https://github.com/favour187/fluxa') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------------------------------------------ *
 * IPC
 * ------------------------------------------------------------------ */
ipcMain.handle('desktop:info', () => ({
  version: app.getVersion(),
  platform: process.platform,
  arch: process.arch,
  localUrl,
  serverPort: signalling?.port ?? null,
  signalUrl: externalSignalUrl || null,
  isPackaged: app.isPackaged,
  instanceId,
}));

ipcMain.handle('desktop:identity', (_event, identity) => {
  if (!identity || typeof identity !== 'object') return { ok: false };
  publishAdvertisement({
    name: String(identity.name ?? 'Fluxa device').slice(0, 48),
    deviceId: String(identity.deviceId ?? ''),
    platform: String(identity.platform ?? 'desktop').slice(0, 24),
    version: app.getVersion(),
  });
  return { ok: true };
});

ipcMain.handle('desktop:nearby-list', () => [...nearby.values()].filter((p) => p.instanceId !== instanceId));

ipcMain.handle('desktop:notify', (_event, { title, body } = {}) => {
  if (!Notification.isSupported()) return { ok: false };
  new Notification({ title: String(title ?? 'Fluxa'), body: String(body ?? '') }).show();
  return { ok: true };
});

ipcMain.handle('desktop:save-dialog', async (_event, { name } = {}) => {
  const result = await dialog.showSaveDialog({ defaultPath: String(name ?? 'fluxa-download') });
  if (!result.canceled && result.filePath) grantedPaths.add(result.filePath);
  return { canceled: result.canceled, filePath: result.filePath ?? null };
});

ipcMain.handle('desktop:log-lines', () => logLines.slice(-200));

/**
 * Writes received bytes to the path the user chose in the native dialog.
 * The renderer never picks the path itself: it must be one this process just
 * returned, and the payload is a plain transferable ArrayBuffer.
 */
const grantedPaths = new Set();

ipcMain.handle('desktop:save-file', async (_event, { filePath, bytes } = {}) => {
  const target = typeof filePath === 'string' ? filePath : '';
  if (!target || !grantedPaths.has(target)) return { ok: false, error: 'path not granted' };
  if (!(bytes instanceof Uint8Array) && !ArrayBuffer.isView(bytes)) return { ok: false, error: 'no bytes' };
  try {
    await writeFile(target, Buffer.from(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength ?? undefined));
    grantedPaths.delete(target);
    log(`saved ${target}`);
    return { ok: true, filePath: target, bytes: bytes.byteLength ?? 0 };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      await startEmbeddedServer();
      createWindow();
      startDiscovery();
      buildMenu();
      if (headlessGuard) log('test mode');
    } catch (err) {
      log(`fatal: ${err.message}`);
      dialog.showErrorBox('Fluxa could not start', String(err.message));
      app.quit();
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
  });
  app.on('before-quit', () => {
    try {
      published?.stop?.();
      bonjour?.destroy?.();
      void signalling?.close?.();
    } catch {
      /* shutting down */
    }
  });
}
