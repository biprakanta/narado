const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { GitAccounts, gitService, NotConnected } = require('../src/narado/git-accounts');
const { GitHubProvider } = require('../src/narado/providers/github');

const quiet = { log() {}, warn() {}, error() {} };
const alice = { id: 'u-alice' };
const bob = { id: 'u-bob' };
const APP_ENV = { NARADO_GITHUB_APP_CLIENT_ID: 'Iv-test', NARADO_GITHUB_APP_CLIENT_SECRET: 'app-secret', NARADO_GITHUB_APP_SLUG: 'narado-test' };

let tmp;
before(() => (tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'narado-git-'))));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const dir = () => fs.mkdtempSync(path.join(tmp, 'd-'));

/** A fake GitHub: OAuth token endpoint (rotating refresh tokens) and /user. */
const fakeGitHub = () => {
  const state = { calls: [], issued: 0, refreshes: 0, valid: new Set(), refreshValid: new Set(), revoked: [] };
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const issue = () => {
    state.issued++;
    const access = `ghu_${state.issued}`;
    const refresh = `ghr_${state.issued}`;
    state.valid.add(access);
    state.refreshValid.add(refresh);
    return { access_token: access, expires_in: 28800, refresh_token: refresh, refresh_token_expires_in: 15897600, token_type: 'bearer' };
  };
  state.fetch = async (url, init = {}) => {
    const u = new URL(url);
    state.calls.push({ url: u.pathname, method: init.method || 'GET', headers: init.headers, body: init.body });
    if (u.pathname === '/login/oauth/access_token') {
      const p = new URLSearchParams(init.body);
      if (p.get('client_secret') !== 'app-secret') return json(200, { error: 'incorrect_client_credentials' });
      if (p.get('grant_type') === 'authorization_code') {
        const pending = state.codes && state.codes.get(p.get('code'));
        if (!pending) return json(200, { error: 'bad_verification_code' });
        const challenge = crypto.createHash('sha256').update(p.get('code_verifier')).digest('base64url');
        if (challenge !== pending.challenge) return json(200, { error: 'bad_verification_code', error_description: 'PKCE' });
        return json(200, issue());
      }
      if (p.get('grant_type') === 'refresh_token') {
        state.refreshes++;
        if (!state.refreshValid.has(p.get('refresh_token'))) return json(200, { error: 'bad_refresh_token' });
        state.refreshValid.delete(p.get('refresh_token')); // rotated
        await new Promise((r) => setTimeout(r, 20));
        return json(200, issue());
      }
    }
    if (u.pathname === '/user') {
      const token = String(init.headers.authorization || '').replace('Bearer ', '');
      if (!state.valid.has(token)) return json(401, { message: 'Bad credentials' });
      return json(200, { id: 42, login: 'alice-gh', name: 'Alice' });
    }
    if (u.pathname.startsWith('/applications/')) {
      state.revoked.push(JSON.parse(init.body).access_token);
      return new Response(null, { status: 204 });
    }
    return json(404, { message: 'Not Found' });
  };
  return state;
};

/** Minimal req/res for GitAccounts.handle. */
const call = async (accounts, { method = 'GET', url, user, origin }) => {
  const res = { status: 0, headers: {}, body: '' };
  const r = {
    writeHead(status, headers) {
      res.status = status;
      res.headers = headers || {};
    },
    end(b) {
      res.body = b || '';
    }
  };
  const handled = await accounts.handle({ method, url, headers: origin ? { origin } : {} }, r, { user, allowedOrigins: new Set(['http://localhost:3000']) });
  return { handled, ...res };
};

/** Connect `user` through the whole flow; returns the final redirect. */
const connect = async (accounts, gh, user, asUser = user) => {
  const start = await call(accounts, { url: '/auth/git/github/connect?return=/workspace', user });
  assert.equal(start.status, 302);
  const to = new URL(start.headers.location);
  assert.equal(to.origin + to.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(to.searchParams.get('client_id'), 'Iv-test');
  assert.equal(to.searchParams.get('redirect_uri'), 'http://localhost:3000/auth/github/callback');
  assert.equal(to.searchParams.get('code_challenge_method'), 'S256');
  gh.codes = gh.codes || new Map();
  const code = `code-${gh.codes.size}`;
  gh.codes.set(code, { challenge: to.searchParams.get('code_challenge') });
  return call(accounts, { url: `/auth/github/callback?code=${code}&state=${to.searchParams.get('state')}`, user: asUser });
};

const make = (opts = {}) => {
  const gh = fakeGitHub();
  const dataDir = dir();
  const accounts = new GitAccounts({ dataDir, publicUrl: 'http://localhost:3000', multiUser: true, env: { ...APP_ENV, ...(opts.env || {}) }, fetchImpl: gh.fetch, log: quiet });
  return { gh, dataDir, accounts };
};

test('connecting a GitHub account: PKCE, state tied to the person, tokens encrypted at rest', async () => {
  const { gh, dataDir, accounts } = make();
  const done = await connect(accounts, gh, alice);
  assert.equal(done.status, 302);
  assert.equal(done.headers.location, '/workspace?git-connect=ok&host=github&login=alice-gh');

  const status = accounts.status(alice).find((h) => h.id === 'github');
  assert.deepEqual(
    { connected: status.connected, via: status.via, login: status.login, installUrl: status.installUrl },
    { connected: true, via: 'account', login: 'alice-gh', installUrl: 'https://github.com/apps/narado-test/installations/new' }
  );
  assert.equal(accounts.status(bob).find((h) => h.id === 'github').connected, false, "Bob does not get Alice's account");

  // Nothing readable in the database.
  const db = new DatabaseSync(path.join(dataDir, 'narado.db'));
  const row = db.prepare('SELECT * FROM git_accounts').get();
  assert.ok(!JSON.stringify(row).includes('ghu_') && !JSON.stringify(row).includes('ghr_'));
  assert.equal(fs.statSync(path.join(dataDir, 'narado-git-key')).mode & 0o777, 0o600);

  // A row moved to another person can't be decrypted (the person is part of the sealed data).
  db.prepare("UPDATE git_accounts SET user_key = 'u-bob'").run();
  assert.throws(() => accounts.store.get('u-bob', 'github'));
});

test('a Git account already connected by another person is refused', async () => {
  const { gh, accounts } = make();
  await connect(accounts, gh, alice);
  // Bob's browser is signed in to the same GitHub account (a shared machine, say).
  const taken = await connect(accounts, gh, bob);
  assert.equal(taken.headers.location, '/workspace?git-connect=taken&host=github&login=alice-gh');
  assert.equal(accounts.status(bob).find((h) => h.id === 'github').connected, false);
  // Alice reconnecting the same account is fine.
  assert.match((await connect(accounts, gh, alice)).headers.location, /git-connect=ok/);
});

test('a callback is refused for a different person, a reused state, or a wrong verifier', async () => {
  const { gh, accounts } = make();
  const stolen = await connect(accounts, gh, alice, bob); // Alice's link opened in Bob's session
  assert.equal(stolen.headers.location, '/?git-connect=expired&host=github');
  assert.equal(accounts.status(bob).find((h) => h.id === 'github').connected, false);

  const start = await call(accounts, { url: '/auth/git/github/connect', user: alice });
  const st = new URL(start.headers.location).searchParams.get('state');
  gh.codes.set('c-bad', { challenge: 'not-the-challenge' });
  const bad = await call(accounts, { url: `/auth/github/callback?code=c-bad&state=${st}`, user: alice });
  assert.equal(bad.headers.location, '/?git-connect=failed&host=github');
  const again = await call(accounts, { url: `/auth/github/callback?code=c-bad&state=${st}`, user: alice });
  assert.equal(again.headers.location, '/?git-connect=expired&host=github', 'a state works once');
});

test('tokens refresh near expiry, once for parallel callers, and the rotated refresh token is kept', async () => {
  const { gh, accounts } = make();
  await connect(accounts, gh, alice);
  const first = await accounts.token(alice, 'github');
  assert.equal(first.token, 'ghu_1');
  assert.equal(gh.refreshes, 0);

  // Make it nearly expired.
  const a = accounts.store.get('u-alice', 'github');
  accounts.store.save('u-alice', 'github', { ...a, accessExpiresAt: Date.now() + 60 * 1000 });
  const [x, y, z] = await Promise.all([accounts.token(alice, 'github'), accounts.token(alice, 'github'), accounts.token(alice, 'github')]);
  assert.equal(gh.refreshes, 1, 'one refresh for three callers');
  assert.equal(x.token, 'ghu_2');
  assert.equal(y.token, 'ghu_2');
  assert.equal(z.token, 'ghu_2');
  assert.equal(accounts.store.get('u-alice', 'github').refreshToken, 'ghr_2');

  // force (after a 401) refreshes again with the new refresh token.
  assert.equal((await accounts.token(alice, 'github', { force: true })).token, 'ghu_3');
});

test('a refused refresh disconnects the account and says to connect again', async () => {
  const { gh, accounts } = make();
  await connect(accounts, gh, alice);
  gh.refreshValid.clear(); // e.g. revoked on GitHub
  await assert.rejects(accounts.token(alice, 'github', { force: true }), (err) => err instanceof NotConnected && /Connect your GitHub account/.test(err.message));
  assert.equal(accounts.status(alice).find((h) => h.id === 'github').connected, false);
});

test('a provider with getToken retries once with a refreshed token after a 401', async () => {
  const { gh, accounts } = make();
  await connect(accounts, gh, alice);
  gh.valid.clear(); // the access token stopped working before its time
  const provider = new GitHubProvider({ id: 'github', getToken: async (o) => (await accounts.token(alice, 'github', o)).token, fetchImpl: gh.fetch });
  const me = await provider.getCurrentUser();
  assert.equal(me.login, 'alice-gh');
  assert.equal(gh.refreshes, 1);
  assert.match(await provider.gitAuthHeader(), /^Authorization: Basic /);
});

test('shared tokens: used in local mode, not for people when sign-in is on', async () => {
  const gh = fakeGitHub();
  const local = new GitAccounts({ dataDir: dir(), publicUrl: 'http://localhost:4100', multiUser: false, env: { NARADO_GITHUB_TOKEN: 'shared' }, fetchImpl: gh.fetch, log: quiet });
  assert.deepEqual(await local.token(null, 'github'), { token: 'shared', via: 'server' });
  assert.equal(local.status(null).find((h) => h.id === 'github').via, 'server');

  const multi = new GitAccounts({ dataDir: dir(), publicUrl: 'http://localhost:3000', multiUser: true, env: { NARADO_GITHUB_TOKEN: 'shared' }, fetchImpl: gh.fetch, log: quiet });
  await assert.rejects(multi.token(alice, 'github'), /not set up on this server/);
  assert.deepEqual(multi.tokenEnvNames(), ['NARADO_GITHUB_TOKEN', 'NARADO_GITLAB_TOKEN']);

  const moving = new GitAccounts({ dataDir: dir(), publicUrl: 'http://localhost:3000', multiUser: true, env: { NARADO_GITHUB_TOKEN: 'shared', NARADO_SHARED_GIT_TOKENS: '1' }, fetchImpl: gh.fetch, log: quiet });
  assert.equal((await moving.token(alice, 'github')).token, 'shared');
});

test('disconnecting needs a same-site POST and withdraws the grant on GitHub', async () => {
  const { gh, accounts } = make();
  await connect(accounts, gh, alice);
  const cross = await call(accounts, { method: 'POST', url: '/auth/git/github/disconnect', user: alice, origin: 'https://evil.test' });
  assert.equal(cross.status, 403);
  assert.equal(accounts.status(alice).find((h) => h.id === 'github').connected, true);
  const ok = await call(accounts, { method: 'POST', url: '/auth/git/github/disconnect', user: alice, origin: 'http://localhost:3000' });
  assert.equal(ok.status, 200);
  assert.deepEqual(gh.revoked, ['ghu_1']);
  assert.equal(accounts.status(alice).find((h) => h.id === 'github').connected, false);
});

test('git.* calls from a worker act for that worker\'s person only', async () => {
  const { gh, accounts } = make();
  await connect(accounts, gh, alice);
  const svc = gitService(accounts);
  assert.equal((await svc(alice, 'git.token', ['github'])).token, 'ghu_1');
  await assert.rejects(svc(bob, 'git.token', ['github']), /Connect your GitHub account/);
  const st = await svc(alice, 'git.status', []);
  assert.ok(!JSON.stringify(st).includes('ghu_'), 'status carries no tokens');
  await assert.rejects(svc(alice, 'git.refresh-all', []), /Unknown call/);
});
