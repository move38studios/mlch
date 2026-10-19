// Web links in made files open in the browser (a new tab), in the viewer: a deck's link (the slide stays),
// a page's link; links within the file stay; a made file opens nothing unasked and can't flood the browser. No AI.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ app, page, base, shot }) => {
  const api = (url, method = 'GET', body) => page.evaluate(async ({ url, method, body }) => {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  }, { url, method, body });
  const library = process.argv[process.argv.indexOf('--library') + 1];
  // The browser, as main reaches it.
  await app.evaluate(({ shell }) => {
    globalThis.__opened = [];
    shell.openExternal = async (url) => { globalThis.__opened.push(url); };
  });
  const opened = () => app.evaluate(() => globalThis.__opened);
  await page.goto(base);
  await api('/api/onboarding', 'POST', { action: 'done' });
  const mulch = (await api('/api/mulches', 'POST', {})).mulch;
  const { outputFiles } = require('esbuild').buildSync({
    stdin: { contents: 'export * from "./src/lib/artifacts/deck";', resolveDir: path.join(__dirname, '..', '..'), loader: 'ts' },
    bundle: true, format: 'cjs', platform: 'node', write: false,
  });
  const bundle = { exports: {} };
  new Function('module', 'exports', 'require', outputFiles[0].text)(bundle, bundle.exports, require);
  const dir = path.join(library, mulch.id, 'artifacts');
  fs.mkdirSync(dir, { recursive: true });
  // A deck as an older maker wrote it: plain links, no target.
  fs.writeFileSync(path.join(dir, 'reading.html'), bundle.exports.buildDeck({ title: 'Reading', slides: [
    '<h1 style="font-size:100px;margin:100px">One</h1><p style="font-size:60px;margin:100px"><a id="ext" href="https://en.wikipedia.org/wiki/Homeostat">Homeostat</a></p>',
    '<h1 style="font-size:100px;margin:100px">Two</h1><p style="font-size:60px;margin:100px"><a id="ext2" href="https://mitpress.mit.edu/9780262521123/vehicles/">Vehicles</a></p>',
  ] }));
  fs.writeFileSync(path.join(dir, 'page.html'), `<!doctype html><html><head><meta name="mlch:kind" content="page"><title>Page</title></head><body>
<p><a id="toc" href="#far">To the end</a></p><p><a id="out" href="https://arxiv.org/abs/2601.16087" target="_blank">Paper</a></p>
<button id="flood" onclick="for (var i = 0; i < 20; i++) { window.open('https://example.com/own' + i); parent.postMessage({ mlchOpenLink: 'https://example.com/' + i }, '*'); }">x</button>
<div style="height:3000px"></div><h2 id="far">End</h2>
<script>setTimeout(function () { window.open('https://example.com/unasked'); parent.postMessage({ mlchOpenLink: 'https://example.com/unasked' }, '*'); }, 300);</script></body></html>`);
  await api(`/api/mulches/${mulch.id}/ops`, 'POST', { ops: [
    { op: 'addNode', node: { id: 'n-deck', kind: 'artifact', x: 0, y: 0, title: 'Reading', text: '', docPath: 'artifacts/reading.html', fileName: 'reading.html', artifactKind: 'deck', origin: 'agent:j0', createdAt: Date.now() } },
    { op: 'addNode', node: { id: 'n-page', kind: 'artifact', x: 500, y: 0, title: 'Page', text: '', docPath: 'artifacts/page.html', fileName: 'page.html', artifactKind: 'page', origin: 'agent:j0', createdAt: Date.now() } },
  ] });
  await page.goto(`${base}/n/${mulch.id}`);
  const deckCard = page.locator('.react-flow__node[data-id="n-deck"]');
  await deckCard.waitFor({ timeout: 20_000 });

  // The deck: its link goes to the browser, the slide stays.
  await deckCard.dblclick({ position: { x: 150, y: 60 } });
  const bar = page.getByRole('slider', { name: 'Slide' });
  await bar.waitFor({ timeout: 15_000 });
  const deck = page.frameLocator('iframe[title="Reading"]').last();
  // Right after opening it.
  await deck.locator('#ext').click();
  await page.waitForTimeout(800);
  assert.deepEqual(await opened(), ['https://en.wikipedia.org/wiki/Homeostat'], 'the deck link opens in the browser');
  assert.equal(await bar.getAttribute('aria-valuenow'), '1', 'the slide stays');
  // Right after the slide bar.
  const box = await bar.boundingBox();
  await page.mouse.click(box.x + box.width * 0.9, box.y + box.height / 2);
  await page.waitForFunction(() => document.querySelector('[role="slider"][aria-label="Slide"]')?.getAttribute('aria-valuenow') === '2', null, { timeout: 5000 });
  await deck.locator('#ext2').click();
  await page.waitForTimeout(800);
  assert.equal((await opened()).at(-1), 'https://mitpress.mit.edu/9780262521123/vehicles/', 'a link right after the slide bar opens');
  await shot('deck-link');
  await page.getByRole('button', { name: 'Close' }).first().click();
  await page.locator('iframe[title="Reading"][sandbox*="popups"]').waitFor({ state: 'detached' });
  await page.waitForTimeout(1100);

  // The page: an anchor stays in place, a web link opens once, a flood opens one.
  const before = (await opened()).length;
  await page.locator('.react-flow__node[data-id="n-page"]').dblclick({ position: { x: 150, y: 60 } });
  const doc = page.frameLocator('iframe[title="Page"]').last();
  await page.waitForTimeout(1000);
  assert.deepEqual((await opened()).slice(before), [], 'nothing opens unasked');
  await doc.locator('#toc').click();
  await page.waitForTimeout(500);
  const scrolled = await page.locator('iframe[title="Page"]').last().evaluate((frame) => frame.contentWindow ? 'opaque' : 'none').catch(() => 'opaque');
  console.log('after anchor', scrolled, (await opened()).slice(before));
  assert.deepEqual((await opened()).slice(before), [], 'the anchor opens nothing, and nothing opens unasked');
  await doc.locator('#out').click();
  await page.waitForTimeout(800);
  assert.ok((await opened()).includes('https://arxiv.org/abs/2601.16087'), 'the page link opens in the browser');
  await page.waitForTimeout(1100);
  const beforeFlood = (await opened()).length;
  await doc.locator('#flood').click();
  await page.waitForTimeout(800);
  const flood = (await opened()).length - beforeFlood;
  console.log('opened', await opened(), 'flood', flood);
  assert.ok(flood <= 1, 'twenty windows at once open one at most');
  assert.ok(!(await opened()).some((url) => url.includes('/own')), 'the file opens no window itself');
  // The viewer is still there: nothing navigated away.
  assert.equal(await page.locator('iframe[title="Page"]').count() >= 1, true);
  assert.ok(page.url().includes(`/n/${mulch.id}`), 'the app stays');
  console.log('links-out ok');
};
