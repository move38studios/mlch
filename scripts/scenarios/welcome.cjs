// First run: an empty library goes to the checklist; each item shows its state; Start opens a new mulch.
const assert = require('node:assert/strict');

module.exports = async ({ page, base, shot }) => {
  await page.goto(base);
  await page.waitForURL('**/welcome', { timeout: 30_000 });
  await page.waitForSelector('h2:has-text("Transcription")');
  await page.waitForSelector('h2:has-text("Search")');
  await shot('welcome');
  // Local transcription needs the model; choose it (already downloaded on this Mac, else it downloads).
  await page.click('button:has-text("Local")');
  const start = page.locator('button:has-text("Start")');
  await start.waitFor();
  await page.waitForFunction(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent === 'Start'); return b && !b.disabled; }, null, { timeout: 120_000 });
  await shot('welcome-ready');
  await start.click();
  await page.waitForURL('**/n/**', { timeout: 30_000 });
  const onboarded = await page.evaluate(async () => (await (await fetch('/api/onboarding')).json()).onboarded);
  assert.equal(onboarded, true);
  console.log('welcome ok');
};
