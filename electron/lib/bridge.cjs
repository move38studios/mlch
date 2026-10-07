// Adapted from node-banana (MIT, © William Falloon).
// The Next server's side of the desktop bridge. The server runs in a utility
// process without Electron's APIs, so it asks main for native actions over
// parentPort and waits for the reply carrying the same id. electron/server.cjs
// exposes request() to route code as globalThis.__mlchDesktop
// (src/lib/desktop/server.ts); lib/bridge-main.cjs answers.
const BRIDGE_REQUESTS = new Set(['reveal', 'open', 'trash', 'choose-directory', 'render', 'thumbnail', 'notify', 'activity']);
const INGEST_PICKER_TITLE = 'Choose a folder';
const REQUEST_TIMEOUT_MS = 30_000;
// A folder picker waits on the user, not on main; this only bounds a lost reply
// (it matches the server's own request timeout).
const PICKER_TIMEOUT_MS = 600_000;

const PICKER_TITLES = { ingest: INGEST_PICKER_TITLE };

// GET /api/browse-directory?purpose=ingest picks a folder to build a mulch
// from; any other purpose keeps main's default title.
function browseDirectoryTitle(searchParams) {
  const purpose = searchParams.get('purpose');
  return Object.hasOwn(PICKER_TITLES, purpose ?? '') ? PICKER_TITLES[purpose] : undefined;
}

// Only the fields the contract names, as plain strings, cross the process
// boundary; anything else could not be cloned or would not be understood.
function bridgePayload(payload) {
  return {
    ...(typeof payload?.path === 'string' ? { path: payload.path } : {}),
    ...(typeof payload?.title === 'string' ? { title: payload.title } : {}),
    ...(typeof payload?.url === 'string' ? { url: payload.url } : {}),
    ...(Number.isInteger(payload?.steps) ? { steps: payload.steps } : {}),
    // mlch: thumbnails, job notifications and the activity count (main checks each again).
    ...(Number.isInteger(payload?.size) ? { size: payload.size } : {}),
    ...(typeof payload?.mulchId === 'string' ? { mulchId: payload.mulchId } : {}),
    ...(Array.isArray(payload?.ids) ? { ids: payload.ids.filter(id => typeof id === 'string').slice(0, 20) } : {}),
    ...(typeof payload?.body === 'string' ? { body: payload.body } : {}),
    ...(typeof payload?.failed === 'boolean' ? { failed: payload.failed } : {}),
    ...(Number.isInteger(payload?.working) ? { working: payload.working } : {}),
    ...(Number.isInteger(payload?.unseen) ? { unseen: payload.unseen } : {}),
  };
}

function bridgeResult(result) {
  if (result?.ok === true) return 'value' in result ? { ok: true, value: result.value } : { ok: true };
  return { ok: false, error: typeof result?.error === 'string' && result.error ? result.error : 'The desktop app could not complete that request.' };
}

function createBridgeClient({ post, timeoutMs = REQUEST_TIMEOUT_MS, pickerTimeoutMs = PICKER_TIMEOUT_MS }) {
  const pending = new Map();
  let lastId = 0;

  function settle(id, value) {
    const entry = pending.get(id);
    if (!entry) return false;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(value);
    return true;
  }

  // Posts `message` under a fresh id. main's reply settles it with its
  // `result`; so do a timeout (`fail('timeout')`), a failed post
  // (`fail('unavailable')`) and cancel(). Whatever comes second finds nothing.
  function send(message, { timeout = 0, fail }) {
    const id = ++lastId;
    let resolve;
    const result = new Promise(done => { resolve = done; });
    const timer = timeout > 0 ? setTimeout(() => settle(id, fail('timeout')), timeout) : undefined;
    timer?.unref?.();
    pending.set(id, { resolve, timer });
    try { post({ ...message, id }); }
    catch { settle(id, fail('unavailable')); }
    return { id, result, cancel: value => settle(id, value) };
  }

  // A reply from main. Returns whether it answered a waiting request.
  function receive(data) {
    return !!data && Number.isInteger(data.id) && settle(data.id, data.result);
  }

  async function request(type, payload) {
    if (!BRIDGE_REQUESTS.has(type)) return { ok: false, error: 'The desktop app does not handle that request.' };
    const call = send({ type: 'bridge', request: { type, payload: bridgePayload(payload) } }, {
      timeout: type === 'choose-directory' ? pickerTimeoutMs : type === 'render' || type === 'thumbnail' ? 60_000 : timeoutMs,
      fail: reason => ({ ok: false, error: reason === 'timeout' ? 'The desktop app did not answer in time.' : 'The desktop app is not reachable.' }),
    });
    return bridgeResult(await call.result);
  }

  // GET /api/browse-directory: the picker stays open as long as the user needs,
  // and the caller cancels it when the request closes. The reply keeps the web
  // route's { success, cancelled, path } shape.
  function pickDirectory({ title } = {}) {
    return send({ type: 'choose-directory', ...(title ? { title } : {}) }, {
      fail: () => ({ success: false, error: 'The folder picker could not open.' }),
    });
  }

  return { request, pickDirectory, receive, pending: () => pending.size };
}

module.exports = {
  BRIDGE_REQUESTS,
  INGEST_PICKER_TITLE,
  browseDirectoryTitle,
  createBridgeClient,
};
