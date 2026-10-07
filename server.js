// Custom Next.js server for browser development. Adapted from node-banana
// (MIT, © William Falloon).
//
// `npm run dev` runs it as the dev server, `npm start` (`--production`) serves
// the `npm run build` output. Both go through here rather than `next dev` /
// `next start`, because only this server can vouch for the agent's requests.

// Set before Next.js loads, like `next start` does; works the same on Windows.
if (process.argv.includes('--production')) process.env.NODE_ENV = 'production';

const { createServer } = require('http');
const { randomBytes } = require('crypto');
const next = require('next');

const dev = process.env.NODE_ENV !== 'production';
// The APIs read and write local files and spend the provider keys in .env,
// with no login. Listen on this machine only, unless HOST names another
// address (HOST=0.0.0.0 opens it to the network; trusted networks only).
const hostname = process.env.HOST || '127.0.0.1';
const port = process.env.PORT || 3100;

// The agent routes (/api/agent/*) run turns on the user's own Claude or ChatGPT
// subscription, so only this machine may use them. Stamp requests whose socket
// really is loopback with a per-process secret; src/lib/agent/server/sameOrigin.ts
// refuses agent requests without it (unless MLCH_AGENT_ALLOWED_HOSTS lists the host),
// and refuses the agent altogether on a server that doesn't set the secret.
// Headers can be forged from another machine; the socket address cannot. The
// app's own server-side fetches to 127.0.0.1 are loopback too and get the stamp,
// so sameOrigin also requires a browser page's headers, which Node's fetch never sends.
const AGENT_LOCAL_HEADER = 'x-mlch-agent-local';
const agentLocalSecret = randomBytes(32).toString('hex');
process.env.MLCH_AGENT_LOCAL_SECRET = agentLocalSecret;

function isLoopback(address) {
  if (!address) return false;
  const ip = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  return ip === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip);
}

function isLoopbackName(host) {
  const name = host.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  return name === 'localhost' || name.endsWith('.localhost') || isLoopback(name);
}

// A server bound to loopback still answers a DNS-rebinding page (a hostile
// name re-pointed at 127.0.0.1), whose Origin and Host agree. Only a loopback
// name in Host tells this machine's own pages apart.
const localOnly = isLoopbackName(hostname);

function requestHostname(req) {
  try {
    return new URL(`http://${req.headers.host}`).hostname;
  } catch {
    return '';
  }
}

// Another website open in the same browser can still send requests here: a
// text/plain POST carrying JSON needs no CORS preflight. The agent routes have
// their own, stricter guard (src/lib/agent/server/sameOrigin.ts); this covers
// every /api route. It is checked here rather than in a Next proxy
// because a proxy buffers request bodies and cuts them off past 10 MB.
// Requests without browser headers (scripts, the server's own fetches) pass.
function isForeignBrowserRequest(req) {
  const site = req.headers['sec-fetch-site'];
  if (site === 'cross-site' || site === 'same-site') return true;
  const origin = req.headers.origin;
  if (origin === undefined) return false;
  try {
    return origin === 'null' || new URL(origin).host !== new URL(`http://${req.headers.host}`).host;
  } catch {
    return true;
  }
}

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer(async (req, res) => {
    if (localOnly && !isLoopbackName(requestHostname(req))) {
      res.writeHead(403).end('Forbidden host');
      return;
    }
    if (req.url?.startsWith('/api/') && isForeignBrowserRequest(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Cross-origin API requests are not allowed' }));
      return;
    }
    // A client's own copy of the stamp is never passed on.
    delete req.headers[AGENT_LOCAL_HEADER];
    if (isLoopback(req.socket.remoteAddress)) req.headers[AGENT_LOCAL_HEADER] = agentLocalSecret;
    await handle(req, res);
  });

  // Event streams and agent turns stay open.
  server.requestTimeout = 0;
  server.headersTimeout = 610000;

  server.listen(port, hostname, () => {
    console.log(`> Ready on http://${localOnly ? 'localhost' : hostname}:${port}`);
  });
});
