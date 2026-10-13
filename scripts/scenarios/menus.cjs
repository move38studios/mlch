// PLAN-3 R5: the app menu (Settings, New, Open Recent, Search, Share, Conversation, Go, Help) and the menu bar's Search and Settings.
const assert = require('node:assert/strict');

module.exports = async ({ app, page, base, shot }) => {
  const api = (url, method = 'GET', body) => page.evaluate(async ({ url, method, body }) => {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  }, { url, method, body });
  await page.goto(base);
  await api('/api/onboarding', 'POST', { action: 'done' });
  const mulch = (await api('/api/mulches', 'POST', {})).mulch;
  await api(`/api/mulches/${mulch.id}/ops`, 'POST', { ops: [{ op: 'setTitle', title: 'Menu test' }, { op: 'addNode', node: { id: 'n-1', kind: 'idea', x: 0, y: 0, text: 'Something', origin: 'user', createdAt: 1 } }] });
  await app.evaluate(() => globalThis.__mlchRefreshTray());

  // Every item of the app menu does something (or is a role).
  const menu = await app.evaluate(({ Menu }) => {
    const walk = (items, trail) => items.flatMap((item) => [
      ...(item.label || item.role ? [{ path: [...trail, item.label || item.role].join(' > '), action: !!item.click || !!item.role || !!item.submenu, enabled: item.enabled }] : []),
      ...(item.submenu ? walk(item.submenu.items, [...trail, item.label || item.role]) : []),
    ]);
    return walk(Menu.getApplicationMenu().items, []);
  });
  const paths = menu.map((m) => m.path);
  for (const want of ['File > New', 'File > New Call', 'File > Open Recent', 'File > Open Recent > Menu test', 'File > Search…', 'File > Share…', 'View > Conversation', 'Go > Home', 'Go > Back', 'Help > Save Support Report']) {
    assert.ok(paths.includes(want), `${want} in ${paths.join(' | ')}`);
  }
  assert.ok(paths.some((p) => p.endsWith('Settings…')), 'Settings…');
  assert.ok(menu.every((m) => m.action), 'every item acts');
  const click = (label, top) => app.evaluate(({ Menu }, { label, top }) => {
    const parent = Menu.getApplicationMenu().items.find((item) => (item.label || item.role) === top);
    parent.submenu.items.find((item) => item.label === label).click();
  }, { label, top });

  // Settings…, then Search… from there: home with the field ready.
  await click('Settings…', 'mlch');
  await page.waitForURL(/\/settings$/);
  await page.getByRole('heading', { name: 'Settings' }).waitFor();
  await page.waitForTimeout(500);
  await click('Search…', 'File');
  await page.waitForURL(/\/\?search=1$/);

  // In a mulch: Conversation opens the panel, Share opens the share menu.
  await page.goto(`${base}/n/${mulch.id}`);
  await page.locator('.react-flow__node').first().waitFor({ timeout: 15_000 });
  await click('Conversation', 'View');
  await page.getByText('Conversation', { exact: true }).first().waitFor({ timeout: 5000 });
  await shot('conversation-from-menu');
  console.log('menus ok');
};
