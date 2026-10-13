// A picture with see-through parts sits on the paper without a card; an opaque one (even a PNG with an alpha channel) keeps its card.
//   node scripts/electron-run.cjs scripts/scenarios/transparent-images.cjs --library <dir>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

/** A 40×40 RGBA PNG; `pixel(x, y)` gives each pixel's 4 bytes. */
function png(pixel) {
  const size = 40;
  const rows = [];
  for (let y = 0; y < size; y++) rows.push(Buffer.concat([Buffer.from([0]), ...Array.from({ length: size }, (_, x) => Buffer.from(pixel(x, y)))]));
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

module.exports = async ({ page, base, shot }) => {
  const api = (url, method = 'GET', body) => page.evaluate(async ({ url, method, body }) => {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  }, { url, method, body });
  const library = process.argv[process.argv.indexOf('--library') + 1];
  const mulch = (await api('/api/mulches', 'POST', {})).mulch;
  const assets = path.join(library, mulch.id, 'assets');
  fs.mkdirSync(assets, { recursive: true });
  // Both PNGs have an alpha channel: one uses it (a dot on nothing), the other is solid everywhere.
  // Assets are named by their content's hash.
  const store = (bytes) => {
    const name = `${require('node:crypto').createHash('sha256').update(bytes).digest('hex')}.png`;
    fs.writeFileSync(path.join(assets, name), bytes);
    return name;
  };
  const see = store(png((x, y) => ((x - 20) ** 2 + (y - 20) ** 2 < 300 ? [0, 0, 0, 255] : [0, 0, 0, 0])));
  const solid = store(png(() => [230, 50, 40, 255]));
  const added = await api(`/api/mulches/${mulch.id}/ops`, 'POST', { ops: [
    { op: 'addNode', node: { id: 'n-see', kind: 'image', x: 0, y: 0, w: 140, assetId: see, text: 'Say "mulch".', origin: 'user', createdAt: 1 } },
    { op: 'addNode', node: { id: 'n-solid', kind: 'image', x: 260, y: 0, w: 140, assetId: solid, fileName: 'solid.png', text: '', origin: 'user', createdAt: 1 } },
  ] });
  assert.equal(added.status, 200, JSON.stringify(added));
  await page.goto(`${base}/n/${mulch.id}`);
  await page.waitForSelector('.react-flow__node[data-id="n-see"] img');
  let nodes;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(500);
    nodes = (await api(`/api/mulches/${mulch.id}`)).mulch.nodes;
    if (nodes['n-see'].transparent !== undefined && nodes['n-solid'].transparent !== undefined) break;
  }
  assert.equal(nodes['n-see'].transparent, true, 'the icon is see-through');
  assert.equal(nodes['n-solid'].transparent, false, 'the solid PNG is not');
  const border = (id) => page.locator(`.react-flow__node[data-id="${id}"] .mlch-node`).evaluate((el) => getComputedStyle(el).borderTopWidth);
  assert.equal(await border('n-see'), '0px', 'no card around the see-through one');
  assert.notEqual(await border('n-solid'), '0px', 'a card around the solid one');
  await shot('transparent-images');
  console.log('transparent-images ok');
};
