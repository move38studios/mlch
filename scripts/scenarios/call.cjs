// A call, end to end with real AI: start listening, a two-person conversation plays into the microphone
// (system audio needs macOS permission; see local-audio.cjs), cards appear in batches, a typed instruction
// during the call makes a quick deck from the conversation. The call has a transcript card filled in as it goes,
// and its notes (summary, decisions, to-dos) when it ends.
//   node scripts/electron-run.cjs scripts/scenarios/call.cjs --fake-mic <call.wav> --shots <dir>
const assert = require('node:assert/strict');

module.exports = async ({ page, base, shot }) => {
  const api = (url, method = 'GET', body) => page.evaluate(async ({ url, method, body }) => {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  }, { url, method, body });
  await api('/api/settings', 'PUT', { transcription: 'local' });
  const mulch = (await api('/api/mulches', 'POST', {})).mulch;
  await page.goto(`${base}/n/${mulch.id}`);
  await page.waitForSelector('[aria-label="Call"]');
  const started = Date.now();
  await page.click('[aria-label="Call"]');
  await page.waitForSelector('[aria-label="Stop listening"]');
  await shot('call-listening');

  // The first batch is captured about 30 s after the first speech.
  const nodes = async () => Object.values((await api(`/api/mulches/${mulch.id}`)).mulch.nodes);
  let first;
  while (Date.now() - started < 150_000) {
    await page.waitForTimeout(5000);
    const now = (await nodes()).filter((n) => n.origin !== 'speech:call');
    if (now.length) { first = Date.now() - started; break; }
  }
  assert.ok(first, 'cards appear during the call');
  console.log(`first cards after ${Math.round(first / 1000)} s`);
  const transcript = (await api(`/api/mulches/${mulch.id}/history`)).status;
  void transcript;

  // Steering while listening.
  await page.fill('textarea[aria-label="Input"]', 'from what we just discussed, build a quick deck');
  await page.keyboard.press('Enter');
  const asked = Date.now();
  let deck;
  while (Date.now() - asked < 240_000) {
    await page.waitForTimeout(5000);
    deck = (await nodes()).find((n) => n.kind === 'artifact');
    if (deck) break;
  }
  assert.ok(deck, 'a deck is made during the call');
  console.log(`deck after ${Math.round((Date.now() - asked) / 1000)} s: ${deck.title} (${deck.docPath})`);

  const live = (await nodes()).find((n) => n.origin === 'speech:call');
  assert.ok(live && /\(\d\d:\d\d\)/.test(live.text), 'the transcript card fills in during the call');

  await page.click('[aria-label="Stop listening"]');
  let notes;
  const stopped = Date.now();
  while (Date.now() - stopped < 240_000) {
    await page.waitForTimeout(5000);
    notes = (await nodes()).find((n) => n.kind === 'writeup' && /^Notes/.test(n.title ?? ''));
    if (notes) break;
  }
  assert.ok(notes, 'the call notes are written when it ends');
  console.log(`notes after ${Math.round((Date.now() - stopped) / 1000)} s:\n${notes.text}`);
  const card = (await nodes()).find((n) => n.origin === 'speech:call');
  assert.match(card.title, /^Call, .* to .* \(\d+ min\)$/, 'the transcript card says when and how long');
  console.log(`transcript card: ${card.title}\n${card.text.slice(0, 600)}`);
  const all = await nodes();
  const said = all.filter((n) => n.origin.startsWith('speech:') && n.origin !== 'speech:call');
  console.log(JSON.stringify(said.map((n) => [n.kind, n.title ?? '', n.text])));
  assert.ok(said.some((n) => /decision/i.test(n.title ?? '') || /per seat/i.test(n.text)), 'the decision is captured');
  assert.ok(said.some((n) => n.kind === 'question'), 'the open question is captured');
  await page.click('[aria-label="Show All"]').catch(() => {});
  await page.keyboard.press('Meta+Digit0');
  await page.waitForTimeout(800);
  await shot('call-after');
  console.log('call ok');
};
