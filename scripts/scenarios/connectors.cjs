// The person's own Claude Code setup (docs/research/connectors.md), in the app with real AI and the
// person's real connectors: an instruction that needs a connector tool that acts (a Gmail draft) shows
// a card in the conversation and waits; Deny refuses it and the job still finishes. Settings has the switch.
// Needs Claude Code signed in with the Gmail connector; nothing is created (the card is denied).
const assert = require('node:assert/strict');

module.exports = async ({ page, base, shot }) => {
  const api = (url, method = 'GET', body) => page.evaluate(async ({ url, method, body }) => {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  }, { url, method, body });

  await page.goto(`${base}/settings`);
  await page.waitForSelector('text=Use my Claude Code and Codex setup');
  assert.equal(await page.isChecked('label:has-text("Use my Claude Code and Codex setup") input'), true, 'on by default');
  await shot('settings');

  const mulch = (await api('/api/mulches', 'POST', {})).mulch;
  await page.goto(`${base}/n/${mulch.id}`);
  await page.waitForSelector('textarea[aria-label="Input"]');
  await page.fill('textarea[aria-label="Input"]', "/use my Gmail connector to create a draft email to me with the subject 'mlch approval test' and the body 'test'");
  await page.keyboard.press('Enter');

  // The card opens the conversation by itself.
  const card = page.locator('aside[aria-label="Conversation"] button:has-text("Allow")');
  await card.waitFor({ timeout: 240_000 });
  await page.waitForTimeout(500);
  await shot('approval');
  await page.click('aside[aria-label="Conversation"] button:has-text("Deny")');
  await page.waitForSelector('aside[aria-label="Conversation"] button:has-text("Allow")', { state: 'detached', timeout: 10_000 });

  let job;
  const asked = Date.now();
  while (Date.now() - asked < 240_000) {
    await page.waitForTimeout(3000);
    job = (await api(`/api/mulches/${mulch.id}/jobs`)).jobs.find((j) => j.retry?.kind === 'command');
    if (job && job.state !== 'queued' && job.state !== 'running') break;
  }
  console.log(`job: ${job?.state} ${job?.error ?? ''} message: ${job?.message?.text ?? ''}`);
  assert.equal(job?.state, 'done', 'the instruction finishes after the denial');
  assert.ok(!job.approvals?.length, 'nothing left waiting');
  await shot('after-deny');
};
