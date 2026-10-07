// Adapted from node-banana (MIT, © William Falloon).
const { contextBridge, ipcRenderer } = require('electron');

// Narrow capabilities; never expose the IPC transport. Types: src/lib/desktop/client.ts.
contextBridge.exposeInMainWorld('npknDesktop', {
  platform: process.platform,
  backend: {
    state: () => ipcRenderer.invoke('desktop:backend-state'),
    restart: () => ipcRenderer.invoke('desktop:restart-backend'),
    onStatus: (callback) => {
      const listener = (_event, online) => callback(online);
      ipcRenderer.on('desktop:backend-status', listener);
      return () => ipcRenderer.removeListener('desktop:backend-status', listener);
    },
  },
  openLogs: () => ipcRenderer.invoke('desktop:open-logs'),
  microphoneAccess: () => ipcRenderer.invoke('desktop:microphone-access'),
  credentials: {
    status: () => ipcRenderer.invoke('desktop:credentials:status'),
    write: (value) => ipcRenderer.invoke('desktop:credentials:write', value),
    delete: (name) => ipcRenderer.invoke('desktop:credentials:delete', name),
  },
});

window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.dataset.desktopPlatform = process.platform;
});
