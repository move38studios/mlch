// New, then back without adding anything: no empty row on the home screen.
const assert = require('node:assert/strict');

module.exports = async ({ page, base }) => {
  const list = () => page.evaluate(async () => (await (await fetch('/api/mulches')).json()).mulches ?? []);
  const before = (await list()).length;
  const id = await page.evaluate(async () => (await (await fetch('/api/mulches', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()).mulch.id);
  await page.goto(`${base}/n/${id}`);
  await page.waitForSelector('.react-flow__pane');
  await page.goto(base);
  await page.waitForTimeout(1500);
  assert.equal((await list()).length, before, 'the empty mulch is not listed');
  await page.waitForTimeout(6000);
  const exists = await page.evaluate(async (mid) => (await fetch(`/api/mulches/${mid}`)).status, id);
  assert.equal(exists, 404, 'the empty mulch is removed');
  console.log('empty mulch ok');
};
