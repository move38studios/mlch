// Mouse wheel zooms at the pointer; trackpad scroll pans; ⌘0 shows everything.
//   node scripts/electron-run.cjs scripts/scenarios/gestures.cjs
const assert = require('node:assert/strict');

module.exports = async ({ page, base, shot }) => {
  const id = await page.evaluate(async () => {
    const created = await (await fetch('/api/mulches', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
    const node = (n, x, y) => ({ id: n, kind: 'idea', x, y, text: `Card ${n}`, origin: 'user', createdAt: Date.now() });
    await fetch(`/api/mulches/${created.mulch.id}/ops`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'scenario', ops: [{ op: 'addNode', node: node('a', 0, 0) }, { op: 'addNode', node: node('b', 600, 400) }] }),
    });
    return created.mulch.id;
  });
  await page.goto(`${base}/n/${id}`);
  await page.waitForSelector('.react-flow__node');
  await page.waitForTimeout(800);
  const viewport = () => page.evaluate(() => {
    const m = new DOMMatrix(getComputedStyle(document.querySelector('.react-flow__viewport')).transform);
    return { x: m.e, y: m.f, zoom: m.a };
  });
  const pane = await page.locator('.react-flow__pane').boundingBox();
  const at = { x: pane.x + pane.width / 2, y: pane.y + pane.height / 2 };

  // A wheel notch zooms out at the pointer.
  let before = await viewport();
  await page.mouse.move(at.x, at.y);
  await page.mouse.wheel(0, 100);
  await page.waitForTimeout(400);
  let after = await viewport();
  assert.ok(after.zoom < before.zoom, `wheel should zoom out: ${before.zoom} → ${after.zoom}`);

  // Trackpad-like scroll (small, with an x component) pans and keeps the zoom.
  await page.waitForTimeout(400);
  before = after;
  await page.evaluate(({ x, y }) => {
    const target = document.elementFromPoint(x, y);
    for (let i = 0; i < 10; i++) target.dispatchEvent(new WheelEvent('wheel', { deltaX: 3, deltaY: 7.5, clientX: x, clientY: y, bubbles: true, cancelable: true }));
  }, at);
  await page.waitForTimeout(400);
  after = await viewport();
  assert.equal(after.zoom.toFixed(3), before.zoom.toFixed(3), 'trackpad scroll keeps the zoom');
  assert.ok(after.y < before.y, `trackpad scroll pans: ${before.y} → ${after.y}`);

  // ⌘+ zooms in, ⌘0 fits everything.
  await page.mouse.click(at.x, at.y);
  before = await viewport();
  await page.keyboard.press('Meta+Equal');
  await page.waitForTimeout(400);
  after = await viewport();
  assert.ok(after.zoom > before.zoom, '⌘+ zooms in');
  await page.keyboard.press('Meta+Digit0');
  await page.waitForTimeout(600);
  const inView = await page.evaluate(() => [...document.querySelectorAll('.react-flow__node')].every((n) => {
    const r = n.getBoundingClientRect();
    return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
  }));
  assert.ok(inView, '⌘0 shows every card');
  await shot('gestures');
  console.log('gestures ok');
};
