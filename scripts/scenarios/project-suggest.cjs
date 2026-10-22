// Which project a mulch probably belongs to (real AI): one about the same subject as a project's mulches
// gets "Looks like <project>" with Move; one about something else gets nothing; dismissed, it stays away.
// An edit of a word in a card from speech is learned (Settings, Words).
//   node scripts/electron-run.cjs scripts/scenarios/project-suggest.cjs --shots <dir>
const assert = require('node:assert/strict');

module.exports = async ({ page, base, shot }) => {
  const api = (url, method = 'GET', body) => page.evaluate(async ({ url, method, body }) => {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  }, { url, method, body });
  await page.goto(base);
  await api('/api/onboarding', 'POST', { action: 'done' });
  const make = async (title, texts, origin = 'user') => {
    const mulch = (await api('/api/mulches', 'POST', { title })).mulch;
    await api(`/api/mulches/${mulch.id}/ops`, 'POST', { ops: texts.map((text, i) => ({ op: 'addNode', node: { id: `n${i}`, kind: 'idea', x: i * 300, y: 0, text, origin, createdAt: Date.now() } })) });
    return mulch;
  };
  const lab = (await api('/api/projects', 'POST', { name: 'Preconscious Labs' })).project;
  await api('/api/projects', 'POST', { name: 'Kitchen renovation' });
  const member = await make('Small minds steering big ones', ['Need-driven control of language models', 'Valence and homeostasis as a steering signal for agents']);
  await api(`/api/mulches/${member.id}`, 'PATCH', { project: lab.id });

  const related = await make('Intro call with Misha', [
    'Me: the lab should publish small experiments where a tiny controller with needs steers a big language model.',
    'Them: like homeostasis, the small model feels hunger or boredom and the big one does the thinking.',
    'Me: we need an editor with a voice to package each experiment into an essay people want to read.',
    'Them: start a repository and a Telegram chat, put Pipi the bot in it to keep everyone moving.',
    'Me: the bottleneck is finding the voice, the editor, the rest of how to work is clear.',
    'Them: compare with Minsky Society of Mind, and with recent preprints on affect controllers for LLMs.',
    'Me: funding could come from a few patrons, not grants, so the lab stays fast and small.',
    'Them: first experiment: a valence signal that stops an agent looping on the same tool call.',
  ], 'speech:j-x');
  const unrelated = await make('Holiday packing', Array.from({ length: 8 }, (_, i) => `Pack item ${i + 1}: sunscreen, hats, the blue suitcase, chargers, passports, swimwear and the travel adapter for Portugal.`));

  console.log('asked:', JSON.stringify((await api(`/api/mulches/${related.id}/project?suggest=1`)).suggestion));
  await page.goto(`${base}/n/${related.id}`);
  const chip = page.locator('header', { hasText: 'Looks like Preconscious Labs' });
  await chip.waitFor({ timeout: 90_000 });
  await shot('project-suggestion');
  await chip.locator('button:has-text("Move")').click();
  await page.locator('header button', { hasText: 'Preconscious Labs /' }).waitFor();
  assert.equal((await api(`/api/mulches/${related.id}/project`)).project?.id, lab.id, 'Move puts it in the project');

  const none = await api(`/api/mulches/${unrelated.id}/project?suggest=1`);
  assert.equal(none.suggestion, null, `nothing for a mulch about something else (${JSON.stringify(none.suggestion)})`);

  // Dismissed, not suggested again.
  const other = await make('Second intro on the lab', [
    'Me: tiny controllers with needs steering big language models, that is the lab.',
    'Them: the editor packages experiments into essays; Pipi keeps the chat moving.',
    'Me: affect controllers and valence signals to stop agents looping.',
    'Them: patrons rather than grants keep the lab small and fast.',
    'Me: compare with Minsky and Braitenberg vehicles for the history section.',
    'Them: first essay due in two weeks, about homeostasis in agents.',
    'Me: the repository holds every experiment with its code, its results and the essay that packages it.',
    'Them: we should ask the researcher friends to try the deck with their own agents and send back what broke.',
  ], 'speech:j-y');
  const first = await api(`/api/mulches/${other.id}/project?suggest=1`);
  assert.equal(first.suggestion?.id, lab.id, 'suggested');
  await api(`/api/mulches/${other.id}/project`, 'POST', { dismiss: lab.id });
  assert.equal((await api(`/api/mulches/${other.id}/project?suggest=1`)).suggestion, null, 'not again once dismissed');

  // A word fixed in a card from speech is learned, for the project the mulch is in.
  await api(`/api/mulches/${related.id}/ops`, 'POST', { ops: [{ op: 'updateNode', id: 'n3', patch: { text: 'Them: start a repository and a Telegram chat, put Pippi the bot in it to keep everyone moving.', userTouched: true } }] });
  await page.waitForTimeout(500);
  const words = (await api('/api/words')).words;
  assert.deepEqual(words.map((w) => [w.term, w.heard, w.project]), [['Pippi', ['Pipi'], lab.id]], 'the corrected word is learned');
  console.log('project-suggest ok');
};
