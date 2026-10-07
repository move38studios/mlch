// Electron main process. Adapted from node-banana (MIT, © William Falloon).
//
// Starts the Next server in a utility process on loopback, opens one window
// on it, and answers the few native requests the server and page make
// (folder picker, reveal in Finder, stored keys). Every request to the local
// server carries a per-launch token; the server refuses anything without it.
const { app, BrowserWindow, dialog, ipcMain, Menu, session, shell, systemPreferences, utilityProcess, safeStorage, screen } = require('electron');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCredentialStore } = require('./lib/credentials.cjs');
const { createDiagnostics, createRedactor } = require('./lib/diagnostics.cjs');
const { createBackend } = require('./lib/backend.cjs');
const { atomicWrite } = require('./lib/files.cjs');
const { visibleBounds } = require('./lib/window-state.cjs');
const { createServerMessageHandler } = require('./lib/bridge-main.cjs');

const root = path.resolve(__dirname, '..');
let backend, window, credentialStore, diagnostics;
let quitting = false, starting;
const dev = !app.isPackaged && process.argv.includes('--dev');
const port = Number(process.env.NPKN_ELECTRON_PORT || 47841);
const origin = `http://127.0.0.1:${port}`;
const token = randomBytes(32).toString('hex');
const redactor = createRedactor();
redactor.add([token]);

app.setName('npkn');
app.setPath('userData', process.env.NPKN_ELECTRON_USER_DATA || path.join(app.getPath('appData'), 'npkn'));

function validCaller(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return false;
  try { return new URL(event.senderFrame.url).origin === origin; } catch { return false; }
}
function log(error) { diagnostics?.write('main', error?.stack || error?.message || String(error)); }
async function openLogs() { await shell.openPath(app.getPath('logs')); }
function message(options) { return window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options); }
async function fail(error) {
  if (quitting) return;
  log(error);
  const { response } = await message({ type: 'error', title: 'npkn could not start', message: redactor.redact(error.message || error), buttons: ['Open Logs', 'Quit'], cancelId: 1 });
  if (response === 0) await openLogs();
  app.quit();
}
function documentsDir() { try { return app.getPath('documents'); } catch { return path.join(os.homedir(), 'Documents'); } }
function libraryDir() {
  if (process.env.NPKN_LIBRARY) return path.resolve(process.env.NPKN_LIBRARY);
  if (process.env.NPKN_ELECTRON_USER_DATA) return path.join(app.getPath('userData'), 'napkins');
  return path.join(documentsDir(), 'npkn');
}
function openExternal(url) { if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(log); }
function allowedPermission(contents, permission, requestingURL) {
  if (!contents || contents !== window?.webContents) return false;
  try { if (new URL(requestingURL).origin !== origin) return false; } catch { return false; }
  // `media` is the microphone (the page never asks for the camera).
  return ['clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'media'].includes(permission);
}
function sendStatus() { window?.webContents.send('desktop:backend-status', !!backend?.online()); }
// The server reads keys from memory; they never travel through the page.
function postCredentials() {
  try { backend?.post({ type: 'credentials', values: credentialStore.read() }); } catch (error) { log(error); }
}

async function startWithRetry() {
  if (starting) return starting;
  starting = (async () => {
    while (!quitting) {
      try {
        await backend.start();
        backend.post({ type: 'secrets', values: redactor.values() });
        postCredentials();
        sendStatus();
        return true;
      } catch (error) {
        log(error); sendStatus();
        const occupied = error.code === 'EADDRINUSE';
        const { response } = await message({ type: 'error', title: 'npkn local server',
          message: occupied ? `Port ${port} is in use by another process.` : 'The local server could not start.',
          detail: occupied ? 'Close the other app using this port, then choose Retry.' : redactor.redact(error.message),
          buttons: ['Retry', 'Open Logs', 'Quit'], defaultId: 0, cancelId: 2 });
        if (response === 1) { await openLogs(); continue; }
        if (response === 2) { app.quit(); return false; }
      }
    }
    return false;
  })().finally(() => { starting = undefined; });
  return starting;
}

async function disconnected(code) {
  sendStatus(); log(`Backend exited ${code}`);
  if (quitting || !window) return;
  const { response } = await message({ type: 'warning', title: 'npkn server stopped',
    message: 'The local server stopped.',
    buttons: ['Restart Server', 'Open Logs', 'Close'], defaultId: 0, cancelId: 2 });
  if (response === 0) await startWithRetry();
  if (response === 1) await openLogs();
}

async function createWindow() {
  if (window) return;
  const stateFile = path.join(app.getPath('userData'), 'window-v1.json');
  let saved;
  try { saved = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
  const bounds = visibleBounds(saved?.bounds, screen.getAllDisplays(), screen.getPrimaryDisplay());
  window = new BrowserWindow({ title: 'npkn', ...bounds,
    minWidth: Math.min(800, bounds.width), minHeight: Math.min(560, bounds.height), backgroundColor: '#f6f4ef', show: false,
    titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 14 },
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'preload.cjs') },
  });
  const current = window;
  let saveTimer;
  const saveBounds = () => {
    clearTimeout(saveTimer);
    if (current.isDestroyed() || current.isFullScreen()) return;
    try { atomicWrite(stateFile, JSON.stringify({ version: 1, bounds: current.getNormalBounds(), maximized: current.isMaximized() })); } catch (error) { log(error); }
  };
  for (const event of ['resize', 'move', 'maximize', 'unmaximize']) current.on(event, () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveBounds, 300); });
  current.on('close', saveBounds);
  if (saved?.maximized) current.maximize();
  current.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  current.webContents.on('will-navigate', (event, url) => {
    try { if (new URL(url).origin === origin) return; } catch {}
    event.preventDefault(); openExternal(url);
  });
  current.webContents.on('will-attach-webview', event => event.preventDefault());
  current.webContents.on('render-process-gone', async (_event, details) => {
    log(`Renderer stopped: ${details.reason}`);
    if (quitting) return;
    const { response } = await message({ type: 'error', title: 'npkn window stopped', message: 'The window stopped unexpectedly. Napkins are saved on disk.', buttons: ['Reload', 'Open Logs', 'Quit'], cancelId: 2 });
    if (response === 1) { await openLogs(); return; }
    if (response === 2) { app.quit(); return; }
    if (!backend.online() && !await startWithRetry()) return;
    current.reload();
  });
  current.once('ready-to-show', () => current.show());
  current.webContents.on('did-finish-load', sendStatus);
  current.on('closed', () => { clearTimeout(saveTimer); window = undefined; });
  await current.loadURL(origin);
}

function guarded(handler) {
  return async (event, ...args) => {
    if (!validCaller(event)) throw new Error('Unauthorized desktop request');
    return handler(...args);
  };
}

function registerBridge() {
  // The page learns which keys are set, never their values.
  const credentialStatus = () => Object.fromEntries(Object.entries(credentialStore.read()).map(([name, value]) => [name, typeof value === 'string' && value.length > 0]));
  const credentialCall = fn => guarded(async value => {
    try { const result = fn(value); postCredentials(); return { ok: true, value: result }; }
    catch (error) { log(error); return { ok: false, error: error.message }; }
  });
  ipcMain.handle('desktop:credentials:status', credentialCall(() => credentialStatus()));
  ipcMain.handle('desktop:credentials:write', credentialCall(value => { credentialStore.write(value); return credentialStatus(); }));
  ipcMain.handle('desktop:credentials:delete', credentialCall(name => { credentialStore.delete(name); return credentialStatus(); }));
  ipcMain.handle('desktop:backend-state', guarded(() => backend.online()));
  ipcMain.handle('desktop:restart-backend', guarded(() => startWithRetry()));
  ipcMain.handle('desktop:open-logs', guarded(() => openLogs()));
  ipcMain.handle('desktop:microphone-access', guarded(async () => {
    // Automated runs feed a fake microphone and must not raise the system prompt.
    if (process.platform !== 'darwin' || (!app.isPackaged && process.env.NPKN_FAKE_MIC === '1')) return true;
    if (systemPreferences.getMediaAccessStatus('microphone') === 'granted') return true;
    return systemPreferences.askForMediaAccess('microphone');
  }));
}

function buildMenu() {
  return Menu.buildFromTemplate([
    { role: 'appMenu' },
    { label: 'File', submenu: [{ role: 'close' }] },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    { label: 'Help', submenu: [
      { label: 'Open Logs', click: () => void openLogs() },
      { label: 'Restart Local Server', click: () => void startWithRetry() },
    ] },
  ]);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  registerBridge();
  app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.show(); window?.focus(); });
  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => backend?.kill());
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('activate', () => { if (!window && backend?.online()) createWindow().catch(fail); });
  process.on('uncaughtException', error => { void fail(error); });
  process.on('unhandledRejection', log);
  app.whenReady().then(async () => {
    diagnostics = createDiagnostics(app.getPath('logs'), redactor);
    credentialStore = createCredentialStore(app.getPath('userData'), safeStorage, values => {
      redactor.add(values); backend?.post({ type: 'secrets', values });
    });
    const serverMessage = createServerMessageHandler({ shell, dialog, fs, getWindow: () => window, log });
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('NPKN_ELECTRON_PORT must be a port number between 1 and 65535.');
    backend = createBackend({ fork: (...args) => utilityProcess.fork(...args),
      entry: path.join(__dirname, 'server.cjs'), diagnostics, onDisconnected: disconnected,
      options: () => ({ cwd: root, serviceName: 'npkn Server', stdio: 'pipe', env: {
        ...process.env,
        NODE_ENV: dev ? 'development' : 'production', NPKN_ELECTRON: '1',
        NPKN_ELECTRON_PORT: String(port), NPKN_ELECTRON_TOKEN: token,
        NPKN_LIBRARY: libraryDir(),
      } }),
      onMessage: async (msg, child) => {
        const reply = await serverMessage(msg);
        if (!reply) return;
        try { child.postMessage(reply); } catch (error) { log(error); }
      },
    });
    const localURLs = [`${origin}/*`, `${origin.replace('http:', 'ws:')}/*`];
    session.defaultSession.webRequest.onBeforeSendHeaders({ urls: localURLs }, (details, callback) => {
      callback({ requestHeaders: { ...details.requestHeaders, 'X-Npkn-Desktop': token } });
    });
    session.defaultSession.setPermissionCheckHandler(allowedPermission);
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => callback(allowedPermission(contents, permission, details.requestingUrl)));
    Menu.setApplicationMenu(buildMenu());
    if (await startWithRetry()) await createWindow();
  }).catch(fail);
}
