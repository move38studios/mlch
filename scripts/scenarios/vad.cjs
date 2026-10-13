// Voice detection: room noise before speech is not sent to transcription; the speech is.
//   node scripts/electron-run.cjs scripts/scenarios/vad.cjs --fake-mic <noise-then-speech.wav>
const assert = require('node:assert/strict');

module.exports = async ({ page, base }) => {
  const api = (url, method = 'GET', body) => page.evaluate(async ({ url, method, body }) => {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  }, { url, method, body });
  await api('/api/settings', 'PUT', { transcription: 'local', enrich: [] });
  const mulch = (await api('/api/mulches', 'POST', {})).mulch;
  const loaded = [];
  const sent = [];
  page.on('response', (r) => { if (/silero_vad|api\/vad\//.test(r.url())) loaded.push(`${r.status()} ${r.url().split('/').pop()}`); });
  page.on('request', (r) => { if (r.url().includes('/transcribe')) sent.push(Date.now()); });
  await page.goto(`${base}/n/${mulch.id}`);
  const started = Date.now();
  await page.click('[aria-label="Microphone"]');
  await page.waitForTimeout(30_000);
  console.log('loaded:', loaded.join(', '));
  console.log('chunks sent at (s):', sent.map((t) => Math.round((t - started) / 1000)).join(', '));
  assert.ok(loaded.some((l) => l.startsWith('200 silero_vad')), 'the model loaded');
  assert.ok(sent.length > 0, 'speech was sent');
  assert.ok(sent.every((t) => t - started > 8000), 'nothing was sent during the 8 s of noise');
  console.log('vad ok');
};
