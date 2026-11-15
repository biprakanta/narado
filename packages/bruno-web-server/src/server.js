/**
 * narado server: the front process (Phase 4d).
 *
 * It does not load Bruno. It handles sign-in (src/narado/auth.js), serves the built
 * interface, checks origins, sessions and MCP tokens, and relays each person's IPC
 * WebSocket (/ipc) and MCP requests (/mcp) to their own Bruno worker (src/worker.js,
 * managed by src/narado/workers.js). MCP tokens are stored here only; workers reach them
 * through a narrow channel limited to their own person.
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');

const HOST = process.env.BRUNO_WEB_HOST || '127.0.0.1';
const PORT = Number(process.env.BRUNO_WEB_PORT || 4100);
const DATA_DIR = path.resolve(process.env.BRUNO_WEB_DATA_DIR || path.join(os.homedir(), '.bruno-web'));
const STATIC_DIR = path.resolve(__dirname, '../../bruno-app/dist');
// Browser origins allowed to connect. The rsbuild dev server (3000) and this server.
const ALLOWED_ORIGINS = new Set(
  (process.env.BRUNO_WEB_ORIGINS || `http://localhost:3000,http://127.0.0.1:3000,http://localhost:${PORT},http://127.0.0.1:${PORT}`)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

const { createAuth } = require('./narado/auth');
const { TokenStore } = require('./narado/mcp-tokens');
const { WorkerPool, WorkerError } = require('./narado/workers');
const { tokenService } = require('./narado/token-service');
const { SecretsService, secretsService } = require('./narado/secrets');
const { Identity } = require('./narado/secrets/identity');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.gif': 'image/gif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.map': 'application/json'
};

const serveStatic = (req, res) => {
  if (!fs.existsSync(STATIC_DIR)) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('narado is running. Open the interface from the rsbuild dev server (npm run dev:web), or build it (npm run build:web) to serve it from here.');
    return;
  }
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = path.normalize(path.join(STATIC_DIR, urlPath));
  if (!file.startsWith(STATIC_DIR)) {
    res.writeHead(403).end();
    return;
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(STATIC_DIR, 'index.html');
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
};

const main = async () => {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // Sign-in (Phase 4b). Without a provider, narado is a single-user local tool and may
  // only listen on a loopback address.
  const auth = createAuth({ dataDir: DATA_DIR, port: PORT });
  if (!auth.enabled && !['127.0.0.1', '::1', 'localhost'].includes(HOST)) {
    throw new Error(`Refusing to listen on ${HOST} without sign-in. Configure NARADO_OIDC_ISSUER, or use 127.0.0.1.`);
  }
  ALLOWED_ORIGINS.add(auth.publicUrl);

  const tokens = new TokenStore({ dataDir: DATA_DIR });
  // Secrets stores (Phase 4e): credentials and narado's signing key stay in this process.
  const identity = new Identity({ dataDir: DATA_DIR, issuer: auth.publicUrl });
  const secrets = new SecretsService({ dataDir: DATA_DIR, identity });
  const tokenCalls = tokenService(tokens, auth.enabled);
  const secretCalls = secretsService(secrets);
  const rpc = (user, method, args) => (method.startsWith('secrets.') ? secretCalls(user, method, args) : tokenCalls(user, method, args));
  const pool = new WorkerPool({ dataDir: DATA_DIR, multiUser: auth.enabled, publicPort: PORT, rpc });

  const fail = (res, err) => {
    const status = err instanceof WorkerError ? err.status : 500;
    if (!(err instanceof WorkerError)) console.error('[narado]', err);
    if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  };

  /** /mcp: the token says who; their worker does the rest (and checks the token again). */
  const handleMcp = async (req, res) => {
    const deny = (status, message) => {
      res.writeHead(status, { 'content-type': 'application/json', ...(status === 401 ? { 'www-authenticate': 'Bearer' } : {}) });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message }, id: null }));
    };
    // Browsers send an Origin; MCP clients do not. Refuse pages trying to reach narado.
    if (req.headers.origin) return deny(403, 'Browser origins may not use the MCP endpoint');
    const authorization = String(req.headers.authorization || '');
    const record = authorization.startsWith('Bearer ') ? tokens.verify(authorization.slice(7).trim()) : null;
    if (!record) return deny(401, 'A valid narado MCP token is required. Create one in narado: Git section, MCP tokens.');
    let user = null;
    if (auth.enabled) {
      user = record.owner && record.owner.userId ? auth.users.getUser(record.owner.userId) : null;
      if (!user) return deny(401, `Token "${record.name}" does not belong to a narado user. Create a new one after signing in.`);
    }
    try {
      pool.proxyHttp(await pool.get(user), req, res);
    } catch (err) {
      fail(res, err);
    }
  };

  const server = http.createServer(async (req, res) => {
    try {
      // narado's public signing key, for stores that check per-person tokens (Vault JWT auth).
      if (new URL(req.url, 'http://x').pathname === '/auth/jwks.json' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'max-age=300' });
        res.end(JSON.stringify(identity.jwks()));
        return;
      }
      if (await auth.handle(req, res)) return;
      if (new URL(req.url, 'http://x').pathname === '/mcp') return handleMcp(req, res);
      if (auth.enabled && !auth.userFor(req)) {
        const { pathname, search } = new URL(req.url, 'http://x');
        res.writeHead(302, { location: `/auth/login?return=${encodeURIComponent(pathname + search)}`, 'cache-control': 'no-store' });
        res.end();
        return;
      }
      serveStatic(req, res);
    } catch (err) {
      fail(res, err);
    }
  });

  server.on('upgrade', async (req, socket, head) => {
    const reject = (status, text) => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\n\r\n`);
      socket.destroy();
    };
    const { pathname } = new URL(req.url, 'http://x');
    const origin = req.headers.origin;
    if (pathname !== '/ipc' || !ALLOWED_ORIGINS.has(origin)) {
      console.warn(`[narado] rejected WebSocket from origin ${origin || '(none)'}`);
      return reject(403, 'Forbidden');
    }
    const user = auth.enabled ? auth.userFor(req) : null;
    if (auth.enabled && !user) return reject(401, 'Unauthorized');
    socket.on('error', () => {});
    try {
      const entry = await pool.get(user);
      if (socket.destroyed) return;
      pool.proxyUpgrade(entry, req, socket, head);
    } catch (err) {
      console.error(`[narado] no worker for ${user ? user.name : 'local'}: ${err.message}`);
      reject(err.status === 503 ? 503 : 502, err.status === 503 ? 'Service Unavailable' : 'Bad Gateway');
    }
  });

  const shutdown = () => {
    pool.stopAll();
    server.close();
    setTimeout(() => process.exit(0), 300).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  server.listen(PORT, HOST, () => {
    console.log(`[narado] sign-in: ${auth.enabled ? `OIDC (${process.env.NARADO_OIDC_ISSUER}), public URL ${auth.publicUrl}` : 'off (single-user local mode)'}`);
    console.log(`[narado] one Bruno worker per ${auth.enabled ? `person, in ${path.join(DATA_DIR, 'users')}${pool.sandbox ? ', sandboxed' : ', NOT sandboxed (NARADO_WORKER_SANDBOX=0)'}` : 'server (local mode)'}`);
    console.log(`[narado] secrets stores: ${secrets.enabled ? secrets.listStores().map((s) => `${s.id} (${s.type}${s.configured ? '' : ', no credentials'})`).join(', ') : 'none'}`);
    console.log(`[narado] MCP server at http://127.0.0.1:${PORT}/mcp`);
    console.log(`[narado] listening on http://${HOST}:${PORT} (data: ${DATA_DIR})`);
  });
};

main().catch((err) => {
  console.error('[narado] failed to start:', err);
  process.exit(1);
});

