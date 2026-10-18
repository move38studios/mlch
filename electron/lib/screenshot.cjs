// mlch: a screenshot of a web page, for the AI's screenshot_page tool. The page loads in a hidden
// window with its own throwaway session: no access to the app, nothing kept, no downloads, no
// pop-ups, no permissions, and nothing on this Mac or the local network.

/** Hosts a screenshot may not reach: this Mac and local networks (by name or address). */
function blockedHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  const v4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (h.includes(':')) return h === '::' || h === '::1' || /^(fc|fd|fe8|fe9|fea|feb)/.test(h) || h.startsWith('::ffff:');
  return false;
}

/** Clicks a cookie banner's accept button when there is an obvious one (best effort, in the page). */
const DISMISS_BANNERS = `(() => {
  const words = /^(accept( all)?( cookies)?|allow( all)?( cookies)?|agree|i agree|got it|ok(ay)?|alle akzeptieren|akzeptieren|tout accepter|accepter|aceptar( todo)?|accetta( tutto)?)$/i;
  for (const el of document.querySelectorAll('button, [role="button"], a')) {
    const text = (el.innerText || el.textContent || '').trim();
    if (text.length < 40 && words.test(text)) { el.click(); return true; }
  }
  return false;
})()`;

/** What the page says it is: its title and first heading. */
const PAGE_FACTS = `({ title: document.title || '', h1: (document.querySelector('h1')?.innerText || '').trim().slice(0, 300), url: location.href })`;

function createScreenshotter({ BrowserWindow, session, userAgent }) {
  let part;
  function shared() {
    if (part) return part;
    part = session.fromPartition('mlch-screenshots');
    part.setPermissionRequestHandler((_wc, _permission, done) => done(false));
    part.setPermissionCheckHandler(() => false);
    part.on('will-download', (event) => event.preventDefault());
    part.webRequest.onBeforeRequest((details, done) => {
      let host;
      try { host = new URL(details.url).hostname; } catch { return done({ cancel: true }); }
      const protocol = details.url.split(':')[0];
      done({ cancel: !['http', 'https', 'data', 'blob'].includes(protocol) || (['http', 'https'].includes(protocol) && blockedHost(host)) });
    });
    if (userAgent) part.setUserAgent(userAgent);
    return part;
  }

  return async function screenshot(url, { width = 1440, height = 900 } = {}) {
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error('Not a valid address.'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only web pages (http or https).');
    if (blockedHost(parsed.hostname)) throw new Error('That address is on this Mac or a local network.');
    const w = Math.min(Math.max(Number(width) || 1440, 320), 2560);
    const h = Math.min(Math.max(Number(height) || 900, 320), 2000);
    const view = new BrowserWindow({ show: false, width: w, height: h, useContentSize: true, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, session: shared() } });
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    view.webContents.setAudioMuted(true);
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const run = (code, fallback) => view.webContents.executeJavaScript(code, true).catch(() => fallback);
    try {
      let failed;
      view.webContents.once('did-fail-load', (_e, code, description) => { if (code !== -3) failed = description; });
      await Promise.race([view.loadURL(parsed.href).catch(() => undefined), wait(25_000)]);
      if (failed) throw new Error(`The page didn't load (${failed}).`);
      await wait(2500);
      if (await run(DISMISS_BANNERS, false)) await wait(800);
      const facts = await run(PAGE_FACTS, { title: '', h1: '', url: parsed.href });
      const png = (await view.webContents.capturePage()).toPNG();
      if (!png.length) throw new Error('The page showed nothing.');
      return { png: png.toString('base64'), title: String(facts.title || '').slice(0, 200), h1: String(facts.h1 || ''), url: String(facts.url || parsed.href) };
    } finally {
      view.destroy();
    }
  };
}

module.exports = { blockedHost, createScreenshotter, DISMISS_BANNERS };
