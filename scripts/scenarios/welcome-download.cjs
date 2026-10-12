// Onboarding without the speech model: choosing "On this Mac" starts its download, the footer shows it,
// and the microphone step waits for it (Allow instead of Try it) until it is in.
const assert = require('node:assert/strict');

module.exports = async ({ page, base, shot }) => {
  const next = () => page.click('footer button:has-text("Continue"), footer button:has-text("Skip")');
  await page.goto(base);
  await page.waitForURL('**/welcome', { timeout: 30_000 });
  await page.click('button:has-text("Get started")');
  await next();
  await page.waitForSelector('h1:has-text("Your AI")');
  await page.click('button[aria-pressed]:has-text("Claude")');
  await next();
  await page.locator('input[type=checkbox]').first().click();
  await page.waitForFunction(() => { const b = [...document.querySelectorAll('footer button')].find((x) => x.textContent === 'Continue'); return b && !b.disabled; }, null, { timeout: 120_000 });
  await next();
  await page.waitForSelector('h1:has-text("Speech")');
  await next();
  await page.waitForSelector('h1:has-text("Microphone and calls")');
  await page.waitForSelector('footer :text("Downloading speech model")', { timeout: 30_000 });
  assert.equal(await page.locator('button:has-text("Try it")').count(), 0, 'no test before the model is in');
  assert.ok(await page.locator('button:has-text("Allow")').first().isVisible(), 'the microphone can still be allowed');
  await page.waitForTimeout(4000);
  await shot('waiting-for-model');
  console.log(await page.locator('main').innerText());
  console.log('welcome-download ok');
};
