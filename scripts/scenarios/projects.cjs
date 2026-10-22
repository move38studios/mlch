// Projects and words: a new project on home, a mulch moved into it by its menu and another dragged
// onto it, New inside it, the project by the title in a mulch (and moved out from there), renaming,
// deleting (its mulches stay); a word added in Settings, Words.
//   node scripts/electron-run.cjs scripts/scenarios/projects.cjs --shots <dir>
const assert = require('node:assert/strict');

module.exports = async ({ page, base, shot }) => {
  const api = (url, method = 'GET', body) => page.evaluate(async ({ url, method, body }) => {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  }, { url, method, body });
  await page.goto(base);
  await api('/api/onboarding', 'POST', { action: 'done' });
  const make = async (title) => {
    const mulch = (await api('/api/mulches', 'POST', { title })).mulch;
    await api(`/api/mulches/${mulch.id}/ops`, 'POST', { ops: [{ op: 'addNode', node: { id: 'n', kind: 'note', x: 0, y: 0, text: title, origin: 'user', createdAt: Date.now() } }] });
    return mulch;
  };
  const one = await make('Lab call one');
  const two = await make('Lab call two');
  await make('Groceries');
  const projectOf = async (id) => (await api('/api/mulches')).mulches.find((m) => m.id === id)?.project;

  await page.goto(base);
  await page.waitForSelector('text=Lab call one');
  await page.click('button:has-text("New project")');
  await page.fill('input[aria-label="New project"]', 'Preconscious Labs');
  await page.keyboard.press('Enter');
  const section = page.locator('section[aria-label="Preconscious Labs"]');
  await section.waitFor();

  // Moved by its menu.
  const row = page.locator('li', { hasText: 'Lab call one' });
  await row.hover();
  await row.locator('button[aria-label="Project"]').click();
  await page.click('[role="menu"] button:has-text("Preconscious Labs")');
  await section.locator('text=Lab call one').waitFor();
  const project = await projectOf(one.id);
  assert.ok(project, 'the mulch is in the project');

  // Dragged onto it.
  await page.locator('li', { hasText: 'Lab call two' }).locator('a').dragTo(section.locator('button', { hasText: 'Preconscious Labs' }));
  await section.locator('text=Lab call two').waitFor({ timeout: 5000 });
  assert.equal(await projectOf(two.id), project);
  assert.equal(await page.locator('section', { hasText: 'Today' }).locator('text=Lab call one').count(), 0, 'mulches in a project are listed only inside it');
  await shot('projects-home');

  // New inside it.
  await section.locator('button[aria-label="New"]').click();
  await page.waitForURL(/\/n\//);
  const created = page.url().split('/n/')[1];
  assert.equal(await projectOf(created), project, 'New inside a project starts in it');

  // In a mulch: the project by the title; moved out from there.
  await page.goto(`${base}/n/${one.id}`);
  const crumb = page.locator('header button', { hasText: 'Preconscious Labs /' });
  await crumb.waitFor();
  await shot('projects-crumb');
  await crumb.click();
  await page.click('[role="menu"] button:has-text("No project")');
  await page.locator('header button[aria-label="Project"]').waitFor();
  assert.equal(await projectOf(one.id), undefined);

  // Rename and delete: its mulches stay.
  await page.goto(base);
  await section.waitFor();
  await section.hover();
  await section.locator('button[aria-label="Rename"]').click();
  await section.locator('input[aria-label="Name"]').fill('Lab');
  await page.keyboard.press('Enter');
  const renamed = page.locator('section[aria-label="Lab"]');
  await renamed.waitFor();
  await renamed.hover();
  await renamed.locator('button[aria-label="Delete project"]').click();
  await renamed.locator('button:has-text("Delete project")').click();
  await renamed.waitFor({ state: 'detached' });
  await page.locator('text=Lab call two').waitFor();
  assert.equal(await projectOf(two.id), undefined, 'its mulches stay, in no project');

  // Words: added by hand, listed, forgotten.
  await page.goto(`${base}/settings`);
  await page.fill('input[aria-label="Word"]', 'Fco');
  await page.fill('input[aria-label="Heard as (optional)"]', 'EFCO');
  await page.click('#words button[type="submit"]');
  await page.locator('#words li', { hasText: 'Fco' }).waitFor();
  await page.locator('#words').scrollIntoViewIfNeeded();
  await shot('words');
  const words = (await api('/api/words')).words;
  assert.deepEqual(words.map((w) => [w.term, w.heard]), [['Fco', ['EFCO']]]);
  await page.click('#words button[aria-label="Forget Fco"]');
  await page.locator('#words li').waitFor({ state: 'detached' });
  console.log('projects ok');
};
