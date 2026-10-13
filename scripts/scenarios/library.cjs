// Settings > Library > Change: the mulches move to the chosen folder and the app carries on there; the index stays with the app.
//   node scripts/electron-run.cjs scripts/scenarios/library.cjs --free-library
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

module.exports = async ({ app, page, base, shot }) => {
  const api = (url, method = 'GET', body) => page.evaluate(async ({ url, method, body }) => {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  }, { url, method, body });
  await page.goto(base);
  await api('/api/onboarding', 'POST', { action: 'done' });
  const mulch = (await api('/api/mulches', 'POST', {})).mulch;
  await api(`/api/mulches/${mulch.id}/ops`, 'POST', { ops: [{ op: 'setTitle', title: 'Moves along' }, { op: 'addNode', node: { id: 'n-1', kind: 'idea', x: 0, y: 0, text: 'Keep me', origin: 'user', createdAt: 1 } }] });
  const before = (await api('/api/settings')).library;
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'mlch-synced-'));
  // The folder picker and the question, answered as a person would.
  await app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
    dialog.showMessageBox = async () => ({ response: 0 });
  }, target);
  await page.goto(`${base}/settings`);
  await page.getByRole('button', { name: 'Change library folder' }).click();
  // The server restarts on the new folder: wait until it answers from there.
  await page.waitForFunction(async (target) => {
    try {
      return (await (await fetch('/api/settings')).json()).library === target;
    } catch {
      return false;
    }
  }, target, { timeout: 60_000, polling: 1000 });
  // Main reloads Settings once the server is back.
  await page.waitForTimeout(2500);
  await page.getByRole('heading', { name: 'Settings' }).waitFor();
  assert.ok(fs.existsSync(path.join(target, mulch.id, 'mulch.json')), 'the mulch is in the new folder');
  assert.ok(!fs.existsSync(path.join(before, mulch.id)), 'and no longer in the old one');
  assert.ok(!fs.existsSync(path.join(target, '.index.sqlite')), 'no index in the library');
  const list = (await api('/api/mulches')).mulches;
  assert.ok(list.some((m) => m.title === 'Moves along'), 'the app lists it from there');
  const hits = (await api(`/api/search?q=${encodeURIComponent('Keep me')}`)).hits;
  assert.ok(hits?.length, 'search works on the new folder');
  await shot('library');
  console.log('library ok', before, '->', target);
};
