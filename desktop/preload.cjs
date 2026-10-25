/**
 * Preload bridge — the only surface the renderer gets.
 *
 * Deliberately tiny: discovery data, notifications, native save dialogs and
 * read-only build information. No filesystem, no shell, no arbitrary IPC.
 */
const { contextBridge, ipcRenderer } = require('electron');

const listeners = new Set();
const handoffListeners = new Set();

ipcRenderer.on('desktop:handoff', (_event, draft) => {
  for (const listener of handoffListeners) {
    try { listener(draft); } catch { /* no external URL can break the bridge */ }
  }
});

ipcRenderer.on('desktop:nearby', (_event, peers) => {
  for (const listener of listeners) {
    try {
      listener(peers);
    } catch {
      /* a renderer listener threw; never let it break discovery */
    }
  }
});

contextBridge.exposeInMainWorld('fluxaDesktop', {
  isDesktop: true,
  info: () => ipcRenderer.invoke('desktop:info'),
  setIdentity: (identity) => ipcRenderer.invoke('desktop:identity', identity),
  nearby: () => ipcRenderer.invoke('desktop:nearby-list'),
  onNearby: (callback) => {
    listeners.add(callback);
    void ipcRenderer.invoke('desktop:nearby-list').then((peers) => {
      if (listeners.has(callback)) callback(peers);
    });
    return () => listeners.delete(callback);
  },
  onHandoff: (callback) => {
    handoffListeners.add(callback);
    void ipcRenderer.invoke('desktop:handoff-pending').then((drafts) => {
      if (handoffListeners.has(callback)) for (const draft of drafts) callback(draft);
    });
    return () => handoffListeners.delete(callback);
  },
  notify: (title, body) => ipcRenderer.invoke('desktop:notify', { title, body }),
  clipboardConsent: (enabled) => ipcRenderer.invoke('desktop:clipboard-consent', { enabled }),
  clipboardRead: () => ipcRenderer.invoke('desktop:clipboard-read'),
  clipboardWrite: (text) => ipcRenderer.invoke('desktop:clipboard-write', { text }),
  saveDialog: (name) => ipcRenderer.invoke('desktop:save-dialog', { name }),
  beginSave: (filePath, size) => ipcRenderer.invoke('desktop:save-begin', { filePath, size }),
  writeSave: (token, offset, bytes) => ipcRenderer.invoke('desktop:save-chunk', { token, offset, bytes }),
  commitSave: (token, sha256) => ipcRenderer.invoke('desktop:save-commit', { token, sha256 }),
  abortSave: (token) => ipcRenderer.invoke('desktop:save-abort', token),
  saveFile: (filePath, bytes) => ipcRenderer.invoke('desktop:save-file', { filePath, bytes }),
  logLines: () => ipcRenderer.invoke('desktop:log-lines'),
});
