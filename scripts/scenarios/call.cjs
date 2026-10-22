// A call, end to end with real AI: start listening, a two-person conversation plays into the microphone
// (system audio needs macOS permission; see local-audio.cjs). During the call: the transcript card fills in,
// decisions and to-dos go into one card, topics become areas left to right, and the live layer adds what
// helps (a book mentioned, an answer, a term) into the current topic; no cards are made from speech.
// When it ends: the notes, and the tidy (the call's points as cards in their topics).
//   node scripts/electron-run.cjs scripts/scenarios/call.cjs --fake-mic <call.wav> --shots <dir>
// The recording: two voices on pricing (Kahneman's book, a question about Slack, the Jevons paradox,
// a decision and a to-do), then a launch event (the Gulbenkian, Kate Raworth, a decision).
const assert = require('node:assert/strict');

module.exports = async ({ page, base, shot }) => {
  const api = (url, method = 'GET', body) => page.evaluate(async ({ url, method, body }) => {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  }, { url, method, body });
  await api('/api/settings', 'PUT', { transcription: 'local' });
  const mulch = (await api('/api/mulches', 'POST', {})).mulch;
  await page.goto(`${base}/n/${mulch.id}`);
  await page.waitForSelector('[aria-label="Call"]');
  const started = Date.now();
  await page.click('[aria-label="Call"]');
  await page.waitForSelector('[aria-label="Stop listening"]');
  await shot('call-listening');

  const get = async () => (await api(`/api/mulches/${mulch.id}`)).mulch;
  const live = (m) => Object.values(m.nodes).filter((n) => n.origin.startsWith('agent:j-'));
  // The recording runs about 85 s; the live layer runs at most once a minute.
  let during;
  while (Date.now() - started < 240_000) {
    await page.waitForTimeout(5000);
    during = await get();
    const decisions = Object.values(during.nodes).find((n) => n.title === 'Decisions and to-dos');
    if (Date.now() - started > 100_000 && decisions && live(during).length >= 2 && Object.keys(during.groups).length >= 2) break;
  }
  await shot('call-during');
  const nodes = Object.values(during.nodes);
  const transcript = nodes.find((n) => n.origin === 'speech:call');
  assert.ok(transcript && /\(\d\d:\d\d\)/.test(transcript.text), 'the transcript card fills in during the call');
  const decisions = nodes.find((n) => n.title === 'Decisions and to-dos');
  assert.ok(decisions, 'decisions and to-dos have their card');
  console.log(`decisions:\n${decisions.text}`);
  assert.match(decisions.text, /seat/i, 'the pricing decision is there');
  const said = nodes.filter((n) => n.origin.startsWith('speech:') && n.origin !== 'speech:call');
  assert.equal(said.length, 0, `no cards from speech during the call (${JSON.stringify(said.map((n) => n.text))})`);
  const topics = Object.values(during.groups);
  console.log(`topics: ${topics.map((g) => `${g.title} @${g.x}`).join(', ')}`);
  assert.ok(topics.length >= 1, 'topics become areas');
  const sorted = [...topics].sort((a, b) => a.createdAt - b.createdAt);
  for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i].x > sorted[i - 1].x, 'topics run left to right');
  const added = live(during);
  console.log(`live cards (${added.length}):\n${added.map((n) => `  [${n.kind}] ${n.title ?? ''}: ${n.text.slice(0, 120)}${n.url ? ` <${n.url}>` : ''} in ${during.groups[n.groupId]?.title ?? '-'}`).join('\n')}`);
  assert.ok(added.length >= 2, 'the live layer adds what helps');
  assert.ok(added.every((n) => n.groupId && during.groups[n.groupId]), 'live cards sit in a topic');
  assert.ok(added.some((n) => /kahneman|thinking, fast|jevons|raworth|gulbenkian|slack/i.test(`${n.title} ${n.text}`)), 'they are about what was mentioned');
  // Each in the topic of its moment: the book in pricing, the museum in the launch.
  const topicOf = (pattern) => added.filter((n) => pattern.test(`${n.title} ${n.text}`)).map((n) => n.groupId);
  const book = topicOf(/kahneman|thinking, fast/i);
  const museum = topicOf(/gulbenkian/i);
  if (book.length && museum.length && sorted.length >= 2) assert.notEqual(book[0], museum[0], 'cards go into the topic of their moment');

  await page.click('[aria-label="Stop listening"]');
  const stopped = Date.now();
  let after;
  let notes;
  while (Date.now() - stopped < 300_000) {
    await page.waitForTimeout(5000);
    after = await get();
    notes = Object.values(after.nodes).find((n) => n.kind === 'writeup' && /^Notes/.test(n.title ?? ''));
    const jobs = (await api(`/api/mulches/${mulch.id}/jobs`)).jobs ?? [];
    const tidy = jobs.find((j) => j.label === 'Tidying the call');
    if (notes && tidy && ['done', 'failed'].includes(tidy.state)) {
      assert.equal(tidy.state, 'done', `the tidy finished (${tidy.error ?? ''})`);
      break;
    }
  }
  assert.ok(notes, 'the call notes are written when it ends');
  // The last batch is captured after the call stops; its decision still reaches the card.
  const finalDecisions = Object.values(after.nodes).find((n) => n.title === 'Decisions and to-dos');
  console.log(`decisions at the end:\n${finalDecisions.text}`);
  assert.match(finalDecisions.text, /ra[iy]?w?orth/i, 'the last decision is on the card');
  const points = Object.values(after.nodes).filter((n) => n.origin.startsWith('speech:j-'));
  console.log(`after: ${Object.keys(after.nodes).length} cards, groups: ${Object.values(after.groups).map((g) => g.title).join(', ')}`);
  console.log(`points (${points.length}):\n${points.map((n) => `  [${n.kind}] ${n.text}`).join('\n')}`);
  assert.ok(points.length >= 3, 'the call\'s points become cards when it ends');
  assert.ok(points.length <= 25, 'but not a card per sentence');
  assert.ok(points.every((n) => n.groupId), 'in groups');
  await page.keyboard.press('Meta+Digit0');
  await page.waitForTimeout(800);
  await shot('call-after');
  console.log(`took ${Math.round((Date.now() - started) / 1000)} s`);
  console.log('call ok');
};
