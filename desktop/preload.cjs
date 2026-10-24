/**
 * Preload bridge — the only surface the renderer gets.
 *
 * Deliberately tiny: discovery data, notifications, native save dialogs and
 * read-only build information. No filesystem, no shell, no arbitrary IPC.
 */
const { contextBridge, ipcRenderer } = require('electron');

const listeners = new Set();

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
  notify: (title, body) => ipcRenderer.invoke('desktop:notify', { title, body }),
  saveDialog: (name) => ipcRenderer.invoke('desktop:save-dialog', { name }),
  saveFile: (filePath, bytes) => ipcRenderer.invoke('desktop:save-file', { filePath, bytes }),
  logLines: () => ipcRenderer.invoke('desktop:log-lines'),
});
