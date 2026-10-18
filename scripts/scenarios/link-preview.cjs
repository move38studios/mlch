// A link added to the canvas shows the page's own preview picture (og:image) at the top of its card.
const assert = require('node:assert/strict');

module.exports = async ({ page, base, shot }) => {
  const api = (url, method = 'GET', body) => page.evaluate(async ({ url, method, body }) => {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  }, { url, method, body });
  await page.goto(base);
  await api('/api/onboarding', 'POST', { action: 'done' });
  await api('/api/settings', 'PUT', { enrich: [] });
  const mulch = (await api('/api/mulches', 'POST', {})).mulch;
  await page.goto(`${base}/n/${mulch.id}`);
  await api(`/api/mulches/${mulch.id}/pause`, 'POST', { paused: true });
  assert.equal((await api(`/api/mulches/${mulch.id}/links`, 'POST', { url: 'https://github.com/move38studios/mlch', x: 0, y: 0 })).status, 200);
  let link;
  for (const end = Date.now() + 90_000; Date.now() < end; await page.waitForTimeout(1500)) {
    link = Object.values((await api(`/api/mulches/${mulch.id}`)).mulch.nodes).find((n) => n.kind === 'link');
    if (link && link.text !== 'Reading…') break;
  }
  console.log(link.title, link.poster);
  assert.ok(link.poster, 'the preview picture was kept');
  const img = page.locator(`.react-flow__node[data-id="${link.id}"] img`).first();
  await img.waitFor({ timeout: 10_000 });
  assert.ok(await img.evaluate((el) => el.complete && el.naturalWidth > 0), 'and shows');
  await shot('link-preview');
  console.log('link-preview ok');
};
