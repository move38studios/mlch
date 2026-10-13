// PLAN-3 R2 with real AI (Codex, the person's subscription): "what do you think" gets a view, a counterpoint and a
// question back; a deck comes out as a deck (kind, player) in mlch's default look with "made with mlch".
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ page, base, shot }) => {
  const api = (url, method = 'GET', body) => page.evaluate(async ({ url, method, body }) => {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  }, { url, method, body });
  const library = process.argv[process.argv.indexOf('--library') + 1];
  await page.goto(base);
  await api('/api/onboarding', 'POST', { action: 'done' });
  await api('/api/settings', 'PUT', { harness: process.env.MLCH_TEST_HARNESS || 'codex', subscriptionConsent: { codex: Date.now(), claude: Date.now() } });
  const mulch = (await api('/api/mulches', 'POST', {})).mulch;
  await api(`/api/mulches/${mulch.id}/ops`, 'POST', { ops: [
    { op: 'addNode', node: { id: 'n-a', kind: 'idea', x: 0, y: 0, text: 'Remote work kills serendipity: the best ideas come from bumping into people.', origin: 'user', createdAt: Date.now() } },
    { op: 'addNode', node: { id: 'n-b', kind: 'idea', x: 320, y: 0, text: 'So we should bring everyone back to the office four days a week.', origin: 'user', createdAt: Date.now() } },
  ] });
  await page.goto(`${base}/n/${mulch.id}`);
  await page.waitForSelector('.react-flow__node[data-id="n-a"]');

  await page.fill('textarea[aria-label="Input"]', '/what do you think?');
  await page.keyboard.press('Enter');
  await page.waitForSelector('aside[aria-label="Conversation"] .mlch-md', { timeout: 240_000 });
  const answer = await page.locator('aside[aria-label="Conversation"] .mlch-md').last().innerText();
  console.log(`answer: ${answer}`);
  assert.match(answer, /\?/, 'a question back');
  await shot('what-do-you-think');

  await page.fill('textarea[aria-label="Input"]', '/make a short deck, 4 slides, about these two ideas');
  await page.keyboard.press('Enter');
  let deck;
  const asked = Date.now();
  while (Date.now() - asked < 600_000 && !deck) {
    await page.waitForTimeout(5000);
    deck = Object.values((await api(`/api/mulches/${mulch.id}`)).mulch.nodes).find((n) => n.kind === 'artifact' && /\.html$/.test(n.docPath ?? ''));
  }
  assert.ok(deck, 'a deck was made');
  const html = fs.readFileSync(path.join(library, mulch.id, deck.docPath), 'utf8');
  console.log('kind', deck.artifactKind, 'bytes', html.length, 'font', html.includes('data:font/woff2'), 'made with', /made with mlch/i.test(html));
  assert.equal(deck.artifactKind, 'deck');
  assert.match(html, /<meta name="mlch:kind" content="deck"/);
  assert.match(html, /made with mlch/i);
  await page.waitForTimeout(3000);
  await page.locator(`.react-flow__node[data-id="${deck.id}"]`).dblclick({ position: { x: 150, y: 40 } });
  await page.waitForTimeout(2500);
  await shot('deck');
  console.log('ai-partner ok');
};
