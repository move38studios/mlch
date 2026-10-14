// A dropped picture: selected, a corner handle makes it wider; double-click shows it full size in the left panel.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ page, base, shot }) => {
  const api = (url, method = 'GET', body) => page.evaluate(async ({ url, method, body }) => {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  }, { url, method, body });
  const mulch = (await api('/api/mulches', 'POST', {})).mulch;
  const library = process.argv[process.argv.indexOf('--library') + 1];
  fs.mkdirSync(path.join(library, mulch.id, 'assets'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', '..', 'public', 'brand', 'icon-180.png'), path.join(library, mulch.id, 'assets', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png'));
  await api(`/api/mulches/${mulch.id}/ops`, 'POST', { ops: [{ op: 'addNode', node: { id: 'n-img', kind: 'image', x: 0, y: 0, assetId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png', fileName: 'icon.png', text: 'The icon', origin: 'user', createdAt: 1 } }] });
  await page.goto(`${base}/n/${mulch.id}`);
  const card = page.locator('.react-flow__node[data-id="n-img"]');
  await card.waitFor();
  await page.waitForTimeout(600);
  await card.click();
  const corner = page.locator('.mlch-resize-corner');
  await corner.waitFor();
  const before = (await card.boundingBox()).width;
  const box = await corner.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 160, box.y + 20, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const after = (await card.boundingBox()).width;
  console.log('width', Math.round(before), '->', Math.round(after));
  assert.ok(after > before + 80, 'the picture got wider');
  await shot('resized');
  await card.dblclick();
  await page.waitForSelector('aside img[src*="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png"]');
  await shot('full');
  await page.locator('aside button[aria-label="Close"]').click();

  // A made picture (a media card): selected, its Open button shows on white; double-click opens it too.
  await api(`/api/mulches/${mulch.id}/ops`, 'POST', { ops: [{ op: 'addNode', node: { id: 'n-made', kind: 'media', x: 600, y: 0, w: 260, assetId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png', mime: 'image/png', fileName: 'made.png', text: 'A prompt', origin: 'agent:test', createdAt: 2 } }] });
  const made = page.locator('.react-flow__node[data-id="n-made"]');
  await made.waitFor();
  await made.click({ position: { x: 40, y: 40 } });
  const open = made.locator('button[aria-label="Open"]');
  await page.mouse.move(0, 0);
  await page.waitForTimeout(200);
  assert.equal(await open.evaluate((el) => getComputedStyle(el).opacity), '1', 'Open shows while selected');
  await shot('made-selected');
  await made.dblclick({ position: { x: 40, y: 40 } });
  await page.waitForSelector('aside button[aria-label="Show in Finder"]');
  console.log('image-card ok');
};
