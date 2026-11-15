const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createDesktopAuth, DeviceStore } = require('../src/narado/devices');
const { RemoteFront, normaliseServer } = require('../src/narado/desktop-front');
const { switchingFront, auditSends } = require('../src/desktop');

const quiet = { log() {}, warn() {}, error() {} };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'narado-devices-'));

/** Enough of createAuth: cookie "sid=<user id>" is the session. */
const fakeAuth = (publicUrl, users) => ({
  enabled: true,
  publicUrl,
  userFor: (req) => {
    const m = /sid=([\w-]+)/.exec(req.headers.cookie || '');
    return m ? users[m[1]] || null : null;
  },
  users: { getUser: (id) => users[id] || null }
});

/** A narado server with only the desktop routes, and a log of front calls. */
const startServer = async ({ env = {} } = {}) => {
  const users = { alice: { id: 'alice', name: 'Alice', email: 'alice@example.com' }, bob: { id: 'bob', name: 'Bob', email: 'bob@example.com' } };
  const calls = [];
  const logs = [];
  const log = { log: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) };
  let desktop;
  const server = http.createServer(async (req, res) => {
    if (!(await desktop.handle(req, res))) res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const publicUrl = `http://127.0.0.1:${server.address().port}`;
  const rpc = async (user, method, args) => {
    calls.push([user.id, method, args]);
    if (method === 'git.token') return { token: `gh-token-for-${user.id}`, expiresAt: Date.now() + 3600e3 };
    if (method === 'secrets.resolve') return { values: Object.fromEntries(args[0].map((r) => [r, `value-of-${r}`])), errors: {} };
    return { method };
  };
  const dataDir = tmp();
  desktop = createDesktopAuth({
    auth: fakeAuth(publicUrl, users),
    dataDir,
    rpc,
    hosts: () => [{ id: 'github', type: 'github' }, { id: 'gl', type: 'gitlab', url: 'https://git.example.com' }],
    env,
    log
  });
  return { server, publicUrl, desktop, calls, logs, dataDir, close: () => new Promise((r) => server.close(r)) };
};

/** Plays the person in the system browser: signed in as `who`, approves (or cancels). */
const browserAs = (who, { decision = 'allow', origin } = {}) => {
  const visited = [];
  return {
    visited,
    open: async (url) => {
      visited.push(url);
      const page = await fetch(url, { headers: { cookie: `sid=${who}` }, redirect: 'manual' });
      if (page.status !== 200) throw new Error(`start page ${page.status}`);
      const html = await page.text();
      const request = /name="request" value="([^"]+)"/.exec(html)[1];
      const u = new URL(url);
      const approve = await fetch(`${u.origin}/auth/desktop/approve`, {
        method: 'POST',
        headers: { cookie: `sid=${who}`, origin: origin || u.origin, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ request, decision }).toString(),
        redirect: 'manual'
      });
      const location = approve.headers.get('location');
      visited.push(location);
      if (location) await fetch(location); // the desktop's loopback listener
    }
  };
};

/** Electron's safeStorage, reversibly "encrypted" so the test can see it isn't plain. */
const fakeSafeStorage = () => ({
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${Buffer.from(s).toString('base64')}`),
  decryptString: (b) => Buffer.from(String(b).slice(4), 'base64').toString()
});

test('desktop sign-in: browser approval, PKCE code exchange, then front calls as the person', async () => {
  const srv = await startServer();
  const dataDir = tmp();
  const browser = browserAs('alice');
  const front = new RemoteFront({ dataDir, safeStorage: fakeSafeStorage(), openExternal: browser.open, deviceName: 'alice-mbp', platform: 'darwin', log: quiet });
  try {
    const status = await front.signIn(srv.publicUrl);
    assert.equal(status.signedIn, true);
    assert.equal(status.user.name, 'Alice');
    assert.equal(status.device.name, 'alice-mbp');
    assert.equal(status.policy.send, 'any');
    assert.deepEqual(front.session.hosts.map((h) => h.id), ['github', 'gl']);

    // The start link carries PKCE and a loopback address; the code went only to the loopback.
    const start = new URL(browser.visited[0]);
    assert.equal(start.pathname, '/auth/desktop/start');
    assert.equal(start.searchParams.get('code_challenge_method'), 'S256');
    assert.match(start.searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    assert.match(browser.visited[1], /^http:\/\/127\.0\.0\.1:\d+\/callback\?code=/);

    // The refresh token is kept encrypted, never in plain text.
    const saved = fs.readFileSync(path.join(dataDir, 'desktop-session.bin'), 'utf8');
    assert.ok(saved.startsWith('enc:') && !saved.includes('nrd_rt_'));
    assert.ok(!fs.readFileSync(path.join(dataDir, 'desktop-server.json'), 'utf8').includes('nrd_'));

    assert.equal((await front.git.token('github')).token, 'gh-token-for-alice');
    assert.equal((await front.git.token('github')).token, 'gh-token-for-alice'); // cached: one call
    assert.deepEqual((await front.secrets.resolve(['secret://vault/a'])).values, { 'secret://vault/a': 'value-of-secret://vault/a' });
    assert.deepEqual(
      srv.calls.map((c) => [c[0], c[1]]),
      [
        ['alice', 'git.token'],
        ['alice', 'secrets.resolve']
      ]
    );
    assert.ok(srv.logs.some((l) => /Git token for github to Alice on "alice-mbp"/.test(l)));
    assert.ok(srv.logs.some((l) => /1 secret reference\(s\) resolved for Alice on "alice-mbp"/.test(l)));

    // A restarted app picks the session up again from secure storage.
    const again = new RemoteFront({ dataDir, safeStorage: fakeSafeStorage(), openExternal: async () => {}, log: quiet });
    assert.equal(again.signedIn, true);
    assert.equal((await again.git.token('github')).token, 'gh-token-for-alice');
  } finally {
    await srv.close();
  }
});

test('desktop sign-in: cancelling in the browser, bad links and a stolen code are refused', async () => {
  const srv = await startServer();
  try {
    const cancelled = new RemoteFront({ dataDir: tmp(), safeStorage: fakeSafeStorage(), openExternal: browserAs('alice', { decision: 'deny' }).open, log: quiet });
    await assert.rejects(cancelled.signIn(srv.publicUrl), /cancelled in the browser/);
    assert.equal(cancelled.signedIn, false);

    // A link that would send the code anywhere but this computer's loopback.
    const evil = await fetch(`${srv.publicUrl}/auth/desktop/start?redirect_uri=${encodeURIComponent('https://evil.example/callback')}&state=aaaaaaaaaaaaaaaa&code_challenge=${'a'.repeat(43)}&code_challenge_method=S256`, {
      headers: { cookie: 'sid=alice' }
    });
    assert.equal(evil.status, 400);

    // Not signed in: off to the sign-in page, coming back to the same link.
    const q = `redirect_uri=${encodeURIComponent('http://127.0.0.1:5000/callback')}&state=aaaaaaaaaaaaaaaa&code_challenge=${'a'.repeat(43)}&code_challenge_method=S256`;
    const anon = await fetch(`${srv.publicUrl}/auth/desktop/start?${q}`, { redirect: 'manual' });
    assert.equal(anon.status, 302);
    assert.match(anon.headers.get('location'), /^\/auth\/login\?return=%2Fauth%2Fdesktop%2Fstart%3F/);

    // Approving from another site is refused.
    const page = await (await fetch(`${srv.publicUrl}/auth/desktop/start?${q}`, { headers: { cookie: 'sid=alice' } })).text();
    const request = /name="request" value="([^"]+)"/.exec(page)[1];
    const cross = await fetch(`${srv.publicUrl}/auth/desktop/approve`, {
      method: 'POST',
      headers: { cookie: 'sid=alice', origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' },
      body: `request=${request}&decision=allow`,
      redirect: 'manual'
    });
    assert.equal(cross.status, 403);

    // A code without the right verifier (someone else who saw the code) gets nothing.
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const q2 = `redirect_uri=${encodeURIComponent('http://127.0.0.1:5000/callback')}&state=bbbbbbbbbbbbbbbb&code_challenge=${challenge}&code_challenge_method=S256`;
    const page2 = await (await fetch(`${srv.publicUrl}/auth/desktop/start?${q2}`, { headers: { cookie: 'sid=alice' } })).text();
    const request2 = /name="request" value="([^"]+)"/.exec(page2)[1];
    const ok = await fetch(`${srv.publicUrl}/auth/desktop/approve`, {
      method: 'POST',
      headers: { cookie: 'sid=alice', origin: srv.publicUrl, 'content-type': 'application/x-www-form-urlencoded' },
      body: `request=${request2}&decision=allow`,
      redirect: 'manual'
    });
    const code = new URL(ok.headers.get('location')).searchParams.get('code');
    const post = (body, headers = {}) => fetch(`${srv.publicUrl}/desktop/api/token`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const wrong = await post({ grant_type: 'authorization_code', code, code_verifier: 'x'.repeat(43), redirect_uri: 'http://127.0.0.1:5000/callback' });
    assert.equal(wrong.status, 400);
    // ...and the code is used up.
    const late = await post({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: 'http://127.0.0.1:5000/callback' });
    assert.equal(late.status, 400);

    // Pages in a browser may not use the API at all.
    assert.equal((await post({ grant_type: 'refresh_token', refresh_token: 'nrd_rt_x' }, { origin: 'https://evil.example' })).status, 403);
  } finally {
    await srv.close();
  }
});

test('devices: listed per person, signed out from the list, and a copied refresh token signs the device out', async () => {
  const srv = await startServer();
  try {
    const dataDir = tmp();
    const front = new RemoteFront({ dataDir, safeStorage: fakeSafeStorage(), openExternal: browserAs('alice').open, deviceName: 'laptop', log: quiet });
    await front.signIn(srv.publicUrl);
    const deviceId = front.session.device.id;

    // Alice sees it (from the web, through her worker's devices.* calls); Bob doesn't.
    assert.deepEqual(srv.desktop.deviceCalls({ id: 'alice' }, 'devices.list', []).map((d) => d.name), ['laptop']);
    assert.deepEqual(srv.desktop.deviceCalls({ id: 'bob' }, 'devices.list', []), []);
    assert.throws(() => srv.desktop.deviceCalls({ id: 'bob', name: 'Bob' }, 'devices.revoke', [deviceId]), /No such device/);

    // Copy the refresh token, let the app rotate it, then use the copy: the device is signed out.
    const copied = front.refreshToken;
    front.access = null;
    await front.git.status();
    assert.notEqual(front.refreshToken, copied);
    const replay = await fetch(`${srv.publicUrl}/desktop/api/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: copied }) });
    assert.equal(replay.status, 400);
    assert.deepEqual(srv.desktop.deviceCalls({ id: 'alice' }, 'devices.list', []), []);
    front.access = null;
    await assert.rejects(front.git.status(), /Sign in to your narado server again/);
    assert.equal(front.signedIn, false);

    // Signing a device out from the list stops it at once, access token included.
    const second = new RemoteFront({ dataDir: tmp(), safeStorage: fakeSafeStorage(), openExternal: browserAs('alice').open, deviceName: 'desktop', log: quiet });
    await second.signIn(srv.publicUrl);
    assert.ok(await second.git.status());
    srv.desktop.deviceCalls({ id: 'alice', name: 'Alice' }, 'devices.revoke', [second.session.device.id]);
    await assert.rejects(second.git.status(), /signed out/i);
    assert.equal(second.signedIn, false);
  } finally {
    await srv.close();
  }
});

test('desktop API: only the desktop calls, sign-out on the computer, policy, audit', async () => {
  const srv = await startServer({ env: { NARADO_DESKTOP_SEND: 'private-only' } });
  try {
    const front = new RemoteFront({ dataDir: tmp(), safeStorage: fakeSafeStorage(), openExternal: browserAs('bob').open, deviceName: 'bob-pc', platform: 'win32', log: quiet });
    await front.signIn(srv.publicUrl);
    assert.equal(front.status().policy.send, 'private-only');
    await assert.rejects(front.call('tokens.create', [{ name: 'x' }]), /may not call tokens.create/);

    await front.audit([{ at: Date.now(), method: 'post', host: 'localhost:4900', repo: 'github:acme/api', status: 200 }, { method: 'GET\nINJECT', host: 'x\ny', status: 'error' }]);
    assert.ok(srv.logs.some((l) => /desktop send: Bob on "bob-pc" post localhost:4900 \(github:acme\/api\) -> 200/.test(l)));
    assert.ok(srv.logs.every((l) => !l.includes('\nINJECT')));

    const before = srv.desktop.deviceCalls({ id: 'bob' }, 'devices.list', []).length;
    await front.signOut();
    assert.equal(front.signedIn, false);
    assert.equal(srv.desktop.deviceCalls({ id: 'bob' }, 'devices.list', []).length, before - 1);
  } finally {
    await srv.close();
  }
});

test('desktop: the server address people type, and the switching front', async () => {
  assert.equal(normaliseServer('narado.example.com'), 'https://narado.example.com');
  assert.equal(normaliseServer('https://narado.example.com/'), 'https://narado.example.com');
  assert.equal(normaliseServer('http://localhost:3000'), 'http://localhost:3000');
  assert.throws(() => normaliseServer('http://narado.example.com'), /must start with https/);
  assert.throws(() => normaliseServer('https://narado.example.com/?next=x'), /just the server address/);

  const local = { git: { status: async () => [{ id: 'github', connected: true }], token: async () => ({ token: 'local' }) }, secrets: {} };
  const remote = { server: null, signedIn: false, session: { hosts: [{ id: 'gl', type: 'gitlab' }] } };
  const front = switchingFront({ local, remote });
  assert.equal((await front.git.token('github')).token, 'local');
  remote.server = 'https://narado.example.com';
  assert.deepEqual((await front.git.status()).map((h) => [h.id, h.connected, h.needsSignIn]), [['gl', false, true]]);
  await assert.rejects(front.git.token('gl'), /Sign in to your narado server/);
  await assert.rejects(front.secrets.resolve(['secret://x/y']), /Sign in to your narado server/);
});

test('desktop audit: sends are reported with method, host and repository, and kept when the server is away', async () => {
  const handlers = new Map([['send-http-request', async () => ({ status: 201 })]]);
  const ipcMain = { _invokeHandlers: handlers, handle: (c, f) => handlers.set(c, f), removeHandler: (c) => handlers.delete(c) };
  let reachable = false;
  const reported = [];
  const remote = {
    signedIn: true,
    audit: async (events) => {
      if (!reachable) throw new Error('offline');
      reported.push(...events);
    }
  };
  const audit = auditSends({ ipcMain, remote, locateRepo: (p) => (p === '/w' ? { hostId: 'github', repoPath: 'acme/api' } : null), log: quiet, intervalMs: 1e9 });
  try {
    const res = await handlers.get('send-http-request')({}, { request: { method: 'put', url: 'http://localhost:4900/x?token=secret' } }, { pathname: '/w' });
    assert.equal(res.status, 201);
    await audit.flush();
    assert.equal(audit.queue.length, 1);
    reachable = true;
    await audit.flush();
    assert.equal(audit.queue.length, 0);
    assert.deepEqual({ ...reported[0], at: 0 }, { at: 0, method: 'PUT', host: 'localhost:4900', repo: 'github:acme/api', status: 201 });
  } finally {
    audit.stop();
  }
});

test('device store: refresh tokens expire when unused', () => {
  const store = new DeviceStore({ dataDir: tmp() });
  const t0 = Date.now();
  const { refreshToken } = store.create('alice', { name: 'old\nlaptop' }, t0);
  assert.equal(store.list('alice')[0].name, 'old laptop');
  assert.throws(() => store.refresh(refreshToken, t0 + 31 * 24 * 3600e3), /expired/);
  assert.deepEqual(store.list('alice'), []);
});

test('updates: the server offers installers to signed-in devices; the app checks the checksum', async () => {
  const srv = await startServer({ env: { NARADO_DESKTOP_MIN_VERSION: '0.1.0' } });
  try {
    const dir = path.join(srv.dataDir, 'desktop-updates', 'mac');
    fs.mkdirSync(dir, { recursive: true });
    const installer = Buffer.from('pretend this is a disk image');
    const sha512 = crypto.createHash('sha512').update(installer).digest('base64');
    fs.writeFileSync(path.join(dir, 'narado_0.2.0_arm64_mac.dmg'), installer);
    fs.writeFileSync(path.join(dir, 'narado_0.2.0_x64_mac.dmg'), Buffer.from('intel'));
    fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify({ version: '0.2.0', files: [{ name: 'narado_0.2.0_x64_mac.dmg', arch: 'x64', kind: 'dmg', size: 5, sha512: 'x' }, { name: 'narado_0.2.0_arm64_mac.dmg', arch: 'arm64', kind: 'dmg', size: installer.length, sha512 }] }));

    // Without a device session: nothing.
    assert.equal((await fetch(`${srv.publicUrl}/desktop/api/updates/mac/latest.json`)).status, 401);

    const front = new RemoteFront({ dataDir: tmp(), safeStorage: fakeSafeStorage(), openExternal: browserAs('alice').open, log: quiet });
    await front.signIn(srv.publicUrl);
    assert.deepEqual(front.session.server, { version: require('../package.json').version, minDesktopVersion: '0.1.0' });

    const latest = await front.latestUpdate({ platform: 'mac', arch: 'arm64', kind: 'dmg' });
    assert.equal(latest.version, '0.2.0');
    assert.equal(latest.file.name, 'narado_0.2.0_arm64_mac.dmg');
    const dest = tmp();
    const got = await front.downloadUpdate('mac', latest.file, dest);
    assert.deepEqual(fs.readFileSync(got), installer);

    // A file that doesn't match its checksum is refused and not kept.
    await assert.rejects(front.downloadUpdate('mac', { ...latest.file, sha512: 'wrong' }, dest), /doesn't match its checksum/);
    assert.deepEqual(fs.readdirSync(dest), ['narado_0.2.0_arm64_mac.dmg']);
    // Only files in the updates folder, by plain name.
    await assert.rejects(front.downloadUpdate('mac', { name: '../../narado.db', sha512: 'x' }, dest), /Unexpected update file name/);
    assert.equal(await front.latestUpdate({ platform: 'linux', arch: 'x64' }), null);
  } finally {
    await srv.close();
  }
});
