// Instructions run as the person's own Claude Code (Settings → AI, Permissions: Auto): a shell with the
// Terminal's tools (ffmpeg from Homebrew), the web (a screenshot with a headless browser), files on the canvas.
const assert = require('node:assert/strict');

module.exports = async ({ page, base, shot }) => {
  const api = (url, method = 'GET', body) => page.evaluate(async ({ url, method, body }) => {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  }, { url, method, body });
  await page.goto(base);
  await api('/api/onboarding', 'POST', { action: 'done' });
  await api('/api/settings', 'PUT', { harness: 'claude', access: process.env.MLCH_TEST_ACCESS || 'auto', subscriptionConsent: { claude: Date.now() } });
  const mulch = (await api('/api/mulches', 'POST', {})).mulch;
  await page.goto(`${base}/n/${mulch.id}`);
  await api(`/api/mulches/${mulch.id}/command`, 'POST', {
    instruction: 'Run `ffmpeg -version` in the shell and tell me its first line. Then take a screenshot of https://example.com with a headless browser (Playwright or Chrome) and put it on the canvas.',
  });
  let job;
  let allowed = 0;
  for (const end = Date.now() + 480_000; Date.now() < end; await page.waitForTimeout(3000)) {
    job = (await api(`/api/mulches/${mulch.id}/jobs`)).jobs.find((j) => j.retry?.kind === 'command');
    for (const approval of job?.approvals ?? []) {
      console.log('allowing', approval.server, approval.tool, JSON.stringify(approval.input).slice(0, 120));
      allowed++;
      await api(`/api/mulches/${mulch.id}/jobs`, 'POST', { action: 'allow', jobId: job.id, approvalId: approval.id });
    }
    if (job && !['queued', 'running'].includes(job.state)) break;
  }
  console.log(job.state, job.error ?? '', '\nmessage:', job.message?.text);
  assert.equal(job.state, 'done');
  assert.match(job.message?.text ?? '', /ffmpeg version/i);
  const nodes = Object.values((await api(`/api/mulches/${mulch.id}`)).mulch.nodes);
  const picture = nodes.find((n) => n.kind === 'image');
  console.log('picture', picture?.fileName, picture?.text);
  assert.ok(picture, 'the screenshot is on the canvas');
  await page.waitForTimeout(1500);
  await shot('access');
  if (process.env.MLCH_TEST_ACCESS === 'ask') assert.ok(allowed > 0, 'Ask me: the shell asked first');
  console.log('access ok', allowed, 'allowed');
};
