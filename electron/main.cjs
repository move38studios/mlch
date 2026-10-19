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
const { loginShellPath } = require('./lib/shell-path.cjs');
const { createScreenshotter } = require('./lib/screenshot.cjs');
// Asked at once, while Electron starts (the shell takes most of a second).
const shellPath = loginShellPath().catch(() => undefined);

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
/** The person's choice of library folder (Settings, Library), kept with the app's preferences. */
function libraryChoiceFile() { return path.join(app.getPath('userData'), 'library.json'); }
function chosenLibrary() {
  try {
    const chosen = JSON.parse(fs.readFileSync(libraryChoiceFile(), 'utf8')).path;
    return typeof chosen === 'string' && path.isAbsolute(chosen) && fs.existsSync(chosen) ? chosen : undefined;
  } catch { return undefined; }
}
function libraryDir() {
  if (process.env.MLCH_LIBRARY) return path.resolve(process.env.MLCH_LIBRARY);
  const chosen = chosenLibrary();
  if (chosen) return chosen;
  if (process.env.MLCH_ELECTRON_USER_DATA) return path.join(app.getPath('userData'), 'mulches');
  return path.join(documentsDir(), 'mlch');
}
/** The search index lives with the app, not in the library: a synced folder (Dropbox, iCloud) must not sync a database. */
function indexDir() {
  return path.join(app.getPath('userData'), 'index');
}

/** What a library folder holds: mulch folders (and the library's own dot files). */
const MULCH_FOLDER = /^[a-z0-9][a-z0-9-]{2,63}$/;
function mulchFolders(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && MULCH_FOLDER.test(e.name)).map((e) => e.name); } catch { return []; }
}

/**
 * Settings, Library, Change: another folder for the library. A folder that already holds mulches is used as it is;
 * otherwise the mulches move there (copied, then removed here). The server restarts on the new folder.
 */
async function chooseLibrary() {
  const current = libraryDir();
  const options = { title: 'Choose a folder for your mlch library', properties: ['openDirectory', 'createDirectory'] };
  const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
  const target = picked.filePaths?.[0];
  if (picked.canceled || !target || path.resolve(target) === path.resolve(current)) return { ok: true, value: current };
  if (path.resolve(target).startsWith(path.resolve(current) + path.sep)) return { ok: false, error: 'Choose a folder outside the current library.' };
  const here = mulchFolders(current);
  if (!mulchFolders(target).length && here.length) {
    const { response } = await message({ type: 'question', message: `Move your ${here.length === 1 ? 'mulch' : `${here.length} mulches`} to ${target}?`, buttons: ['Move', 'Cancel'], defaultId: 0, cancelId: 1 });
    if (response !== 0) return { ok: true, value: current };
    // Nothing may write to the library while it moves.
    await backend.stop();
    const entries = fs.readdirSync(current).filter((name) => !name.startsWith('.index.sqlite') && name !== '.DS_Store');
    // Copy everything first; remove the originals only once all of it is there.
    for (const name of entries) fs.cpSync(path.join(current, name), path.join(target, name), { recursive: true, errorOnExist: false, force: false });
    for (const name of entries) fs.rmSync(path.join(current, name), { recursive: true, force: true });
  }
  fs.writeFileSync(libraryChoiceFile(), JSON.stringify({ path: target }));
  log(`Library moved to ${target}`);
  await startWithRetry();
  if (window) await window.loadURL(new URL('/settings', origin).href);
  return { ok: true, value: target };
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

/** The mulch open in the window, if one is and the window is on screen. */
function openMulchId() {
  if (!window || window.isDestroyed() || !window.isVisible() || window.isMinimized()) return undefined;
  try { return new URL(window.webContents.getURL()).pathname.match(/^\/n\/([^/]+)$/)?.[1]; } catch { return undefined; }
}

/**
 * A finished job, unless the person is looking at that mulch, or has a mulch in
 * focus mode open (`quietIn`): then other mulches wait. Clicking opens it at the results.
 */
function notifyJob({ mulchId, ids, title, body, quietIn = [] }) {
  if (lookingAt(mulchId) || !Notification.isSupported()) return;
  const here = openMulchId();
  if (here && here !== mulchId && quietIn.includes(here)) return;
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
 * What the page shows about updates: off (a build from source), idle, checking, downloading, ready, latest or
 * error; the version being fetched or ready; and, on the first run after an update, the version and its notes.
 */
let updateState = { status: 'off' };
function setUpdateState(patch) {
  updateState = { ...updateState, ...patch };
  if (window && !window.isDestroyed()) window.webContents.send('desktop:update', { ...updateState, channel: updateChannel() });
}
/** The version that ran last, and the notes of a downloaded update (userData), for "Updated to …" once. */
function noteUpdatedVersion() {
  const lastFile = path.join(app.getPath('userData'), 'last-version');
  const notesFile = path.join(app.getPath('userData'), 'update-notes.json');
  let last;
  try { last = fs.readFileSync(lastFile, 'utf8').trim(); } catch {}
  if (last && last !== app.getVersion()) {
    let notes;
    try { const saved = JSON.parse(fs.readFileSync(notesFile, 'utf8')); if (saved.version === app.getVersion()) notes = saved.notes; } catch {}
    updateState = { ...updateState, updated: { version: app.getVersion(), ...(notes ? { notes } : {}) } };
  }
  try { fs.writeFileSync(lastFile, app.getVersion()); fs.rmSync(notesFile, { force: true }); } catch {}
}
/** Release notes from the feed: a string, or electron-updater's list of { note }. */
function notesText(info) {
  const notes = info?.releaseNotes;
  if (typeof notes === 'string') return notes.replace(/<[^>]+>/g, '').trim() || undefined;
  if (Array.isArray(notes)) return notes.map((n) => String(n?.note ?? '').replace(/<[^>]+>/g, '').trim()).filter(Boolean).join('\n') || undefined;
  return undefined;
}
/**
 * Official builds update from mlch.app. A build from source never updates itself into ours: it installs updates
 * only from its own feed (MLCH_UPDATE_URL when it was packaged, kept in build.json; the variable at run time also
 * works), and otherwise only says when a new mlch is out (notify, below).
 */
function updateFeed() { return process.env.MLCH_UPDATE_URL || buildInfo.updateUrl || ''; }
function updatesOn() {
  return app.isPackaged && !process.env.MLCH_NO_UPDATES && (buildInfo.official || !!updateFeed());
}
/** A packaged build that cannot install updates: it checks mlch.app's feed and links to the release. */
function notifyOnly() {
  return app.isPackaged && !process.env.MLCH_NO_UPDATES && !updatesOn();
}
/** The person's choices (userData/update-prefs.json): download automatically (installing builds), tell me (the others), a version not to mention again. */
function updatePrefsFile() { return path.join(app.getPath('userData'), 'update-prefs.json'); }
function updatePrefs() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(updatePrefsFile(), 'utf8')); } catch {}
  return { autoDownload: saved.autoDownload !== false, notify: saved.notify !== false, dismissed: typeof saved.dismissed === 'string' ? saved.dismissed : undefined };
}
function setUpdatePrefs(patch) {
  const next = { ...updatePrefs(), ...patch };
  try { fs.writeFileSync(updatePrefsFile(), JSON.stringify(next)); } catch (error) { log(`Update preferences not saved: ${error.message}`); }
  return next;
}
/** "beta" or "latest" (the default), kept beside the app's other preferences. */
function updateChannelFile() { return path.join(app.getPath('userData'), 'update-channel'); }
function updateChannel() {
  try { return fs.readFileSync(updateChannelFile(), 'utf8').trim() === 'beta' ? 'beta' : 'latest'; } catch { return 'latest'; }
}
function setUpdateChannel(channel) {
  fs.writeFileSync(updateChannelFile(), channel);
  setUpdateState({});
  if (updater) {
    updater.channel = channel;
    void updater.checkForUpdates().catch(() => {});
  } else if (notifyOnly()) void checkNotify();
  Menu.setApplicationMenu(buildMenu());
}
/** a.b.c newer than x.y.z (pre-release tags ignored). */
function newerVersion(a, b) {
  const parts = (v) => String(v).split('-')[0].split('.').map((n) => Number(n) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}
const RELEASES_PAGE = 'https://github.com/move38studios/mlch/releases';
/** For builds that cannot install updates: is a newer official mlch out? */
async function checkNotify() {
  if (!notifyOnly()) return updateState;
  setUpdateState({ status: 'checking' });
  try {
    const response = await fetch(`https://mlch.app/releases/mac/${updateChannel()}-mac.yml`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`mlch.app answered ${response.status}`);
    const latest = (await response.text()).match(/^version: (\S+)/m)?.[1];
    if (latest && newerVersion(latest, app.getVersion())) setUpdateState({ status: 'available', version: latest, url: `${RELEASES_PAGE}/tag/v${latest}`, checkedAt: Date.now() });
    else setUpdateState({ status: 'latest', version: undefined, url: undefined, checkedAt: Date.now() });
  } catch (error) {
    setUpdateState({ status: 'error', error: String(error?.message ?? error).split('\n')[0] });
  }
  return updateState;
}
function startUpdates() {
  const prefs = updatePrefs();
  if (notifyOnly()) {
    setUpdateState({ status: 'idle', mode: 'notify', notify: prefs.notify, dismissed: prefs.dismissed });
    const check = () => { if (updatePrefs().notify) void checkNotify(); };
    check();
    setInterval(check, 24 * 60 * 60 * 1000).unref();
    return;
  }
  if (!updatesOn()) return;
  const { autoUpdater } = require('electron-updater');
  updater = autoUpdater;
  if (updateFeed()) autoUpdater.setFeedURL({ provider: 'generic', url: updateFeed() });
  // Each channel has its own feed file (beta-mac.yml, latest-mac.yml); never down to an older version.
  autoUpdater.channel = updateChannel();
  autoUpdater.allowDowngrade = false;
  // Downloads quietly unless the person chose to be asked (Settings → Updates).
  autoUpdater.autoDownload = prefs.autoDownload;
  // One line per problem: the updater's own errors carry whole HTTP responses.
  const firstLine = (value) => String(value?.message ?? value).split('\n')[0];
  autoUpdater.logger = { info: log, warn: (value) => log(firstLine(value)), error: (value) => log(firstLine(value)), debug: () => {} };
  autoUpdater.autoInstallOnAppQuit = true;
  setUpdateState({ status: 'idle', mode: 'install', autoDownload: prefs.autoDownload, dismissed: prefs.dismissed });
  autoUpdater.on('checking-for-update', () => { if (!updateReady && updateState.status !== 'downloading') setUpdateState({ status: 'checking' }); });
  autoUpdater.on('update-not-available', () => { if (!updateReady) setUpdateState({ status: 'latest', version: undefined, checkedAt: Date.now() }); });
  autoUpdater.on('update-available', (info) => {
    if (updateReady) return;
    setUpdateState(autoUpdater.autoDownload ? { status: 'downloading', version: info?.version, percent: 0 } : { status: 'available', version: info?.version, checkedAt: Date.now() });
  });
  autoUpdater.on('download-progress', (progress) => { if (!updateReady) setUpdateState({ status: 'downloading', percent: Math.round(progress?.percent ?? 0) }); });
  autoUpdater.on('error', (error) => { if (!updateReady) setUpdateState({ status: 'error', error: firstLine(error) }); });
  autoUpdater.on('update-downloaded', (info) => {
    updateReady = true;
    setUpdateState({ status: 'ready', version: info?.version });
    // Shown once after the restart, with "Updated to …".
    try { fs.writeFileSync(path.join(app.getPath('userData'), 'update-notes.json'), JSON.stringify({ version: info?.version, notes: notesText(info) })); } catch {}
    Menu.setApplicationMenu(buildMenu());
    void refreshTray();
  });
  const check = () => autoUpdater.checkForUpdates().catch((error) => log(`Update check failed: ${firstLine(error)}`));
  void check();
  setInterval(check, 6 * 60 * 60 * 1000).unref();
}
/** An update the person chose to fetch (automatic downloads off). */
function downloadUpdate() {
  if (!updater || updateReady || updateState.status !== 'available') return;
  setUpdateState({ status: 'downloading', percent: 0 });
  updater.downloadUpdate().catch((error) => setUpdateState({ status: 'error', error: String(error?.message ?? error).split('\n')[0] }));
}
async function checkForUpdatesNow() {
  if (notifyOnly()) {
    const state = await checkNotify();
    if (state.status === 'available') {
      const { response } = await dialog.showMessageBox({ message: `mlch ${state.version} is out.`, detail: 'This build does not update itself.', buttons: ['View release', 'OK'], defaultId: 0, cancelId: 1 });
      if (response === 0) openExternal(state.url);
    } else if (state.status === 'latest') await dialog.showMessageBox({ message: `mlch ${app.getVersion()} is the latest version.`, buttons: ['OK'] });
    else await dialog.showMessageBox({ type: 'warning', message: 'Could not check for updates.', detail: state.error ?? '', buttons: ['OK'] });
    return;
  }
  if (!updater) {
    await dialog.showMessageBox({ message: 'Updates are off in this build.', buttons: ['OK'] });
    return;
  }
  try {
    const result = await updater.checkForUpdates();
    const next = result?.updateInfo?.version;
    if (!next || !newerVersion(next, app.getVersion())) await dialog.showMessageBox({ message: `mlch ${app.getVersion()} is the latest version.`, buttons: ['OK'] });
    else if (updateReady) await dialog.showMessageBox({ message: `mlch ${next} is ready. Restart to update.`, buttons: ['OK'] });
    else if (!updater.autoDownload) {
      const { response } = await dialog.showMessageBox({ message: `mlch ${next} is out.`, buttons: ['Download', 'Later'], defaultId: 0, cancelId: 1 });
      if (response === 0) downloadUpdate();
    } else await dialog.showMessageBox({ message: `mlch ${next} is downloading. Restart to update when it is ready.`, buttons: ['OK'] });
  } catch (error) {
    await dialog.showMessageBox({ type: 'warning', message: 'Could not check for updates.', detail: String(error?.message ?? error).split('\n')[0], buttons: ['OK'] });
  }
}
function restartToUpdate() {
  if (!updateReady) return;
  // quitAndInstall closes the windows before before-quit, which then cannot ask: ask here.
  if (jobActivity.working > 0 && !process.env.MLCH_NO_QUIT_PROMPT) {
    const count = jobActivity.working;
    const response = dialog.showMessageBoxSync(window && !window.isDestroyed() ? window : undefined, {
      type: 'question',
      message: count === 1 ? '1 job is running.' : `${count} jobs are running.`,
      detail: 'Restarting stops them. They can be retried later.',
      buttons: ['Restart', 'Cancel'], defaultId: 1, cancelId: 1,
    });
    if (response !== 0) return;
  }
  quitConfirmed = true;
  updater?.quitAndInstall();
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
async function audioRequest({ action, path: file, target, session, out, count, maxSide, start, length }) {
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
      // A long recording takes minutes.
      return helper.request('transcribe', { path: file }, { timeout: 14 * 60_000 });
    case 'media-info':
      return helper.request('media-info', { path: file }, { timeout: 30_000 });
    case 'frames':
      return helper.request('frames', { path: file, out, count, maxSide }, { timeout: 5 * 60_000 });
    case 'extract-audio':
      return helper.request('extract-audio', { path: file, out, ...(start !== undefined ? { start } : {}), ...(length !== undefined ? { length } : {}) }, { timeout: 14 * 60_000 });
    case 'tap-start':
      return helper.request('tap-start', { target, ...(session ? { session } : {}) });
    case 'tap-stop':
      return helper.request('tap-stop', { session });
  }
  throw new Error('Unknown audio action.');
}

function setJobActivity(next) {
  jobActivity = next;
  // Results not yet seen, and connector cards waiting for an answer.
  const badge = (next.unseen || 0) + (next.waiting || 0);
  if (process.platform === 'darwin') app.dock?.setBadge(badge ? String(badge) : '');
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
  // New windows go to the browser: the app's own links, and web links clicked in made files (the viewer opens them
  // after a real click, src/lib/artifacts/links.ts). At most one a second, so nothing can flood the browser.
  let lastOpened = 0;
  current.webContents.setWindowOpenHandler(({ url }) => {
    const now = Date.now();
    if (now - lastOpened >= 1000) { lastOpened = now; openExternal(url); }
    return { action: 'deny' };
  });
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
// server sends the same sandboxing CSP) and reports script errors with screenshots.
// A deck with the player (src/lib/artifacts/deck.ts) is stepped through slide by
// slide and measured (overflow, slides visible at once); a page is shot at desktop
// and phone width and measured (sideways scroll, clipped height, small text). Other
// files: the first screens, pressing ArrowRight between them. The app phrases the
// measurements as problems (src/lib/artifacts/checks.ts).
const ARTIFACT_URL = /^\/api\/mulches\/[a-z0-9-]+\/(artifacts\/[a-z0-9][a-z0-9._-]*\.(html|svg)|model-view\/[a-f0-9]{64}\.(glb|gltf))$/;
const { VISIBLE_SLIDES, PAGE_MEASURE, renderOptions } = require('./lib/artifact-checks.cjs');
const MAX_DECK_SLIDES = 80;
const MAX_SHOTS = 12;
async function renderArtifact(url, options) {
  const { steps, kind } = renderOptions(options);
  let parsed;
  try { parsed = new URL(url, origin); } catch { throw new Error('Invalid page.'); }
  if (parsed.origin !== origin || !ARTIFACT_URL.test(parsed.pathname)) throw new Error('Only mulch artifacts and models can be rendered.');
  const size = kind === 'page' ? { width: 1280, height: 800 } : { width: 1280, height: 720 };
  const view = new BrowserWindow({ show: false, ...size, useContentSize: true, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const errors = [];
  view.webContents.on('console-message', (event) => { if (event.level === 'error' || event.level === 'warning') errors.push(String(event.message).slice(0, 300)); });
  view.webContents.on('render-process-gone', () => errors.push('The page crashed.'));
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  view.webContents.on('will-navigate', (event) => event.preventDefault());
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const run = (code, fallback) => view.webContents.executeJavaScript(code, true).catch(() => fallback);
  const shot = async (width = 960) => (await view.webContents.capturePage()).resize({ width }).toPNG().toString('base64');
  const images = [];
  const result = (extra = {}) => ({ images, errors: [...new Set(errors)].slice(0, 20), ...extra });
  try {
    await Promise.race([view.loadURL(parsed.href), wait(15_000)]);
    // 3D viewers load their model and libraries after the page itself.
    await wait(parsed.pathname.includes('/model-view/') ? 4000 : 900);
    if (kind === 'deck') {
      const info = await run('window.__mlchDeck ? { count: window.__mlchDeck.count, expected: window.__mlchDeck.expected } : null', null);
      const visibleAtLoad = await run(VISIBLE_SLIDES, 0);
      if (info) {
        const slides = [];
        const count = Math.min(MAX_DECK_SLIDES, info.count);
        for (let i = 0; i < count; i++) {
          await run(`window.__mlchDeck.go(${i})`);
          await wait(i === 0 ? 300 : 150);
          slides.push({ slide: i + 1, visible: await run(VISIBLE_SLIDES, 0), overflow: await run('window.__mlchDeck.overflow()', null) });
          if (images.length < MAX_SHOTS) images.push(await shot(count > 6 ? 640 : 960));
        }
        return result({ deck: { count: info.count, expected: info.expected, visibleAtLoad, slides } });
      }
      // A deck made by hand, without the player: its first screens.
      await stepThrough(view, steps, shot, wait, images);
      return result({ deck: { visibleAtLoad, slides: [] } });
    }
    if (kind === 'page') {
      const shots = [];
      for (const [width, height] of [[1280, 800], [390, 844]]) {
        if (shots.length) { view.setContentSize(width, height); await wait(500); }
        shots.push(await run(PAGE_MEASURE, { width, height, scrollWidth: width, scrollHeight: height, clipped: false, smallText: [] }));
        images.push(await shot(Math.min(960, width)));
      }
      return result({ page: { shots } });
    }
    await stepThrough(view, steps, shot, wait, images);
    return result();
  } finally {
    view.destroy();
  }
}

// App scenarios check made files the way preview_artifact does (scripts/scenarios/decks-pages.cjs).
if (process.env.MLCH_ELECTRON_USER_DATA) globalThis.__mlchRender = (url, options) => renderArtifact(url, options);

async function stepThrough(view, steps, shot, wait, images) {
  const count = Math.max(1, Math.min(8, steps));
  for (let i = 0; i < count; i++) {
    if (i > 0) {
      view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Right' });
      view.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Right' });
      await wait(700);
    }
    images.push(await shot());
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
  ipcMain.handle('desktop:update:state', guarded(() => ({ ...updateState, channel: updateChannel() })));
  ipcMain.handle('desktop:update:check', guarded(async () => {
    if (notifyOnly()) return checkNotify();
    if (!updater) return updateState;
    await updater.checkForUpdates().catch(() => {});
    return updateState;
  }));
  ipcMain.handle('desktop:update:download', guarded(() => downloadUpdate()));
  ipcMain.handle('desktop:update:prefs', guarded((patch) => {
    const next = setUpdatePrefs({
      ...(typeof patch?.autoDownload === 'boolean' ? { autoDownload: patch.autoDownload } : {}),
      ...(typeof patch?.notify === 'boolean' ? { notify: patch.notify } : {}),
      ...(typeof patch?.dismissed === 'string' ? { dismissed: patch.dismissed } : {}),
    });
    if (updater) {
      updater.autoDownload = next.autoDownload;
      // Turned on with an update waiting: fetch it now.
      if (next.autoDownload && updateState.status === 'available') downloadUpdate();
    }
    setUpdateState({ autoDownload: next.autoDownload, notify: next.notify, dismissed: next.dismissed });
    if (notifyOnly() && patch?.notify === true) void checkNotify();
    return updateState;
  }));
  ipcMain.handle('desktop:update:restart', guarded(() => restartToUpdate()));
  ipcMain.handle('desktop:update:channel', guarded((channel) => { setUpdateChannel(channel === 'beta' ? 'beta' : 'latest'); return updateChannel(); }));
  ipcMain.handle('desktop:update:seen', guarded(() => { const { updated: _seen, ...rest } = updateState; updateState = rest; }));
  ipcMain.handle('desktop:library:choose', guarded(async () => {
    try { return await chooseLibrary(); } catch (error) { log(error); return { ok: false, error: String(error?.message ?? error) }; }
  }));
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
      { label: 'Check for Updates…', enabled: updatesOn() || notifyOnly(), click: () => void checkForUpdatesNow() },
      ...(updatesOn() || notifyOnly() ? [{ label: 'Beta Updates', type: 'checkbox', checked: updateChannel() === 'beta', click: (item) => setUpdateChannel(item.checked ? 'beta' : 'latest') }] : []),
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
    // The tools the person's Terminal finds (ffmpeg, uv, node), for the server and the AI it runs.
    process.env.PATH = (await shellPath) || process.env.PATH;
    credentialStore = createCredentialStore(app.getPath('userData'), safeStorage, values => {
      redactor.add(values); backend?.post({ type: 'secrets', values });
    });
    const serverMessage = createServerMessageHandler({ shell, dialog, fs, getWindow: () => window, render: renderArtifact, notify: notifyJob, activity: setJobActivity, thumbnail: fileThumbnail, audio: audioRequest, storeAccount, log,
      // Pages look as they do in Chrome: the user agent without Electron's and mlch's names.
      screenshot: createScreenshotter({ BrowserWindow, session, userAgent: app.userAgentFallback.replace(/ (Electron|mlch)\/\S+/g, '') }) });
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('MLCH_ELECTRON_PORT must be a port number between 1 and 65535.');
    backend = createBackend({ fork: (...args) => utilityProcess.fork(...args),
      entry: path.join(__dirname, 'server.cjs'), diagnostics, onDisconnected: disconnected,
      options: () => ({ cwd: root, serviceName: 'mlch Server', stdio: 'pipe', env: {
        ...process.env,
        NODE_ENV: dev ? 'development' : 'production', MLCH_ELECTRON: '1',
        MLCH_ELECTRON_PORT: String(port), MLCH_ELECTRON_TOKEN: token,
        MLCH_LIBRARY: libraryDir(),
        MLCH_INDEX_DIR: process.env.MLCH_ELECTRON_USER_DATA ? '' : indexDir(),
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
    noteUpdatedVersion();
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
