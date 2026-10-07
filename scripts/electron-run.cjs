// Launch the desktop app (dev mode) with a throwaway profile and run a test
// script against it. The script exports `async ({ app, page, base, shot }) => {}`.
//   node scripts/electron-run.cjs <script.cjs> [--library <dir>] [--shots <dir>]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright-core');

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const library = flag('--library');
const shots = flag('--shots') || os.tmpdir();
const [script] = args;

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'npkn-run-'));
  const app = await electron.launch({
    args: [path.resolve(__dirname, '..'), '--dev'],
    env: { ...process.env, NPKN_ELECTRON_USER_DATA: profile, NPKN_LIBRARY: library || path.join(profile, 'napkins'), NPKN_ELECTRON_PORT: '47851' },
    timeout: 180_000,
  });
  let failed = false;
  try {
    const page = await app.firstWindow({ timeout: 180_000 });
    page.on('console', (msg) => { if (msg.type() === 'error') console.log('[console.error]', msg.text()); });
    page.on('pageerror', (error) => console.log('[pageerror]', error.message));
    await page.waitForLoadState('networkidle', { timeout: 180_000 });
    const base = new URL(page.url()).origin;
    const shot = async (name) => { const file = path.join(shots, `${name}.png`); await page.screenshot({ path: file }); console.log('shot', file); };
    await require(path.resolve(script))({ app, page, base, shot });
  } catch (error) {
    failed = true;
    console.error(error);
  } finally {
    await app.close();
  }
  process.exit(failed ? 1 : 0);
})();
