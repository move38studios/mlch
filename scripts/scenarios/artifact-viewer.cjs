// A made page: double-click opens it on a 16:9 stage; Esc closes it even while the page has the keyboard.
const assert = require('node:assert/strict');

module.exports = async ({ app, page, base, shot }) => {
  const api = (url, method = 'GET', body) => page.evaluate(async ({ url, method, body }) => {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  }, { url, method, body });
  const mulch = (await api('/api/mulches', 'POST', {})).mulch;
  const deck = '<!doctype html><body style="margin:0;font:48px sans-serif;display:grid;place-items:center;height:100vh;background:#123;color:#fff">Slide 1</body>';
  // The made file, as the AI would leave it: in artifacts/, with a card.
  const library = process.argv[process.argv.indexOf('--library') + 1];
  require('node:fs').mkdirSync(require('node:path').join(library, mulch.id, 'artifacts'), { recursive: true });
  require('node:fs').writeFileSync(require('node:path').join(library, mulch.id, 'artifacts', 'deck.html'), deck);
  await api(`/api/mulches/${mulch.id}/ops`, 'POST', { ops: [{ op: 'addNode', node: { id: 'n-deck', kind: 'artifact', x: 0, y: 0, title: 'Deck', text: 'A test deck', docPath: 'artifacts/deck.html', origin: 'agent:j0', createdAt: 1 } }] });
  await page.goto(`${base}/n/${mulch.id}`);
  const card = page.locator('.react-flow__node').filter({ hasText: 'Deck' }).first();
  await card.waitFor({ timeout: 15_000 });
  await card.dblclick({ position: { x: 150, y: 60 } });
  const frame = page.locator('iframe[title="Deck"]').last();
  await frame.waitFor();
  await page.waitForTimeout(800);
  const box = await frame.boundingBox();
  console.log('stage', Math.round(box.width), Math.round(box.height), (box.width / box.height).toFixed(3));
  assert.ok(Math.abs(box.width / box.height - 16 / 9) < 0.02, '16:9');
  await shot('viewer');
  await frame.click();
  // A real key event through the window (Playwright's own skips Electron's input hook).
  await app.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  });
  await page.waitForTimeout(600);
  assert.equal(await page.locator('iframe[title="Deck"][sandbox]').count(), 1, 'viewer closed (only the card preview is left)');
  console.log('artifact-viewer ok');
};
