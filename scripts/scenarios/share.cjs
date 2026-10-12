// Sharing against a local Worker: canvas live, a made file, and Open in mlch.
//   (cd cloud && npm run dev) &
//   MLCH_SHARE_URL=http://localhost:8787 node scripts/electron-run.cjs scripts/scenarios/share.cjs --library <tmp dir> --shots <dir>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ app, page, base, shot }) => {
  const library = process.env.MLCH_SCENARIO_LIBRARY;
  assert.ok(library, 'set MLCH_SCENARIO_LIBRARY to the --library dir');
  const api = (url, method = 'GET', body) => page.evaluate(async ({ url, method, body }) => {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  }, { url, method, body });
  const node = (id, text, extra = {}) => ({ id, kind: 'idea', x: 0, y: 0, text, origin: 'user', createdAt: Date.now(), ...extra });

  const mulch = (await api('/api/mulches', 'POST', {})).mulch;
  fs.mkdirSync(path.join(library, mulch.id, 'artifacts'), { recursive: true });
  fs.writeFileSync(path.join(library, mulch.id, 'artifacts', 'deck.html'), '<!doctype html><title>Deck</title><body style="font:40px system-ui;padding:60px"><h1>Seat pricing</h1><p>One idea per slide.</p></body>');
  await api(`/api/mulches/${mulch.id}/ops`, 'POST', { clientId: 's', ops: [
    { op: 'setTitle', title: 'Pricing call' },
    { op: 'addNode', node: node('a', 'Per seat, not per minute', { x: 0, y: 0 }) },
    { op: 'addNode', node: node('b', 'Teams buy seats', { x: 320, y: 40, origin: 'agent:x', kind: 'example' }) },
    { op: 'addNode', node: { id: 'd', kind: 'artifact', x: 0, y: 220, title: 'Deck', text: '', docPath: 'artifacts/deck.html', fileName: 'deck.html', origin: 'agent:x', createdAt: Date.now() } },
    { op: 'addEdge', edge: { id: 'e', source: 'a', target: 'b', label: 'example', origin: 'agent:x', createdAt: Date.now() } },
  ] });

  // The canvas, live.
  const shared = await api(`/api/mulches/${mulch.id}/shares`, 'POST', { kind: 'mulch' });
  assert.equal(shared.status, 200, JSON.stringify(shared));
  const share = shared.share;
  assert.ok(share.live && share.url.includes('/s/'));
  assert.equal(share.ownerToken, undefined, 'the page never sees the owner token');

  const viewer = await new Promise((resolve) => {
    app.once('window', resolve);
    app.evaluate(({ BrowserWindow }, url) => { new BrowserWindow({ width: 1280, height: 800 }).loadURL(url); }, share.url);
  });
  await viewer.waitForSelector('.react-flow__node', { timeout: 30_000 });
  await viewer.waitForTimeout(800);
  await shot('share-viewer-before').catch(() => {});
  await viewer.screenshot({ path: path.join(process.env.MLCH_SCENARIO_SHOTS || '/tmp', 'share-viewer.png') });

  // A change in the app reaches the viewer.
  await api(`/api/mulches/${mulch.id}/ops`, 'POST', { clientId: 's', ops: [{ op: 'addNode', node: node('c', 'Live from the call', { x: 0, y: -160 }) }] });
  await viewer.waitForSelector('text=Live from the call', { timeout: 10_000 });
  await viewer.screenshot({ path: path.join(process.env.MLCH_SCENARIO_SHOTS || '/tmp', 'share-viewer-live.png') });

  // A made file on its own.
  const deck = await api(`/api/mulches/${mulch.id}/shares`, 'POST', { kind: 'artifact', nodeId: 'd' });
  assert.equal(deck.status, 200, JSON.stringify(deck));
  const response = await fetch(deck.share.url);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy') ?? '', /sandbox/);
  assert.match(await response.text(), /Seat pricing/);

  // Open in mlch: a copy as a new mulch.
  const manifestUrl = share.manifestUrl;
  const opened = await api('/api/import', 'POST', { manifest: manifestUrl });
  assert.equal(opened.status, 200, JSON.stringify(opened));
  const copy = (await api(`/api/mulches/${opened.mulchId}`)).mulch;
  assert.equal(copy.title, 'Pricing call');
  assert.equal(Object.keys(copy.nodes).length, 4);
  assert.ok(fs.existsSync(path.join(library, opened.mulchId, 'artifacts', 'deck.html')), 'files come along');

  // Stop, then delete.
  const stopped = await api(`/api/mulches/${mulch.id}/shares/${share.id}`, 'PATCH', { live: false });
  assert.equal(stopped.shares.find((s) => s.id === share.id).live, false);
  await viewer.waitForTimeout(1500);
  await viewer.screenshot({ path: path.join(process.env.MLCH_SCENARIO_SHOTS || '/tmp', 'share-viewer-ended.png') });
  await api(`/api/mulches/${mulch.id}/shares/${share.id}`, 'DELETE');
  assert.equal((await fetch(share.manifestUrl)).status, 404);

  // The menu in the app.
  await page.goto(`${base}/n/${mulch.id}`);
  await page.waitForSelector('[aria-label="Share"]');
  await page.click('[aria-label="Share"]');
  await page.waitForSelector('.float >> text=items');
  await shot('share-menu');
  console.log('share ok');
};
