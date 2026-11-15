const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { execFileSync } = require('node:child_process');
const { AddressPolicy } = require('../src/narado/requests/blocklist');
const { AllowlistReader, RepoRules, parseEntry, codeownersCovers } = require('../src/narado/requests/allowlist');
const { RequestGuard, installSendRules } = require('../src/narado/requests/guard');

const quiet = { log() {}, warn() {}, error() {} };
let tmp;
before(() => (tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'narado-requests-')))));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/* ------------------------------------------------------------------ block list */

test('the block list refuses loopback, metadata and private ranges, however they are written', () => {
  const p = new AddressPolicy({ env: {} });
  for (const a of ['127.0.0.1', '127.9.9.9', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '169.254.169.254', 'fd00:ec2::254', '0.0.0.0', '10.1.2.3', '172.20.0.1', '192.168.1.1', '100.64.0.1', 'fc00::1', 'fe80::1%lo0', '::ffff:10.0.0.1', '224.0.0.1']) {
    assert.ok(p.check(a), `${a} should be blocked`);
  }
  for (const a of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '172.32.0.1']) assert.equal(p.check(a), null, `${a} should be allowed`);
  assert.match(p.check('169.254.169.254'), /metadata/);

  const opened = new AddressPolicy({ env: { NARADO_ALLOWED_NETWORKS: '10.20.0.0/16, 127.0.0.0/8', NARADO_BLOCKED_NETWORKS: '10.20.5.0/24' } });
  assert.equal(opened.check('10.20.1.1'), null, 'admins can open an internal range');
  assert.ok(opened.check('10.20.5.9'), 'NARADO_BLOCKED_NETWORKS wins');
  assert.ok(opened.check('127.0.0.1'), 'loopback cannot be opened');
  assert.ok(opened.check('10.30.0.1'));
  assert.equal(p.check('10.1.2.3', { trusted: true }), null, 'configured Git hosts may be private');
  assert.ok(p.check('169.254.169.254', { trusted: true }), 'but never metadata');
  assert.throws(() => new AddressPolicy({ env: { NARADO_BLOCKED_NETWORKS: 'nonsense' } }), /not an address/);
});

/* ------------------------------------------------------------------ allowlists */

test('allowlist entries, wildcards, ports and paths', () => {
  const rules = new RepoRules({
    repo: 'github:acme/api',
    branch: 'main',
    entries: ['api.stripe.com', '*.sandbox.acme.com', 'api.acme.com:8443', { host: 'pay.acme.com', ports: [443], paths: ['/v1/'] }].map(parseEntry)
  });
  assert.ok(rules.allowsRequest('api.stripe.com', 443, '/anything'));
  assert.ok(rules.allowsRequest('API.Stripe.com.', 80, '/'));
  assert.ok(!rules.allowsRequest('api.stripe.com', 8080, '/'));
  assert.ok(rules.allowsRequest('a.b.sandbox.acme.com', 443, '/'));
  assert.ok(!rules.allowsRequest('sandbox.acme.com', 443, '/'), 'a wildcard needs a subdomain');
  assert.ok(!rules.allowsRequest('evil-sandbox.acme.com.attacker.test', 443, '/'));
  assert.ok(rules.allowsRequest('api.acme.com', 8443, '/'));
  assert.ok(!rules.allowsRequest('api.acme.com', 443, '/'));
  assert.ok(rules.allowsRequest('pay.acme.com', 443, '/v1/charges'));
  assert.ok(!rules.allowsRequest('pay.acme.com', 443, '/admin'));
  assert.ok(rules.allowsHost('pay.acme.com', 443), 'connections are checked by host and port');
});

test('CODEOWNERS coverage of the allowlist file', () => {
  assert.equal(codeownersCovers(null), false);
  assert.equal(codeownersCovers('* @acme/platform'), true);
  assert.equal(codeownersCovers('/.client/allowed-hosts.yml @acme/security'), true);
  assert.equal(codeownersCovers('.client/ @acme/security'), true);
  assert.equal(codeownersCovers('allowed-hosts.yml @sec'), true);
  assert.equal(codeownersCovers('* @acme/platform\n.client/allowed-hosts.yml'), false, 'a later line with no owners removes them');
  assert.equal(codeownersCovers('docs/ @writers'), false);
});

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString();

test('only the default branch counts: allowed-hosts.yml, spec servers and environment URLs', async () => {
  const origin = path.join(tmp, 'origin');
  fs.mkdirSync(path.join(origin, '.client', 'environments'), { recursive: true });
  sh(origin, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(origin, '.client', 'allowed-hosts.yml'), 'hosts:\n  - api.stripe.com\n  - host: pay.acme.com\n    paths: ["/v1/"]\n');
  fs.writeFileSync(path.join(origin, 'openapi.yaml'), 'openapi: 3.1.0\nservers:\n  - url: https://api.acme.com/v2\n  - url: "{{baseUrl}}"\n');
  fs.writeFileSync(path.join(origin, '.client', 'environments', 'staging.yml'), 'variables:\n  - name: auth\n    value: https://login.acme.com:8443/oauth\n');
  sh(origin, 'add', '-A');
  sh(origin, 'commit', '-qm', 'main');
  sh(origin, 'checkout', '-qb', 'narado/alice/sneaky');
  fs.writeFileSync(path.join(origin, '.client', 'allowed-hosts.yml'), 'hosts:\n  - internal.attacker.test\n');
  sh(origin, 'commit', '-qam', 'branch');
  sh(origin, 'checkout', '-q', 'main');

  // A bare clone laid out as narado's workspaces keep it.
  const base = path.join(tmp, 'base.git');
  sh(tmp, 'clone', '--bare', '-q', origin, base);
  sh(base, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
  sh(base, 'fetch', '-q', 'origin');

  const reader = new AllowlistReader();
  const rules = await reader.rulesFor({ base, repo: 'github:acme/api' });
  assert.equal(rules.branch, 'main');
  assert.ok(rules.allowsRequest('api.stripe.com', 443, '/'));
  assert.ok(rules.allowsRequest('pay.acme.com', 443, '/v1/x'));
  assert.ok(!rules.allowsRequest('pay.acme.com', 443, '/v2/x'));
  assert.ok(rules.allowsRequest('api.acme.com', 443, '/v2/anything'), 'spec servers count');
  assert.ok(rules.allowsRequest('login.acme.com', 8443, '/oauth'), 'environment URLs count');
  assert.ok(!rules.allowsHost('internal.attacker.test', 443), "a branch's own list does not count");
  assert.equal(rules.codeowners, false);

  // Merged to main with CODEOWNERS: the new commit is picked up.
  fs.writeFileSync(path.join(origin, 'CODEOWNERS'), '.client/allowed-hosts.yml @acme/security\n');
  fs.appendFileSync(path.join(origin, '.client', 'allowed-hosts.yml'), '  - hooks.slack.com\n');
  sh(origin, 'add', '-A');
  sh(origin, 'commit', '-qm', 'merge');
  sh(base, 'fetch', '-q', 'origin');
  const next = await reader.rulesFor({ base, repo: 'github:acme/api' });
  assert.ok(next.allowsHost('hooks.slack.com', 443));
  assert.equal(next.codeowners, true);
});

/* ------------------------------------------------------------------ the guard, on real sockets */

const listen = async (handler) => {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, close: () => (server.closeAllConnections(), server.close()) };
};

const get = (url, opts = {}) =>
  new Promise((resolve, reject) => {
    const req = http.get(url, opts, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
  });

test('the guard: block list on every connection, repo rules inside a send', async () => {
  const lines = [];
  // Loopback is always blocked, so the allowlist part uses a policy that lets the test servers through.
  const guard = new RequestGuard({ env: {}, user: { email: 'alice@acme.test' }, log: { log: (l) => lines.push(l) } });
  guard.install();
  const real = guard.addresses;
  const permissive = { check: (a) => (a === '127.0.0.3' ? 'blocked test address' : null) };

  const a = await listen((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: 'http://127.0.0.3:9/' }).end();
    } else res.end(`ok ${req.url}`);
  });
  const b = await listen((_req, res) => res.end('other'));
  try {
    // 1. The real block list: loopback refused outside any send, by literal and by name.
    await assert.rejects(get(`http://127.0.0.1:${a.port}/`), /loopback address/);
    await assert.rejects(get(`http://[::ffff:127.0.0.1]:${a.port}/`), /loopback/);
    const rebinding = (_h, _o, cb) => cb(null, [{ address: '169.254.169.254', family: 4 }]);
    await assert.rejects(get(`http://metadata.attacker.test:${a.port}/`, { lookup: rebinding }), /metadata.attacker.test \(169.254.169.254\) is a link-local/);
    await assert.rejects(
      new Promise((resolve, reject) => net.connect({ path: path.join(tmp, 'docker.sock') }).on('error', reject).on('connect', resolve)),
      /local sockets are not allowed/
    );

    guard.addresses = permissive;
    const rules = new RepoRules({ repo: 'github:acme/api', branch: 'main', entries: [parseEntry({ host: '127.0.0.1', ports: [a.port], paths: ['/ok', '/redirect'] })] });
    const send = (fn) => guard.runSend({ rules, repo: 'github:acme/api' }, fn);

    // 2. Inside a send: allowed host, port and path only.
    assert.equal((await send(() => get(`http://127.0.0.1:${a.port}/ok/1`))).body, 'ok /ok/1');
    await assert.rejects(send(() => get(`http://127.0.0.1:${a.port}/admin`)), /not on the allowlist of github:acme\/api/);
    await assert.rejects(send(() => get(`http://127.0.0.1:${b.port}/`)), /not on the allowlist/);
    // Raw connections (gRPC, WebSockets before their request) are checked by host and port.
    await assert.rejects(send(() => new Promise((resolve, reject) => net.connect(b.port, '127.0.0.1').on('error', reject).on('connect', resolve))), /not on the allowlist/);

    // 3. A keep-alive socket opened for one repo is not a way in for another.
    const agent = new http.Agent({ keepAlive: true });
    assert.equal((await send(() => get(`http://127.0.0.1:${a.port}/ok`, { agent }))).status, 200);
    const other = new RepoRules({ repo: 'github:acme/other', branch: 'main', entries: [] });
    await assert.rejects(guard.runSend({ rules: other, repo: 'github:acme/other' }, () => get(`http://127.0.0.1:${a.port}/ok`, { agent })), /allowlist of github:acme\/other/);
    agent.destroy();

    // 4. Redirects and later calls in the same send keep the send's rules; a redirect to a blocked address fails.
    const followed = await send(async () => {
      const first = await get(`http://127.0.0.1:${a.port}/redirect`);
      return get(new URL(first.headers.location)).then(
        () => 'followed',
        (err) => err.message
      );
    });
    assert.match(followed, /not on the allowlist|blocked test address/);
    const later = await send(() => new Promise((r) => setTimeout(() => get(`http://127.0.0.1:${b.port}/`).then(() => 'sent', (e) => e.message).then(r), 5)));
    assert.match(later, /not on the allowlist/, 'timers inside a send keep its rules');

    // 5. Outside a send (the worker's own calls) only the block list applies.
    assert.equal((await get(`http://127.0.0.1:${b.port}/`)).body, 'other');

    // 6. Collections outside Git: block list only, or refused when the server says so.
    assert.equal((await guard.runSend({ rules: null }, () => get(`http://127.0.0.1:${b.port}/`))).status, 200);
    guard.outsideRepos = 'refuse';
    await assert.rejects(guard.runSend({ rules: null }, () => get(`http://127.0.0.1:${b.port}/`)), /outside a Git workspace/);
    guard.outsideRepos = 'allow';

    // 7. The log names the person, method, host and status, never the path or query.
    assert.ok(lines.some((l) => /request GET 127\.0\.0\.1:\d+ for alice@acme\.test in github:acme\/api: 200/.test(l)));
    assert.ok(!lines.some((l) => l.includes('/ok/1')));

    // 8. Send handlers run inside their collection's context.
    const handlers = new Map([['send-http-request', async () => get(`http://127.0.0.1:${b.port}/`)]]);
    const ipcMain = { getHandler: (c) => handlers.get(c), removeHandler: (c) => handlers.delete(c), handle: (c, f) => handlers.set(c, f) };
    installSendRules({ ipcMain, guard, channels: ['send-http-request'], collectionPathIn: (args) => args[1].pathname, rulesFor: async () => ({ rules, repo: 'github:acme/api' }) });
    await assert.rejects(handlers.get('send-http-request')({}, {}, { pathname: '/w' }), /not on the allowlist/);
  } finally {
    guard.addresses = real;
    a.close();
    b.close();
  }
});
