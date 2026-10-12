// Adapted from node-banana (MIT, © William Falloon).
const { contextBridge, ipcRenderer } = require('electron');

// Narrow capabilities; never expose the IPC transport. Types: src/lib/desktop/client.ts.
contextBridge.exposeInMainWorld('mlchDesktop', {
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
  showWindow: () => ipcRenderer.invoke('desktop:show-window'),
  /** The call being listened to ({ mulchId }) or null, for the menu bar. */
  setCallState: (state) => ipcRenderer.invoke('desktop:call-state', state),
  /** Open at login: read it, or set it with a boolean. */
  openAtLogin: (value) => ipcRenderer.invoke('desktop:login-item', value),
  onMenu: (callback) => {
    const listener = (_event, command) => callback(command);
    ipcRenderer.on('desktop:menu', listener);
    return () => ipcRenderer.removeListener('desktop:menu', listener);
  },
  credentials: {
    status: () => ipcRenderer.invoke('desktop:credentials:status'),
    write: (value) => ipcRenderer.invoke('desktop:credentials:write', value),
    delete: (name) => ipcRenderer.invoke('desktop:credentials:delete', name),
  },
});

window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.dataset.desktopPlatform = process.platform;
});
