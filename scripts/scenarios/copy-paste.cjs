// Copy, paste and duplicate cards (any kind, files too, connections kept, into another mulch);
// empty post-its stay; nothing on the canvas is tilted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ app, page, base, shot }) => {
  const api = (url, method = 'GET', body) => page.evaluate(async ({ url, method, body }) => {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  }, { url, method, body });
  const library = process.argv[process.argv.indexOf('--library') + 1];
  const command = (name) => app.evaluate(({ BrowserWindow }, name) => BrowserWindow.getAllWindows().find((w) => w.isVisible())?.webContents[name](), name);
  const nodes = async (id) => Object.values((await api(`/api/mulches/${id}`)).mulch.nodes);
  const edges = async (id) => Object.values((await api(`/api/mulches/${id}`)).mulch.edges);
  const mulchOf = async (id) => (await api(`/api/mulches/${id}`)).mulch;
  const until = async (check, what, ms = 8000) => {
    for (const end = Date.now() + ms; ; await page.waitForTimeout(100)) {
      if (await check()) return;
      if (Date.now() > end) throw new Error(`timed out: ${what}`);
    }
  };
  const count = (id, n) => until(async () => Object.keys((await mulchOf(id)).nodes).length === n, `${n} cards`);

  // The system clipboard is the person's: put it back afterwards.
  const saved = await app.evaluate(({ clipboard }) => clipboard.readText());
  try {
    await run();
  } finally {
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), saved);
  }

  async function run() {
  const one = (await api('/api/mulches', 'POST', {})).mulch;
  const other = (await api('/api/mulches', 'POST', {})).mulch;
  // A made file and a picture with real files behind them.
  const dir = path.join(library, one.id);
  fs.mkdirSync(path.join(dir, 'artifacts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'artifacts', 'plan.html'), '<!doctype html><meta name="mlch:kind" content="page"><h1>Plan</h1>');
  const asset = `${'b'.repeat(64)}.svg`;
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'assets', asset), '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><rect width="200" height="120" fill="#333"/></svg>');
  await api(`/api/mulches/${one.id}/ops`, 'POST', {
    ops: [
      { op: 'addNode', node: { id: 'n-src', kind: 'search', x: 0, y: 0, title: 'A source', text: 'Found on the web.', url: 'https://example.com', origin: 'agent:j1', createdAt: 1 } },
      { op: 'addNode', node: { id: 'n-made', kind: 'artifact', x: 380, y: 0, title: 'plan', text: '', docPath: 'artifacts/plan.html', fileName: 'plan.html', artifactKind: 'page', origin: 'agent:j2', createdAt: 1 } },
      { op: 'addNode', node: { id: 'n-pic', kind: 'image', x: 0, y: 260, text: 'A dark box', assetId: asset, fileName: 'box.svg', origin: 'user', createdAt: 1 } },
      { op: 'addNode', node: { id: 'n-note', kind: 'note', x: 380, y: 300, text: 'Mine', origin: 'user', createdAt: 1 } },
      { op: 'addEdge', edge: { id: 'e1', source: 'n-src', target: 'n-made', label: 'used in', origin: 'agent:j2', createdAt: 1 } },
      { op: 'addEdge', edge: { id: 'e2', source: 'n-made', target: 'n-note', origin: 'user', createdAt: 1 } },
    ],
  });

  await page.goto(`${base}/n/${one.id}`);
  const card = (id) => page.locator(`.react-flow__node[data-id="${id}"]`);
  await card('n-made').waitFor({ timeout: 15_000 });
  await page.waitForTimeout(800);

  // Nothing is rotated, post-its included.
  const rotated = await page.evaluate(() => [...document.querySelectorAll('.mlch-node')].filter((el) => /rotate|matrix\((?!1, 0, 0, 1)/.test(getComputedStyle(el).transform + el.getAttribute('style'))).length);
  assert.equal(rotated, 0, 'no card is tilted');

  // ⌘D: one card (the made file), a copy beside it with its own file.
  await card('n-made').click({ position: { x: 30, y: 12 } });
  await page.keyboard.press('Meta+d');
  await count(one.id, 5);
  let all = await nodes(one.id);
  const dup = all.find((n) => n.kind === 'artifact' && n.id !== 'n-made');
  assert.equal(dup.origin, 'user');
  assert.equal(dup.docPath, 'artifacts/plan-2.html');
  assert.ok(fs.existsSync(path.join(dir, 'artifacts', 'plan-2.html')), 'the made file was copied');
  assert.deepEqual([dup.x, dup.y], [420, 40]);
  // The copy is selected.
  assert.ok(await card(dup.id).evaluate((el) => el.classList.contains('selected')), 'the copy is selected');
  await shot('duplicated');
  // Undo takes it away.
  await page.keyboard.press('Meta+z');
  await count(one.id, 4);

  // ⌘C on three cards (⌘-click), ⌘V at the pointer: copies with the connection between them.
  await card('n-src').click({ position: { x: 30, y: 12 } });
  await card('n-made').click({ position: { x: 30, y: 12 }, modifiers: ['Meta'] });
  await card('n-pic').click({ position: { x: 30, y: 12 }, modifiers: ['Meta'] });
  await command('copy');
  const clip = await app.evaluate(({ clipboard }) => clipboard.readText());
  assert.match(clip, /A source/, 'plain text for other apps');
  const pane = await page.locator('.react-flow__pane').boundingBox();
  await page.mouse.move(pane.x + pane.width - 250, pane.y + pane.height / 2);
  await command('paste');
  await count(one.id, 7);
  all = await nodes(one.id);
  const pasted = all.filter((n) => !['n-src', 'n-made', 'n-pic', 'n-note'].includes(n.id));
  assert.deepEqual(pasted.map((n) => n.kind).sort(), ['artifact', 'image', 'search']);
  assert.ok(pasted.every((n) => n.origin === 'user' && n.userTouched), 'pasted cards are the person’s own');
  const pastedSearch = pasted.find((n) => n.kind === 'search');
  assert.ok(pastedSearch.x > 400, 'pasted near the pointer, not on the originals');
  const pastedEdges = (await edges(one.id)).filter((e) => pasted.some((n) => n.id === e.source));
  assert.equal(pastedEdges.length, 1, 'only the connection with both ends copied');
  assert.equal(pastedEdges[0].label, 'used in');
  await page.waitForTimeout(500);
  await shot('pasted');

  // Into another mulch: files come along.
  await page.goto(`${base}/n/${other.id}`);
  await page.locator('.react-flow__pane').waitFor({ timeout: 15_000 });
  await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2);
  await command('paste');
  await count(other.id, 3);
  const there = await nodes(other.id);
  const pic = there.find((n) => n.kind === 'image');
  assert.ok(fs.existsSync(path.join(library, other.id, 'assets', asset)), 'the picture was copied');
  const made = there.find((n) => n.kind === 'artifact');
  assert.ok(fs.existsSync(path.join(library, other.id, made.docPath)), 'the made file was copied');
  assert.equal((await edges(other.id)).length, 1);
  await page.locator(`.react-flow__node[data-id="${pic.id}"] img`).waitFor({ timeout: 5000 });
  assert.ok(await page.locator(`.react-flow__node[data-id="${pic.id}"] img`).evaluate((img) => img.complete && img.naturalWidth > 0), 'the picture shows');
  await shot('pasted-other-mulch');

  // Text from outside mlch still pastes as before.
  await app.evaluate(({ clipboard }) => clipboard.writeText('A thought from elsewhere'));
  await command('paste');
  await until(async () => Object.values((await mulchOf(other.id)).nodes).some((n) => n.text.includes('A thought from elsewhere')), 'pasted text');

  // Empty post-its: a double-click, then a click away, leaves an empty note that can be selected, written and deleted.
  const before = (await nodes(other.id)).length;
  await shot('before-note');
  await page.mouse.dblclick(pane.x + 120, pane.y + pane.height - 220);
  await page.locator('textarea.bg-amber-soft').waitFor();
  await page.mouse.click(pane.x + 500, pane.y + 80);
  await count(other.id, before + 1);
  const empty = (await nodes(other.id)).find((n) => n.kind === 'note' && n.text === '');
  assert.ok(empty, 'the empty note stays');
  await shot('empty-note');
  // Write it later.
  await card(empty.id).dblclick();
  await page.keyboard.type('Later');
  await page.mouse.click(pane.x + 500, pane.y + 80);
  await until(async () => (await mulchOf(other.id)).nodes[empty.id]?.text === 'Later', 'written');
  // Clearing its text keeps it.
  await card(empty.id).dblclick();
  await page.keyboard.press('Meta+a');
  await page.keyboard.press('Backspace');
  await page.mouse.click(pane.x + 500, pane.y + 80);
  await until(async () => (await mulchOf(other.id)).nodes[empty.id]?.text === '', 'cleared');
  // Selected and deleted.
  await card(empty.id).click();
  await page.keyboard.press('Backspace');
  await until(async () => !(await mulchOf(other.id)).nodes[empty.id], 'deleted');
  // Search still answers.
  const search = await api(`/api/search?q=${encodeURIComponent('source')}`);
  assert.equal(search.status, 200);
  console.log('copy-paste ok');
  }
};
