// The menu bar: New Call opens a new mulch listening; closing the window keeps mlch running; the menu shows the call.
//   node scripts/electron-run.cjs scripts/scenarios/menubar.cjs --fake-mic <wav> --shots <dir>
const assert = require('node:assert/strict');

module.exports = async ({ app, page, base, shot }) => {
  const labels = () => app.evaluate(async () => {
    await globalThis.__mlchRefreshTray();
    return globalThis.__mlchTrayMenu.items.map((item) => item.label).filter(Boolean);
  });
  const click = (label) => app.evaluate((_electron, label) => globalThis.__mlchTrayMenu.items.find((item) => item.label === label).click(), label);
  let items = await labels();
  assert.ok(items.includes('New') && items.includes('New Call') && !items.includes('Stop Listening'), items.join(', '));

  // Closing the window keeps the app (and the menu bar) running.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.close()));
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.ok(await app.evaluate(({ app }) => app.isReady()), 'still running');

  // New Call from the menu bar.
  const opened = app.waitForEvent('window');
  await click('New Call');
  const win = await opened;
  await win.waitForSelector('[aria-label="Stop listening"]', { timeout: 60_000 });
  items = await labels();
  assert.ok(items.includes('Stop Listening') && items.includes('Show Call'), items.join(', '));
  await win.screenshot({ path: require('node:path').join(process.env.MLCH_SCENARIO_SHOTS || '/tmp', 'menubar-call.png') });

  await click('Stop Listening');
  await win.waitForSelector('[aria-label="Call"]', { timeout: 20_000 });
  items = await labels();
  assert.ok(!items.includes('Stop Listening'), items.join(', '));
  void page; void base; void shot;
  console.log('menubar ok');
};
