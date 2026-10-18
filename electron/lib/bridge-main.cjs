// Adapted from node-banana (MIT, © William Falloon).
// Main's side of the desktop bridge (lib/bridge.cjs is the server's): native
// actions the Next server cannot take from its utility process. The server has
// already resolved and checked every path; main still accepts only an absolute,
// existing target, and never throws, so a bad request cannot take main down.
const os = require('node:os');
const path = require('node:path');

const DEFAULT_PICKER_TITLE = 'Choose a folder';

function createServerMessageHandler({ shell, dialog, fs, getWindow, render, notify, activity, thumbnail, audio, storeAccount, screenshot, log = () => {}, platform = process.platform }) {
  const bin = platform === 'win32' ? 'Recycle Bin' : 'Trash';
  const fail = error => ({ ok: false, error });

  function pickerTitle(title) {
    return typeof title === 'string' && title.trim() ? title.trim().slice(0, 200) : DEFAULT_PICKER_TITLE;
  }

  // dialog is read at call time, so a test that stubs showOpenDialog in main
  // (scripts/electron-smoke.cjs) is honoured.
  async function chooseDirectory(title) {
    const window = getWindow();
    const options = { title: pickerTitle(title), properties: ['openDirectory', 'createDirectory'] };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    return { cancelled: result.canceled === true, path: result.filePaths?.[0] || null };
  }

  // An absolute path with no parent-directory segments, or nothing.
  function target(payload) {
    const value = payload?.path;
    if (typeof value !== 'string' || !value || value.includes('\0') || !path.isAbsolute(value)) return undefined;
    if (value.split(/[\\/]/).includes('..')) return undefined;
    return path.normalize(value);
  }

  async function perform(request) {
    const payload = request?.payload && typeof request.payload === 'object' ? request.payload : {};
    switch (request?.type) {
      case 'reveal': {
        const file = target(payload);
        if (!file) return fail('Show in folder needs a full path.');
        if (!fs.existsSync(file)) return fail('That file is no longer on disk.');
        shell.showItemInFolder(file);
        return { ok: true };
      }
      case 'open': {
        // mlch: open a mulch file in its default app.
        const file = target(payload);
        if (!file) return fail('Opening a file needs a full path.');
        let stat;
        try { stat = fs.statSync(file); } catch { return fail('That file is no longer on disk.'); }
        if (!stat.isFile()) return fail('Only a file can be opened.');
        const error = await shell.openPath(file);
        return error ? fail(error) : { ok: true };
      }
      case 'open-url': {
        // mlch: a note from a linked Obsidian vault, opened in Obsidian.
        const url = typeof payload.url === 'string' ? payload.url : '';
        if (!/^obsidian:\/\/open\?vault=[^&\s]+&file=[^&\s]+$/.test(url)) return fail('Only an Obsidian note link can be opened.');
        await shell.openExternal(url);
        return { ok: true };
      }
      case 'render': {
        // mlch: screenshots of an artifact page for the agent (see main.cjs renderArtifact).
        if (!render) return fail('Rendering is not available.');
        return { ok: true, value: await render(payload.url, { steps: payload.steps, kind: payload.kind }) };
      }
      case 'trash': {
        const file = target(payload);
        if (!file) return fail(`Moving to the ${bin} needs the full path of a file.`);
        let stat;
        try { stat = fs.lstatSync(file); } catch { return fail('That file is no longer on disk.'); }
        // Never a folder, and never through a link to somewhere else.
        if (!stat.isFile()) return fail(`Only a single file can be moved to the ${bin}.`);
        await shell.trashItem(file);
        return { ok: true };
      }
      case 'choose-directory':
        return { ok: true, value: await chooseDirectory(payload.title) };
      case 'thumbnail': {
        // mlch: a Quick Look preview of a deck or document, as PNG (base64).
        if (!thumbnail) return fail('Previews are not available.');
        const file = target(payload);
        if (!file) return fail('A preview needs a full path.');
        let stat;
        try { stat = fs.statSync(file); } catch { return fail('That file is no longer on disk.'); }
        if (!stat.isFile()) return fail('Only a file has a preview.');
        const size = Number.isInteger(payload.size) ? Math.min(Math.max(payload.size, 64), 1600) : 800;
        return { ok: true, value: await thumbnail(file, size) };
      }
      case 'notify': {
        // mlch: a finished job (see main.cjs notifyJob).
        if (!notify) return fail('Notifications are not available.');
        const text = value => (typeof value === 'string' ? value.slice(0, 200) : '');
        const mulchId = typeof payload.mulchId === 'string' && /^[a-z0-9-]{1,64}$/i.test(payload.mulchId) ? payload.mulchId : undefined;
        if (!mulchId) return fail('A notification needs a mulch.');
        const ids = Array.isArray(payload.ids) ? payload.ids.filter(id => typeof id === 'string' && /^[\w-]{1,64}$/.test(id)).slice(0, 20) : [];
        const quietIn = Array.isArray(payload.quietIn) ? payload.quietIn.filter(id => typeof id === 'string' && /^[a-z0-9-]{1,64}$/i.test(id)).slice(0, 200) : [];
        notify({ mulchId, ids, title: text(payload.title), body: text(payload.body), failed: payload.failed === true, quietIn });
        return { ok: true };
      }
      case 'activity': {
        // mlch: work running and results not yet seen, for the Dock badge and quitting.
        if (!activity) return fail('Not available.');
        const count = value => (Number.isInteger(value) && value >= 0 ? Math.min(value, 999) : 0);
        activity({ working: count(payload.working), unseen: count(payload.unseen) });
        return { ok: true };
      }
      case 'audio': {
        // mlch: the native audio helper (see main.cjs and lib/audio-helper.cjs).
        if (!audio) return fail('Local audio is not available.');
        const action = payload.action;
        if (!['status', 'download', 'warm', 'transcribe', 'media-info', 'frames', 'extract-audio', 'tap-start', 'tap-stop'].includes(action)) return fail('Unknown audio action.');
        const request = { action };
        if (['transcribe', 'media-info', 'frames', 'extract-audio'].includes(action)) {
          const file = target(payload);
          if (!file) return fail('Reading a recording needs its full path.');
          request.path = file;
        }
        if (action === 'frames' || action === 'extract-audio') {
          // Pictures and sound go only to a fresh place in the temporary folder.
          const out = target({ path: payload.out });
          const tmp = path.resolve(os.tmpdir());
          if (!out || !(out + path.sep).startsWith(tmp + path.sep) || out === tmp) return fail('Pictures and sound go in the temporary folder.');
          request.out = out;
          if (action === 'frames') {
            request.count = Number.isInteger(payload.count) ? Math.min(Math.max(payload.count, 1), 60) : 8;
            request.maxSide = Number.isInteger(payload.maxSide) ? Math.min(Math.max(payload.maxSide, 128), 2048) : 768;
          } else {
            if (Number.isFinite(payload.start) && payload.start >= 0) request.start = payload.start;
            if (Number.isFinite(payload.length) && payload.length > 0) request.length = payload.length;
          }
        }
        if (action === 'tap-start') {
          const t = payload.target;
          if (t !== undefined && !(t === 'all' || (Number.isInteger(t) && t > 0) || (typeof t === 'string' && /^[A-Za-z0-9.-]{3,200}$/.test(t)))) return fail('Capture target is "all", a bundle id or a process id.');
          request.target = t ?? 'all';
        }
        if (action === 'tap-start' || action === 'tap-stop') {
          if (payload.session !== undefined && !(typeof payload.session === 'string' && /^[\w-]{1,64}$/.test(payload.session))) return fail('Invalid capture session.');
          if (action === 'tap-stop' && !payload.session) return fail('Stopping a capture needs its session.');
          if (payload.session) request.session = payload.session;
        }
        // The helper's own messages are plain sentences for the person; pass them on.
        try { return { ok: true, value: await audio(request) }; }
        catch (error) { log(error); return fail(error?.message || 'The audio helper could not complete that request.'); }
      }
      case 'screenshot': {
        // mlch: a web page for the AI's screenshot_page (lib/screenshot.cjs checks the address again).
        if (!screenshot) return fail('Screenshots are not available.');
        if (typeof payload.url !== 'string' || !/^https?:\/\//i.test(payload.url)) return fail('Only web pages (http or https).');
        try { return { ok: true, value: await screenshot(payload.url, { width: payload.width, height: payload.height }) }; }
        catch (error) { return fail(error?.message || 'The page could not be captured.'); }
      }
      case 'account-token': {
        // mlch: the mlch.app session after sign-in (or null on sign-out), kept in Keychain like the keys.
        if (!storeAccount) return fail('Not available.');
        const value = payload.token;
        if (!(value === null || (typeof value === 'string' && /^[\w-]{20,200}$/.test(value)))) return fail('Not a session.');
        storeAccount(value);
        return { ok: true };
      }
      default:
        return fail('The desktop app does not handle that request.');
    }
  }

  const failures = {
    reveal: 'The file could not be shown in its folder.',
    open: 'The file could not be opened.',
    render: 'The page could not be rendered.',
    thumbnail: 'No preview could be made for that file.',
    audio: 'The audio helper could not complete that request.',
    trash: `The file could not be moved to the ${bin}.`,
    'choose-directory': 'The folder picker could not open.',
  };

  // One message from the server; resolves to the reply to post back, or
  // undefined when the message is not a request main answers.
  //   { type: 'choose-directory', id, title? } → { id, result: { success, cancelled, path } | { success: false, error } }
  //   { type: 'bridge', id, request: { type, payload } } → { type: 'bridge-result', id, result: { ok, value? } | { ok: false, error } }
  return async function handleServerMessage(message) {
    if (!message || typeof message !== 'object' || !Number.isInteger(message.id)) return undefined;
    if (message.type === 'choose-directory') {
      try { return { id: message.id, result: { success: true, ...(await chooseDirectory(message.title)) } }; }
      catch (error) { log(error); return { id: message.id, result: { success: false, error: failures['choose-directory'] } }; }
    }
    if (message.type === 'bridge') {
      let result;
      try { result = await perform(message.request); }
      catch (error) {
        log(error);
        const type = message.request?.type;
        result = fail(Object.hasOwn(failures, type) ? failures[type] : 'The desktop app could not complete that request.');
      }
      return { type: 'bridge-result', id: message.id, result };
    }
    return undefined;
  };
}

module.exports = { DEFAULT_PICKER_TITLE, createServerMessageHandler };
