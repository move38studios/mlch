// Sharing against a local own server: canvas live, a made file, and Open in mlch.
//   (cd cloud && npx wrangler dev --port 8788 --var SERVER_KEY:dev-key) &
//   MLCH_SCENARIO_LIBRARY=<tmp dir> node scripts/electron-run.cjs scripts/scenarios/share.cjs --library <tmp dir> --shots <dir>
// (mlch.app's sign-in and subscription: share-account.cjs.)
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

  // Shares go to the own server (address in Settings, key through the desktop shell as the page saves it).
  const server = process.env.MLCH_OWN_SERVER || 'http://localhost:8788';
  const moded = await api('/api/account', 'POST', { action: 'mode', mode: 'own', server });
  assert.equal(moded.status, 200, JSON.stringify(moded));
  assert.ok(await page.evaluate(async () => (await window.mlchDesktop.credentials.write({ shareKey: 'dev-key' })).ok));
  await page.waitForTimeout(300);

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
  // A page opens in the frame page (Full screen); the file itself is served sandboxed.
  const frame = await fetch(deck.share.url);
  assert.equal(frame.status, 200);
  assert.match(await frame.text(), /artifacts\/deck\.html/);
  const response = await fetch(`${deck.share.url}artifacts/deck.html`);
  assert.match(response.headers.get('content-security-policy') ?? '', /sandbox/);
  assert.match(await response.text(), /Seat pricing/);

  // A write-up (a call's transcript, say) on its own, as a page.
  await api(`/api/mulches/${mulch.id}/ops`, 'POST', { clientId: 's', ops: [
    { op: 'addNode', node: { id: 'w', kind: 'writeup', x: 600, y: 220, title: 'Call, 18 Oct', text: '**Me** (10:00) Per seat.\n\n**Them** (10:01) Agreed.', docPath: 'docs/call.md', origin: 'speech:call', createdAt: Date.now() } },
    // A comment never goes to a shared canvas.
    { op: 'addComment', comment: { id: 'c-1', nodeId: 'a', text: 'Private note to the AI', createdAt: Date.now() } },
  ] });
  const writeup = await api(`/api/mulches/${mulch.id}/shares`, 'POST', { kind: 'artifact', nodeId: 'w' });
  assert.equal(writeup.status, 200, JSON.stringify(writeup));
  const writtenPage = await (await fetch(`${writeup.share.url}docs/call.html`)).text();
  assert.match(writtenPage, /<strong>Me<\/strong> \(10:00\) Per seat\./);
  // Sharing the canvas again sends a fresh snapshot: still without the comment.
  assert.equal((await api(`/api/mulches/${mulch.id}/shares`, 'POST', { kind: 'mulch' })).status, 200);
  const snapshot = await (await fetch(`${share.url}snapshot.json`)).json();
  assert.ok(snapshot.nodes.w, 'the write-up is on the shared canvas');
  assert.equal(snapshot.comments, undefined, 'comments are not shared');

  // Open in mlch: a copy as a new mulch.
  const manifestUrl = share.manifestUrl;
  const opened = await api('/api/import', 'POST', { manifest: manifestUrl });
  assert.equal(opened.status, 200, JSON.stringify(opened));
  const copy = (await api(`/api/mulches/${opened.mulchId}`)).mulch;
  assert.equal(copy.title, 'Pricing call');
  assert.equal(Object.keys(copy.nodes).length, 5);
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
