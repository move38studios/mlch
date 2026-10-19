// A comment acted on now (⌘↩ in the comment box): it goes by itself, the AI acts and closes it; another
// comment and a note keep waiting for the person's turn (the chip). Then an existing comment's arrow. Real AI.
const assert = require('node:assert/strict');

module.exports = async ({ page, base, shot }) => {
  const api = (url, method = 'GET', body) => page.evaluate(async ({ url, method, body }) => {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  }, { url, method, body });
  await page.goto(base);
  await api('/api/onboarding', 'POST', { action: 'done' });
  await api('/api/settings', 'PUT', { harness: 'claude', subscriptionConsent: { claude: Date.now() } });
  const mulch = (await api('/api/mulches', 'POST', {})).mulch;
  await api(`/api/mulches/${mulch.id}/ops`, 'POST', { ops: [
    { op: 'addNode', node: { id: 'n-a', kind: 'idea', x: 0, y: 0, text: 'Remote teams need written decisions because spoken ones are forgotten and nobody can find them later when it matters.', origin: 'agent:j0', createdAt: Date.now() } },
    { op: 'addNode', node: { id: 'n-b', kind: 'idea', x: 500, y: 0, text: 'Async work suits deep focus.', origin: 'agent:j0', createdAt: Date.now() } },
  ] });
  await page.goto(`${base}/n/${mulch.id}`);
  const cardA = page.locator('.react-flow__node[data-id="n-a"]');
  const cardB = page.locator('.react-flow__node[data-id="n-b"]');
  await cardA.waitFor({ timeout: 20_000 });
  const field = page.getByRole('textbox', { name: 'Comment' });

  // A comment that waits, on B, and a note.
  await cardB.click({ position: { x: 20, y: 12 } });
  await cardB.getByRole('button', { name: 'Comments' }).click();
  await field.fill('Add an example.');
  await field.press('Enter');
  await page.keyboard.press('Escape');
  await api(`/api/mulches/${mulch.id}/ops`, 'POST', { ops: [{ op: 'addNode', node: { id: 'n-note', kind: 'note', x: 0, y: 300, text: 'Decision logs: one line each.', origin: 'user', createdAt: Date.now() } }] });
  await page.getByRole('button', { name: '1 comment, 1 note' }).waitFor({ timeout: 10_000 });

  // One acted on now, on A.
  await cardA.click({ position: { x: 20, y: 12 } });
  await cardA.getByRole('button', { name: 'Comments' }).click();
  await field.fill('Make this one short sentence.');
  await shot('comment-now');
  await field.press('Meta+Enter');
  await page.keyboard.press('Escape');
  let job;
  for (const end = Date.now() + 420_000; Date.now() < end; await page.waitForTimeout(3000)) {
    job = (await api(`/api/mulches/${mulch.id}/jobs`)).jobs.find((j) => j.retry?.comment);
    if (job && !['queued', 'running'].includes(job.state)) break;
  }
  const now = (await api(`/api/mulches/${mulch.id}`)).mulch;
  const comments = Object.values(now.comments);
  const onA = comments.find((c) => c.nodeId === 'n-a');
  const onB = comments.find((c) => c.nodeId === 'n-b');
  console.log('job', job.state, job.retry, job.message?.text?.slice(0, 200) ?? '');
  console.log('A now:', now.nodes['n-a'].text, '| comment ->', onA.resolution);
  assert.equal(job.state, 'done');
  assert.equal(job.retry.input, 'Make this one short sentence.');
  assert.ok(onA.resolvedAt, 'the AI closed the comment acted on now');
  assert.ok(!onB.sentAt, 'the other comment keeps waiting');
  await page.getByRole('button', { name: '1 comment, 1 note' }).waitFor({ timeout: 5000 });
  await shot('after-now');

  // The waiting one, by its arrow.
  await cardB.getByRole('button', { name: 'Comments' }).click();
  await page.locator('li').filter({ hasText: 'Add an example.' }).hover();
  await page.getByRole('button', { name: 'Do it now' }).first().click();
  for (const end = Date.now() + 420_000; Date.now() < end; await page.waitForTimeout(3000)) {
    job = (await api(`/api/mulches/${mulch.id}/jobs`)).jobs.find((j) => j.retry?.comment === onB.id);
    if (job && !['queued', 'running'].includes(job.state)) break;
  }
  const last = (await api(`/api/mulches/${mulch.id}`)).mulch;
  console.log('B comment ->', last.comments[onB.id].resolution);
  assert.equal(job.state, 'done');
  assert.ok(last.comments[onB.id].resolvedAt, 'closed');
  await page.getByRole('button', { name: '1 note' }).waitFor({ timeout: 5000 });
  console.log('comment-now ok');
};
