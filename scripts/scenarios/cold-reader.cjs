// A deck made from a canvas full of inside references reads cold: the reader who saw nothing else
// is asked after it is written, and the deck explains or cuts what it pointed at. Real AI.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ page, base }) => {
  const api = (url, method = 'GET', body) => page.evaluate(async ({ url, method, body }) => {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  }, { url, method, body });
  const library = process.argv[process.argv.indexOf('--library') + 1];
  await page.goto(base);
  await api('/api/onboarding', 'POST', { action: 'done' });
  await api('/api/settings', 'PUT', { harness: process.env.MLCH_TEST_HARNESS || 'claude', subscriptionConsent: { claude: Date.now(), codex: Date.now() } });
  const mulch = (await api('/api/mulches', 'POST', {})).mulch;
  const cards = [
    'Loudbox: AI creative strategy for paid social. DCBL runs the service layer.',
    'Of the 31 we mapped, only 5 cover all five steps of the loop.',
    'Vadim raised on the call that "self-improving" is taken by GetCrux.',
    'My post-it: lead with the Finom curve, not the tech.',
    'ICP: Head of UA at digital natives.',
  ];
  await api(`/api/mulches/${mulch.id}/ops`, 'POST', { ops: cards.map((text, i) => ({ op: 'addNode', node: { id: `n-${i}`, kind: 'note', x: i * 260, y: 0, text, origin: 'user', createdAt: Date.now() } })) });
  await page.goto(`${base}/n/${mulch.id}`);
  await api(`/api/mulches/${mulch.id}/command`, 'POST', { instruction: 'Make a 4-slide deck from these notes for the Loudbox founders.' });
  let job;
  const activities = new Set();
  for (const end = Date.now() + 600_000; Date.now() < end; await page.waitForTimeout(2000)) {
    job = (await api(`/api/mulches/${mulch.id}/jobs`)).jobs.find((j) => j.retry?.kind === 'command');
    if (job?.activity) activities.add(job.activity);
    if (job && !['queued', 'running'].includes(job.state)) break;
  }
  console.log(job.state, job.error ?? '', [...activities].join(' | '));
  assert.equal(job.state, 'done');
  const deck = Object.values((await api(`/api/mulches/${mulch.id}`)).mulch.nodes).find((n) => n.kind === 'artifact');
  assert.ok(deck, 'a deck');
  const html = fs.readFileSync(path.join(library, mulch.id, deck.docPath), 'utf8');
  const text = html.replace(/<(script|style)[\s\S]*?<\/\1>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  console.log('DECK TEXT:', text.slice(0, 2500));
  assert.ok([...activities].some((a) => /cold/i.test(a)), 'the cold reader ran');
  console.log('cold-reader ok');
};
