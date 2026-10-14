// Editing a card the person sized: cut-off text opens in the side panel, already editing;
// a card whose text fits edits in place, and lines typed past its bottom scroll inside it.
const assert = require('node:assert/strict');

module.exports = async ({ page, base, shot }) => {
  const api = (url, method = 'GET', body) => page.evaluate(async ({ url, method, body }) => {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  }, { url, method, body });
  const mulch = (await api('/api/mulches', 'POST', {})).mulch;
  const long = Array.from({ length: 30 }, (_, i) => `Line ${i + 1} of a long note.`).join('\n');
  const card = (id, x, text, h) => ({ op: 'addNode', node: { id, kind: 'idea', x, y: 0, w: 260, h, fixedH: true, text, origin: 'user', createdAt: 1 } });
  await api(`/api/mulches/${mulch.id}/ops`, 'POST', { ops: [card('n-cut', 0, long, 120), card('n-fits', 400, 'Short.', 120)] });
  await page.goto(`${base}/n/${mulch.id}`);
  const cut = page.locator('.react-flow__node[data-id="n-cut"]');
  const fits = page.locator('.react-flow__node[data-id="n-fits"]');
  await cut.waitFor();
  await page.waitForTimeout(800);

  // Cut off: the side panel opens with its text in an editor, focused.
  await cut.dblclick();
  const panelEditor = page.locator('aside textarea[aria-label="Text"]');
  await panelEditor.waitFor();
  assert.equal(await panelEditor.inputValue(), long);
  assert.ok(await panelEditor.evaluate((el) => el === document.activeElement), 'the panel editor has focus');
  assert.equal(await cut.locator('textarea').count(), 0, 'no editor on the card');
  await shot('cut-in-panel');
  await page.keyboard.press('Escape');
  await page.locator('aside button[aria-label="Close"]').click();

  // Fits: edits in place; typing past the bottom keeps the editor inside the card.
  await fits.dblclick();
  const inPlace = fits.locator('textarea');
  await inPlace.waitFor();
  for (let i = 0; i < 15; i++) await page.keyboard.type(`\nMore ${i + 1}`);
  await page.waitForTimeout(200);
  const outer = await fits.boundingBox();
  const scroller = fits.locator('textarea').locator('xpath=..');
  const inner = await scroller.boundingBox();
  console.log('card', Math.round(outer.height), 'editor box', Math.round(inner.height));
  assert.ok(inner.y + inner.height <= outer.y + outer.height + 1, 'the editor stays inside the card');
  assert.ok(await scroller.evaluate((el) => el.scrollHeight > el.clientHeight), 'the extra lines scroll');
  await shot('fits-in-place');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const saved = (await api(`/api/mulches/${mulch.id}`)).mulch.nodes['n-fits'].text;
  assert.ok(saved.includes('More 15'), 'the typed text was saved');
  console.log('card-edit ok');
};
