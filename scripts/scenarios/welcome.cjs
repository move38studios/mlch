// First run, step by step: an empty library goes to onboarding; the AI step needs a choice, the
// access step the subscription box (or a key); the microphone test shows the words it heard
// (run with --fake-mic); Open mlch goes to the list, where "Start here" waits (not opened).
const assert = require('node:assert/strict');

module.exports = async ({ page, base, shot: take }) => {
  // Steps come in with a short transition: let it finish.
  const shot = async (name) => { await page.waitForTimeout(500); await take(name); };
  const next = () => page.click('footer button:has-text("Continue"), footer button:has-text("Skip")');
  const heading = (text) => page.waitForSelector(`h1:has-text("${text}")`, { timeout: 30_000 });

  await page.goto(base);
  await page.waitForURL('**/welcome', { timeout: 30_000 });
  await heading('Welcome to mlch');
  await shot('1-welcome');
  await page.click('button:has-text("Get started")');

  await heading('A whiteboard that thinks with you');
  await shot('1b-about');
  await next();

  await heading('Your AI');
  await page.click('button[aria-pressed]:has-text("Claude")');
  await page.waitForSelector('button[aria-pressed=true]:has-text("Claude")');
  await shot('2-ai');
  await next();

  await heading('Connect Claude');
  assert.ok(await page.locator('footer button:has-text("Continue")').isDisabled(), 'Continue waits for the subscription box');
  await shot('3-access');
  await page.locator('input[type=checkbox]').first().click();
  await page.waitForFunction(() => { const b = [...document.querySelectorAll('footer button')].find((x) => x.textContent === 'Continue'); return b && !b.disabled; }, null, { timeout: 180_000 });
  await shot('3-access-done');
  await next();

  await heading('Speech');
  await shot('4-speech');
  await next();

  await heading('Microphone and calls');
  // The test needs the speech model; on a Mac that has it, it shows the words.
  await page.waitForSelector('button:has-text("Try it")', { timeout: 300_000 });
  await page.click('button:has-text("Try it")');
  await page.waitForFunction(() => /\w{3,}\s+\w{3,}/.test(document.querySelector('[data-heard]')?.textContent ?? ''), null, { timeout: 120_000 });
  await shot('5-permissions');
  await page.click('button:has-text("Stop")');
  await next();

  await heading('Web and making');
  await shot('6-web');
  await next();

  await heading('Your context');
  await shot('7-context');
  await next();

  await heading('Calls');
  await shot('8-calls');
  await next();

  await heading('Sharing');
  await page.waitForSelector('button[aria-pressed=true]:has-text("mlch.app")');
  await page.waitForSelector('button:has-text("Sign in with Google")');
  await shot('8b-sharing');
  await next();

  await heading('Ready');
  await shot('9-ready');
  await page.click('button:has-text("Open mlch")');
  await page.waitForURL((url) => url.pathname === '/', { timeout: 30_000 });
  await page.waitForSelector('text=Start here');
  const mulches = await page.evaluate(async () => (await (await fetch('/api/mulches')).json()).mulches);
  const start = mulches.find((m) => m.title === 'Start here');
  assert.ok(start && start.nodeCount > 10, 'Start here is in the list, with its cards');
  const settings = await page.evaluate(async () => (await (await fetch('/api/settings')).json()).settings);
  assert.equal(settings.transcription, 'local');
  assert.equal(settings.onboarded, true);
  assert.equal(settings.harness, 'claude');
  assert.ok(settings.subscriptionConsent.claude > 0, 'the confirmation is recorded with its time');
  console.log('welcome ok');
};
