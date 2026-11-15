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
const NARADO_FAVICON = path.resolve(__dirname, '../../bruno-app/public/narado/favicon.ico');
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
const { GitAccounts, gitService } = require('./narado/git-accounts');
const { createDesktopAuth } = require('./narado/devices');
const { SettingsStore, adminsFrom } = require('./narado/settings');
const { createAdmin } = require('./narado/admin');
const { messagePage } = require('./narado/pages');

const LOOPBACK = ['127.0.0.1', '::1', 'localhost'].includes(HOST);

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

/**
 * Start narado's front with the current settings (the environment, over what admins saved
 * in the admin pages). Returns { close } so saving settings can restart it in place.
 */
const start = async ({ settings, restart }) => {
  const env = settings.effectiveEnv(process.env);

  // Sign-in (Phase 4b). Without a provider, narado is a single-user local tool on a loopback
  // address; anywhere else it only serves the setup pages until sign-in is configured.
  const auth = createAuth({ dataDir: DATA_DIR, port: PORT, env });
  const localOnly = !auth.enabled && LOOPBACK;
  const setupOnly = !auth.enabled && !LOOPBACK;
  ALLOWED_ORIGINS.add(auth.publicUrl);

  const tokens = new TokenStore({ dataDir: DATA_DIR });
  // Secrets stores (Phase 4e): credentials and narado's signing key stay in this process.
  const identity = new Identity({ dataDir: DATA_DIR, issuer: auth.publicUrl });
  const secrets = new SecretsService({ dataDir: DATA_DIR, identity, env });
  // Each person's own Git accounts (Phase 4c): refresh tokens and app credentials stay here.
  const gitAccounts = new GitAccounts({ dataDir: DATA_DIR, publicUrl: auth.publicUrl, multiUser: auth.enabled, env });
  const tokenCalls = tokenService(tokens, auth.enabled);
  const secretCalls = secretsService(secrets);
  const gitCalls = gitService(gitAccounts);
  // A worker says which repository a secrets call is for; rules that name repositories only
  // count when the person can really read it (asked of the host as them). Otherwise the call
  // goes ahead without a repository, so repository-specific rules don't match.
  const checkedSecretCalls = async (user, method, args) => {
    const last = args[args.length - 1];
    if (auth.enabled && last && typeof last === 'object' && !Array.isArray(last) && last.repoPath) {
      const ok = typeof last.hostId === 'string' && typeof last.repoPath === 'string' && (await gitAccounts.canRead(user, last.hostId, last.repoPath));
      if (!ok) args = [...args.slice(0, -1), {}];
    }
    return secretCalls(user, method, args);
  };
  // narado desktop (desktop phase D2): sign-in for computers, devices, and its HTTPS channel.
  let desktop = null;
  const rpc = (user, method, args) =>
    method.startsWith('secrets.')
      ? checkedSecretCalls(user, method, args)
      : method.startsWith('git.')
        ? gitCalls(user, method, args)
        : method.startsWith('devices.')
          ? desktop.deviceCalls(user, method, args)
          : tokenCalls(user, method, args);
  desktop = createDesktopAuth({
    auth,
    dataDir: DATA_DIR,
    rpc,
    // The desktop builds its Git host list from the server's (self-managed hosts included).
    hosts: () => gitAccounts.registry.hosts.map(({ tokenEnv, ...h }) => h),
    isAdmin: (user) => !!(user && user.email && adminsFrom(env).includes(String(user.email).toLowerCase())),
    env
  });
  const pool = new WorkerPool({ dataDir: DATA_DIR, multiUser: auth.enabled, publicPort: PORT, rpc, privateEnv: gitAccounts.tokenEnvNames(), env });
  // Setup and admin pages (narado/admin.js).
  const admin = createAdmin({ settings, env, realEnv: process.env, auth, desktop, gitAccounts, dataDir: DATA_DIR, localOnly, restart });

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
      const { pathname } = new URL(req.url, 'http://x');
      // Browsers ask for /favicon.ico on their own: narado's, not the interface build's default.
      if (pathname === '/favicon.ico' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'image/x-icon', 'cache-control': 'public, max-age=86400' });
        fs.createReadStream(NARADO_FAVICON).pipe(res);
        return;
      }
      if (await admin.handle(req, res)) return;
      // Not set up yet (no sign-in, not on this computer only): the setup pages and their images only.
      if (setupOnly && !pathname.startsWith('/auth/assets/')) {
        res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(messagePage({ title: 'Setting up', text: "narado isn't set up yet. An admin opens the setup link from narado's log to set it up." }));
        return;
      }
      // Who's signed in, and whether they're an admin (for the interface's Admin link).
      if (pathname === '/auth/me' && req.method === 'GET') {
        const user = auth.enabled ? auth.userFor(req) : null;
        res.writeHead(auth.enabled && !user ? 401 : 200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(
          JSON.stringify(
            auth.enabled
              ? { mode: 'oidc', user: user ? { id: user.id, name: user.name, email: user.email } : null, isAdmin: admin.isAdminUser(user) }
              : { mode: 'local', user: null, isAdmin: localOnly }
          )
        );
        return;
      }
      // narado's public signing key, for stores that check per-person tokens (Vault JWT auth).
      if (new URL(req.url, 'http://x').pathname === '/auth/jwks.json' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'max-age=300' });
        res.end(JSON.stringify(identity.jwks()));
        return;
      }
      // Connecting a Git account: needs the narado session (or local mode), before /auth/*'s 404.
      if (/^\/auth\/(git\/[^/]+\/(connect|disconnect)|[^/]+\/callback)$/.test(new URL(req.url, 'http://x').pathname)) {
        const user = auth.enabled ? auth.userFor(req) : null;
        if (auth.enabled && !user) {
          res.writeHead(302, { location: '/auth/login?return=/', 'cache-control': 'no-store' });
          res.end();
          return;
        }
        if (await gitAccounts.handle(req, res, { user, allowedOrigins: ALLOWED_ORIGINS })) return;
      }
      if (await desktop.handle(req, res)) return;
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
    if (setupOnly) return reject(503, 'Service Unavailable');
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

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });
  console.log(`[narado] sign-in: ${auth.enabled ? `OIDC (${env.NARADO_OIDC_ISSUER}), public URL ${auth.publicUrl}` : localOnly ? 'off (single-user local mode)' : 'not set up yet: only the setup pages are served'}`);
  if (!setupOnly) {
    console.log(`[narado] one Bruno worker per ${auth.enabled ? `person, in ${path.join(DATA_DIR, 'users')}${pool.sandbox ? ', sandboxed' : ', NOT sandboxed (NARADO_WORKER_SANDBOX=0)'}` : 'server (local mode)'}`);
    console.log(
      `[narado] Git accounts: ${gitAccounts.status(null).map((h) => `${h.id} (${h.canConnect ? 'people connect their own' : 'no app configured'}${gitAccounts.sharedTokens && env[h.tokenEnv] ? ', shared token' : ''})`).join(', ')}`
    );
    console.log(`[narado] secrets stores: ${secrets.enabled ? secrets.listStores().map((s) => `${s.id} (${s.type}${s.configured ? '' : ', no credentials'})`).join(', ') : 'none'}`);
    console.log(`[narado] narado desktop: ${auth.enabled ? `sign-in on, sends allowed: ${desktop.sendPolicy}` : 'off (needs sign-in)'}`);
    console.log(`[narado] MCP server at http://127.0.0.1:${PORT}/mcp`);
  }
  if (admin.setupNeeded) {
    // A new one-time link each start; it works until an admin signs in with SSO.
    const token = settings.newSetupToken();
    console.log(`[narado] SETUP: open ${auth.publicUrl}/setup?token=${token} to set up sign-in, admins and Git`);
  } else {
    console.log(`[narado] admin pages at ${auth.publicUrl}/admin`);
  }
  console.log(`[narado] listening on http://${HOST}:${PORT} (data: ${DATA_DIR})`);

  return {
    close: async () => {
      pool.stopAll();
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
    }
  };
};

const main = async () => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const settings = new SettingsStore({ dataDir: DATA_DIR });
  let current = null;
  let restarting = null;
  // Saving settings in the admin pages restarts the front in place, with the new settings.
  const restart = () => {
    if (!restarting) {
      restarting = (async () => {
        console.log('[narado] restarting with new settings');
        await current.close();
        current = await start({ settings, restart });
      })().finally(() => {
        restarting = null;
      });
    }
    return restarting;
  };
  current = await start({ settings, restart });

  const shutdown = () => {
    Promise.resolve(current && current.close()).finally(() => setTimeout(() => process.exit(0), 300).unref());
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
};

main().catch((err) => {
  console.error('[narado] failed to start:', err);
  process.exit(1);
});
