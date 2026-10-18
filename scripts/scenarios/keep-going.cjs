// An instruction runs for a period (MLCH_PERIOD_MS, short here), pauses keeping what it added, and
// "Keep going" resumes it. Real AI (MLCH_TEST_HARNESS, default claude).
//   MLCH_PERIOD_MS=25000 node scripts/electron-run.cjs scripts/scenarios/keep-going.cjs --library <dir> --shots <dir>
const assert = require('node:assert/strict');

module.exports = async ({ page, base, shot }) => {
  const api = (url, method = 'GET', body) => page.evaluate(async ({ url, method, body }) => {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  }, { url, method, body });
  assert.ok(Number(process.env.MLCH_PERIOD_MS) > 0, 'set MLCH_PERIOD_MS');
  await page.goto(base);
  await api('/api/onboarding', 'POST', { action: 'done' });
  await api('/api/settings', 'PUT', { harness: process.env.MLCH_TEST_HARNESS || 'claude', subscriptionConsent: { codex: Date.now(), claude: Date.now() } });
  const mulch = (await api('/api/mulches', 'POST', {})).mulch;
  await page.goto(`${base}/n/${mulch.id}`);
  await page.locator('textarea[aria-label="Input"]').waitFor({ timeout: 30_000 });
  await page.fill('textarea[aria-label="Input"]', '/Add 16 cards, one per call to add_nodes (never several in one call): each a European country, its capital, and one fact about it. Then connect neighbours.');
  await page.keyboard.press('Enter');

  const job = async () => (await api(`/api/mulches/${mulch.id}/jobs`)).jobs.find((j) => j.retry?.kind === 'command');
  let paused;
  for (const end = Date.now() + 240_000; Date.now() < end && !paused; await page.waitForTimeout(1000)) {
    const j = await job();
    if (j?.state === 'paused') paused = j;
    else if (j && ['done', 'failed', 'cancelled'].includes(j.state)) throw new Error(`ended ${j.state} before its period: ${j.error ?? ''}`);
  }
  assert.ok(paused, 'paused');
  assert.ok(paused.session?.id, 'its session is kept');
  const kept = paused.resultIds?.length ?? 0;
  console.log('paused with', kept, 'items, session', paused.session);
  // The job shows paused in the activity list.
  await page.getByRole('button', { name: 'Activity' }).click();
  const keepGoing = page.getByRole('button', { name: 'Keep going' }).first();
  await keepGoing.waitFor({ timeout: 5000 });
  await shot('paused');
  await keepGoing.click();

  let done;
  for (const end = Date.now() + 400_000; Date.now() < end && !done; await page.waitForTimeout(1500)) {
    const j = await job();
    if (j?.state === 'paused') {
      // Another period ran out: keep going again.
      console.log('paused again with', j.resultIds?.length ?? 0, 'items');
      await api(`/api/mulches/${mulch.id}/jobs`, 'POST', { action: 'continue', jobId: j.id });
    } else if (j && ['done', 'failed', 'cancelled'].includes(j.state)) done = j;
  }
  assert.equal(done?.state, 'done', done?.error);
  assert.equal(done.id, paused.id, 'the same job');
  assert.ok((done.resultIds?.length ?? 0) >= kept, 'what it added before stays');
  const cards = Object.values((await api(`/api/mulches/${mulch.id}`)).mulch.nodes).filter((n) => n.kind !== 'note');
  console.log('done with', done.resultIds?.length, 'items;', cards.length, 'cards on the canvas');
  await shot('kept-going');
  console.log('keep-going ok');
};
