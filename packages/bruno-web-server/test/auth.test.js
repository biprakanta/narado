const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createAuth, OidcClient, UserStore, safeReturn } = require('../src/narado/auth');

/* -------------------------------------------------- a fake OIDC provider */

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'test-key-1';
let idp; // { url, server, codes, claimsFor }
let tmp;

const sign = (claims, { key = privateKey, kid = KID, alg = 'RS256' } = {}) => {
  const h = Buffer.from(JSON.stringify({ alg, kid, typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const sig = crypto.sign('sha256', Buffer.from(`${h}.${p}`), key).toString('base64url');
  return `${h}.${p}.${sig}`;
};

const startIdp = async () => {
  const codes = new Map();
  const state = { claimsFor: (c) => c };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, idp.url);
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, { issuer: idp.url, authorization_endpoint: `${idp.url}/authorize`, token_endpoint: `${idp.url}/token`, jwks_uri: `${idp.url}/jwks`, end_session_endpoint: `${idp.url}/logout` });
    }
    if (url.pathname === '/jwks') return json(200, { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: KID, use: 'sig', alg: 'RS256' }] });
    if (url.pathname === '/authorize') {
      // Sign the user straight in and send them back, as a real provider would after login.
      const code = crypto.randomUUID();
      codes.set(code, { nonce: url.searchParams.get('nonce'), challenge: url.searchParams.get('code_challenge'), clientId: url.searchParams.get('client_id'), redirect: url.searchParams.get('redirect_uri') });
      const back = new URL(url.searchParams.get('redirect_uri'));
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state'));
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let body = '';
      for await (const c of req) body += c;
      const form = new URLSearchParams(body);
      const entry = codes.get(form.get('code'));
      codes.delete(form.get('code'));
      const basic = Buffer.from(String(req.headers.authorization || '').replace(/^Basic /, ''), 'base64').toString();
      if (!entry) return json(400, { error: 'invalid_grant' });
      if (basic !== 'narado-web:client-secret') return json(401, { error: 'invalid_client' });
      const challenge = crypto.createHash('sha256').update(form.get('code_verifier') || '').digest('base64url');
      if (challenge !== entry.challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
      if (form.get('redirect_uri') !== entry.redirect) return json(400, { error: 'invalid_grant' });
      const now = Math.floor(Date.now() / 1000);
      const claims = state.claimsFor({ iss: idp.url, aud: 'narado-web', sub: 'user-123', nonce: entry.nonce, iat: now, exp: now + 300, email: 'alice@acme.test', email_verified: true, name: 'Alice Example' });
      return json(200, { id_token: sign(claims), access_token: 'at', token_type: 'Bearer' });
    }
    json(404, {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  idp = { url: `http://127.0.0.1:${server.address().port}`, server, codes, state };
};

/* --------------------------------------------------------- narado side */

const startNarado = async (extraEnv = {}) => {
  const dataDir = fs.mkdtempSync(path.join(tmp, 'data-'));
  let auth;
  const server = http.createServer(async (req, res) => {
    if (await auth.handle(req, res)) return;
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  auth = createAuth({
    dataDir,
    port,
    env: { NARADO_OIDC_ISSUER: idp.url, NARADO_OIDC_CLIENT_ID: 'narado-web', NARADO_OIDC_CLIENT_SECRET: 'client-secret', NARADO_PUBLIC_URL: base, ...extraEnv },
    log: { log() {}, error() {} }
  });
  const close = () => {
    server.closeAllConnections();
    server.close();
  };
  return { auth, base, close };
};

/** Walk the redirects of a sign-in like a browser, returning the session cookie and final location. */
const signIn = async (base, returnTo = '/workspace') => {
  const start = await fetch(`${base}/auth/login/start?return=${encodeURIComponent(returnTo)}`, { redirect: 'manual' });
  assert.equal(start.status, 302);
  const atIdp = await fetch(start.headers.get('location'), { redirect: 'manual' });
  assert.equal(atIdp.status, 302);
  const callback = await fetch(atIdp.headers.get('location'), { redirect: 'manual' });
  return { callback, cookie: (callback.headers.get('set-cookie') || '').split(';')[0], callbackUrl: atIdp.headers.get('location') };
};

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'narado-auth-'));
  await startIdp();
});

after(() => {
  idp.server.closeAllConnections();
  idp.server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('signs in with PKCE, sets a safe session cookie, and signs out', async () => {
  const n = await startNarado();
  assert.equal((await fetch(`${n.base}/auth/me`)).status, 401);

  const start = await fetch(`${n.base}/auth/login/start?return=/x`, { redirect: 'manual' });
  const authorize = new URL(start.headers.get('location'));
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(authorize.searchParams.get('state') && authorize.searchParams.get('nonce'));
  assert.equal(authorize.searchParams.get('redirect_uri'), `${n.base}/auth/callback`);

  const { callback, cookie } = await signIn(n.base, '/workspace?tab=git');
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get('location'), '/workspace?tab=git');
  const setCookie = callback.headers.get('set-cookie');
  assert.match(setCookie, /narado_session=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+/);
  assert.doesNotMatch(setCookie, /Secure/, 'no Secure flag on plain http');

  const me = await fetch(`${n.base}/auth/me`, { headers: { cookie } });
  assert.equal(me.status, 200);
  assert.deepEqual((await me.json()).user, { id: (await (await fetch(`${n.base}/auth/me`, { headers: { cookie } })).json()).user.id, name: 'Alice Example', email: 'alice@acme.test' });

  // Signing in again maps to the same user.
  const again = await signIn(n.base);
  const id1 = (await (await fetch(`${n.base}/auth/me`, { headers: { cookie } })).json()).user.id;
  const id2 = (await (await fetch(`${n.base}/auth/me`, { headers: { cookie: again.cookie } })).json()).user.id;
  assert.equal(id1, id2);

  const out = await fetch(`${n.base}/auth/logout`, { method: 'POST', headers: { cookie } });
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  assert.match((await out.json()).redirect, /\/logout\?client_id=narado-web&post_logout_redirect_uri=/);
  assert.equal((await fetch(`${n.base}/auth/me`, { headers: { cookie } })).status, 401, 'session ended');
  assert.equal((await fetch(`${n.base}/auth/logout`, { method: 'POST', headers: { cookie: again.cookie, origin: 'https://evil.test' } })).status, 403);
  n.close();
});

test('a login link works once, and only returns to this site', async () => {
  const n = await startNarado();
  const { callbackUrl } = await signIn(n.base);
  const replay = await fetch(callbackUrl, { redirect: 'manual' });
  assert.equal(replay.status, 400, 'state cannot be replayed');

  assert.equal(safeReturn('//evil.test/x'), '/');
  assert.equal(safeReturn('https://evil.test'), '/');
  assert.equal(safeReturn('/\\evil'), '/');
  assert.equal(safeReturn('/ok?a=1'), '/ok?a=1');
  const { callback } = await signIn(n.base, '//evil.test');
  assert.equal(callback.headers.get('location'), '/');
  n.close();
});

test('only allowed email domains get in', async () => {
  const n = await startNarado({ NARADO_ALLOWED_EMAIL_DOMAINS: 'other.test' });
  const { callback } = await signIn(n.base);
  assert.equal(callback.status, 403);
  assert.equal(callback.headers.get('set-cookie'), null);
  n.close();
});

test('ID tokens are checked: signature, issuer, audience, expiry, nonce', async () => {
  const client = new OidcClient({ issuer: idp.url, clientId: 'narado-web', redirectUri: 'http://x/cb' });
  const now = Math.floor(Date.now() / 1000);
  const good = { iss: idp.url, aud: 'narado-web', sub: 's', nonce: 'n1', iat: now, exp: now + 60 };
  assert.equal((await client.verify(sign(good), 'n1')).sub, 's');

  const { privateKey: other } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  await assert.rejects(client.verify(sign(good, { key: other }), 'n1'), /signature is not valid/);
  await assert.rejects(client.verify(sign({ ...good, iss: 'http://evil' }), 'n1'), /another issuer/);
  await assert.rejects(client.verify(sign({ ...good, aud: 'someone-else' }), 'n1'), /another application/);
  await assert.rejects(client.verify(sign({ ...good, exp: now - 3600 }), 'n1'), /expired/);
  await assert.rejects(client.verify(sign(good), 'n2'), /does not match this sign-in/);
  await assert.rejects(client.verify(sign(good, { kid: 'unknown' }), 'n1'), /key the provider does not publish/);
  const [h, p] = sign(good).split('.');
  await assert.rejects(client.verify(`${h}.${p}.`, 'n1'), /signature/);
  const none = `${Buffer.from(JSON.stringify({ alg: 'none', kid: KID })).toString('base64url')}.${p}.`;
  await assert.rejects(client.verify(none, 'n1'), /not accepted/);
});

test('a bad token from the provider ends the sign-in without a session', async () => {
  const n = await startNarado();
  idp.state.claimsFor = (c) => ({ ...c, aud: 'someone-else' });
  const { callback } = await signIn(n.base);
  idp.state.claimsFor = (c) => c;
  assert.equal(callback.status, 502);
  assert.equal(callback.headers.get('set-cookie'), null);
  n.close();
});

test('sessions end after 12 hours idle or 7 days in total; only hashes are stored', () => {
  const store = new UserStore({ dataDir: fs.mkdtempSync(path.join(tmp, 'store-')) });
  const t0 = Date.now();
  const user = store.upsertUser({ issuer: 'i', subject: 's', email: 'a@b', name: 'A' }, t0);
  const sid = store.createSession(user.id, 'idt', t0);
  assert.equal(store.sessionUser(sid, t0 + 11 * 3600e3).id, user.id);
  assert.equal(store.sessionUser(sid, t0 + 11 * 3600e3 + 13 * 3600e3), null, 'idle too long');

  const sid2 = store.createSession(user.id, null, t0);
  let t = t0;
  for (let i = 0; i < 14; i++) {
    t += 11 * 3600e3;
    if (t - t0 <= 7 * 24 * 3600e3) assert.ok(store.sessionUser(sid2, t));
  }
  assert.equal(store.sessionUser(sid2, t0 + 7 * 24 * 3600e3 + 1), null, 'past 7 days');

  const sid3 = store.createSession(user.id, null, t0);
  const row = store.db.prepare('SELECT id_hash FROM sessions').all().map((r) => r.id_hash);
  assert.ok(!row.includes(sid3) && row.includes(crypto.createHash('sha256').update(sid3).digest('hex')));
});

test('without a provider, sign-in is off and /auth/me says so', async () => {
  const dataDir = fs.mkdtempSync(path.join(tmp, 'local-'));
  const auth = createAuth({ dataDir, port: 1, env: {} });
  assert.equal(auth.enabled, false);
  const res = { status: 0, body: '', writeHead(s) { this.status = s; }, end(b) { this.body = b; } };
  await auth.handle({ url: '/auth/me', method: 'GET', headers: {} }, res);
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { mode: 'local', user: null });
});

test('the sign-in page is narado\'s own, escapes what it shows, and serves only its own images', async () => {
  const n = await startNarado({ NARADO_OIDC_PROVIDER_NAME: 'Acme SSO' });
  try {
    const res = await fetch(`${n.base}/auth/login?return=${encodeURIComponent('/x"><script>alert(1)</script>')}`, { redirect: 'manual' });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Sign in with Acme SSO/);
    assert.match(html, /href="\/auth\/login\/start\?return=/);
    assert.doesNotMatch(html, /<script>alert/);

    const out = await (await fetch(`${n.base}/auth/login?signedout=1`)).text();
    assert.match(out, /You have signed out\./);

    const img = await fetch(`${n.base}/auth/assets/narado-loader-dark.svg`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/svg+xml');
    assert.equal((await fetch(`${n.base}/auth/assets/..%2F..%2Fpackage.json`)).status, 404);
    assert.equal((await fetch(`${n.base}/auth/assets/index.html`)).status, 404);
  } finally {
    n.close();
  }
});

test('NARADO_OIDC_AUTO_REDIRECT=1 skips the sign-in page', async () => {
  const n = await startNarado({ NARADO_OIDC_AUTO_REDIRECT: '1' });
  try {
    const res = await fetch(`${n.base}/auth/login?return=/x`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location'), /\/authorize\?/);
  } finally {
    n.close();
  }
});
