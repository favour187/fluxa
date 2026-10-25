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
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, Notification, screen, shell } from 'electron';
import { constants, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, link, copyFile, unlink } from 'node:fs/promises';
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
      // Mobile WebViews have a packaged localhost origin, not this LAN host.
      // Same-origin browser requests are still admitted by the server.
      allowedOrigins: ['https://localhost', 'http://localhost', 'capacitor://localhost'],
      allowLanOrigins: true, // a second private-LAN desktop instance has a different origin/port
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
    if (new URL(url).origin !== new URL(localUrl).origin) {
      event.preventDefault();
      if (/^https?:/.test(url)) void shell.openExternal(url);
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

/** The renderer cannot choose an arbitrary filesystem target. A one-use
 * capability is granted ONLY after the OS save dialog returns a path. Writes go
 * to a 0600 sibling .part file, fsync, hash-check, then atomic link (exclusive)
 * to the chosen name. COPYFILE_EXCL is a fallback on filesystems without links.
 */
const grantedPaths = new Set();
const openSaves = new Map();
const MAX_SAVE_CHUNK = 256 * 1024;
const MAX_SAVE_BYTES = 64 * 1024 * 1024 * 1024;

async function beginSave(filePath, expectedSize) {
  if (typeof filePath !== 'string' || !grantedPaths.delete(filePath)) throw new Error('destination was not selected by the user');
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > MAX_SAVE_BYTES) throw new Error('invalid save size');
  if (openSaves.size >= 4) throw new Error('too many files being exported');
  const token = randomBytes(16).toString('hex');
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.fluxa-${token}.part`);
  const handle = await open(temporary, 'wx', 0o600);
  openSaves.set(token, { filePath, temporary, handle, expectedSize, written: 0, hash: createHash('sha256'), at: Date.now() });
  return token;
}

async function writeSave(token, offset, bytes) {
  const save = openSaves.get(token);
  if (!save) throw new Error('save capability is not available');
  if (!(bytes instanceof Uint8Array) && !ArrayBuffer.isView(bytes)) throw new Error('invalid save chunk');
  if (!Number.isSafeInteger(offset) || offset !== save.written || !bytes.byteLength || bytes.byteLength > MAX_SAVE_CHUNK ||
      offset + bytes.byteLength > save.expectedSize) throw new Error('save chunk out of bounds');
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let position = 0;
  while (position < buffer.length) {
    const { bytesWritten } = await save.handle.write(buffer, position, buffer.length - position, offset + position);
    if (!bytesWritten) throw new Error('disk write returned zero bytes');
    position += bytesWritten;
  }
  save.hash.update(buffer);
  save.written += buffer.byteLength;
  save.at = Date.now();
  return save.written;
}

async function abandonSave(token) {
  const save = openSaves.get(token);
  if (!save) return;
  openSaves.delete(token);
  await save.handle.close().catch(() => undefined);
  await unlink(save.temporary).catch(() => undefined);
}

async function finishSave(token, expectedHash) {
  const save = openSaves.get(token);
  if (!save) throw new Error('save capability is not available');
  if (!/^[0-9a-f]{64}$/.test(expectedHash) || save.expectedSize !== save.written || save.hash.digest('hex') !== expectedHash) {
    await abandonSave(token);
    throw new Error('exported bytes failed size/SHA-256 verification');
  }
  try {
    await save.handle.sync();
    await save.handle.close();
    try {
      await link(save.temporary, save.filePath); // same directory; atomic, no overwrite
    } catch (error) {
      if (!['EPERM', 'ENOSYS', 'EOPNOTSUPP'].includes(error.code)) throw error;
      await copyFile(save.temporary, save.filePath, constants.COPYFILE_EXCL);
    }
    await unlink(save.temporary).catch(() => undefined);
    openSaves.delete(token);
    return { ok: true, filePath: save.filePath, bytes: save.written };
  } catch (error) {
    await abandonSave(token);
    throw error;
  }
}

ipcMain.handle('desktop:save-begin', async (_event, { filePath, size } = {}) => {
  try { return { ok: true, token: await beginSave(filePath, size) }; }
  catch (error) { return { ok: false, error: error.message }; }
});
ipcMain.handle('desktop:save-chunk', async (_event, { token, offset, bytes } = {}) => {
  try { return { ok: true, bytes: await writeSave(token, offset, bytes) }; }
  catch (error) { await abandonSave(token); return { ok: false, error: error.message }; }
});
ipcMain.handle('desktop:save-commit', async (_event, { token, sha256 } = {}) => {
  try { return await finishSave(token, sha256); }
  catch (error) { return { ok: false, error: error.code === 'EEXIST' ? 'File already exists; choose a new name' : error.message }; }
});
ipcMain.handle('desktop:save-abort', async (_event, token) => {
  await abandonSave(token);
  return { ok: true };
});

// Compatibility bridge for older tests/extensions, bounded to 8 MiB. The app
// itself uses the streaming methods, so a multi-gigabyte save never materialises
// as one renderer IPC payload.
ipcMain.handle('desktop:save-file', async (_event, { filePath, bytes } = {}) => {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > 8 * 1024 * 1024) return { ok: false, error: 'use streaming save for large files' };
  let token;
  try {
    token = await beginSave(filePath, bytes.byteLength);
    for (let at = 0; at < bytes.byteLength; at += MAX_SAVE_CHUNK) {
      const chunk = bytes.subarray(at, at + MAX_SAVE_CHUNK);
      await writeSave(token, at, chunk);
    }
    return await finishSave(token, createHash('sha256').update(bytes).digest('hex'));
  } catch (error) {
    if (token) await abandonSave(token);
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
    for (const token of openSaves.keys()) void abandonSave(token);
    try {
      published?.stop?.();
      bonjour?.destroy?.();
      void signalling?.close?.();
    } catch {
      /* shutting down */
    }
  });
}
