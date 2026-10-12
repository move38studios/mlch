// First run: an empty library goes to the first-run screen; models download by themselves;
// Start goes to the list, where "Start here" waits (not opened).
const assert = require('node:assert/strict');

module.exports = async ({ page, base, shot }) => {
  await page.goto(base);
  await page.waitForURL('**/welcome', { timeout: 30_000 });
  await page.waitForSelector('h2:has-text("Keys")');
  await shot('welcome');
  await page.waitForFunction(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent === 'Start'); return b && !b.disabled; }, null, { timeout: 180_000 });
  await shot('welcome-ready');
  await page.click('button:has-text("Start")');
  await page.waitForURL((url) => url.pathname === '/', { timeout: 30_000 });
  await page.waitForSelector('text=Start here');
  await shot('welcome-home');
  const mulches = await page.evaluate(async () => (await (await fetch('/api/mulches')).json()).mulches);
  const start = mulches.find((m) => m.title === 'Start here');
  assert.ok(start && start.nodeCount > 10, 'Start here is in the list, with its cards');
  const settings = await page.evaluate(async () => (await (await fetch('/api/settings')).json()).settings);
  assert.equal(settings.transcription, 'local');
  assert.equal(settings.onboarded, true);
  console.log('welcome ok');
};
