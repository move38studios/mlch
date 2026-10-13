// Connection points, the AI's message in the conversation panel and clearing a canvas, in the app with real AI:
// dragging from a card's top point to another card connects them; a question gets its answer in a
// bubble that stays until closed (and can become a card); "erase everything" leaves no card or box.
const assert = require('node:assert/strict');

module.exports = async ({ page, base, shot }) => {
  const api = (url, method = 'GET', body) => page.evaluate(async ({ url, method, body }) => {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  }, { url, method, body });
  const mulch = (await api('/api/mulches', 'POST', {})).mulch;
  await api(`/api/mulches/${mulch.id}/ops`, 'POST', { ops: [
    { op: 'addNode', node: { id: 'n-a', kind: 'note', x: 0, y: 0, text: 'Forest cities', origin: 'user', createdAt: 1 } },
    { op: 'addNode', node: { id: 'n-b', kind: 'note', x: 0, y: 300, text: 'Cooler streets', origin: 'user', createdAt: 2 } },
    { op: 'addGroup', group: { id: 'g-x', title: 'Old area', x: -40, y: -60, w: 400, h: 520, origin: 'user', createdAt: 3 } },
    { op: 'updateNode', id: 'n-a', patch: { groupId: 'g-x' } },
    { op: 'updateNode', id: 'n-b', patch: { groupId: 'g-x' } },
  ] });
  await page.goto(`${base}/n/${mulch.id}`);
  await page.waitForSelector('.react-flow__node[data-id="n-a"]');
  await page.waitForTimeout(800);

  // Four points per card; drag from A's bottom point onto B's top point.
  const a = page.locator('.react-flow__node[data-id="n-a"]');
  await a.hover();
  assert.equal(await a.locator('.mlch-handle').count(), 4, 'four connection points');
  const from = await a.locator('.react-flow__handle-bottom').boundingBox();
  const to = await page.locator('.react-flow__node[data-id="n-b"] .react-flow__handle-top').boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + 4, to.y + 10, { steps: 12 });
  await shot('connect-snapping');
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(800);
  const edges = Object.values((await api(`/api/mulches/${mulch.id}`)).mulch.edges);
  assert.equal(edges.length, 1, 'the cards are connected');
  await shot('connected');

  // A question: the conversation opens by itself with the answer.
  assert.equal(await page.locator('aside[aria-label="Conversation"]').count(), 0, 'closed by default');
  await page.fill('textarea[aria-label="Input"]', '/what do these two notes have in common? answer briefly');
  await page.keyboard.press('Enter');
  await page.waitForSelector('aside[aria-label="Conversation"] .mlch-md', { timeout: 180_000 });
  const answer = await page.locator('aside[aria-label="Conversation"] .mlch-md').last().innerText();
  console.log(`answer: ${answer}`);
  await page.waitForTimeout(500);
  await shot('message');
  await page.click('aside[aria-label="Conversation"] button:has-text("Add to canvas")');
  await page.waitForTimeout(1500);
  const kept = Object.values((await api(`/api/mulches/${mulch.id}`)).mulch.nodes).find((n) => n.kind === 'writeup');
  assert.ok(kept, 'the answer became a card');

  // Clearing everything leaves nothing, boxes included.
  await page.fill('textarea[aria-label="Input"]', '/erase everything on this canvas');
  await page.keyboard.press('Enter');
  let after;
  const asked = Date.now();
  while (Date.now() - asked < 180_000) {
    await page.waitForTimeout(4000);
    after = (await api(`/api/mulches/${mulch.id}`)).mulch;
    if (!Object.keys(after.nodes).length && !Object.keys(after.groups).length) break;
  }
  assert.equal(Object.keys(after.nodes).length, 0, 'no cards left');
  assert.equal(Object.keys(after.groups).length, 0, 'no boxes left');
  await shot('cleared');
  console.log('tell-and-clear ok');
};
