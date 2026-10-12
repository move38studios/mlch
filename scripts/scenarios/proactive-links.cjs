// Real AI turns: a thought related to an earlier mulch and a linked note gets a link card with a reason;
// an unrelated thought gets none. Uses the signed-in Claude Code / Codex subscription.
//   node scripts/electron-run.cjs scripts/scenarios/proactive-links.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

module.exports = async ({ page }) => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
  fs.mkdirSync(path.join(vault, '.obsidian'));
  fs.writeFileSync(path.join(vault, 'Pricing principles.md'), '---\ntags: [pricing]\n---\nWe decided in March: price per seat, never per minute of audio. Metered pricing makes people afraid to leave the mic on.');
  fs.writeFileSync(path.join(vault, 'Garden.md'), 'Tomatoes need six hours of sun.');

  const api = (url, method = 'GET', body) => page.evaluate(async ({ url, method, body }) => {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return r.json();
  }, { url, method, body });
  await api('/api/sources', 'POST', { path: vault });
  const old = (await api('/api/mulches', 'POST', {})).mulch;
  await api(`/api/mulches/${old.id}/ops`, 'POST', { clientId: 's', ops: [
    { op: 'setTitle', title: 'Business model' },
    { op: 'addNode', node: { id: 'p1', kind: 'idea', x: 0, y: 0, title: 'Per-seat, not per-minute', text: 'Charging per minute of listening would make people switch mlch off during calls. Per seat keeps it always on.', origin: 'user', createdAt: Date.now() } },
  ] });
  // Let the index catch up.
  await page.waitForTimeout(4000);

  async function trial(text) {
    const here = (await api('/api/mulches', 'POST', {})).mulch;
    await api(`/api/mulches/${here.id}/input`, 'POST', { text });
    // Done when enrichment has added something and nothing changed for 45 s (or after 5 minutes).
    const deadline = Date.now() + 300_000;
    let mulch;
    let lastCount = -1;
    let stableSince = Date.now();
    for (;;) {
      await page.waitForTimeout(5000);
      mulch = (await api(`/api/mulches/${here.id}`)).mulch;
      const count = Object.keys(mulch.nodes).length + Object.keys(mulch.edges).length;
      if (count !== lastCount) {
        lastCount = count;
        stableSince = Date.now();
      }
      const enriched = Object.values(mulch.nodes).some((n) => n.origin.startsWith('agent:'));
      if ((enriched && Date.now() - stableSince > 45_000) || Date.now() > deadline) break;
    }
    const refs = Object.values(mulch.nodes).filter((n) => n.kind === 'ref');
    const reasons = refs.map((r) => Object.values(mulch.edges).find((e) => e.target === r.id || e.source === r.id)?.label);
    console.log(JSON.stringify({ text, items: Object.keys(mulch.nodes).length, refs: refs.map((r, i) => ({ to: r.ref, title: r.title, why: reasons[i] })) }));
    return { refs, reasons };
  }

  const related = await trial('For the call feature I think we should charge by the minute of audio, it is simplest.');
  assert.ok(related.refs.length >= 1, 'a related thought gets a link');
  assert.ok(related.reasons.every(Boolean), 'every link says why');
  const unrelated = await trial('The light in Lisbon in October is unreal, everything goes golden at five.');
  assert.equal(unrelated.refs.length, 0, 'an unrelated thought gets no link');
  fs.rmSync(vault, { recursive: true, force: true });
  console.log('proactive links ok');
};
