// Launch the desktop app (dev mode) with a throwaway profile and napkin
// library, open a path, and save a screenshot. For checking UI changes.
//   node scripts/electron-shot.cjs <out.png> [path] [--library <dir>] [--wait <ms>]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright-core');

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const library = flag('--library');
const wait = Number(flag('--wait') || 1500);
const [out = 'shot.png', route = '/'] = args;

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mulch-shot-'));
  const app = await electron.launch({
    args: [path.resolve(__dirname, '..'), '--dev'],
    env: { ...process.env, MULCH_ELECTRON_USER_DATA: profile, MULCH_LIBRARY: library || path.join(profile, 'napkins'), MULCH_ELECTRON_PORT: '47851' },
    timeout: 180_000,
  });
  try {
    const page = await app.firstWindow({ timeout: 180_000 });
    page.on('console', (msg) => { if (['error', 'warning'].includes(msg.type())) console.log(`[console.${msg.type()}]`, msg.text()); });
    await page.waitForLoadState('networkidle', { timeout: 180_000 });
    if (route !== '/') await page.goto(new URL(route, page.url()).toString());
    await page.waitForTimeout(wait);
    await page.screenshot({ path: out });
    console.log('saved', out);
  } finally {
    await app.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
