const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { DesktopGuard, classify } = require('../src/narado/requests/desktop-guard');
const { RemoteFront } = require('../src/narado/desktop-front');
const { auditSends } = require('../src/desktop');

const quiet = { log() {}, warn() {}, error() {} };

/** A repo's allowlist: api.example.com on 443, only under /v1/. */
const rules = {
  repo: 'github:acme/payments',
  branch: 'main',
  allowsHost: (h, p) => h === 'api.example.com' && p === 443,
  allowsRequest: (h, p, pathname) => h === 'api.example.com' && p === 443 && pathname.startsWith('/v1/')
};

let policy = 'any';
const guard = new DesktopGuard({ policy: () => policy, trusted: () => ['narado.example.com'], log: quiet });
let server;
let port;

before(async () => {
  guard.install();
  server = http.createServer((req, res) => res.end('ok'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(() => server.close());

const get = (url) =>
  new Promise((resolve, reject) => {
    try {
      http
        .get(url, { agent: false }, (res) => {
          res.resume();
          resolve(res.statusCode);
        })
        .on('error', reject);
    } catch (err) {
      reject(err);
    }
  });

const inSend = (r, fn) => guard.runSend({ rules: r, repo: r ? r.repo : null }, fn);

test('addresses: metadata and link-local blocked, loopback and private ranges are private', () => {
  assert.deepEqual(classify('169.254.169.254'), { blocked: 'link-local (cloud metadata) address' });
  assert.deepEqual(classify('fd00:ec2::254'), { blocked: 'cloud metadata address' });
  assert.deepEqual(classify('::ffff:169.254.169.254'), { blocked: 'link-local (cloud metadata) address' });
  assert.equal(classify('127.0.0.1'), 'private');
  assert.equal(classify('10.2.3.4'), 'private');
  assert.equal(classify('192.168.1.20'), 'private');
  assert.equal(classify('fd12::1'), 'private');
  assert.equal(classify('93.184.216.34'), 'public');
});

test('a repo send reaches localhost without listing it, and never cloud metadata', async () => {
  policy = 'any';
  assert.equal(await inSend(rules, () => get(`http://127.0.0.1:${port}/x`)), 200);
  assert.equal(await inSend(rules, () => get(`http://localhost:${port}/x`)), 200);
  await assert.rejects(inSend(rules, () => get('http://169.254.169.254/latest/meta-data/')), /cloud metadata/);
  // Outside any send too (scripts, anything else in the app).
  await assert.rejects(get('http://169.254.169.254/'), /cloud metadata/);
});

test('public hosts: only from the allowlist, path included', async () => {
  policy = 'any';
  // A public address that isn't listed.
  await assert.rejects(inSend(rules, () => get('http://93.184.216.34/')), /public address and isn't on the allowlist of github:acme\/payments/);
  // A listed host resolved earlier to a public address: a path outside /v1/ is refused.
  guard.recordLookup('api.example.com', ['93.184.216.34']);
  assert.throws(() => inSend(rules, () => guard.checkRequest(guard.current(), [{ host: 'api.example.com', port: 443, path: '/admin' }], true)), /isn't on the allowlist/);
  assert.doesNotThrow(() => inSend(rules, () => guard.checkRequest(guard.current(), [{ host: 'api.example.com', port: 443, path: '/v1/pay' }], true)));
  // Not resolved yet: the request goes ahead only if the connection turns out private.
  inSend(rules, () => {
    guard.checkRequest(guard.current(), [{ host: 'new.example.com', port: 443, path: '/' }], true);
    assert.throws(() => guard.checkAddress('93.184.216.40', 'new.example.com', 443), /public address/);
    assert.doesNotThrow(() => guard.checkAddress('10.1.2.3', 'new.example.com', 443));
  });
  // A listed host connecting to a public address is fine at the connection level.
  inSend(rules, () => assert.doesNotThrow(() => guard.checkAddress('93.184.216.34', 'api.example.com', 443)));
});

test("collections outside Git may send anywhere not blocked; narado's own hosts are exempt", () => {
  policy = 'any';
  inSend(null, () => {
    assert.doesNotThrow(() => guard.checkAddress('93.184.216.34', 'public.example.org', 443));
    assert.throws(() => guard.checkAddress('169.254.169.254', 'metadata', 80), /cloud metadata/);
  });
  inSend(rules, () => assert.doesNotThrow(() => guard.checkAddress('93.184.216.50', 'narado.example.com', 443)));
});

test("the organisation's policy narrows what the desktop may send", async () => {
  policy = 'private-only';
  inSend(null, () => assert.throws(() => guard.checkAddress('93.184.216.34', 'public.example.org', 443), /only to private and local networks/));
  inSend(rules, () => assert.throws(() => guard.checkAddress('93.184.216.34', 'api.example.com', 443), /only to private and local networks/));
  assert.equal(await inSend(rules, () => get(`http://127.0.0.1:${port}/x`)), 200);

  policy = 'allowlist-only';
  await assert.rejects(inSend(rules, () => get(`http://127.0.0.1:${port}/x`)), /only to hosts on a repository's allowlist/);
  inSend(null, () => assert.throws(() => guard.checkAddress('10.0.0.5', 'internal', 80), /only from collections in a Git repository/));
  inSend(rules, () => assert.doesNotThrow(() => guard.checkAddress('93.184.216.34', 'api.example.com', 443)));
  policy = 'any';
});

test('offline: secret values from earlier in the session are used, others are refused', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'narado-offline-'));
  let online = true;
  const fetchImpl = async (url, init) => {
    if (!online) throw new Error('ECONNREFUSED');
    const body = JSON.parse(init.body || '{}');
    if (url.endsWith('/desktop/api/token')) return { status: 200, json: async () => ({ access_token: 'nrd_at_x', expires_in: 3600, refresh_token: 'nrd_rt_y', user: { name: 'A' }, device: { id: 'd' } }) };
    if (url.endsWith('/desktop/api/call')) return { status: 200, json: async () => ({ result: Object.fromEntries(body.args[0].map((r) => [r, `v:${r}`])) }) };
    return { status: 404, json: async () => ({}) };
  };
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => String(b) };
  const front = new RemoteFront({ dataDir, safeStorage, fetchImpl, openExternal: async () => {}, log: quiet });
  front.server = 'https://narado.example.com';
  front.refreshToken = 'nrd_rt_start';
  const changes = [];
  front.onChange((s) => changes.push(s.online));

  const ctx = { hostId: 'github', repoPath: 'acme/payments' };
  assert.deepEqual(await front.secrets.resolve(['secret://vault/a'], ctx), { 'secret://vault/a': 'v:secret://vault/a' });
  online = false;
  front.access = null;
  assert.deepEqual(await front.secrets.resolve(['secret://vault/a'], ctx), { 'secret://vault/a': 'v:secret://vault/a' });
  assert.equal(front.status().online, false);
  assert.deepEqual(changes, [false]);
  await assert.rejects(front.secrets.resolve(['secret://vault/b'], ctx), /can't be used offline/);
  // Another repository's context doesn't get this repository's values.
  await assert.rejects(front.secrets.resolve(['secret://vault/a'], { hostId: 'github', repoPath: 'acme/other' }), /can't be used offline/);
  // Never written to disk.
  for (const f of fs.readdirSync(dataDir)) assert.ok(!fs.readFileSync(path.join(dataDir, f), 'utf8').includes('v:secret'), f);
  // After 8 hours, not even those.
  for (const v of front.secretCache.values()) v.at -= 8 * 3600e3 + 1;
  await assert.rejects(front.secrets.resolve(['secret://vault/a'], ctx), /can't be used offline/);
  online = true;
  await front.secrets.resolve(['secret://vault/a'], ctx);
  assert.equal(front.status().online, true);

  // A proxy in front of a stopped server answers 502-504: that's offline too.
  const proxied = new RemoteFront({ dataDir, safeStorage, fetchImpl: async () => ({ status: 502, json: async () => ({}) }), openExternal: async () => {}, log: quiet });
  proxied.server = 'https://narado.example.com';
  proxied.refreshToken = 'nrd_rt_start';
  await assert.rejects(proxied.git.token('github'), /This needs a connection/);
  assert.equal(proxied.status().online, false);
});

test('send reports made offline are kept on disk until the server has them', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'narado-reports-')), 'pending.json');
  const handlers = new Map([['send-http-request', async () => ({ status: 204 })]]);
  const ipcMain = { _invokeHandlers: handlers, handle: (c, f) => handlers.set(c, f), removeHandler: (c) => handlers.delete(c) };
  let reachable = false;
  const got = [];
  const remote = {
    signedIn: true,
    online: false,
    audit: async (events) => {
      if (!reachable) throw new Error('offline');
      got.push(...events);
    }
  };
  const a = auditSends({ ipcMain, remote, locateRepo: () => null, log: quiet, file, intervalMs: 1e9 });
  await handlers.get('send-http-request')({}, { request: { method: 'GET', url: 'http://localhost:4900/' } }, {});
  await a.flush();
  await new Promise((r) => setTimeout(r, 700));
  a.stop();
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].offline, true);
  assert.equal(saved[0].host, 'localhost:4900');

  // The app restarts; the server is back.
  reachable = true;
  const handlers2 = new Map([['send-http-request', async () => ({ status: 204 })]]);
  const b = auditSends({ ipcMain: { _invokeHandlers: handlers2, handle: (c, f) => handlers2.set(c, f), removeHandler: (c) => handlers2.delete(c) }, remote, locateRepo: () => null, log: quiet, file, intervalMs: 1e9 });
  await b.flush();
  await new Promise((r) => setTimeout(r, 700));
  b.stop();
  assert.equal(got.length, 1);
  assert.ok(!fs.existsSync(file));
});
