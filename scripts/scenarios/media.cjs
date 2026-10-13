// Media on the canvas: a YouTube link becomes a video with title and poster that plays in place;
// a link straight to a picture becomes the picture; a dropped recording plays and is transcribed.
//   node scripts/electron-run.cjs scripts/scenarios/media.cjs --library <dir> [--wav file.wav]
const assert = require('node:assert/strict');
const fs = require('node:fs');

module.exports = async ({ page, base, shot }) => {
  const api = (url, method = 'GET', body) => page.evaluate(async ({ url, method, body }) => {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  }, { url, method, body });
  const mulch = (await api('/api/mulches', 'POST', {})).mulch;
  await page.goto(`${base}/n/${mulch.id}`);
  await page.waitForTimeout(800);
  const nodes = async () => Object.values((await api(`/api/mulches/${mulch.id}`)).mulch.nodes);
  const until = async (test, ms = 60_000) => { const end = Date.now() + ms; while (Date.now() < end) { const found = (await nodes()).find(test); if (found) return found; await page.waitForTimeout(1000); } };

  await api(`/api/mulches/${mulch.id}/links`, 'POST', { url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', x: 0, y: 0 });
  const video = await until((n) => n.kind === 'link' && n.poster);
  assert.ok(video, 'the video link has a poster');
  console.log('video:', video.title, '|', video.text);
  await api(`/api/mulches/${mulch.id}/links`, 'POST', { url: 'https://upload.wikimedia.org/wikipedia/commons/a/a7/Camponotus_flavomarginatus_ant.jpg', x: 500, y: 0 });
  const picture = await until((n) => n.kind === 'image');
  assert.ok(picture, 'a link to a picture becomes the picture');

  const wavIndex = process.argv.indexOf('--wav');
  if (wavIndex > 0) {
    const bytes = fs.readFileSync(process.argv[wavIndex + 1]).toString('base64');
    await page.evaluate(async ({ id, bytes }) => {
      const data = Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0));
      await fetch(`/api/mulches/${id}/files?name=talk.wav&x=0&y=500`, { method: 'POST', body: data });
    }, { id: mulch.id, bytes });
    const heard = await until((n) => n.kind === 'media' && n.text && n.text !== 'Transcribing…', 120_000);
    assert.ok(heard && heard.text.length > 20, 'the recording is transcribed');
    console.log('heard:', heard.text.slice(0, 120));
  }

  await page.keyboard.press('Meta+Digit0');
  await page.waitForTimeout(1500);
  await shot('media');
  await page.click('.react-flow__node button[aria-label="Play"]');
  await page.waitForTimeout(6000);
  const frame = page.frames().find((f) => f.url().includes('youtube.com/embed'));
  assert.ok(frame, 'the YouTube player loaded in the card');
  const error = await frame.locator('text=/Error 15[0-9]|unavailable/i').count().catch(() => 0);
  console.log('player error text:', error);
  await shot('playing');
  console.log('media ok');
};
