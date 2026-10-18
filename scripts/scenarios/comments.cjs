// Comments wait for your turn: a comment on a card and one on a deck's slide (in the viewer, with its slide bar),
// a note added, the chip says "2 comments, 1 note", sending it hands all of it to the AI, which acts and closes
// each comment. Live / Quiet per mulch, kept. Real AI.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ page, base, shot }) => {
  const api = (url, method = 'GET', body) => page.evaluate(async ({ url, method, body }) => {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  }, { url, method, body });
  const library = process.argv[process.argv.indexOf('--library') + 1];
  await page.goto(base);
  await api('/api/onboarding', 'POST', { action: 'done' });
  await api('/api/settings', 'PUT', { harness: 'claude', subscriptionConsent: { claude: Date.now() } });
  const mulch = (await api('/api/mulches', 'POST', {})).mulch;
  // A deck of 30 slides, made the way write_artifact makes them.
  const slides = Array.from({ length: 30 }, (_, i) => `<h1 style="font-size:120px;margin:120px">Slide ${i + 1}</h1>`);
  fs.mkdirSync(path.join(library, mulch.id, 'artifacts'), { recursive: true });
  await api(`/api/mulches/${mulch.id}/ops`, 'POST', { ops: [
    { op: 'addNode', node: { id: 'n-idea', kind: 'idea', x: 0, y: 0, text: 'Remote teams need written decisions.', origin: 'agent:j0', createdAt: Date.now() } },
  ] });
  const { outputFiles } = require('esbuild').buildSync({
    stdin: { contents: 'export * from "./src/lib/artifacts/deck";', resolveDir: path.join(__dirname, '..', '..'), loader: 'ts' },
    bundle: true, format: 'cjs', platform: 'node', write: false,
  });
  const bundle = { exports: {} };
  new Function('module', 'exports', 'require', outputFiles[0].text)(bundle, bundle.exports, require);
  const deckHtml = bundle.exports.buildDeck({ title: 'Thirty', slides });
  fs.writeFileSync(path.join(library, mulch.id, 'artifacts', 'thirty.html'), deckHtml);
  await api(`/api/mulches/${mulch.id}/ops`, 'POST', { ops: [
    { op: 'addNode', node: { id: 'n-deck', kind: 'artifact', x: 500, y: 0, title: 'Thirty', text: '', docPath: 'artifacts/thirty.html', fileName: 'thirty.html', artifactKind: 'deck', origin: 'agent:j0', createdAt: Date.now() } },
  ] });
  await page.goto(`${base}/n/${mulch.id}`);
  const card = page.locator('.react-flow__node[data-id="n-idea"]');
  await card.waitFor({ timeout: 20_000 });

  // Live / Quiet: Quiet is kept for this mulch.
  await page.getByRole('button', { name: 'Live' }).click();
  await page.getByRole('button', { name: 'Quiet' }).waitFor();
  await page.reload();
  await page.getByRole('button', { name: 'Quiet' }).waitFor({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Quiet' }).click();
  await page.getByRole('button', { name: 'Live' }).waitFor();

  // A comment on the card.
  await card.click({ position: { x: 20, y: 12 } });
  await card.getByRole('button', { name: 'Comments' }).click();
  const field = page.getByRole('textbox', { name: 'Comment' });
  await field.fill('Make this sharper: say who decides.');
  await field.press('Enter');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('.react-flow__node[data-id="n-idea"] [aria-label="Comments"]')?.textContent?.trim() === '1');

  // The deck in the viewer: the slide bar jumps, a comment keeps its slide.
  await page.locator('.react-flow__node[data-id="n-deck"]').dblclick({ position: { x: 150, y: 60 } });
  const bar = page.getByRole('slider', { name: 'Slide' });
  await bar.waitFor({ timeout: 15_000 });
  const box = await bar.boundingBox();
  await page.mouse.click(box.x + box.width * 0.5 + 2, box.y + box.height / 2);
  await page.waitForFunction(() => document.querySelector('[role="slider"][aria-label="Slide"]')?.getAttribute('aria-valuenow') === '16', null, { timeout: 5000 });
  await shot('slide-bar');
  await page.locator('[aria-label="Comments"]').last().click();
  await field.fill('Cut this slide.');
  await field.press('Enter');
  await page.keyboard.press('Escape');
  const comments = Object.values((await api(`/api/mulches/${mulch.id}`)).mulch.comments ?? {});
  const onSlide = comments.find((c) => c.nodeId === 'n-deck');
  assert.equal(onSlide?.at?.slide, 16, 'the comment keeps its slide');
  await page.getByRole('button', { name: 'Close' }).first().click().catch(() => {});
  await page.keyboard.press('Escape');

  // A note of mine, then the chip.
  await api(`/api/mulches/${mulch.id}/ops`, 'POST', { ops: [{ op: 'addNode', node: { id: 'n-note', kind: 'note', x: 0, y: 300, text: 'Also: written beats spoken for async teams.', origin: 'user', createdAt: Date.now() } }] });
  const chip = page.getByRole('button', { name: '2 comments, 1 note' });
  await chip.waitFor({ timeout: 10_000 });
  await shot('chip');
  await chip.click();
  let job;
  for (const end = Date.now() + 420_000; Date.now() < end; await page.waitForTimeout(3000)) {
    job = (await api(`/api/mulches/${mulch.id}/jobs`)).jobs.find((j) => j.retry?.kind === 'command');
    if (job && !['queued', 'running'].includes(job.state)) break;
  }
  console.log('job', job.state, job.retry.input, job.message?.text?.slice(0, 300) ?? '');
  assert.equal(job.state, 'done');
  const after = Object.values((await api(`/api/mulches/${mulch.id}`)).mulch.comments ?? {});
  for (const c of after) console.log('comment', c.text, '->', c.resolvedAt ? c.resolution : '(open)');
  assert.ok(after.every((c) => c.sentAt), 'both went with the turn');
  assert.ok(after.filter((c) => c.resolvedAt).length >= 1, 'the AI closed comments with what it did');
  assert.equal(await chip.isVisible(), false, 'the chip is gone after the turn');
  await shot('after-turn');
  console.log('comments ok');
};
