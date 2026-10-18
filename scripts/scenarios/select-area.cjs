// Dragging on empty canvas draws a selection box; Backspace deletes what it caught. Post-its show markdown.
const assert = require('node:assert/strict');

module.exports = async ({ page, base, shot }) => {
  const api = (url, method = 'GET', body) => page.evaluate(async ({ url, method, body }) => {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  }, { url, method, body });
  await page.goto(base);
  await api('/api/onboarding', 'POST', { action: 'done' });
  const mulch = (await api('/api/mulches', 'POST', {})).mulch;
  await api(`/api/mulches/${mulch.id}/ops`, 'POST', { ops: [
    { op: 'addNode', node: { id: 'n-1', kind: 'note', x: 0, y: 0, text: 'A **bold** point', origin: 'user', createdAt: 1 } },
    { op: 'addNode', node: { id: 'n-2', kind: 'idea', x: 320, y: 0, text: 'Second', origin: 'user', createdAt: 1 } },
    { op: 'addNode', node: { id: 'n-3', kind: 'idea', x: 0, y: 600, text: 'Far away', origin: 'user', createdAt: 1 } },
  ] });
  await page.goto(`${base}/n/${mulch.id}`);
  const first = page.locator('.react-flow__node[data-id="n-1"]');
  await first.waitFor({ timeout: 20_000 });
  assert.equal(await first.locator('strong').innerText(), 'bold', 'markdown on a post-it');
  await page.waitForTimeout(600);
  const a = await first.boundingBox();
  const b = await page.locator('.react-flow__node[data-id="n-2"]').boundingBox();
  // From empty canvas above-left of the first card to the middle of the second.
  await page.mouse.move(a.x - 30, a.y - 30);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  await shot('selecting');
  await page.mouse.up();
  const selected = await page.$$eval('.react-flow__node.selected', (els) => els.map((el) => el.getAttribute('data-id')).sort());
  assert.deepEqual(selected, ['n-1', 'n-2']);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(800);
  const left = Object.keys((await api(`/api/mulches/${mulch.id}`)).mulch.nodes);
  assert.deepEqual(left, ['n-3']);
  console.log('select-area ok');
};
