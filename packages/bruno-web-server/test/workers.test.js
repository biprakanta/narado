const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const WebSocket = require('ws');
const { WorkerPool } = require('../src/narado/workers');
const { tokenService } = require('../src/narado/token-service');
const { TokenStore } = require('../src/narado/mcp-tokens');

const FAKE = path.join(__dirname, 'fixtures', 'fake-worker.js');
const quiet = { log() {}, warn() {}, error() {} };
const alice = { id: 'u-alice', name: 'Alice', email: 'alice@example.test' };
const bob = { id: 'u-bob', name: 'Bob', email: 'bob@example.test' };

let tmp;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'narado-workers-'));
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A front-like server: every request and upgrade goes to the worker of the user in `x-test-user`. */
const startFront = async (pool, users) => {
  const pick = (req) => users[req.headers['x-test-user']] || null;
  const server = http.createServer(async (req, res) => {
    try {
      pool.proxyHttp(await pool.get(pick(req)), req, res);
    } catch (err) {
      res.writeHead(err.status || 500).end(err.message);
    }
  });
  server.on('upgrade', async (req, socket, head) => {
    try {
      pool.proxyUpgrade(await pool.get(pick(req)), req, socket, head);
    } catch (err) {
      socket.write(`HTTP/1.1 ${err.status || 500} No\r\n\r\n`);
      socket.destroy();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `127.0.0.1:${server.address().port}`, close: () => (server.closeAllConnections(), server.close()) };
};

const openSocket = (url, user, extra = {}) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${url}/ipc`, { headers: { 'x-test-user': user, cookie: 'narado_session=secret-cookie', ...extra } });
    ws.once('message', (d) => resolve({ ws, first: JSON.parse(d) }));
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.once('error', reject);
  });

const getJson = (url, user) =>
  new Promise((resolve, reject) => {
    http.get(`http://${url}/mcp`, { headers: { 'x-test-user': user, cookie: 'narado_session=secret-cookie' } }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, body: body && body.startsWith('{') ? JSON.parse(body) : body }));
    }).on('error', reject);
  });

const fakePool = (opts = {}) =>
  new WorkerPool({
    dataDir: fs.mkdtempSync(path.join(tmp, 'data-')),
    multiUser: true,
    publicPort: 1,
    script: FAKE,
    sandbox: false,
    rpc: async (user, method) => ({ user: user && user.id, method }),
    privateEnv: ['NARADO_GITHUB_TOKEN'],
    env: { ...process.env, NARADO_OIDC_CLIENT_SECRET: 'must-not-leak', NARADO_GITHUB_APP_CLIENT_SECRET: 'nor-this', NARADO_SECRETS_VAULT_TOKEN: 'nor-the-vault', NARADO_GITHUB_TOKEN: 'git-token' },
    log: quiet,
    ...opts
  });

test('each person gets their own worker and data folder; cookies and sign-in secrets stay in the front', async () => {
  const pool = fakePool();
  const front = await startFront(pool, { alice, bob });
  try {
    const a = await openSocket(front.url, 'alice');
    const b = await openSocket(front.url, 'bob');
    assert.equal(a.first.user.id, 'u-alice');
    assert.equal(b.first.user.id, 'u-bob');
    assert.notEqual(a.first.id, b.first.id, 'two separate workers');
    assert.equal(a.first.dataDir, path.join(pool.dataDir, 'users', 'u-alice'));
    assert.equal(b.first.dataDir, path.join(pool.dataDir, 'users', 'u-bob'));
    assert.equal(a.first.headers.cookie, undefined, 'the session cookie is not passed on');
    assert.ok(!a.first.envKeys.includes('NARADO_OIDC_CLIENT_SECRET'));
    assert.ok(!a.first.envKeys.includes('NARADO_GITHUB_APP_CLIENT_SECRET'));
    assert.ok(!a.first.envKeys.includes('NARADO_SECRETS_VAULT_TOKEN'), 'secrets-store credentials stay in the front');
    assert.ok(!a.first.envKeys.includes('NARADO_GITHUB_TOKEN'), 'shared Git tokens stay in the front (Phase 4c)');

    // A second connection for Alice reaches the same worker.
    const a2 = await openSocket(front.url, 'alice');
    assert.equal(a2.first.id, a.first.id);

    // HTTP (MCP) goes the same way.
    const m = await getJson(front.url, 'bob');
    assert.equal(m.status, 200);
    assert.equal(m.body.user.id, 'u-bob');
    assert.equal(m.body.headers.cookie, undefined);

    // Calls from a worker to the front say which person they come from.
    a.ws.send(JSON.stringify({ t: 'rpc', method: 'tokens.list', args: [] }));
    const reply = await new Promise((r) => a.ws.once('message', (d) => r(JSON.parse(d))));
    assert.deepEqual(reply.result, { user: 'u-alice', method: 'tokens.list' });
    for (const s of [a, b, a2]) s.ws.close();
  } finally {
    front.close();
    pool.stopAll();
  }
});

test('a worker only accepts requests that carry its secret', async () => {
  const pool = fakePool();
  try {
    const entry = await pool.get(alice);
    const direct = await new Promise((resolve) => http.get(`http://127.0.0.1:${entry.port}/mcp`, (res) => resolve(res.statusCode)));
    assert.equal(direct, 403);
    const forged = await new Promise((resolve) =>
      http.get(`http://127.0.0.1:${entry.port}/mcp`, { headers: { 'x-narado-worker': 'guess' } }, (res) => resolve(res.statusCode))
    );
    assert.equal(forged, 403);
  } finally {
    pool.stopAll();
  }
});

test('idle workers stop; a stopped or crashed worker is started again', async () => {
  const pool = fakePool({ idleMs: 50 });
  try {
    const first = await pool.get(alice);
    await new Promise((r) => setTimeout(r, 80));
    pool.sweep();
    await new Promise((r) => first.child.once('exit', r));
    assert.equal(pool.workers.size, 0);

    const second = await pool.get(alice);
    assert.notEqual(second.instance, first.instance);
    second.child.kill('SIGKILL');
    await new Promise((r) => second.child.once('exit', r));
    const third = await pool.get(alice);
    assert.notEqual(third.instance, second.instance);
  } finally {
    pool.stopAll();
  }
});

test('a worker with an open connection is not stopped for being idle', async () => {
  const pool = fakePool({ idleMs: 10 });
  const front = await startFront(pool, { alice });
  try {
    const a = await openSocket(front.url, 'alice');
    await new Promise((r) => setTimeout(r, 40));
    pool.sweep();
    assert.equal(pool.workers.size, 1);
    a.ws.close();
  } finally {
    front.close();
    pool.stopAll();
  }
});

test('at the worker limit, an idle worker makes room; busy ones are not stopped', async () => {
  const pool = fakePool({ maxWorkers: 1 });
  const front = await startFront(pool, { alice, bob, carol: { id: 'u-carol', name: 'Carol' } });
  try {
    const a = await openSocket(front.url, 'alice');
    await assert.rejects(openSocket(front.url, 'bob'), /HTTP 503/);
    a.ws.close();
    await new Promise((r) => setTimeout(r, 50));
    const b = await openSocket(front.url, 'bob');
    assert.equal(b.first.user.id, 'u-bob');
    b.ws.close();
  } finally {
    front.close();
    pool.stopAll();
  }
});

test('without sign-in there is one worker, in the data folder itself', async () => {
  const pool = fakePool({ multiUser: false });
  try {
    const e = await pool.get(null);
    assert.equal(e.key, 'local');
    assert.equal(pool.dirFor(null), pool.dataDir);
  } finally {
    pool.stopAll();
  }
});

test('token calls from a worker only reach its own person\'s tokens', () => {
  const store = new TokenStore({ dataDir: fs.mkdtempSync(path.join(tmp, 'tokens-')) });
  const svc = tokenService(store, true);
  // A worker cannot make a token for someone else, whatever it asks for.
  const { token: aliceToken, record } = svc(alice, 'tokens.create', [{ name: 'a', scope: 'read', owner: { userId: 'u-bob', hosts: { github: 'alice-gh' } } }]);
  assert.equal(record.owner.userId, 'u-alice');
  assert.equal(svc(alice, 'tokens.list', []).length, 1);
  assert.equal(svc(bob, 'tokens.list', []).length, 0);
  assert.equal(svc(bob, 'tokens.verify', [aliceToken]), null, "bob's worker cannot use alice's token");
  assert.equal(svc(alice, 'tokens.verify', [aliceToken]).id, record.id);
  assert.throws(() => svc(bob, 'tokens.revoke', [record.id]), /No such token/);
  assert.throws(() => svc(alice, 'tokens.delete-all', []), /Unknown call/);
  assert.equal(svc(alice, 'tokens.revoke', [record.id]), true);
  assert.equal(store.list().length, 0);
});

/* ------------------------------------------------- real, sandboxed workers */

const invoke = (ws, ch, ...args) =>
  new Promise((resolve) => {
    const id = Math.random();
    const onMsg = (d) => {
      const m = JSON.parse(d);
      if (m.t === 'res' && m.id === id) {
        ws.off('message', onMsg);
        resolve(m);
      }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ t: 'invoke', id, ch, args, u: [] }));
  });

const ROOT_ON_LINUX = process.platform === 'linux' && process.getuid && process.getuid() === 0;

const sandboxTest = (osUsers) => async () => {
  const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(tmp, 'real-')));
  // Each person's own system user (NARADO_WORKER_USERS=1) has to pass through the folders above.
  if (osUsers) for (let d = path.dirname(dataDir); d !== path.dirname(d); d = path.dirname(d)) fs.chmodSync(d, fs.statSync(d).mode | 0o011);
  const pool = new WorkerPool({ dataDir, multiUser: true, publicPort: 1, rpc: async () => [], env: { ...process.env, NARADO_WORKER_SANDBOX: '1', ...(osUsers ? { NARADO_WORKER_USERS: '1' } : {}) }, log: quiet });
  assert.equal(pool.sandbox, true);
  assert.equal(!!pool.osUsers, osUsers);
  const front = await startFront(pool, { alice, bob });
  try {
    const [a, b] = await Promise.all([openSocket(front.url, 'alice'), openSocket(front.url, 'bob')]);
    assert.equal(a.first.t, 'instance');
    const bobFile = path.join(dataDir, 'users', 'u-bob', 'secret.txt');
    const aliceFile = path.join(dataDir, 'users', 'u-alice', 'mine.txt');
    fs.writeFileSync(bobFile, 'bob only');
    fs.writeFileSync(aliceFile, 'alice');

    assert.equal((await invoke(a.ws, 'renderer:exists-sync', aliceFile)).value, true, 'alice can read her own folder');
    assert.equal((await invoke(a.ws, 'renderer:exists-sync', bobFile)).value, false, "alice's worker cannot see bob's files");
    assert.equal((await invoke(b.ws, 'renderer:exists-sync', bobFile)).value, true);
    assert.equal((await invoke(a.ws, 'renderer:exists-sync', path.join(dataDir, 'narado.db'))).value, false, 'nor the shared sign-in database');

    const dev = await invoke(a.ws, 'renderer:save-collection-security-config', path.join(dataDir, 'users', 'u-alice'), { jsSandboxMode: 'developer' });
    assert.equal(dev.ok, false);
    assert.match(dev.error, /Developer mode is turned off/);
    const npm = await invoke(a.ws, 'renderer:install-postman-packages', path.join(dataDir, 'users', 'u-alice'), ['left-pad']);
    assert.equal(npm.ok, false);
    assert.match(npm.error, /npm packages is turned off/);
    const clone = await invoke(a.ws, 'renderer:clone-git-repository', {});
    assert.equal(clone.ok, false);
    a.ws.close();
    b.ws.close();
  } finally {
    front.close();
    pool.stopAll();
  }
};

test("sandboxed workers cannot read each other's files, run developer-mode scripts or install packages", { timeout: 120000 }, sandboxTest(false));
test('the same, with each worker as its own system user (root on Linux)', { timeout: 120000, skip: !ROOT_ON_LINUX && 'needs root on Linux' }, sandboxTest(true));
