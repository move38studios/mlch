// Link cards, the side panel, backlinks, Bring here, and a linked folder in search.
//   node scripts/electron-run.cjs scripts/scenarios/links.cjs --shots <dir>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

module.exports = async ({ page, base, shot }) => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
  fs.mkdirSync(path.join(vault, '.obsidian'));
  fs.writeFileSync(path.join(vault, 'Pricing.md'), '---\ntitle: Pricing notes\ntags: [pricing]\n---\nCharge per seat, not per minute. Teams buy seats; minutes feel like a meter running.');

  const api = (url, method = 'GET', body) => page.evaluate(async ({ url, method, body }) => {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return r.json();
  }, { url, method, body });
  const node = (id, text, extra = {}) => ({ id, kind: 'idea', x: 0, y: 0, text, origin: 'user', createdAt: Date.now(), ...extra });

  const sources = await api('/api/sources', 'POST', { path: vault });
  const source = sources.sources[0];
  assert.equal(source.vault, true);
  const old = (await api('/api/mulches', 'POST', {})).mulch;
  await api(`/api/mulches/${old.id}/ops`, 'POST', { clientId: 's', ops: [{ op: 'setTitle', title: 'Pricing call' }, { op: 'addNode', node: node('p1', 'Seats beat minutes for pricing; teams already think in seats.', { title: 'Seat pricing' }) }] });
  const here = (await api('/api/mulches', 'POST', {})).mulch;
  await api(`/api/mulches/${here.id}/ops`, 'POST', { clientId: 's', ops: [
    { op: 'setTitle', title: 'New call' },
    { op: 'addNode', node: node('h1', 'How should we price the app?') },
    { op: 'addNode', node: { id: 'r1', kind: 'ref', x: 360, y: -20, text: '', title: 'Seat pricing', ref: { mulchId: old.id, itemId: 'p1' }, origin: 'agent:x', createdAt: Date.now() } },
    { op: 'addNode', node: { id: 'r2', kind: 'ref', x: 360, y: 160, text: '', title: 'Pricing', ref: { sourceId: source.id, path: 'Pricing.md' }, origin: 'agent:x', createdAt: Date.now() } },
    { op: 'addEdge', edge: { id: 'e1', source: 'h1', target: 'r1', label: 'earlier decision', origin: 'agent:x', createdAt: Date.now() } },
    { op: 'addEdge', edge: { id: 'e2', source: 'h1', target: 'r2', label: 'same idea', origin: 'agent:x', createdAt: Date.now() } },
  ] });

  await page.goto(`${base}/n/${here.id}`);
  await page.waitForSelector('[data-id="r1"]');
  await page.waitForFunction(() => document.querySelector('[data-id="r1"]')?.textContent?.includes('Pricing call'));
  await page.waitForFunction(() => document.querySelector('[data-id="r2"]')?.textContent?.includes('Charge per seat'));
  await shot('links-canvas');

  // The panel shows the target in full; Open goes there.
  await page.dblclick('[data-id="r1"]');
  await page.waitForSelector('aside >> text=Bring here');
  await shot('links-panel');
  assert.ok(await page.isVisible('aside >> text=Seats beat minutes'));

  // Backlinks in the other mulch.
  await page.goto(`${base}/n/${old.id}`);
  await page.waitForSelector('[aria-label="Linked from"]');
  await page.click('[aria-label="Linked from"]');
  await page.waitForSelector('text=New call');
  await shot('links-backlinks');

  // Bring here: the card becomes a copy and keeps its connection.
  await page.goto(`${base}/n/${here.id}`);
  await page.waitForSelector('[data-id="r1"]');
  await page.dblclick('[data-id="r1"]');
  await page.click('aside >> text=Bring here');
  await page.waitForSelector('[data-id="r1"]', { state: 'detached' });
  const mulch = (await api(`/api/mulches/${here.id}`)).mulch;
  const copy = Object.values(mulch.nodes).find((n) => n.kind === 'idea' && n.title === 'Seat pricing');
  assert.ok(copy, 'a copy is on the canvas');
  assert.ok(Object.values(mulch.edges).some((e) => e.target === copy.id && e.label === 'earlier decision'), 'its connection is kept');

  // A linked folder in search (All).
  await page.keyboard.press('Meta+k');
  await page.fill('input[aria-label="Search"]', 'meter running');
  await page.click('button:has-text("All")');
  await page.waitForSelector('li >> text=Notes');
  await shot('links-search');
  fs.rmSync(vault, { recursive: true, force: true });
  console.log('links ok');
};
