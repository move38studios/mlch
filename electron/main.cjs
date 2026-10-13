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

/** build.json (scripts/package-app.mjs): the version, the commit, and whether this is an official build. Absent in dev. */
const buildInfo = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'build.json'), 'utf8')); } catch { return { version: app.getVersion(), commit: '', official: false }; }
})();
// A packaged build from source keeps its own name and profile (preferences, saved keys), so it can sit beside the official app.
const appName = app.isPackaged && !buildInfo.official ? 'mlch dev' : 'mlch';
app.setName(appName);
app.setPath('userData', process.env.MLCH_ELECTRON_USER_DATA || path.join(app.getPath('appData'), appName));
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
// Video players a card may load in a frame (src/lib/ingest/video.ts PLAYER_ORIGINS).
const PLAYER_ORIGINS = new Set(['https://www.youtube.com', 'https://player.vimeo.com']);
function allowedPermission(contents, permission, requestingURL) {
  if (!contents || contents !== window?.webContents) return false;
  let from;
  try { from = new URL(requestingURL).origin; } catch { return false; }
  // A playing video may go full screen; nothing else for players.
  if (PLAYER_ORIGINS.has(from)) return permission === 'fullscreen';
  if (from !== origin) return false;
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

// mlch: the mlch.app session (sign-in for sharing), from the server process. Kept like the keys.
function storeAccount(token) {
  credentialStore.write({ mlchAccount: token });
  postCredentials();
}

function showWindow() {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

// mlch://signed-in?code=… (after Google sign-in on mlch.app): the server finishes it with the
// verifier it kept; mlch://account (back from Stripe): the page refreshes the account.
async function accountLink(parsed) {
  showWindow();
  const code = parsed.searchParams.get('code');
  if (parsed.host === 'signed-in' && code && /^[\w-]{20,200}$/.test(code) && backend?.online()) {
    try {
      const response = await fetch(`${origin}/api/account`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mlch-Desktop': token, Origin: origin }, body: JSON.stringify({ action: 'finish', code }) });
      if (!response.ok) log(`Sign-in not finished: ${response.status}`);
    } catch (error) { log(error); }
  }
  window?.webContents.send('desktop:menu', 'account');
}

// mlch: "Open in mlch" on a shared canvas (mlch://open?share=<manifest link>) copies it into a new mulch.
let pendingShare;
function openShareLink(link) {
  let manifest;
  try {
    const parsed = new URL(link);
    if (parsed.protocol !== 'mlch:') return;
    if (parsed.host === 'signed-in' || parsed.host === 'account') { void accountLink(parsed); return; }
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

// mlch: updates for the packaged app, from mlch.app (electron-builder.yml publish). Downloaded quietly, installed on quit;
// once one is ready the menus offer "Restart to Update" (a menu bar app is rarely quit).
let updater;
let updateReady = false;
/**
 * Official builds update from mlch.app. A build from source has no feed, so it never
 * updates itself into ours (its own feed: MLCH_UPDATE_URL).
 */
function updatesOn() {
  return app.isPackaged && !process.env.MLCH_NO_UPDATES && (buildInfo.official || !!process.env.MLCH_UPDATE_URL);
}
/** "beta" or "latest" (the default), kept beside the app's other preferences. */
function updateChannelFile() { return path.join(app.getPath('userData'), 'update-channel'); }
function updateChannel() {
  try { return fs.readFileSync(updateChannelFile(), 'utf8').trim() === 'beta' ? 'beta' : 'latest'; } catch { return 'latest'; }
}
function setUpdateChannel(channel) {
  fs.writeFileSync(updateChannelFile(), channel);
  if (updater) {
    updater.channel = channel;
    void updater.checkForUpdates().catch(() => {});
  }
  Menu.setApplicationMenu(buildMenu());
}
function startUpdates() {
  if (!updatesOn()) return;
  const { autoUpdater } = require('electron-updater');
  updater = autoUpdater;
  if (process.env.MLCH_UPDATE_URL) autoUpdater.setFeedURL({ provider: 'generic', url: process.env.MLCH_UPDATE_URL });
  // Each channel has its own feed file (beta-mac.yml, latest-mac.yml); never down to an older version.
  autoUpdater.channel = updateChannel();
  autoUpdater.allowDowngrade = false;
  // One line per problem: the updater's own errors carry whole HTTP responses.
  const firstLine = (value) => String(value?.message ?? value).split('\n')[0];
  autoUpdater.logger = { info: log, warn: (value) => log(firstLine(value)), error: (value) => log(firstLine(value)), debug: () => {} };
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-downloaded', () => {
    updateReady = true;
    Menu.setApplicationMenu(buildMenu());
    void refreshTray();
  });
  const check = () => autoUpdater.checkForUpdates().catch((error) => log(`Update check failed: ${firstLine(error)}`));
  void check();
  setInterval(check, 6 * 60 * 60 * 1000).unref();
}
async function checkForUpdatesNow() {
  if (!updater) {
    await dialog.showMessageBox({ message: 'Updates are off in this build.', buttons: ['OK'] });
    return;
  }
  try {
    const result = await updater.checkForUpdates();
    const next = result?.updateInfo?.version;
    if (!next || next === app.getVersion()) await dialog.showMessageBox({ message: `mlch ${app.getVersion()} is the latest version.`, buttons: ['OK'] });
    else await dialog.showMessageBox({ message: `mlch ${next} is downloading. Restart to update when it is ready.`, buttons: ['OK'] });
  } catch (error) {
    await dialog.showMessageBox({ type: 'warning', message: 'Could not check for updates.', detail: String(error?.message ?? error).split('\n')[0], buttons: ['OK'] });
  }
}
function restartToUpdate() {
  if (updateReady) updater?.quitAndInstall();
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

async function recentMulches(count = 5) {
  try {
    const response = await fetch(`${origin}/api/mulches`, { headers: { 'X-Mlch-Desktop': token } });
    const body = await response.json();
    return Array.isArray(body.mulches) ? body.mulches.filter((mulch) => !mulch.archivedAt).slice(0, count) : [];
  } catch { return []; }
}

/** A recent mulch as a menu item: working or with new results shows in its label. */
function recentItem(mulch) {
  const state = mulch.activity?.working ? ' (working)' : mulch.activity?.unseen ? ' (new results)' : '';
  return { label: `${String(mulch.title).slice(0, 60)}${state}`, click: () => void openPage(`/n/${mulch.id}`) };
}

/** Sent to the page: Search, Share, Conversation and the like act where the person is. */
function pageCommand(command) {
  if (!window) return;
  window.show();
  window.focus();
  window.webContents.send('desktop:menu', command);
}

/** Settings → Diagnostics' report, from the menu: saved to Downloads and shown in Finder. */
async function saveSupportReport() {
  try {
    const response = await fetch(`${origin}/api/diagnostics`, { method: 'POST', headers: { 'X-Mlch-Desktop': token } });
    const body = await response.json();
    if (body.file) shell.showItemInFolder(body.file);
    else await dialog.showMessageBox({ type: 'warning', message: 'The report could not be saved.', detail: body.error ?? '', buttons: ['OK'] });
  } catch (error) {
    await dialog.showMessageBox({ type: 'warning', message: 'The report could not be saved.', detail: String(error?.message ?? error), buttons: ['OK'] });
  }
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
    ...(recent.length ? [{ type: 'separator' }, ...recent.map(recentItem)] : []),
    { type: 'separator' },
    { label: 'Search…', click: () => void openPage('/?search=1') },
    { label: 'Open mlch', click: () => { if (!window) void createWindow(); else { window.show(); window.focus(); } } },
    { label: 'Settings…', click: () => void openPage('/settings') },
    ...(updateReady ? [{ type: 'separator' }, { label: 'Restart to Update', click: restartToUpdate }] : []),
    { type: 'separator' },
    { role: 'quit' },
  ]);
  tray.setContextMenu(menu);
  // The Dock's menu: the same start points.
  if (process.platform === 'darwin') {
    app.dock?.setMenu(Menu.buildFromTemplate([
      { label: 'New', click: () => void openPage('/new') },
      { label: 'New Call', click: () => void openPage('/new?call=1') },
      ...(recent.length ? [{ type: 'separator' }, ...recent.map(recentItem)] : []),
    ]));
  }
  // The app menu's Open Recent follows the list too.
  const longer = recent.length ? await recentMulches(10) : [];
  if (JSON.stringify(longer.map((m) => [m.id, m.title])) !== JSON.stringify(openRecent.map((m) => [m.id, m.title]))) {
    openRecent = longer;
    Menu.setApplicationMenu(buildMenu());
  }
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
  // Esc reaches the page even when a made page in a frame has the keyboard (the viewer closes on it).
  current.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') current.webContents.send('desktop:menu', 'escape');
  });
  // Frames inside the page (artifacts) may not navigate anywhere else.
  current.webContents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame) return;
    try {
      const target = new URL(event.url);
      if (target.origin === origin) return;
      // Video cards: the YouTube and Vimeo players only (and what they load inside themselves).
      if (PLAYER_ORIGINS.has(target.origin) && /^\/(embed|video)\//.test(target.pathname)) return;
      if (event.frame?.parent && PLAYER_ORIGINS.has(new URL(event.frame.parent.url).origin)) return;
    } catch {}
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
  // A picture of the canvas for a shared link's preview (Slack, iMessage): the part of the window the page names.
  ipcMain.handle('desktop:capture', guarded(async (rect) => {
    if (!window || !rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return null;
    const area = { x: Math.max(0, Math.round(rect.x)), y: Math.max(0, Math.round(rect.y)), width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) };
    const image = await window.webContents.capturePage(area);
    return image.resize({ width: 1200 }).toPNG().toString('base64');
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

/** The app menu's Open Recent (kept fresh by refreshTray). */
let openRecent = [];

function buildMenu() {
  // Keys the page handles itself (⌘K, ⌘J, zoom) are shown here but not taken from it (registerAccelerator: false).
  return Menu.buildFromTemplate([
    { label: app.name, submenu: [
      { role: 'about' },
      { label: 'Check for Updates…', enabled: updatesOn(), click: () => void checkForUpdatesNow() },
      ...(updatesOn() ? [{ label: 'Beta Updates', type: 'checkbox', checked: updateChannel() === 'beta', click: (item) => setUpdateChannel(item.checked ? 'beta' : 'latest') }] : []),
      ...(updateReady ? [{ label: 'Restart to Update', click: restartToUpdate }] : []),
      { type: 'separator' },
      { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => void openPage('/settings') },
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' },
    ] },
    { label: 'File', submenu: [
      { label: 'New', accelerator: 'CmdOrCtrl+N', click: () => void openPage('/new') },
      { label: 'New Call', accelerator: CALL_SHORTCUT, registerAccelerator: false, click: () => void openPage('/new?call=1') },
      { label: 'Open Recent', enabled: openRecent.length > 0, submenu: openRecent.map(recentItem) },
      { type: 'separator' },
      { label: 'Search…', accelerator: 'CmdOrCtrl+K', registerAccelerator: false, click: () => pageCommand('search') },
      { label: 'Share…', click: () => pageCommand('share') },
      { label: 'Add Screenshot', accelerator: SCREENSHOT_SHORTCUT, registerAccelerator: false, click: () => void screenshotToCanvas() },
      { type: 'separator' },
      { role: 'close' },
    ] },
    { role: 'editMenu' },
    // Zoom acts on the canvas, not the page; the keys reach the page (gestures.ts), clicks are sent to it.
    { label: 'View', submenu: [
      { label: 'Conversation', accelerator: 'CmdOrCtrl+J', registerAccelerator: false, click: () => pageCommand('conversation') },
      { type: 'separator' },
      { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', registerAccelerator: false, click: () => window?.webContents.send('desktop:menu', 'zoom-in') },
      { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', registerAccelerator: false, click: () => window?.webContents.send('desktop:menu', 'zoom-out') },
      { label: 'Show All', accelerator: 'CmdOrCtrl+0', registerAccelerator: false, click: () => window?.webContents.send('desktop:menu', 'zoom-fit') },
      { type: 'separator' },
      ...(app.isPackaged ? [] : [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }]),
      { role: 'togglefullscreen' },
    ] },
    { label: 'Go', submenu: [
      { label: 'Home', accelerator: 'Shift+CmdOrCtrl+H', click: () => void openPage('/') },
      { label: 'Back', accelerator: 'CmdOrCtrl+[', click: () => window?.webContents.navigationHistory.goBack() },
    ] },
    { role: 'windowMenu' },
    { role: 'help', submenu: [
      { label: 'mlch Help', click: () => void shell.openExternal('https://mlch.app') },
      { label: 'Save Support Report', click: () => void saveSupportReport() },
      { type: 'separator' },
      { label: 'Open Logs', click: () => void openLogs() },
      { label: 'Restart Local Server', click: () => void startWithRetry() },
    ] },
  ]);
}

/**
 * Opened from the disk image (or anywhere outside Applications): offer to move there, the
 * way Mac apps from outside the App Store do. Updates and mlch:// links need the installed copy.
 * Returns true when the app is moving (it relaunches from Applications).
 */
function offerMoveToApplications() {
  if (!app.isPackaged || process.platform !== 'darwin' || process.env.MLCH_NO_MOVE || app.isInApplicationsFolder()) return false;
  // Placeholder wording (George).
  const response = dialog.showMessageBoxSync({
    type: 'question',
    message: 'Move mlch to Applications?',
    buttons: ['Move', 'Not now'], defaultId: 0, cancelId: 1,
  });
  if (response !== 0) return false;
  // Eject the disk image once this copy has quit.
  const volume = /^\/Volumes\/[^/]+/.exec(app.getPath('exe'))?.[0];
  try {
    const moved = app.moveToApplicationsFolder({ conflictHandler: () => true });
    if (moved && volume) spawn('/bin/sh', ['-c', 'sleep 3; /usr/bin/hdiutil detach "$0" -quiet', volume], { detached: true, stdio: 'ignore' }).unref();
    return moved;
  } catch (error) {
    log(error);
    dialog.showMessageBoxSync({ type: 'warning', message: 'Could not move mlch to Applications.', detail: String(error?.message ?? error) });
    return false;
  }
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
    if (offerMoveToApplications()) return;
    // A packaged app gets its icon from the bundle; in development, set it here.
    if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(path.join(__dirname, 'icon.png'));
    diagnostics = createDiagnostics(app.getPath('logs'), redactor);
    credentialStore = createCredentialStore(app.getPath('userData'), safeStorage, values => {
      redactor.add(values); backend?.post({ type: 'secrets', values });
    });
    const serverMessage = createServerMessageHandler({ shell, dialog, fs, getWindow: () => window, render: renderArtifact, notify: notifyJob, activity: setJobActivity, thumbnail: fileThumbnail, audio: audioRequest, storeAccount, log });
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('MLCH_ELECTRON_PORT must be a port number between 1 and 65535.');
    backend = createBackend({ fork: (...args) => utilityProcess.fork(...args),
      entry: path.join(__dirname, 'server.cjs'), diagnostics, onDisconnected: disconnected,
      options: () => ({ cwd: root, serviceName: 'mlch Server', stdio: 'pipe', env: {
        ...process.env,
        NODE_ENV: dev ? 'development' : 'production', MLCH_ELECTRON: '1',
        MLCH_ELECTRON_PORT: String(port), MLCH_ELECTRON_TOKEN: token,
        MLCH_LIBRARY: libraryDir(),
        MLCH_BUILD: JSON.stringify({ commit: buildInfo.commit ?? '', official: !!buildInfo.official }),
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
    // About: the version, and which commit it was built from (and whether officially).
    app.setAboutPanelOptions({ applicationVersion: buildInfo.version, version: [buildInfo.commit, buildInfo.official ? '' : app.isPackaged ? 'built from source' : 'development'].filter(Boolean).join(', '), copyright: '© 2026 move38 B.V.' });
    setupScreenshots();
    if (await startWithRetry()) await createWindow();
    createTray();
    startUpdates();
    // Scripted dev runs (a throwaway profile, unpackaged) leave the system's mlch:// handler alone.
    if (app.isPackaged || !process.env.MLCH_ELECTRON_USER_DATA) {
      if (app.isPackaged) app.setAsDefaultProtocolClient('mlch');
      else app.setAsDefaultProtocolClient('mlch', process.execPath, [path.resolve(process.argv[1] ?? root), '--dev']);
    }
    if (pendingShare) openShareLink(`mlch://open?share=${encodeURIComponent(pendingShare)}`);
  }).catch(fail);
}
