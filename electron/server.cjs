// Runs in Electron's Node utility process, never in the renderer.
// Adapted from node-banana (MIT, © William Falloon).
const { createServer } = require('node:http');
const { randomBytes } = require('node:crypto');
const { existsSync } = require('node:fs');
const path = require('node:path');
const next = require('next');
const { createRedactor } = require('./lib/diagnostics.cjs');
const { browseDirectoryTitle, createBridgeClient } = require('./lib/bridge.cjs');
const redactor = createRedactor();
globalThis.__npknRedact = value => redactor.redact(value);
// Native actions (reveal, folder picker) for route code, answered by main;
// see src/lib/desktop/server.ts.
const bridge = createBridgeClient({ post: message => process.parentPort.postMessage(message) });
globalThis.__npknDesktop = { request: (type, payload) => bridge.request(type, payload) };
// Keys stored by main (Keychain-encrypted); read by src/lib/desktop/server.ts.
globalThis.__npknCredentials = {};

const dev = process.env.NODE_ENV !== 'production';
const hostname = '127.0.0.1';
const port = Number(process.env.NPKN_ELECTRON_PORT);
const token = process.env.NPKN_ELECTRON_TOKEN;
delete process.env.NPKN_ELECTRON_TOKEN;
const origin = `http://${hostname}:${port}`;
// The agent routes run turns on the user's own Claude or ChatGPT subscription
// and only answer requests this server vouches for (see
// src/lib/agent/server/sameOrigin.ts). Every request that passes authorized()
// comes from the desktop window, so it gets the stamp.
const AGENT_LOCAL_HEADER = 'x-npkn-agent-local';
const agentLocalSecret = randomBytes(32).toString('hex');
process.env.NPKN_AGENT_LOCAL_SECRET = agentLocalSecret;

// A stray rejection or exception in route code is logged, not fatal: the
// window and running jobs keep going. (desktop.log keeps stderr.)
process.on('unhandledRejection', (reason) => console.error('[server] unhandled rejection', reason));
process.on('uncaughtException', (error) => console.error('[server] uncaught exception', error));

process.parentPort.on('message', ({ data }) => {
  if (data?.type === 'secrets') { redactor.add(data.values); return; }
  if (data?.type === 'credentials') { globalThis.__npknCredentials = data.values && typeof data.values === 'object' ? data.values : {}; return; }
  bridge.receive(data);
});

// Pages inside the app that are not the app itself (sandboxed artifacts, which
// get the token header like every request to this origin) must not reach the
// API: their requests carry Origin: null or a foreign Sec-Fetch-Site.
function foreignPage(req) {
  const site = req.headers['sec-fetch-site'];
  if (site === 'cross-site' || site === 'same-site') return true;
  const origin = req.headers.origin;
  return origin !== undefined && origin !== `http://${hostname}:${port}`;
}

function authorized(req) {
  return req.headers.host === `${hostname}:${port}` && req.headers['x-npkn-desktop'] === token;
}

async function start() {
  if (!dev && !existsSync(path.join(process.cwd(), '.next', 'BUILD_ID'))) {
    throw new Error('No production build found. Run npm run build first, or use npm run electron:dev.');
  }
  const nextApp = next({ dev, hostname, port, dir: process.cwd() });
  const handle = nextApp.getRequestHandler();
  await nextApp.prepare();
  const server = createServer(async (req, res) => {
    if (!authorized(req)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    delete req.headers['x-npkn-desktop'];
    if (req.url?.startsWith('/api/') && foreignPage(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' }).end('{"error":"Not allowed"}');
      return;
    }
    req.headers[AGENT_LOCAL_HEADER] = agentLocalSecret;
    try {
      const url = req.method === 'GET' ? new URL(req.url, origin) : undefined;
      if (url?.pathname === '/api/browse-directory') {
        const picker = bridge.pickDirectory({ title: browseDirectoryTitle(url.searchParams) });
        res.on('close', () => picker.cancel({ success: true, cancelled: true, path: null }));
        const result = await picker.result;
        if (!res.destroyed) {
          res.writeHead(result.success ? 200 : 500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        }
        return;
      }
      await handle(req, res);
    } catch (error) {
      console.error(error);
      if (!res.headersSent) res.writeHead(500);
      res.end('Internal server error');
    }
  });
  // Next's request handler installs its own HMR upgrade listener on this server.
  // Register the authentication guard first; do not install a second handler.
  server.on('upgrade', (req, socket) => {
    if (!authorized(req)) {
      socket.destroy();
      return;
    }
    delete req.headers['x-npkn-desktop'];
  });
  // Agent turns and transcription can run long.
  server.requestTimeout = 0;
  server.headersTimeout = 610_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, hostname, resolve);
  });
  process.parentPort.postMessage({ type: 'ready', origin });
  console.log(`[electron] Local server ready at ${origin}`);
}

start().catch((error) => {
  console.error(error);
  process.parentPort.postMessage({ type: 'error', code: error.code, message: error.code === 'EADDRINUSE'
    ? `Port ${port} is already in use. Close the app using this port, then choose Retry.`
    : error.message });
  process.exitCode = 1;
});
