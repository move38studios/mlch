// Screenshots of web pages land on the canvas named after the site, and a deck built from them has them,
// even when the maker is sandboxed (no websites from its shell). Real AI.
//   MLCH_TEST_ACCESS=sandboxed|auto node scripts/electron-run.cjs scripts/scenarios/screenshots.cjs
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
  await api('/api/settings', 'PUT', { harness: 'claude', access: process.env.MLCH_TEST_ACCESS || 'sandboxed', subscriptionConsent: { claude: Date.now() } });
  const mulch = (await api('/api/mulches', 'POST', {})).mulch;
  await page.goto(`${base}/n/${mulch.id}`);
  await api(`/api/mulches/${mulch.id}/command`, 'POST', {
    instruction: 'Take screenshots of the homepages of https://example.com and https://www.wikipedia.org, then make a 3-slide deck (HTML, through make) with a title slide and one slide per site showing its screenshot.',
  });
  const until = async (test, ms) => {
    for (const end = Date.now() + ms; Date.now() < end; await page.waitForTimeout(3000)) {
      const value = await test();
      if (value) return value;
    }
    return undefined;
  };
  const pictures = await until(async () => {
    const found = Object.values((await api(`/api/mulches/${mulch.id}`)).mulch.nodes).filter((n) => n.kind === 'image');
    return found.length >= 2 ? found : undefined;
  }, 300_000);
  assert.ok(pictures, 'two screenshots on the canvas');
  console.log('pictures:', pictures.map((n) => `${n.fileName}: ${n.text}`).join(' | '));
  assert.ok(pictures.every((n) => /example\.com|wikipedia\.org/.test(n.fileName)), 'named after the site');
  const deck = await until(async () => {
    const jobs = (await api(`/api/mulches/${mulch.id}/jobs`)).jobs.filter((j) => j.retry);
    const busy = jobs.some((j) => ['queued', 'running'].includes(j.state));
    const made = Object.values((await api(`/api/mulches/${mulch.id}`)).mulch.nodes).find((n) => n.kind === 'artifact' && /\.html$/.test(n.docPath ?? ''));
    return !busy && made ? made : undefined;
  }, 900_000);
  assert.ok(deck, 'a deck');
  const html = fs.readFileSync(path.join(library, mulch.id, deck.docPath), 'utf8');
  const images = (html.match(/<img[^>]+src="data:image|url\(\s*["']?data:image/g) ?? []).length;
  console.log('deck', deck.docPath, 'embedded pictures:', images);
  for (const j of (await api(`/api/mulches/${mulch.id}/jobs`)).jobs.filter((j) => j.retry)) console.log(`${j.retry.kind} ${j.state} ${j.error ?? ''} ${j.message?.text?.slice(0, 200) ?? ''}`);
  assert.ok(images >= 2, 'the screenshots are in the deck');
  await shot('screenshots');
  console.log('screenshots ok');
};
