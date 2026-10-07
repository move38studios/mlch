const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { INGEST_PICKER_TITLE, browseDirectoryTitle, createBridgeClient } = require('../lib/bridge.cjs');
const { DEFAULT_PICKER_TITLE, createServerMessageHandler } = require('../lib/bridge-main.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function client(options = {}) {
  const posted = [];
  const bridge = createBridgeClient({ post: message => posted.push(message), ...options });
  return { bridge, posted };
}

function main({ platform, window } = {}) {
  const calls = { shown: [], trashed: [], dialogs: [], logged: [] };
  const shell = {
    showItemInFolder: file => calls.shown.push(file),
    trashItem: async file => { if (shell.refuse) throw new Error('No trash on this volume'); calls.trashed.push(file); },
  };
  const dialog = { showOpenDialog: async (...args) => { calls.dialogs.push(args); return { canceled: false, filePaths: ['/picked'] }; } };
  const handle = createServerMessageHandler({ shell, dialog, fs, getWindow: () => window, log: error => calls.logged.push(error), platform });
  return { handle, shell, dialog, calls };
}

function withTemp(run) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'npkn-bridge-'));
  return Promise.resolve(run(temp)).finally(() => fs.rmSync(temp, { recursive: true, force: true }));
}

test('requests travel under their own ids and settle from the matching reply', async () => {
  const { bridge, posted } = client();
  const reveal = bridge.request('reveal', { path: '/a.png', title: 7, extra: () => {} });
  const trash = bridge.request('trash', { path: '/b.png' });
  assert.deepEqual(posted, [
    { type: 'bridge', id: 1, request: { type: 'reveal', payload: { path: '/a.png' } } },
    { type: 'bridge', id: 2, request: { type: 'trash', payload: { path: '/b.png' } } },
  ]);
  assert.equal(bridge.pending(), 2);
  // Replies may arrive in any order; unknown and repeated ids are ignored.
  assert.equal(bridge.receive({ type: 'bridge-result', id: 2, result: { ok: false, error: 'Busy' } }), true);
  assert.equal(bridge.receive({ type: 'bridge-result', id: 2, result: { ok: true } }), false);
  assert.equal(bridge.receive({ id: 99, result: { ok: true } }), false);
  for (const junk of [null, undefined, {}, { id: '1' }]) assert.equal(bridge.receive(junk), false);
  bridge.receive({ type: 'bridge-result', id: 1, result: { ok: true, value: { shown: true } } });
  assert.deepEqual(await reveal, { ok: true, value: { shown: true } });
  assert.deepEqual(await trash, { ok: false, error: 'Busy' });
  assert.equal(bridge.pending(), 0);
});

test('replies are normalised to the DesktopServerBridge result shape', async () => {
  const { bridge, posted } = client();
  const answer = result => { const pending = bridge.request('reveal', { path: '/a' }); bridge.receive({ id: posted.at(-1).id, result }); return pending; };
  assert.deepEqual(await answer({ ok: true }), { ok: true });
  assert.deepEqual(await answer({ ok: true, value: null }), { ok: true, value: null });
  assert.deepEqual(await answer({ ok: false }), { ok: false, error: 'The desktop app could not complete that request.' });
  assert.deepEqual(await answer({ success: true }), { ok: false, error: 'The desktop app could not complete that request.' });
  assert.deepEqual(await answer(undefined), { ok: false, error: 'The desktop app could not complete that request.' });
});

test('a request main never answers times out, and a folder picker waits longer', async () => {
  const { bridge, posted } = client({ timeoutMs: 10, pickerTimeoutMs: 200 });
  const started = Date.now();
  assert.deepEqual(await bridge.request('trash', { path: '/a' }), { ok: false, error: 'The desktop app did not answer in time.' });
  assert.ok(Date.now() - started >= 9);
  assert.equal(bridge.pending(), 0);
  assert.equal(bridge.receive({ id: posted[0].id, result: { ok: true } }), false);
  const picked = bridge.request('choose-directory', { title: 'Pick' });
  await delay(30);
  assert.equal(bridge.pending(), 1);
  bridge.receive({ id: posted[1].id, result: { ok: true, value: { cancelled: false, path: '/chosen' } } });
  assert.deepEqual(await picked, { ok: true, value: { cancelled: false, path: '/chosen' } });
  assert.deepEqual(posted[1].request, { type: 'choose-directory', payload: { title: 'Pick' } });
});

test('unknown requests and an unreachable main fail without waiting', async () => {
  const { bridge, posted } = client();
  for (const type of ['launch', '__proto__', undefined]) assert.deepEqual(await bridge.request(type, {}), { ok: false, error: 'The desktop app does not handle that request.' });
  assert.equal(posted.length, 0);
  const closed = createBridgeClient({ post: () => { throw new Error('Port closed'); } });
  assert.deepEqual(await closed.request('reveal', { path: '/a' }), { ok: false, error: 'The desktop app is not reachable.' });
  assert.equal(closed.pending(), 0);
  assert.deepEqual(await closed.pickDirectory().result, { success: false, error: 'The folder picker could not open.' });
});

test('the browse-directory picker keeps its reply shape and is cancelled by a closed request', async () => {
  const { bridge, posted } = client({ timeoutMs: 1, pickerTimeoutMs: 1 });
  const picker = bridge.pickDirectory({ title: browseDirectoryTitle(new URLSearchParams('purpose=ingest')) });
  const plain = bridge.pickDirectory({ title: browseDirectoryTitle(new URLSearchParams('purpose=project')) });
  assert.deepEqual(posted, [{ type: 'choose-directory', id: 1, title: INGEST_PICKER_TITLE }, { type: 'choose-directory', id: 2 }]);
  assert.equal(browseDirectoryTitle(new URLSearchParams('')), undefined);
  // Export and "Save a copy…" ask for a destination, not a workflow folder.
  // "Find projects in a folder…" asks for a folder of projects, as the web route does.
  // The user may browse for as long as the request stays open.
  await delay(20);
  bridge.receive({ id: 1, result: { success: true, cancelled: false, path: '/library' } });
  assert.deepEqual(await picker.result, { success: true, cancelled: false, path: '/library' });
  assert.equal(plain.cancel({ success: true, cancelled: true, path: null }), true);
  assert.deepEqual(await plain.result, { success: true, cancelled: true, path: null });
  assert.equal(bridge.receive({ id: 2, result: { success: true, cancelled: false, path: '/late' } }), false);
  assert.equal(plain.cancel({}), false);
});

test('main reveals existing paths only', () => withTemp(async temp => {
  const file = path.join(temp, 'image.png');
  fs.writeFileSync(file, 'png');
  const { handle, calls } = main();
  assert.deepEqual(await handle({ type: 'bridge', id: 1, request: { type: 'reveal', payload: { path: file } } }), { type: 'bridge-result', id: 1, result: { ok: true } });
  assert.deepEqual(await handle({ type: 'bridge', id: 2, request: { type: 'reveal', payload: { path: temp } } }), { type: 'bridge-result', id: 2, result: { ok: true } });
  assert.deepEqual(calls.shown, [file, temp]);
  const refused = async payload => (await handle({ type: 'bridge', id: 3, request: { type: 'reveal', payload } })).result;
  assert.deepEqual(await refused({ path: path.join(temp, 'gone.png') }), { ok: false, error: 'That file is no longer on disk.' });
  for (const payload of [{ path: 'image.png' }, { path: `${temp}${path.sep}..${path.sep}${path.basename(temp)}${path.sep}image.png` }, { path: `${file}\0` }, { path: '' }, { path: 42 }, {}, null]) {
    assert.deepEqual(await refused(payload), { ok: false, error: 'Show in folder needs a full path.' });
  }
  assert.equal(calls.shown.length, 2);
}));

test('main moves only a single existing file to the trash', () => withTemp(async temp => {
  const file = path.join(temp, 'clip.mp4');
  fs.writeFileSync(file, 'mp4');
  const { handle, shell, calls } = main();
  const trash = async target => (await handle({ type: 'bridge', id: 1, request: { type: 'trash', payload: { path: target } } })).result;
  assert.deepEqual(await trash(file), { ok: true });
  assert.deepEqual(calls.trashed, [file]);
  assert.deepEqual(await trash(temp), { ok: false, error: 'Only a single file can be moved to the Trash.' });
  assert.deepEqual(await trash(path.join(temp, 'gone.mp4')), { ok: false, error: 'That file is no longer on disk.' });
  assert.deepEqual(await trash('clip.mp4'), { ok: false, error: 'Moving to the Trash needs the full path of a file.' });
  if (process.platform !== 'win32') {
    const link = path.join(temp, 'link.mp4');
    fs.symlinkSync(file, link);
    assert.deepEqual(await trash(link), { ok: false, error: 'Only a single file can be moved to the Trash.' });
  }
  shell.refuse = true;
  assert.deepEqual(await trash(file), { ok: false, error: 'The file could not be moved to the Trash.' });
  assert.equal(calls.logged.length, 1);
  assert.deepEqual(calls.trashed, [file]);
  const windows = main({ platform: 'win32' });
  assert.deepEqual((await windows.handle({ type: 'bridge', id: 2, request: { type: 'trash', payload: { path: temp } } })).result, { ok: false, error: 'Only a single file can be moved to the Recycle Bin.' });
}));

test('main opens the folder picker with the requested title, in both message forms', async () => {
  const window = { id: 'window' };
  const { handle, dialog, calls } = main({ window });
  assert.deepEqual(await handle({ type: 'bridge', id: 1, request: { type: 'choose-directory', payload: { title: INGEST_PICKER_TITLE } } }),
    { type: 'bridge-result', id: 1, result: { ok: true, value: { cancelled: false, path: '/picked' } } });
  assert.deepEqual(calls.dialogs[0], [window, { title: INGEST_PICKER_TITLE, properties: ['openDirectory', 'createDirectory'] }]);
  assert.deepEqual(await handle({ type: 'choose-directory', id: 2 }), { id: 2, result: { success: true, cancelled: false, path: '/picked' } });
  assert.equal(calls.dialogs[1][1].title, DEFAULT_PICKER_TITLE);
  await handle({ type: 'choose-directory', id: 3, title: INGEST_PICKER_TITLE });
  await handle({ type: 'bridge', id: 4, request: { type: 'choose-directory', payload: { title: '   ' } } });
  assert.deepEqual(calls.dialogs.slice(2).map(args => args[1].title), [INGEST_PICKER_TITLE, DEFAULT_PICKER_TITLE]);
  // A stub installed after start-up (the smoke test's) is the one used.
  dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  assert.deepEqual(await handle({ type: 'choose-directory', id: 5 }), { id: 5, result: { success: true, cancelled: true, path: null } });
  dialog.showOpenDialog = async () => { throw new Error('No display'); };
  assert.deepEqual(await handle({ type: 'choose-directory', id: 6 }), { id: 6, result: { success: false, error: 'The folder picker could not open.' } });
  assert.deepEqual(await handle({ type: 'bridge', id: 7, request: { type: 'choose-directory', payload: {} } }),
    { type: 'bridge-result', id: 7, result: { ok: false, error: 'The folder picker could not open.' } });
  // Without a window the picker opens unparented.
  const detached = main();
  await detached.handle({ type: 'choose-directory', id: 8 });
  assert.equal(detached.calls.dialogs[0].length, 1);
});

test('main ignores what it does not answer and never throws', async () => {
  const { handle, shell } = main();
  for (const message of [null, 'bridge', { type: 'bridge' }, { type: 'bridge', id: '1' }, { type: 'log', id: 1 }, { type: 'ready', id: 1 }]) assert.equal(await handle(message), undefined);
  for (const request of [undefined, null, { type: 'launch' }, { type: 'constructor' }, { type: '__proto__', payload: 'x' }]) {
    assert.deepEqual(await handle({ type: 'bridge', id: 1, request }), { type: 'bridge-result', id: 1, result: { ok: false, error: 'The desktop app does not handle that request.' } });
  }
  shell.showItemInFolder = () => { throw new Error('Finder is busy'); };
  assert.deepEqual((await handle({ type: 'bridge', id: 2, request: { type: 'reveal', payload: { path: __filename } } })).result, { ok: false, error: 'The file could not be shown in its folder.' });
});

test('the server client and main agree on the wire protocol', () => withTemp(async temp => {
  const file = path.join(temp, 'image.png');
  fs.writeFileSync(file, 'png');
  const { handle, calls } = main({ window: {} });
  let bridge;
  bridge = createBridgeClient({ post: message => { void handle(structuredClone(message)).then(reply => reply && bridge.receive(structuredClone(reply))); } });
  assert.deepEqual(await bridge.request('reveal', { path: file }), { ok: true });
  assert.deepEqual(await bridge.request('trash', { path: file }), { ok: true });
  assert.deepEqual(await bridge.request('choose-directory', { title: INGEST_PICKER_TITLE }), { ok: true, value: { cancelled: false, path: '/picked' } });
  assert.deepEqual(await bridge.pickDirectory({ title: INGEST_PICKER_TITLE }).result, { success: true, cancelled: false, path: '/picked' });
  assert.deepEqual(await bridge.request('reveal', { path: 'relative.png' }), { ok: false, error: 'Show in folder needs a full path.' });
  assert.deepEqual(calls.shown, [file]);
  assert.deepEqual(calls.trashed, [file]);
  assert.deepEqual(calls.dialogs.map(args => args[1].title), [INGEST_PICKER_TITLE, INGEST_PICKER_TITLE]);
  assert.equal(bridge.pending(), 0);
}));
