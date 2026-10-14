// Settings → Updates in the real app: the version, and (a dev or source build) that updates are off.
// The update states themselves (ready, downloading, updated) only happen in an official packaged app.
const assert = require('node:assert/strict');

module.exports = async ({ page, base, shot }) => {
  const state = await page.evaluate(() => window.mlchDesktop?.updates?.state());
  console.log('update state', JSON.stringify(state));
  assert.ok(state && typeof state.status === 'string', 'the bridge answers with the update state');
  await page.goto(`${base}/settings#updates`);
  const section = page.locator('#updates');
  await section.waitFor();
  await page.waitForTimeout(800);
  const text = await section.innerText();
  assert.match(text, /Version \d+\.\d+\.\d+/);
  if (state.status === 'off') assert.match(text, /Updates are off in this build\./);
  await section.scrollIntoViewIfNeeded();
  await shot('settings-updates');
  console.log('updates ok');
};
