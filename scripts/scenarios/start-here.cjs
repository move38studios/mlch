// The "Start here" mulch: made on the first onboarding call, with its picture, example deck and video card.
const assert = require('node:assert/strict');

module.exports = async ({ page, base, shot }) => {
  const api = (url) => page.evaluate(async (url) => (await fetch(url)).json(), url);
  await api('/api/onboarding');
  const start = (await api('/api/mulches')).mulches.find((m) => m.title === 'Start here');
  assert.ok(start, 'Start here was made');
  const { mulch } = await api(`/api/mulches/${start.id}`);
  const nodes = Object.values(mulch.nodes);
  const picture = nodes.find((n) => n.kind === 'image');
  const deck = nodes.find((n) => n.kind === 'artifact');
  const video = nodes.find((n) => n.kind === 'link' && n.url?.includes('youtube.com'));
  assert.ok(picture?.assetId, 'the picture card has its file');
  assert.match(deck?.docPath ?? '', /^artifacts\/.+\.html$/, 'the example deck was made');
  assert.ok(video, 'the video card is there');

  await page.goto(`${base}/n/${start.id}`);
  await page.locator(`.react-flow__node[data-id="${picture.id}"] img`).waitFor();
  await page.waitForTimeout(1500);
  assert.ok(await page.locator(`.react-flow__node[data-id="${picture.id}"] img`).evaluate((img) => img.naturalWidth > 0), 'the picture loads');
  await shot('start-here');
  await page.locator(`.react-flow__node[data-id="${deck.id}"]`).dblclick();
  await page.waitForTimeout(2000);
  await shot('start-here-deck');
  console.log('start-here ok');
};
