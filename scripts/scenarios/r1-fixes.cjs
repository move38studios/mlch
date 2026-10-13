// PLAN-3 R1: resizing a card (live, both directions), the Settings bar stays, ⌘K from Settings, "Open in mlch" on one's own share.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ page, base, shot }) => {
  const api = (url, method = 'GET', body) => page.evaluate(async ({ url, method, body }) => {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  }, { url, method, body });
  const library = process.argv[process.argv.indexOf('--library') + 1];
  const mulch = (await api('/api/mulches', 'POST', {})).mulch;
  const text = Array.from({ length: 12 }, (_, i) => `Line ${i + 1} of a longer thought that wraps.`).join(' ');
  await api(`/api/mulches/${mulch.id}/ops`, 'POST', { ops: [{ op: 'addNode', node: { id: 'n-a', kind: 'idea', x: 0, y: 0, text, origin: 'user', createdAt: 1 } }] });

  // Resize: the card follows the pointer during the drag, in both directions.
  await page.goto(`${base}/n/${mulch.id}`);
  const card = page.locator('.react-flow__node[data-id="n-a"]');
  await card.waitFor({ timeout: 15_000 });
  await card.click({ position: { x: 20, y: 20 } });
  const handle = page.locator('.react-flow__node[data-id="n-a"] .mlch-resize-corner');
  await handle.waitFor();
  const before = await card.boundingBox();
  const h = await handle.boundingBox();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  const widths = [];
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(h.x + h.width / 2 + i * 12, h.y + h.height / 2 - i * 10, { steps: 2 });
    await page.waitForTimeout(40);
    widths.push(Math.round((await card.boundingBox()).width));
  }
  await shot('resizing');
  await page.mouse.up();
  await page.waitForTimeout(500);
  const after = await card.boundingBox();
  console.log('widths during drag', widths.join(' '), 'before', Math.round(before.width), Math.round(before.height), 'after', Math.round(after.width), Math.round(after.height));
  for (let i = 1; i < widths.length; i++) assert.ok(widths[i] >= widths[i - 1] - 1, 'the width never jumps back during the drag');
  assert.ok(after.width > before.width + 80, 'wider');
  assert.ok(after.height < before.height - 50, 'shorter');
  const stored = (await api(`/api/mulches/${mulch.id}`)).mulch.nodes['n-a'];
  assert.equal(stored.fixedH, true);
  await shot('resized');

  // Settings: the bar with the back arrow stays at the top.
  await page.goto(`${base}/settings`);
  await page.getByRole('heading', { name: 'Settings' }).waitFor();
  await page.mouse.wheel(0, 2000);
  await page.waitForTimeout(400);
  const back = await page.getByRole('link', { name: 'Home' }).boundingBox();
  assert.ok(back && back.y >= 0 && back.y < 120, `back arrow still at the top (${back && back.y})`);
  await shot('settings-scrolled');

  // ⌘K from Settings: home with the search field focused.
  await page.keyboard.press('Meta+k');
  await page.waitForURL(/\/\?search=1$/);
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Search', null, { timeout: 5000 });

  // "Open in mlch" on one's own share opens that mulch, out of the archive.
  const manifestUrl = 'https://share.mlch.app/api/shares/abc123own/manifest';
  fs.writeFileSync(path.join(library, mulch.id, 'shares.json'), JSON.stringify([{ id: 'abc123own', ownerToken: 't', url: 'https://share.mlch.app/s/abc123own/', manifestUrl, kind: 'mulch', createdAt: 1 }]));
  await api(`/api/mulches/${mulch.id}`, 'PATCH', { archived: true });
  const count = (await api('/api/mulches')).mulches.length;
  const opened = await api('/api/import', 'POST', { manifest: manifestUrl });
  assert.equal(opened.mulchId, mulch.id);
  const list = (await api('/api/mulches')).mulches;
  assert.equal(list.length, count, 'no copy made');
  assert.ok(!list.find((m) => m.id === mulch.id).archivedAt, 'brought back from the archive');
  console.log('r1-fixes ok');
};
