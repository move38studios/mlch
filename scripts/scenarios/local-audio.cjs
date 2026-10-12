// Local transcription and system audio in the real app (PLAN-2 M2, M3 step 1).
//   node scripts/build-native.mjs && node scripts/electron-run.cjs scripts/scenarios/local-audio.cjs --shots <dir>
// Needs the model downloaded (Settings → Transcription → Local, or this
// scenario's download step). System audio needs the "System Audio Recording"
// permission; without it the capture runs but hears silence (peak 0), which
// this scenario reports rather than fails on.
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = async ({ page, shot }) => {
  const api = (url, init) => page.evaluate(async ([url, init]) => {
    const response = await fetch(url, init ? { ...init, headers: { 'Content-Type': 'application/json' } } : undefined);
    return { status: response.status, body: await response.json() };
  }, [url, init]);

  let status = (await api('/api/transcription')).body;
  console.log('local status', status);
  assert.equal(status.installed, true, 'helper built and reachable');
  if (status.model !== 'present') {
    await api('/api/transcription', { method: 'POST', body: JSON.stringify({ action: 'download' }) });
    for (let i = 0; i < 600 && status.model !== 'present'; i++) {
      await wait(1000);
      status = (await api('/api/transcription')).body;
    }
  }
  assert.equal(status.model, 'present');
  await api('/api/settings', { method: 'PUT', body: JSON.stringify({ transcription: 'local' }) });

  await page.goto(new URL('/settings', page.url()).href);
  await page.getByText('Transcription', { exact: true }).waitFor();
  await shot('settings-transcription');

  // A chunk through the same route the microphone uses.
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mlch-scenario-'));
  const aiff = path.join(temp, 'x.aiff'), wav = path.join(temp, 'x.wav');
  execFileSync('say', ['-o', aiff, 'We should keep the call notes on this Mac.']);
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, wav]);
  const { mulch } = (await api('/api/mulches', { method: 'POST', body: JSON.stringify({ title: 'Local audio' }) })).body;
  const started = Date.now();
  const result = await page.evaluate(async ([url, b64]) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const response = await fetch(url, { method: 'POST', body: bytes, headers: { 'Content-Type': 'audio/wav' } });
    return response.json();
  }, [`/api/mulches/${mulch.id}/transcribe?at=${Date.now()}`, fs.readFileSync(wav).toString('base64')]);
  console.log('mic chunk', result.segment?.text, `${Date.now() - started} ms round trip`);
  assert.match(result.segment.text.toLowerCase(), /keep the call notes on this mac/);

  // The Mac's sound output into the same mulch.
  const capture = (await api(`/api/mulches/${mulch.id}/system-audio`, { method: 'POST', body: JSON.stringify({ action: 'start', target: 'all' }) })).body.capture;
  assert.ok(capture?.session, 'capture started');
  const player = spawn('afplay', ['-v', '0.1', wav]);
  await new Promise((resolve) => player.on('exit', resolve));
  await wait(1500);
  const during = (await api(`/api/mulches/${mulch.id}/system-audio`)).body.capture;
  await api(`/api/mulches/${mulch.id}/system-audio`, { method: 'POST', body: JSON.stringify({ action: 'stop' }) });
  console.log('system audio', { peak: during?.peak, chunks: during?.chunks });
  if (!during?.peak) console.log('MANUAL: system audio heard silence — grant System Audio Recording to the app (System Settings → Privacy & Security) and run again.');
  else assert.ok(during.chunks >= 1, 'a chunk was transcribed');
  fs.rmSync(temp, { recursive: true, force: true });
};
