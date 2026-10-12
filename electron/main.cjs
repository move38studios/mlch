// Electron main process. Adapted from node-banana (MIT, © William Falloon).
//
// Starts the Next server in a utility process on loopback, opens one window
// on it, and answers the few native requests the server and page make
// (folder picker, reveal in Finder, stored keys). Every request to the local
// server carries a per-launch token; the server refuses anything without it.
const { app, BrowserWindow, crashReporter, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, nativeImage, Notification, session, shell, systemPreferences, utilityProcess, safeStorage, screen, Tray } = require('electron');
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
const { audioHelperPath, createAudioHelper } = require('./lib/audio-helper.cjs');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
let backend, window, credentialStore, diagnostics;
let quitting = false, starting;
const dev = !app.isPackaged && process.argv.includes('--dev');
const port = Number(process.env.MLCH_ELECTRON_PORT || 47841);
const origin = `http://127.0.0.1:${port}`;
const token = randomBytes(32).toString('hex');
const redactor = createRedactor();
redactor.add([token]);

app.setName('mlch');
app.setPath('userData', process.env.MLCH_ELECTRON_USER_DATA || path.join(app.getPath('appData'), 'mlch'));
// Test profiles keep their logs to themselves.
if (process.env.MLCH_ELECTRON_USER_DATA) app.setAppLogsPath(path.join(app.getPath('userData'), 'logs'));
// Crash dumps stay on this machine (in the app's crashDumps folder); nothing is uploaded.
crashReporter.start({ uploadToServer: false });

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
  const { response } = await message({ type: 'error', title: 'mlch could not start', message: redactor.redact(error.message || error), buttons: ['Open Logs', 'Quit'], cancelId: 1 });
  if (response === 0) await openLogs();
  app.quit();
}
function documentsDir() { try { return app.getPath('documents'); } catch { return path.join(os.homedir(), 'Documents'); } }
function libraryDir() {
  if (process.env.MLCH_LIBRARY) return path.resolve(process.env.MLCH_LIBRARY);
  if (process.env.MLCH_ELECTRON_USER_DATA) return path.join(app.getPath('userData'), 'mulches');
  return path.join(documentsDir(), 'mlch');
}
function openExternal(url) { if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(log); }
function allowedPermission(contents, permission, requestingURL) {
  if (!contents || contents !== window?.webContents) return false;
  try { if (new URL(requestingURL).origin !== origin) return false; } catch { return false; }
  // Screen capture only right after the person asked for a screenshot.
  if (permission === 'display-capture') return Date.now() < captureUntil;
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
        const { response } = await message({ type: 'error', title: 'mlch local server',
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
  const { response } = await message({ type: 'warning', title: 'mlch server stopped',
    message: 'The local server stopped.',
    buttons: ['Restart Server', 'Open Logs', 'Close'], defaultId: 0, cancelId: 2 });
  if (response === 0) await startWithRetry();
  if (response === 1) await openLogs();
}

// mlch: work running and finished results (bridge-main 'notify' and 'activity').
let jobActivity = { working: 0, unseen: 0 };
let quitConfirmed = false;
const shownNotifications = new Set();

function lookingAt(mulchId) {
  if (!window || window.isDestroyed() || !window.isFocused()) return false;
  try { return new URL(window.webContents.getURL()).pathname === `/n/${mulchId}`; } catch { return false; }
}

async function showMulch(mulchId, ids) {
  if (!window) await createWindow();
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  const url = new URL(`/n/${mulchId}`, origin);
  if (ids.length) url.searchParams.set('focus', ids.join(','));
  await window.loadURL(url.href);
}

// mlch: "Open in mlch" on a shared canvas (mlch://open?share=<manifest link>) copies it into a new mulch.
let pendingShare;
function openShareLink(link) {
  let manifest;
  try {
    const parsed = new URL(link);
    if (parsed.protocol !== 'mlch:') return;
    manifest = parsed.searchParams.get('share');
  } catch { return; }
  if (!manifest || !/^https?:\/\//i.test(manifest)) return;
  if (!window || !backend?.online()) { pendingShare = manifest; return; }
  pendingShare = undefined;
  const url = new URL('/open', origin);
  url.searchParams.set('manifest', manifest);
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  window.loadURL(url.href).catch(log);
}

/** A finished job, unless the person is looking at that mulch. Clicking opens it at the results. */
function notifyJob({ mulchId, ids, title, body }) {
  if (lookingAt(mulchId) || !Notification.isSupported()) return;
  const notification = new Notification({ title: title || 'mlch', body });
  shownNotifications.add(notification);
  notification.on('click', () => { shownNotifications.delete(notification); showMulch(mulchId, ids).catch(log); });
  notification.on('close', () => shownNotifications.delete(notification));
  notification.show();
}

/** A Quick Look thumbnail (macOS renders decks, documents and PDFs), as base64 PNG. */
async function fileThumbnail(file, size) {
  const image = await nativeImage.createThumbnailFromPath(file, { width: size, height: size });
  if (image.isEmpty()) throw new Error('Empty preview.');
  // When Quick Look cannot render a file it returns the app's square icon; decks and pages are never square.
  // (getSize reports the requested box; the PNG has the real shape.)
  const png = image.toPNG();
  const { width, height } = nativeImage.createFromBuffer(png).getSize();
  if (width === height && !/\.(xlsx?|numbers)$/i.test(file)) throw new Error('No preview, only the file icon.');
  return png.toString('base64');
}

// mlch: screenshots onto the canvas. The shortcut or menu opens a short window
// in which the page may capture; macOS's own picker (macOS 15+) lets the
// person choose a window, so no Screen Recording permission is needed.
const SCREENSHOT_SHORTCUT = 'CommandOrControl+Shift+2';
let captureUntil = 0;

async function screenshotToCanvas() {
  if (!window) await createWindow();
  if (!window) return;
  captureUntil = Date.now() + 60_000;
  await window.webContents.executeJavaScript("window.dispatchEvent(new Event('mlch:screenshot'))", true).catch(log);
}

function setupScreenshots() {
  const testing = process.env.MLCH_TEST_CAPTURE === '1' && !app.isPackaged;
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    // Only without the system picker (older macOS, or automated runs).
    let fromApp = false;
    try { fromApp = new URL(request.frame?.url ?? '').origin === origin && !request.frame?.parent; } catch {}
    if (Date.now() >= captureUntil || !window || !fromApp) { callback(null); return; }
    captureUntil = 0;
    if (testing) { callback({ video: window.webContents.mainFrame }); return; }
    desktopCapturer.getSources({ types: ['screen'] })
      .then(sources => callback(sources[0] ? { video: sources[0] } : null))
      .catch(error => { log(error); callback(null); });
  }, { useSystemPicker: !testing });
  if (!globalShortcut.register(SCREENSHOT_SHORTCUT, () => void screenshotToCanvas())) log(`Shortcut ${SCREENSHOT_SHORTCUT} is taken by another app.`);
  if (!globalShortcut.register(CALL_SHORTCUT, () => void openPage('/new?call=1'))) log(`Shortcut ${CALL_SHORTCUT} is taken by another app.`);
}

// mlch: updates for the packaged app, from mlch.app (electron-builder.yml publish). Downloaded quietly, installed on quit.
function startUpdates() {
  if (!app.isPackaged || process.env.MLCH_NO_UPDATES) return;
  const { autoUpdater } = require('electron-updater');
  autoUpdater.logger = { info: log, warn: log, error: log, debug: () => {} };
  autoUpdater.autoInstallOnAppQuit = true;
  const check = () => autoUpdater.checkForUpdates().catch((error) => log(`Update check failed: ${error.message}`));
  void check();
  setInterval(check, 6 * 60 * 60 * 1000).unref();
}

// mlch: the menu bar. New, New Call, the last few mulches, and the call being listened to.
const CALL_SHORTCUT = 'Control+Command+L';
let tray;
/** The call the window is listening to ({ mulchId }), reported by the page. */
let callState;

async function openPage(pathname) {
  if (!window) await createWindow();
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  await window.loadURL(new URL(pathname, origin).href);
}

async function recentMulches() {
  try {
    const response = await fetch(`${origin}/api/mulches`, { headers: { 'X-Mlch-Desktop': token } });
    const body = await response.json();
    return Array.isArray(body.mulches) ? body.mulches.slice(0, 5) : [];
  } catch { return []; }
}

async function refreshTray() {
  if (!tray || tray.isDestroyed()) return;
  const recent = backend?.online() ? await recentMulches() : [];
  tray.setImage(nativeImage.createFromPath(path.join(__dirname, callState ? 'trayListeningTemplate.png' : 'trayTemplate.png')));
  tray.setToolTip(callState ? 'mlch, listening' : 'mlch');
  const menu = Menu.buildFromTemplate([
    ...(callState ? [
      { label: 'Show Call', click: () => void openPage(`/n/${callState.mulchId}`) },
      { label: 'Stop Listening', click: () => window?.webContents.send('desktop:menu', 'stop-call') },
      { type: 'separator' },
    ] : []),
    { label: 'New', click: () => void openPage('/new') },
    { label: 'New Call', accelerator: CALL_SHORTCUT, registerAccelerator: false, click: () => void openPage('/new?call=1') },
    ...(recent.length ? [{ type: 'separator' }, ...recent.map((mulch) => ({ label: String(mulch.title).slice(0, 60), click: () => void openPage(`/n/${mulch.id}`) }))] : []),
    { type: 'separator' },
    { label: 'Open mlch', click: () => { if (!window) void createWindow(); else { window.show(); window.focus(); } } },
    { role: 'quit' },
  ]);
  tray.setContextMenu(menu);
  // Scripted runs (scripts/scenarios/menubar.cjs) read and click the menu.
  if (process.env.MLCH_ELECTRON_USER_DATA) globalThis.__mlchTrayMenu = menu;
}

if (process.env.MLCH_ELECTRON_USER_DATA) globalThis.__mlchRefreshTray = () => refreshTray();

function createTray() {
  if (tray || process.platform !== 'darwin') return;
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'trayTemplate.png')));
  void refreshTray();
  setInterval(() => void refreshTray(), 20_000).unref();
}

// mlch: the native audio helper (local transcription, system audio capture).
// Its events go to the server: model download progress and capture chunks.
let audioHelper;
function modelsDir() {
  // Shared by every profile (test runs too): the model is 600 MB.
  return process.env.MLCH_MODELS_DIR || path.join(app.getPath('appData'), 'mlch', 'models');
}
function forwardAudioEvent(event) {
  try { backend?.post({ type: 'audio-event', event }); } catch (error) { log(error); }
}
function getAudioHelper() {
  audioHelper ??= createAudioHelper({
    spawn, binary: audioHelperPath({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, root }),
    args: ['--models', modelsDir()], exists: fs.existsSync,
    log: (line) => diagnostics?.write('audio', line), onEvent: forwardAudioEvent,
  });
  return audioHelper;
}
async function audioRequest({ action, path: file, target, session }) {
  const helper = getAudioHelper();
  switch (action) {
    case 'status':
      if (!helper.available()) return { installed: false };
      return { installed: true, ...(await helper.request('status')) };
    case 'download':
      // Minutes long: answered at once; progress and the outcome arrive as events.
      helper.request('download-model', {}, { timeout: 0 })
        .then(() => forwardAudioEvent({ event: 'model-ready' }))
        .catch((error) => forwardAudioEvent({ event: 'model-error', error: error.message }));
      return { started: true };
    case 'warm':
      return helper.request('warm', {}, { timeout: 55_000 });
    case 'transcribe':
      return helper.request('transcribe', { path: file }, { timeout: 55_000 });
    case 'tap-start':
      return helper.request('tap-start', { target, ...(session ? { session } : {}) });
    case 'tap-stop':
      return helper.request('tap-stop', { session });
  }
  throw new Error('Unknown audio action.');
}

function setJobActivity(next) {
  jobActivity = next;
  if (process.platform === 'darwin') app.dock?.setBadge(next.unseen ? String(next.unseen) : '');
}

async function createWindow() {
  if (window) return;
  const stateFile = path.join(app.getPath('userData'), 'window-v1.json');
  let saved;
  try { saved = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
  const bounds = visibleBounds(saved?.bounds, screen.getAllDisplays(), screen.getPrimaryDisplay());
  window = new BrowserWindow({ title: 'mlch', ...bounds,
    minWidth: Math.min(800, bounds.width), minHeight: Math.min(560, bounds.height), backgroundColor: '#fcfcfa', show: false, icon: path.join(__dirname, 'icon.png'),
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
  // Frames inside the page (artifacts) may not navigate anywhere else.
  current.webContents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame) return;
    try { if (new URL(event.url).origin === origin) return; } catch {}
    event.preventDefault();
  });
  current.webContents.on('render-process-gone', async (_event, details) => {
    log(`Renderer stopped: ${details.reason} (exit ${details.exitCode})`);
    if (quitting) return;
    const { response } = await message({ type: 'error', title: 'mlch window stopped', message: 'The window stopped unexpectedly. Your work is saved on disk.', buttons: ['Reload', 'Open Logs', 'Quit'], cancelId: 2 });
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

// mlch: the agent's eyes on an HTML artifact. Loads it in a hidden window (the
// server sends the same sandboxing CSP), captures the first slides, pressing
// ArrowRight between them, and reports script errors.
const ARTIFACT_URL = /^\/api\/mulches\/[a-z0-9-]+\/(artifacts\/[a-z0-9][a-z0-9._-]*\.(html|svg)|model-view\/[a-f0-9]{64}\.(glb|gltf))$/;
async function renderArtifact(url, steps = 1) {
  let parsed;
  try { parsed = new URL(url, origin); } catch { throw new Error('Invalid page.'); }
  if (parsed.origin !== origin || !ARTIFACT_URL.test(parsed.pathname)) throw new Error('Only mulch artifacts and models can be rendered.');
  const view = new BrowserWindow({ show: false, width: 1280, height: 720, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const errors = [];
  view.webContents.on('console-message', (event) => { if (event.level === 'error' || event.level === 'warning') errors.push(String(event.message).slice(0, 300)); });
  view.webContents.on('render-process-gone', () => errors.push('The page crashed.'));
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  view.webContents.on('will-navigate', (event) => event.preventDefault());
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    await Promise.race([view.loadURL(parsed.href), wait(15_000)]);
    // 3D viewers load their model and libraries after the page itself.
    await wait(parsed.pathname.includes('/model-view/') ? 4000 : 900);
    const images = [];
    const count = Math.max(1, Math.min(8, steps));
    for (let i = 0; i < count; i++) {
      if (i > 0) {
        view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Right' });
        view.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Right' });
        await wait(700);
      }
      const image = await view.webContents.capturePage();
      images.push(image.resize({ width: 960 }).toPNG().toString('base64'));
    }
    return { images, errors: [...new Set(errors)].slice(0, 20) };
  } finally {
    view.destroy();
  }
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
  ipcMain.handle('desktop:call-state', guarded((state) => {
    callState = state && typeof state.mulchId === 'string' ? { mulchId: state.mulchId } : undefined;
    void refreshTray();
  }));
  ipcMain.handle('desktop:login-item', guarded((value) => {
    if (typeof value === 'boolean') app.setLoginItemSettings({ openAtLogin: value });
    return app.getLoginItemSettings().openAtLogin;
  }));
  ipcMain.handle('desktop:show-window', guarded(() => { if (window?.isMinimized()) window.restore(); window?.show(); window?.focus(); }));
  ipcMain.handle('desktop:microphone-access', guarded(async () => {
    // Automated runs feed a fake microphone and must not raise the system prompt.
    if (process.platform !== 'darwin' || (!app.isPackaged && process.env.MLCH_FAKE_MIC === '1')) return true;
    if (systemPreferences.getMediaAccessStatus('microphone') === 'granted') return true;
    return systemPreferences.askForMediaAccess('microphone');
  }));
}

function buildMenu() {
  return Menu.buildFromTemplate([
    { role: 'appMenu' },
    { label: 'File', submenu: [
      { label: 'Add Screenshot', accelerator: SCREENSHOT_SHORTCUT, registerAccelerator: false, click: () => void screenshotToCanvas() },
      { type: 'separator' },
      { role: 'close' },
    ] },
    { role: 'editMenu' },
    // Zoom acts on the canvas, not the page; the keys reach the page (gestures.ts), clicks are sent to it.
    { label: 'View', submenu: [
      { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', registerAccelerator: false, click: () => window?.webContents.send('desktop:menu', 'zoom-in') },
      { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', registerAccelerator: false, click: () => window?.webContents.send('desktop:menu', 'zoom-out') },
      { label: 'Show All', accelerator: 'CmdOrCtrl+0', registerAccelerator: false, click: () => window?.webContents.send('desktop:menu', 'zoom-fit') },
      { type: 'separator' },
      ...(app.isPackaged ? [] : [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }]),
      { role: 'togglefullscreen' },
    ] },
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
  app.on('second-instance', (_event, argv) => {
    if (window?.isMinimized()) window.restore(); window?.show(); window?.focus();
    const link = argv.find((arg) => arg.startsWith('mlch://'));
    if (link) openShareLink(link);
  });
  app.on('open-url', (event, link) => { event.preventDefault(); openShareLink(link); });
  app.on('before-quit', (event) => {
    // Running work stops on quit: ask first (scripted test runs skip this).
    if (!quitConfirmed && jobActivity.working > 0 && window && !window.isDestroyed() && !process.env.MLCH_NO_QUIT_PROMPT) {
      event.preventDefault();
      const count = jobActivity.working;
      const response = dialog.showMessageBoxSync(window, {
        type: 'question',
        message: count === 1 ? '1 job is running.' : `${count} jobs are running.`,
        detail: 'Quitting stops them. They can be retried later.',
        buttons: ['Quit', 'Cancel'], defaultId: 1, cancelId: 1,
      });
      if (response === 0) { quitConfirmed = true; app.quit(); }
      return;
    }
    quitting = true;
  });
  app.on('will-quit', () => { globalShortcut.unregisterAll(); void audioHelper?.stop(); backend?.kill(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('activate', () => { if (!window && backend?.online()) createWindow().catch(fail); });
  process.on('uncaughtException', error => { void fail(error); });
  // Any process of the app that ends abnormally (server, GPU, renderer, helpers) is recorded.
  app.on('child-process-gone', (_event, details) => {
    if (details.reason !== 'clean-exit') log(`Process gone: ${JSON.stringify(details)}`);
  });
  process.on('unhandledRejection', log);
  app.whenReady().then(async () => {
    // A packaged app gets its icon from the bundle; in development, set it here.
    if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(path.join(__dirname, 'icon.png'));
    diagnostics = createDiagnostics(app.getPath('logs'), redactor);
    credentialStore = createCredentialStore(app.getPath('userData'), safeStorage, values => {
      redactor.add(values); backend?.post({ type: 'secrets', values });
    });
    const serverMessage = createServerMessageHandler({ shell, dialog, fs, getWindow: () => window, render: renderArtifact, notify: notifyJob, activity: setJobActivity, thumbnail: fileThumbnail, audio: audioRequest, log });
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('MLCH_ELECTRON_PORT must be a port number between 1 and 65535.');
    backend = createBackend({ fork: (...args) => utilityProcess.fork(...args),
      entry: path.join(__dirname, 'server.cjs'), diagnostics, onDisconnected: disconnected,
      options: () => ({ cwd: root, serviceName: 'mlch Server', stdio: 'pipe', env: {
        ...process.env,
        NODE_ENV: dev ? 'development' : 'production', MLCH_ELECTRON: '1',
        MLCH_ELECTRON_PORT: String(port), MLCH_ELECTRON_TOKEN: token,
        MLCH_LIBRARY: libraryDir(),
        MLCH_LOGS_DIR: app.getPath('logs'),
      } }),
      onMessage: async (msg, child) => {
        const reply = await serverMessage(msg);
        if (!reply) return;
        try { child.postMessage(reply); } catch (error) { log(error); }
      },
    });
    const localURLs = [`${origin}/*`, `${origin.replace('http:', 'ws:')}/*`];
    session.defaultSession.webRequest.onBeforeSendHeaders({ urls: localURLs }, (details, callback) => {
      callback({ requestHeaders: { ...details.requestHeaders, 'X-Mlch-Desktop': token } });
    });
    session.defaultSession.setPermissionCheckHandler(allowedPermission);
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => callback(allowedPermission(contents, permission, details.requestingUrl)));
    Menu.setApplicationMenu(buildMenu());
    setupScreenshots();
    if (await startWithRetry()) await createWindow();
    createTray();
    startUpdates();
    if (!process.env.MLCH_ELECTRON_USER_DATA) {
      if (app.isPackaged) app.setAsDefaultProtocolClient('mlch');
      else app.setAsDefaultProtocolClient('mlch', process.execPath, [path.resolve(process.argv[1] ?? root), '--dev']);
    }
    if (pendingShare) openShareLink(`mlch://open?share=${encodeURIComponent(pendingShare)}`);
  }).catch(fail);
}
