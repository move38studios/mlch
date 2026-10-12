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
// A WAV file to use as the microphone: the page's getUserMedia plays it.
const fakeMic = flag('--fake-mic');
// Run the `next build` output instead of the dev server.
const production = args.includes('--production');
if (production) args.splice(args.indexOf('--production'), 1);
const shots = flag('--shots') || os.tmpdir();
const [script] = args;

// macOS writes a crash report for every crashed process; a test run that
// leaves a new one behind fails, even if its own checks passed.
const reports = path.join(os.homedir(), 'Library', 'Logs', 'DiagnosticReports');
const crashReports = () => new Set((fs.existsSync(reports) ? fs.readdirSync(reports) : []).filter((name) => /^Electron/.test(name)));

(async () => {
  const crashesBefore = crashReports();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mulch-run-'));
  const app = await electron.launch({
    args: [
      path.resolve(__dirname, '..'), ...(production ? [] : ['--dev']),
    ],
    env: { ...process.env, ...(fakeMic ? { MLCH_FAKE_MIC: '1' } : {}), MLCH_ELECTRON_USER_DATA: profile, MLCH_NO_QUIT_PROMPT: '1', MLCH_LIBRARY: library || path.join(profile, 'mulches'), MLCH_ELECTRON_PORT: process.env.MLCH_RUN_PORT || '47851' },
    timeout: 180_000,
  });
  let failed = false;
  try {
    const page = await app.firstWindow({ timeout: 180_000 });
    page.on('console', (msg) => { if (msg.type() === 'error') console.log('[console.error]', msg.text()); });
    page.on('pageerror', (error) => console.log('[pageerror]', error.message));
    await page.waitForLoadState('networkidle', { timeout: 180_000 });
    const base = new URL(page.url()).origin;
    if (fakeMic) {
      const audio = fs.readFileSync(fakeMic).toString('base64');
      await page.evaluate((b64) => {
        navigator.mediaDevices.getUserMedia = async () => {
          const ctx = new AudioContext();
          const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          const buffer = await ctx.decodeAudioData(bytes.buffer);
          const source = ctx.createBufferSource();
          source.buffer = buffer;
          const destination = ctx.createMediaStreamDestination();
          source.connect(destination);
          source.start();
          return destination.stream;
        };
      }, audio);
    }
    const shot = async (name) => { const file = path.join(shots, `${name}.png`); await page.screenshot({ path: file }); console.log('shot', file); };
    await require(path.resolve(script))({ app, page, base, shot });
  } catch (error) {
    failed = true;
    console.error(error);
  } finally {
    await app.close();
  }
  const crashed = [...crashReports()].filter((name) => !crashesBefore.has(name));
  if (crashed.length) {
    failed = true;
    console.error(`CRASH: new crash report(s) in ${reports}: ${crashed.join(', ')}`);
  }
  process.exit(failed ? 1 : 0);
})();
