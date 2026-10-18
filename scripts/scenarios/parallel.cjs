// Many instructions at once in one mulch (real AI, MLCH_TEST_HARNESS, default claude), each about the cards
// selected when it was given; other mulches with work in them listed at the left; closing the list is focus
// mode for this mulch, kept, and the count by the title opens it again.
const assert = require('node:assert/strict');

module.exports = async ({ page, base, shot }) => {
  const api = (url, method = 'GET', body) => page.evaluate(async ({ url, method, body }) => {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  }, { url, method, body });
  await page.goto(base);
  await api('/api/onboarding', 'POST', { action: 'done' });
  await api('/api/settings', 'PUT', { harness: process.env.MLCH_TEST_HARNESS || 'claude', subscriptionConsent: { codex: Date.now(), claude: Date.now() } });

  // Another mulch with work in it.
  const other = (await api('/api/mulches', 'POST', {})).mulch;
  await api(`/api/mulches/${other.id}/ops`, 'POST', { ops: [{ op: 'addNode', node: { id: 'o-1', kind: 'idea', x: 0, y: 0, text: 'Coffee shops as offices', origin: 'user', createdAt: Date.now() } }] });
  await api(`/api/mulches/${other.id}/command`, 'POST', { instruction: 'Add three cards with arguments for and against working from coffee shops.' });

  const mulch = (await api('/api/mulches', 'POST', {})).mulch;
  const areas = [['a', 'Pricing: charge per seat', 0], ['b', 'Hiring: first designer', 900], ['c', 'Launch: which city first', 1800]];
  await api(`/api/mulches/${mulch.id}/ops`, 'POST', { ops: areas.map(([id, text, x]) => ({ op: 'addNode', node: { id: `n-${id}`, kind: 'idea', x, y: 0, text, origin: 'user', createdAt: Date.now() } })) });
  await page.goto(`${base}/n/${mulch.id}`);
  await page.locator('.react-flow__node[data-id="n-a"]').waitFor({ timeout: 30_000 });

  // The list of other mulches shows the one at work.
  const list = page.getByRole('navigation', { name: 'Other mulches' });
  await list.waitFor({ timeout: 20_000 });
  assert.match(await list.innerText(), /Untitled|Coffee|office/i);
  await shot('list');

  // Three instructions, each with its card selected, and three more with nothing selected.
  const input = page.locator('textarea[aria-label="Input"]');
  for (const [id] of areas) {
    await page.locator(`.react-flow__node[data-id="n-${id}"]`).click({ position: { x: 20, y: 12 } });
    await input.fill('/Add two cards: one risk and one question about this.');
    await input.press('Enter');
    await page.waitForTimeout(300);
  }
  await page.locator('.react-flow__pane').click({ position: { x: 5, y: 300 } });
  for (const topic of ['remote teams', 'note-taking apps', 'city cycling']) {
    await input.fill(`/Add one card with a surprising fact about ${topic}, far from the other cards.`);
    await input.press('Enter');
    await page.waitForTimeout(300);
  }
  const kept = async () => (await api(`/api/mulches/${mulch.id}/jobs`)).jobs.filter((j) => j.retry?.kind === 'command');
  let most = 0;
  for (const end = Date.now() + 300_000; Date.now() < end; await page.waitForTimeout(1000)) {
    const jobs = await kept();
    most = Math.max(most, jobs.filter((j) => j.state === 'running').length);
    if (jobs.length === 6 && jobs.every((j) => !['queued', 'running'].includes(j.state))) break;
  }
  const jobs = await kept();
  console.log('most at once', most, jobs.map((j) => `${j.state}:${j.resultIds?.length ?? 0}`).join(' '));
  assert.ok(most >= 5, `ran side by side (${most} at most)`);
  assert.ok(jobs.every((j) => j.state === 'done'), 'all done');
  // Each selected-card instruction kept what it was about, and its cards landed near it.
  const now = (await api(`/api/mulches/${mulch.id}`)).mulch;
  for (const [id] of areas) {
    const job = jobs.find((j) => j.retry.near?.includes(`n-${id}`));
    assert.ok(job, `instruction about n-${id}`);
    const added = (job.resultIds ?? []).map((r) => now.nodes[r]).filter(Boolean);
    assert.ok(added.length >= 1, `added cards for n-${id}`);
    const nearest = (node) => areas.reduce((best, area) => (Math.abs(node.x - area[2]) < Math.abs(node.x - best[2]) ? area : best));
    const right = added.filter((node) => nearest(node)[0] === id).length;
    console.log(`n-${id}: ${right}/${added.length} near it`);
    assert.ok(right >= added.length / 2, `cards for n-${id} land near it`);
  }
  await page.locator('.react-flow__pane').click({ position: { x: 5, y: 300 } });
  await shot('six-done');

  // Close the list: focus mode for this mulch; the count by the title opens it again.
  if (!(await list.isVisible())) {
    // The other mulch's work may have aged out of the list: give it something unseen.
    await api(`/api/mulches/${other.id}/command`, 'POST', { instruction: 'Add one more card.' });
    await list.waitFor({ timeout: 20_000 });
  }
  await list.getByRole('button', { name: 'Close' }).click();
  await list.waitFor({ state: 'hidden' });
  const count = page.getByRole('button', { name: 'Other mulches' });
  await count.waitFor();
  await shot('focus');
  const listed = (await api('/api/mulches')).mulches.find((m) => m.id === mulch.id);
  assert.equal(listed.focus, true, 'kept for this mulch');
  // Kept across a reload; the other mulch is not in focus mode.
  await page.reload();
  await count.waitFor({ timeout: 20_000 });
  assert.equal(await list.isVisible(), false);
  await page.goto(`${base}/n/${other.id}`);
  await page.locator('.react-flow__node[data-id="o-1"]').waitFor({ timeout: 20_000 });
  assert.equal(await count.isVisible(), false, 'focus mode belongs to one mulch');
  await page.goto(`${base}/n/${mulch.id}`);
  await count.waitFor({ timeout: 20_000 });
  await count.click();
  await list.waitFor();
  assert.equal((await api('/api/mulches')).mulches.find((m) => m.id === mulch.id).focus, undefined);
  // Clicking a row goes there.
  await list.getByRole('link').first().click();
  await page.waitForURL(new RegExp(`/n/${other.id}$`));
  console.log('parallel ok');
};
