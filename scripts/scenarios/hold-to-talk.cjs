// Hold ⌥ and speak: what is said while holding becomes one instruction when ⌥ is let go.
//   node scripts/electron-run.cjs scripts/scenarios/hold-to-talk.cjs --fake-mic <speech.wav>
const assert = require('node:assert/strict');

module.exports = async ({ page, base, shot }) => {
  const api = (url, method = 'GET', body) => page.evaluate(async ({ url, method, body }) => {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  }, { url, method, body });
  await api('/api/settings', 'PUT', { transcription: 'local' });
  const mulch = (await api('/api/mulches', 'POST', {})).mulch;
  await page.goto(`${base}/n/${mulch.id}`);
  await page.waitForTimeout(1000);
  await page.mouse.click(700, 300); // the canvas has the keyboard
  await page.keyboard.down('Alt');
  await page.waitForSelector('text=let go of ⌥ to send');
  await page.waitForTimeout(9000);
  await shot('holding');
  await page.keyboard.up('Alt');
  let job;
  for (let i = 0; i < 40 && !job; i++) {
    await page.waitForTimeout(1000);
    job = (await api(`/api/mulches/${mulch.id}/jobs`)).jobs.find((j) => j.lane === 'command');
  }
  console.log('instruction job:', job ? job.retry?.input : 'none');
  assert.ok(job && /\w+ \w+ \w+/.test(job.retry?.input ?? ''), 'the held speech became one instruction');
  console.log('hold-to-talk ok');
};
