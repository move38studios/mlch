// Decks and pages (PLAN-3 R3): a deck built by src/lib/artifacts/deck.ts and two pages, checked the way
// preview_artifact checks them (main's renderArtifact), then shown in the app viewer at desktop and phone size:
// one slide visible even with CSS that shows them all, keys and swipe move, a page scrolls, edge to edge on a phone.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/** The app's own deck builder and problem wording, bundled for this script. */
function appCode() {
  const root = path.join(__dirname, '..', '..');
  const { outputFiles } = require('esbuild').buildSync({
    stdin: { contents: 'export * from "./src/lib/artifacts/deck"; export * from "./src/lib/artifacts/checks";', resolveDir: root, loader: 'ts' },
    bundle: true, format: 'cjs', platform: 'node', write: false,
  });
  const bundle = { exports: {} };
  new Function('module', 'exports', 'require', outputFiles[0].text)(bundle, bundle.exports, require);
  return bundle.exports;
}

const VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1">';
const GOOD_PAGE = `<!doctype html><html><head><meta name="mlch:kind" content="page">${VIEWPORT}<style>body{margin:0;font:18px/1.5 sans-serif}main{max-width:70ch;margin:0 auto;padding:24px}</style></head>
<body><main><h1>A page</h1>${'<p>Squirrels bury nuts in many places and find most of them again by smell and memory.</p>'.repeat(40)}</main></body></html>`;
const BAD_PAGE = `<!doctype html><html><head><meta name="mlch:kind" content="page"><style>html,body{margin:0;height:100%;overflow:hidden}table{width:900px}small{font-size:9px}</style></head>
<body><table><tr><td>Wide table</td></tr></table>${'<p>Line</p>'.repeat(80)}<small>fine print</small></body></html>`;

module.exports = async ({ app, page, base, shot }) => {
  const { buildDeck, deckProblems, pageProblems } = appCode();
  const api = (url, method = 'GET', body) => page.evaluate(async ({ url, method, body }) => {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  }, { url, method, body });
  const library = process.argv[process.argv.indexOf('--library') + 1];
  const mulch = (await api('/api/mulches', 'POST', {})).mulch;
  const dir = path.join(library, mulch.id, 'artifacts');
  fs.mkdirSync(dir, { recursive: true });

  // The squirrel deck's mistake (a rule that shows a slide at all times), and a slide too full to fit.
  const deck = buildDeck({
    title: 'Squirrels',
    css: '.split{display:grid!important;grid-template-columns:1fr 1fr} .slide{display:block!important} .t{padding:160px;font:120px/1.1 sans-serif}',
    slides: [
      '<div class="t">The squirrel\'s morning</div>',
      '<div class="split t"><p>Left</p><p>Right</p></div>',
      `<div class="t">${'Too many words on one slide. '.repeat(30)}</div>`,
    ],
  });
  fs.writeFileSync(path.join(dir, 'squirrels.html'), deck);
  fs.writeFileSync(path.join(dir, 'notes.html'), GOOD_PAGE);
  fs.writeFileSync(path.join(dir, 'cramped.html'), BAD_PAGE);
  await api(`/api/mulches/${mulch.id}/ops`, 'POST', { ops: [
    { op: 'addNode', node: { id: 'n-deck', kind: 'artifact', x: 0, y: 0, title: 'Squirrels', text: 'A deck', docPath: 'artifacts/squirrels.html', artifactKind: 'deck', origin: 'agent:j0', createdAt: 1 } },
    { op: 'addNode', node: { id: 'n-page', kind: 'artifact', x: 500, y: 0, title: 'Notes', text: 'A page', docPath: 'artifacts/notes.html', artifactKind: 'page', origin: 'agent:j0', createdAt: 1 } },
  ] });

  // What preview_artifact sees.
  const render = (file, kind) => app.evaluate((_electron, { url, kind }) => globalThis.__mlchRender(url, { kind }), { url: `/api/mulches/${mulch.id}/artifacts/${file}`, kind });
  const deckSeen = await render('squirrels.html', 'deck');
  console.log('deck', JSON.stringify(deckSeen.deck), deckProblems(deckSeen.deck));
  assert.equal(deckSeen.deck.count, 3);
  assert.equal(deckSeen.images.length, 3, 'a screenshot per slide');
  assert.equal(deckSeen.deck.visibleAtLoad, 1);
  assert.deepEqual(deckSeen.deck.slides.map((s) => s.visible), [1, 1, 1], 'one slide at a time');
  assert.equal(deckSeen.deck.slides[0].overflow, null);
  assert.ok(deckSeen.deck.slides[2].overflow?.bottom > 1080, 'the full slide overflows');
  assert.equal(deckProblems(deckSeen.deck).length, 1);
  const good = await render('notes.html', 'page');
  console.log('page', JSON.stringify(good.page.shots.map(({ smallText, ...rest }) => ({ ...rest, small: smallText.length }))));
  assert.deepEqual(good.page.shots.map((s) => s.width), [1280, 390], 'desktop and phone width');
  assert.deepEqual(pageProblems(good.page, GOOD_PAGE), []);
  const bad = await render('cramped.html', 'page');
  const problems = pageProblems(bad.page, BAD_PAGE);
  console.log('cramped page problems', problems);
  assert.ok(problems.some((p) => p.includes('scrolls sideways')), 'sideways scroll');
  assert.ok(problems.some((p) => p.includes('cannot scroll')), 'clipped');
  assert.ok(problems.some((p) => p.includes('fine print')), 'small text');
  assert.ok(problems.some((p) => p.includes('viewport')), 'no viewport meta');

  // The deck in the app's viewer.
  await page.goto(`${base}/n/${mulch.id}`);
  const card = page.locator('.react-flow__node').filter({ hasText: 'Squirrels' }).first();
  await card.waitFor({ timeout: 15_000 });
  assert.match(await card.locator('iframe').getAttribute('src'), /\?still#1$/, 'the card shows the first slide, no counter');
  await card.dblclick({ position: { x: 150, y: 60 } });
  const viewer = page.locator('[data-kind="deck"] iframe');
  await viewer.waitFor();
  await page.waitForTimeout(800);
  const stage = await page.locator('[data-kind="deck"]').boundingBox();
  const box = await viewer.boundingBox();
  assert.ok(box.width > stage.width - 30 && box.height > stage.height - 20, 'the deck fills the stage');
  assert.equal(await page.getByRole('button', { name: 'Present' }).count(), 1);
  const slides = (await viewer.elementHandle()).contentFrame();
  const inDeck = async () => (await slides).evaluate(() => ({
    index: window.__mlchDeck.index,
    visible: Array.from(document.querySelectorAll('[data-slide]')).filter((s) => getComputedStyle(s).display !== 'none').length,
  }));
  assert.deepEqual(await inDeck(), { index: 0, visible: 1 });
  await shot('deck-desktop');
  await viewer.click({ position: { x: box.width * 0.8, y: box.height / 2 } });
  assert.deepEqual(await inDeck(), { index: 1, visible: 1 }, 'a click on the right half moves on');
  await page.keyboard.press('ArrowLeft');
  assert.equal((await inDeck()).index, 0, 'the left arrow moves back');
  await page.keyboard.press('End');
  assert.equal((await inDeck()).index, 2, 'End goes to the last slide');
  await page.keyboard.press('Escape');

  // A phone-sized window: the deck edge to edge, a swipe moves.
  // (A window cannot be made that narrow on macOS, so the page is emulated at phone size.)
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await page.waitForTimeout(800);
  const phone = await viewer.boundingBox();
  assert.ok(phone && phone.x === 0 && phone.width === 390, `edge to edge on a phone (${JSON.stringify(phone)})`);
  await (await slides).evaluate(() => {
    const fire = (type, x) => document.dispatchEvent(new PointerEvent(type, { pointerType: 'touch', pointerId: 3, clientX: x, clientY: 200, bubbles: true }));
    window.__mlchDeck.go(0);
    fire('pointerdown', 300);
    fire('pointerup', 80);
  });
  assert.deepEqual(await inDeck(), { index: 1, visible: 1 }, 'a swipe to the left moves on');
  await shot('deck-phone');
  await page.getByRole('button', { name: 'Close' }).click();

  // The page: fills the stage, scrolls, no Present.
  const pageCard = page.locator('.react-flow__node').filter({ hasText: 'Notes' }).first();
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await page.waitForTimeout(500);
  await pageCard.dblclick({ position: { x: 150, y: 60 } });
  const pageFrame = page.locator('[data-kind="page"] iframe');
  await pageFrame.waitFor();
  await page.waitForTimeout(800);
  assert.equal(await page.getByRole('button', { name: 'Present' }).count(), 0, 'no Present for a page');
  const scrolled = await (await (await pageFrame.elementHandle()).contentFrame()).evaluate(() => { window.scrollTo(0, 600); return window.scrollY; });
  assert.ok(scrolled > 0, 'the page scrolls');
  await shot('page-desktop');
  console.log('decks-pages ok');
};
