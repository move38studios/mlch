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
  chooseLibrary: () => ipcRenderer.invoke('desktop:library:choose'),
  microphoneAccess: () => ipcRenderer.invoke('desktop:microphone-access'),
  showWindow: () => ipcRenderer.invoke('desktop:show-window'),
  /** The call being listened to ({ mulchId }) or null, for the menu bar. */
  setCallState: (state) => ipcRenderer.invoke('desktop:call-state', state),
  /** Open at login: read it, or set it with a boolean. */
  openAtLogin: (value) => ipcRenderer.invoke('desktop:login-item', value),
  capture: (rect) => ipcRenderer.invoke('desktop:capture', rect),
  onMenu: (callback) => {
    const listener = (_event, command) => callback(command);
    ipcRenderer.on('desktop:menu', listener);
    return () => ipcRenderer.removeListener('desktop:menu', listener);
  },
  updates: {
    state: () => ipcRenderer.invoke('desktop:update:state'),
    check: () => ipcRenderer.invoke('desktop:update:check'),
    restart: () => ipcRenderer.invoke('desktop:update:restart'),
    download: () => ipcRenderer.invoke('desktop:update:download'),
    setPrefs: (patch) => ipcRenderer.invoke('desktop:update:prefs', patch),
    setChannel: (channel) => ipcRenderer.invoke('desktop:update:channel', channel),
    seen: () => ipcRenderer.invoke('desktop:update:seen'),
    onChange: (callback) => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on('desktop:update', listener);
      return () => ipcRenderer.removeListener('desktop:update', listener);
    },
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
