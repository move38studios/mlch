// Sharing servers: mlch.app with sign-in and a subscription, no sharing, and an own server.
// Linked items go into a shared canvas as cards.
//   (cd cloud && npm run dev) &                                   mlch.app on :8787 (accounts, /auth/dev)
//   (cd cloud && npx wrangler dev --port 8788 --var SERVER_KEY:dev-key) &   an own server
//   MLCH_SHARE_URL=http://localhost:8787 MLCH_DEV_SIGN_IN=ana@example.com MLCH_SCENARIO_LIBRARY=<dir> \
//     node scripts/electron-run.cjs scripts/scenarios/share-account.cjs --library <dir> --shots <dir>
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

module.exports = async ({ page, base, shot }) => {
  const api = (url, method = 'GET', body) => page.evaluate(async ({ url, method, body }) => {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  }, { url, method, body });
  const node = (id, text, extra = {}) => ({ id, kind: 'idea', x: 0, y: 0, text, origin: 'user', createdAt: Date.now(), ...extra });
  const d1 = (sql) => execFileSync('npx', ['wrangler', 'd1', 'execute', 'mlch-accounts', '--local', '-c', 'wrangler.mlch.jsonc', '--command', sql], { cwd: path.join(__dirname, '..', '..', 'cloud'), stdio: 'ignore' });
  // A fresh account each run (the local server keeps its database).
  try { d1("DELETE FROM users WHERE email = 'ana@example.com'"); } catch { /* no tables yet */ }

  // Something elsewhere to link to, and a canvas that links to it.
  const other = (await api('/api/mulches', 'POST', {})).mulch;
  await api(`/api/mulches/${other.id}/ops`, 'POST', { clientId: 's', ops: [{ op: 'setTitle', title: 'Private research' }, { op: 'addNode', node: node('p1', 'Seat pricing beats usage pricing for teams') }] });
  const mulch = (await api('/api/mulches', 'POST', {})).mulch;
  await api(`/api/mulches/${mulch.id}/ops`, 'POST', { clientId: 's', ops: [
    { op: 'setTitle', title: 'Pricing call' },
    { op: 'addNode', node: node('a', 'Per seat, not per minute') },
    { op: 'addNode', node: { id: 'r', kind: 'ref', x: 320, y: 0, text: '', title: 'Seat pricing', ref: { mulchId: other.id, itemId: 'p1' }, origin: 'user', createdAt: Date.now() } },
  ] });

  // mlch.app is the default: signed out, the Share menu says what to do.
  let sharing = await api('/api/account');
  assert.equal(sharing.mode, 'mlch');
  assert.equal(sharing.account.signedIn, false);
  await page.goto(`${base}/n/${mulch.id}`);
  await page.click('[aria-label="Share"]');
  await page.waitForSelector('text=Sign in to share from mlch.app.');
  await page.waitForSelector('text=Also shared: what 1 link card links to');
  await shot('1-share-menu-signed-out');
  const refused = await api(`/api/mulches/${mulch.id}/shares`, 'POST', { kind: 'mulch' });
  assert.equal(refused.status, 401, JSON.stringify(refused));

  // Settings, Sharing.
  await page.goto(`${base}/settings#sharing`);
  await page.waitForSelector('button:has-text("Sign in with Google")');
  await shot('2-settings-sharing');

  // Sign in: the browser part is the local server's /auth/dev; the app finishes it as main does for mlch://signed-in.
  const { url } = await api('/api/account', 'POST', { action: 'sign-in' });
  assert.match(url, /\/auth\/dev\?email=ana%40example\.com&challenge=/);
  const code = /mlch:\/\/signed-in\?code=([\w-]+)/.exec(await (await fetch(url)).text())[1];
  sharing = await api('/api/account', 'POST', { action: 'finish', code });
  assert.equal(sharing.account.signedIn, true, JSON.stringify(sharing));
  assert.equal(sharing.account.email, 'ana@example.com');
  assert.equal(sharing.account.canShare, false);
  await page.reload();
  await page.waitForSelector('text=Signed in as ana@example.com');
  await page.waitForSelector('button:has-text("Subscribe, $12 a year")');
  await shot('3-signed-in');
  const unpaid = await api(`/api/mulches/${mulch.id}/shares`, 'POST', { kind: 'mulch' });
  assert.equal(unpaid.status, 402, JSON.stringify(unpaid));

  // Subscribed (what Stripe's webhook records).
  d1("UPDATE users SET status = 'active', period_end = 2000000000000 WHERE email = 'ana@example.com'");
  await page.reload();
  await page.waitForSelector('text=Subscribed, renews');
  await shot('4-subscribed');

  // Share: the link card goes as what it links to.
  const shared = await api(`/api/mulches/${mulch.id}/shares`, 'POST', { kind: 'mulch' });
  assert.equal(shared.status, 200, JSON.stringify(shared));
  assert.ok(shared.share.url.startsWith('http://localhost:8787/s/'));
  const snapshot = await (await fetch(`${shared.share.url}snapshot.json`)).json();
  assert.equal(snapshot.nodes.r.kind, 'idea');
  assert.equal(snapshot.nodes.r.text, 'Seat pricing beats usage pricing for teams');
  assert.ok(!JSON.stringify(snapshot).includes(other.id), 'where the item lives stays private');

  // No sharing: no Share buttons; live updates stop.
  await api('/api/account', 'POST', { action: 'mode', mode: 'off' });
  await page.goto(`${base}/n/${mulch.id}`);
  await page.waitForSelector('[aria-label="Conversation"]');
  await page.waitForTimeout(500);
  assert.equal(await page.locator('[aria-label="Share"]').count(), 0, 'no Share button when sharing is off');

  // Your own server: address and key, checked; new shares go there, the old one stays on mlch.app.
  await page.goto(`${base}/settings#sharing`);
  await page.click('button[aria-pressed]:has-text("Your own server")');
  await page.fill('input[aria-label="Server address"]', 'http://localhost:8788');
  await page.click('input[aria-label="Server address"] + button');
  await page.fill('input[aria-label="Server key"]', 'wrong-key');
  await page.click('input[aria-label="Server key"] + button');
  await page.waitForSelector('text=The server did not accept that key.');
  await page.click('button:has-text("Change key")');
  await page.fill('input[aria-label="Server key"]', 'dev-key');
  await page.click('input[aria-label="Server key"] + button');
  await page.waitForSelector('text=Connected');
  await shot('5-own-server');
  const second = (await api('/api/mulches', 'POST', {})).mulch;
  await api(`/api/mulches/${second.id}/ops`, 'POST', { clientId: 's', ops: [{ op: 'addNode', node: node('x', 'On my server') }] });
  const own = await api(`/api/mulches/${second.id}/shares`, 'POST', { kind: 'mulch' });
  assert.equal(own.status, 200, JSON.stringify(own));
  assert.ok(own.share.url.startsWith('http://localhost:8788/s/'), own.share.url);
  const first = (await api(`/api/mulches/${mulch.id}/shares`)).shares[0];
  assert.equal(first.server, 'http://localhost:8787');

  // Back to mlch.app, still signed in.
  await api('/api/account', 'POST', { action: 'mode', mode: 'mlch' });
  sharing = await api('/api/account');
  assert.equal(sharing.account.canShare, true);
  console.log('share-account ok');
};
