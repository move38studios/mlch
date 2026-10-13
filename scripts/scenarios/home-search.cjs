// PLAN-3 R4: home with many mulches: grouped by when, more on scroll, typing anywhere searches, titles filter, inside hits, keys open.
const assert = require('node:assert/strict');

module.exports = async ({ page, base, shot }) => {
  const api = (url, method = 'GET', body) => page.evaluate(async ({ url, method, body }) => {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  }, { url, method, body });
  await page.goto(base);
  await api('/api/onboarding', 'POST', { action: 'done' });
  const words = ['river', 'garden', 'pricing', 'kitchen', 'orbit', 'lantern', 'harbor', 'meadow'];
  let zebra;
  for (let i = 0; i < 120; i++) {
    const mulch = (await api('/api/mulches', 'POST', {})).mulch;
    const title = i === 77 ? 'Zebra crossing ideas' : `${words[i % words.length]} notes ${i}`;
    const text = i === 33 ? 'Quantum pancakes need a better name' : `Thought ${i} about ${words[i % words.length]}`;
    await api(`/api/mulches/${mulch.id}/ops`, 'POST', { ops: [{ op: 'setTitle', title }, { op: 'addNode', node: { id: 'n-1', kind: 'idea', x: 0, y: 0, text, origin: 'user', createdAt: 1 } }] });
    if (i === 77) zebra = mulch.id;
  }
  await page.goto(base);
  await page.getByText('Today', { exact: true }).waitFor({ timeout: 20_000 });
  const rows = () => page.locator('main li a[href^="/n/"]').count();
  assert.equal(await rows(), 50, 'first 50');
  await page.mouse.wheel(0, 20_000);
  await page.waitForTimeout(800);
  await page.mouse.wheel(0, 20_000);
  await page.waitForTimeout(800);
  assert.ok((await rows()) >= 100, `more on scroll (${await rows()})`);
  await shot('home-list');

  // Typing anywhere goes into search; titles filter at once.
  await page.mouse.click(5, 300);
  await page.keyboard.type('zeb');
  await page.waitForTimeout(150);
  assert.equal(await page.locator('input[aria-label="Search"]').inputValue(), 'zeb');
  const titled = page.locator('main li a[href^="/n/"]');
  assert.equal(await titled.count(), 1);
  assert.match(await titled.first().textContent(), /Zebra crossing ideas/);
  await page.keyboard.press('Enter');
  await page.waitForURL(new RegExp(`/n/${zebra}`));

  // Inside: content from a mulch, one row per mulch; Esc clears.
  await page.goto(base);
  await page.locator('input[aria-label="Search"]').waitFor();
  await page.locator('input[aria-label="Search"]').fill('quantum pancakes');
  await page.getByText('Inside', { exact: true }).waitFor({ timeout: 15_000 });
  await shot('home-search');
  await page.locator('input[aria-label="Search"]').press('Escape');
  assert.equal(await page.locator('input[aria-label="Search"]').inputValue(), '');
  console.log('home-search ok');
};
