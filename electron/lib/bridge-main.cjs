// Adapted from node-banana (MIT, © William Falloon).
// Main's side of the desktop bridge (lib/bridge.cjs is the server's): native
// actions the Next server cannot take from its utility process. The server has
// already resolved and checked every path; main still accepts only an absolute,
// existing target, and never throws, so a bad request cannot take main down.
const path = require('node:path');

const DEFAULT_PICKER_TITLE = 'Choose a folder';

function createServerMessageHandler({ shell, dialog, fs, getWindow, render, log = () => {}, platform = process.platform }) {
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
        // Mulch: open a mulch file in its default app.
        const file = target(payload);
        if (!file) return fail('Opening a file needs a full path.');
        let stat;
        try { stat = fs.statSync(file); } catch { return fail('That file is no longer on disk.'); }
        if (!stat.isFile()) return fail('Only a file can be opened.');
        const error = await shell.openPath(file);
        return error ? fail(error) : { ok: true };
      }
      case 'render': {
        // Mulch: screenshots of an artifact page for the agent (see main.cjs renderArtifact).
        if (!render) return fail('Rendering is not available.');
        return { ok: true, value: await render(payload.url, payload.steps) };
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
      default:
        return fail('The desktop app does not handle that request.');
    }
  }

  const failures = {
    reveal: 'The file could not be shown in its folder.',
    open: 'The file could not be opened.',
    render: 'The page could not be rendered.',
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
