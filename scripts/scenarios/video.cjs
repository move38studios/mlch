// A video dropped on the canvas is read: Gemini with a key; otherwise what is said is transcribed (on this Mac
// when the model is there; MLCH_MODELS_DIR points at it) and the AI looks at its pictures through the helper.
// Without a way to transcribe, the card says so and the pictures are still read. Real AI.
//   MLCH_TEST_VIDEO=<file.mp4> [MLCH_MODELS_DIR=~/Library/Application\ Support/mlch/models] node scripts/electron-run.cjs scripts/scenarios/video.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ page, base, shot }) => {
  const api = (url, method = 'GET', body) => page.evaluate(async ({ url, method, body }) => {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  }, { url, method, body });
  const video = process.env.MLCH_TEST_VIDEO;
  assert.ok(video && fs.existsSync(video), 'set MLCH_TEST_VIDEO');
  await page.goto(base);
  await api('/api/onboarding', 'POST', { action: 'done' });
  await api('/api/settings', 'PUT', { harness: 'claude', transcription: 'local', subscriptionConsent: { claude: Date.now() } });
  const mulch = (await api('/api/mulches', 'POST', {})).mulch;
  await page.goto(`${base}/n/${mulch.id}`);
  await page.locator('.react-flow__pane').waitFor({ timeout: 20_000 });
  const name = path.basename(video);
  const b64 = fs.readFileSync(video).toString('base64');
  const added = await page.evaluate(async ({ id, name, b64 }) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const r = await fetch(`/api/mulches/${id}/files?name=${encodeURIComponent(name)}&x=0&y=0`, { method: 'POST', body: new Blob([bytes], { type: 'video/mp4' }) });
    return r.status;
  }, { id: mulch.id, name, b64 });
  assert.equal(added, 200);
  let card;
  for (const end = Date.now() + 180_000; Date.now() < end; await page.waitForTimeout(2000)) {
    card = Object.values((await api(`/api/mulches/${mulch.id}`)).mulch.nodes).find((n) => n.kind === 'media');
    if (card && card.text && card.text !== 'Watching…') break;
  }
  console.log('card:', card.text);
  assert.notEqual(card.text, 'Watching…');
  // The reading job looks at it and adds what it holds.
  let others = [];
  for (const end = Date.now() + 300_000; Date.now() < end; await page.waitForTimeout(3000)) {
    others = Object.values((await api(`/api/mulches/${mulch.id}`)).mulch.nodes).filter((n) => n.id !== card.id);
    const jobs = (await api(`/api/mulches/${mulch.id}/jobs`)).jobs;
    if (others.length && !jobs.some((j) => j.lane === 'ingest' && ['queued', 'running'].includes(j.state))) break;
  }
  console.log('items:', others.map((n) => `[${n.kind}] ${(n.title ? n.title + ': ' : '') + n.text}`.slice(0, 160)).join('\n  '));
  assert.ok(others.length >= 1, 'items from the video');
  await page.waitForTimeout(1500);
  await shot('video');
  console.log('video ok');
};
