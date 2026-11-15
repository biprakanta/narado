const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { SettingsStore } = require('../src/narado/settings');
const { createAdmin } = require('../src/narado/admin');

const quiet = { log() {}, warn() {}, error() {} };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'narado-admin-'));

/** An admin-pages server; cookie "sid=<user id>" signs in. */
const startAdmin = async ({ env = {}, users = {}, enabled = true, localOnly = false, fetchImpl, dataDir = tmp(), secrets = null } = {}) => {
  const settings = new SettingsStore({ dataDir, env: {} });
  let restarts = 0;
  let publicUrl;
  let admin;
  const build = () => {
    const effective = settings.effectiveEnv(env);
    admin = createAdmin({
      settings,
      env: effective,
      realEnv: env,
      auth: {
        enabled,
        publicUrl,
        userFor: (req) => {
          const m = /sid=([\w-]+)/.exec(req.headers.cookie || '');
          return m ? users[m[1]] || null : null;
        }
      },
      desktop: { adminDevices: () => [], adminRevoke: () => true },
      gitAccounts: {},
      secrets,
      dataDir,
      localOnly,
      restart: async () => {
        restarts++;
        build();
      },
      fetchImpl,
      log: quiet
    });
  };
  const server = http.createServer(async (req, res) => {
    if (!(await admin.handle(req, res))) res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  publicUrl = `http://127.0.0.1:${server.address().port}`;
  build();
  const post = (p, form, headers = {}) =>
    fetch(`${publicUrl}${p}`, { method: 'POST', redirect: 'manual', headers: { origin: publicUrl, 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(form).toString() });
  return { settings, publicUrl, post, get admin() { return admin; }, restarts: () => restarts, dataDir, close: () => new Promise((r) => server.close(r)) };
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('settings: saved under environment names, secrets encrypted, the environment wins', () => {
  const dataDir = tmp();
  const s = new SettingsStore({ dataDir, env: {} });
  s.set({ NARADO_OIDC_ISSUER: 'https://login.acme.com', NARADO_OIDC_CLIENT_SECRET: 'shh', NARADO_GITHUB_APP_PRIVATE_KEY: '-----BEGIN' });
  const raw = fs.readFileSync(path.join(dataDir, 'narado.db'));
  assert.ok(!raw.includes('shh') && !raw.includes('-----BEGIN'), 'secrets are not stored in plain text');
  assert.equal(s.get('NARADO_OIDC_CLIENT_SECRET'), 'shh');
  const env = s.effectiveEnv({ NARADO_OIDC_ISSUER: 'https://from-env.acme.com' });
  assert.equal(env.NARADO_OIDC_ISSUER, 'https://from-env.acme.com');
  assert.equal(env.NARADO_OIDC_CLIENT_SECRET, 'shh');
  assert.equal(s.source('NARADO_OIDC_ISSUER', { NARADO_OIDC_ISSUER: 'x' }), 'env');
  assert.equal(s.source('NARADO_OIDC_ISSUER', {}), 'settings');
  assert.throws(() => s.set({ PATH: '/tmp' }), /Not a narado setting/);
  s.set({ NARADO_OIDC_ISSUER: '' });
  assert.equal(s.get('NARADO_OIDC_ISSUER'), undefined);
});

test('setup link: only the latest token works, gives a setup session, ends when an admin signs in', async () => {
  const users = { alice: { id: 'alice', name: 'Alice', email: 'alice@acme.com' } };
  const a = await startAdmin({ users });
  try {
    assert.equal(a.admin.setupNeeded, true);
    const old = a.settings.newSetupToken();
    const token = a.settings.newSetupToken();
    assert.equal((await fetch(`${a.publicUrl}/setup?token=${old}`, { redirect: 'manual' })).status, 403);
    assert.equal((await fetch(`${a.publicUrl}/admin`, { redirect: 'manual', headers: { cookie: 'sid=alice' } })).status, 403);
    const opened = await fetch(`${a.publicUrl}/setup?token=${token}`, { redirect: 'manual' });
    assert.equal(opened.status, 303);
    const cookie = opened.headers.get('set-cookie').split(';')[0];
    assert.match(opened.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
    const pageText = await (await fetch(`${a.publicUrl}/admin`, { headers: { cookie } })).text();
    assert.match(pageText, /Set up narado/);

    // Naming admins: from another site refused; from here saved, then narado restarts.
    assert.equal((await a.post('/admin/admins', { NARADO_ADMINS: 'alice@acme.com' }, { cookie, origin: 'https://evil.example' })).status, 403);
    const saved = await a.post('/admin/admins', { NARADO_ADMINS: 'Alice@acme.com, bob@acme.com' }, { cookie });
    assert.equal(saved.status, 200);
    await wait(400);
    assert.equal(a.restarts(), 1);
    assert.equal(a.settings.get('NARADO_ADMINS'), 'alice@acme.com,bob@acme.com');
    assert.equal(a.admin.setupNeeded, false);

    // The setup session no longer works; Alice, signed in, is an admin, and setup ends.
    assert.equal((await fetch(`${a.publicUrl}/admin`, { redirect: 'manual', headers: { cookie } })).status, 303); // to sign-in
    assert.equal((await fetch(`${a.publicUrl}/admin`, { headers: { cookie: 'sid=alice' } })).status, 200);
    assert.equal(a.settings.checkSetupToken(token), false);
    assert.equal(a.admin.isAdminUser(users.alice), true);
  } finally {
    await a.close();
  }
});

test('admins: only listed people, and nobody removes themselves', async () => {
  const users = { alice: { id: 'alice', name: 'Alice', email: 'alice@acme.com' }, eve: { id: 'eve', name: 'Eve', email: 'eve@acme.com' } };
  const a = await startAdmin({ users, env: { NARADO_ADMINS: 'alice@acme.com' } });
  try {
    assert.equal((await fetch(`${a.publicUrl}/admin`, { headers: { cookie: 'sid=eve' } })).status, 403);
    assert.equal((await fetch(`${a.publicUrl}/admin`, { redirect: 'manual' })).status, 303); // to sign-in
    // Set in the environment: shown, not editable.
    const text = await (await fetch(`${a.publicUrl}/admin`, { headers: { cookie: 'sid=alice' } })).text();
    assert.match(text, /set in the server environment/);
    const r = await a.post('/admin/admins', { NARADO_ADMINS: 'bob@acme.com' }, { cookie: 'sid=alice' });
    assert.match(await r.text(), /Admins are set in the server environment/);
  } finally {
    await a.close();
  }
});

test('sign-in settings: the issuer is checked before saving', async () => {
  const fetchImpl = async (url, init) => {
    if (String(url).startsWith('https://login.acme.com/.well-known/openid-configuration')) return { ok: true, json: async () => ({ authorization_endpoint: 'https://login.acme.com/auth' }) };
    if (String(url).startsWith('https://')) return { ok: false, json: async () => ({}) };
    return fetch(url, init);
  };
  const a = await startAdmin({ enabled: false, localOnly: true, fetchImpl });
  try {
    const bad = await a.post('/admin/signin', { NARADO_OIDC_ISSUER: 'https://typo.acme.com', NARADO_OIDC_CLIENT_ID: 'narado' });
    assert.match(await bad.text(), /Couldn&#39;t read https:\/\/typo.acme.com/);
    assert.equal(a.settings.get('NARADO_OIDC_ISSUER'), undefined);
    const good = await a.post('/admin/signin', { NARADO_PUBLIC_URL: 'https://narado.acme.com/', NARADO_OIDC_ISSUER: 'https://login.acme.com', NARADO_OIDC_CLIENT_ID: 'narado', NARADO_OIDC_CLIENT_SECRET: 'top-secret' });
    assert.equal(good.status, 200);
    assert.equal(a.settings.get('NARADO_PUBLIC_URL'), 'https://narado.acme.com');
    assert.equal(a.settings.get('NARADO_OIDC_CLIENT_SECRET'), 'top-secret');
    // The secret is never shown back.
    await wait(400);
    assert.ok(!(await (await fetch(`${a.publicUrl}/admin`)).text()).includes('top-secret'));
  } finally {
    await a.close();
  }
});

test('GitHub: narado creates its app through the manifest flow and keeps the credentials', async () => {
  const users = { alice: { id: 'alice', name: 'Alice', email: 'alice@acme.com' } };
  const conversions = [];
  const fetchImpl = async (url, init) => {
    if (String(url).startsWith('https://api.github.com/app-manifests/')) {
      conversions.push(String(url));
      return { ok: true, status: 201, json: async () => ({ id: 42, slug: 'narado-acme', client_id: 'Iv1.abc', client_secret: 'gh-secret', pem: '-----BEGIN RSA', webhook_secret: 'wh', owner: { login: 'acme' } }) };
    }
    return fetch(url, init);
  };
  const a = await startAdmin({ users, env: { NARADO_ADMINS: 'alice@acme.com' }, fetchImpl });
  try {
    const start = await a.post('/admin/git/github/github-app', { org: 'acme', name: 'narado (acme)' }, { cookie: 'sid=alice' });
    const html = await start.text();
    const action = /action="([^"]+)"/.exec(html)[1].replace(/&amp;/g, '&');
    assert.match(action, /^https:\/\/github\.com\/organizations\/acme\/settings\/apps\/new\?state=/);
    const manifest = JSON.parse(/name="manifest" value="([^"]+)"/.exec(html)[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
    assert.deepEqual(manifest.callback_urls, [`${a.publicUrl}/auth/github/callback`]);
    assert.equal(manifest.public, false);
    assert.equal(manifest.hook_attributes.active, false);
    assert.equal(manifest.default_permissions.contents, 'write');
    const state = new URL(action).searchParams.get('state');

    // GitHub sends the admin back with a code; a wrong state gets nothing.
    const wrong = await fetch(`${a.publicUrl}/admin/git/github/github-app-done?code=abc&state=nope`, { headers: { cookie: 'sid=alice' } });
    assert.match(await wrong.text(), /expired/);
    const back = await fetch(`${a.publicUrl}/admin/git/github/github-app-done?code=abc123&state=${state}`, { headers: { cookie: 'sid=alice' } });
    assert.equal(back.status, 200);
    assert.deepEqual(conversions, ['https://api.github.com/app-manifests/abc123/conversions']);
    assert.equal(a.settings.get('NARADO_GITHUB_APP_CLIENT_ID'), 'Iv1.abc');
    assert.equal(a.settings.get('NARADO_GITHUB_APP_CLIENT_SECRET'), 'gh-secret');
    assert.equal(a.settings.get('NARADO_GITHUB_APP_SLUG'), 'narado-acme');
    assert.equal(a.settings.get('NARADO_GITHUB_APP_PRIVATE_KEY'), '-----BEGIN RSA');
    await wait(400);
    // After the restart the page links to installing it.
    assert.match(await (await fetch(`${a.publicUrl}/admin`, { headers: { cookie: 'sid=alice' } })).text(), /github\.com\/apps\/narado-acme\/installations\/new/);
  } finally {
    await a.close();
  }
});

test("GitLab: a self-managed instance's application is created with an admin token that isn't kept", async () => {
  const users = { alice: { id: 'alice', name: 'Alice', email: 'alice@acme.com' } };
  const dataDir = tmp();
  fs.writeFileSync(path.join(dataDir, 'narado.json'), JSON.stringify({ hosts: [{ id: 'github', type: 'github' }, { id: 'gitlab', type: 'gitlab', url: 'https://gitlab.com' }, { id: 'gitlab-acme', type: 'gitlab', url: 'https://git.acme.com' }] }));
  const calls = [];
  const fetchImpl = async (url, init) => {
    if (String(url) === 'https://git.acme.com/api/v4/applications') {
      calls.push({ token: init.headers['private-token'], body: JSON.parse(init.body) });
      if (init.headers['private-token'] !== 'glpat-admin') return { ok: false, status: 403, json: async () => ({ message: '403 Forbidden' }) };
      return { ok: true, status: 201, json: async () => ({ application_id: 'app-1', secret: 'gloas-secret' }) };
    }
    return fetch(url, init);
  };
  const a = await startAdmin({ users, env: { NARADO_ADMINS: 'alice@acme.com' }, fetchImpl, dataDir });
  try {
    const denied = await a.post('/admin/git/gitlab-acme/gitlab-app', { token: 'glpat-user' }, { cookie: 'sid=alice' });
    assert.match(await denied.text(), /needs an administrator/);
    const ok = await a.post('/admin/git/gitlab-acme/gitlab-app', { token: 'glpat-admin' }, { cookie: 'sid=alice' });
    assert.equal(ok.status, 200);
    assert.deepEqual(calls[1].body, { name: 'narado', redirect_uri: `${a.publicUrl}/auth/gitlab-acme/callback`, scopes: 'api read_user', confidential: true });
    assert.equal(a.settings.get('NARADO_GITLAB_ACME_APP_CLIENT_ID'), 'app-1');
    assert.equal(a.settings.get('NARADO_GITLAB_ACME_APP_CLIENT_SECRET'), 'gloas-secret');
    assert.ok(!fs.readFileSync(path.join(dataDir, 'narado.db')).includes('glpat-admin'), 'the admin token is not stored');
    // GitLab.com: no API for this, so the page explains what to create.
    await wait(400);
    assert.match(await (await fetch(`${a.publicUrl}/admin`, { headers: { cookie: 'sid=alice' } })).text(), /GitLab.com can(&#39;|')t create applications through its API/);
  } finally {
    await a.close();
  }
});

test('Git hosts: adding and removing self-managed hosts, Explore defaults', async () => {
  const users = { alice: { id: 'alice', name: 'Alice', email: 'alice@acme.com' } };
  const a = await startAdmin({ users, env: { NARADO_ADMINS: 'alice@acme.com' } });
  try {
    await a.post('/admin/git/add', { id: 'ghe', type: 'github', url: 'https://ghe.acme.com/' }, { cookie: 'sid=alice' });
    await a.post('/admin/git/github/namespaces', { namespaces: 'acme, acme-platform' }, { cookie: 'sid=alice' });
    const cfg = JSON.parse(fs.readFileSync(path.join(a.dataDir, 'narado.json'), 'utf8'));
    assert.deepEqual(cfg.hosts.map((h) => h.id), ['github', 'gitlab', 'ghe']);
    assert.deepEqual(cfg.hosts[0].exploreNamespaces, ['acme', 'acme-platform']);
    const bad = await a.post('/admin/git/add', { id: 'x', type: 'gitlab', url: 'http://plain.example' }, { cookie: 'sid=alice' });
    assert.match(await bad.text(), /must be/);
    await a.post('/admin/git/ghe/remove', {}, { cookie: 'sid=alice' });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(a.dataDir, 'narado.json'), 'utf8')).hosts.map((h) => h.id), ['github', 'gitlab']);
  } finally {
    await a.close();
  }
});


test('secrets stores: added and changed from the admin page, credentials kept encrypted and never shown', async () => {
  const users = { alice: { id: 'alice', name: 'Alice', email: 'alice@acme.com' } };
  const a = await startAdmin({ users, env: { NARADO_ADMINS: 'alice@acme.com' } });
  const cookie = { cookie: 'sid=alice' };
  try {
    const added = await a.post('/admin/secrets/add', { type: 'aws', id: 'aws-prod', region: 'ap-south-1', cred_ACCESS_KEY_ID: 'AKIATEST', cred_SECRET_ACCESS_KEY: 'very-secret' }, cookie);
    assert.equal(added.status, 200);
    const cfg = JSON.parse(fs.readFileSync(path.join(a.dataDir, 'narado.json'), 'utf8'));
    assert.deepEqual(cfg.secrets.stores, [{ id: 'aws-prod', type: 'aws', region: 'ap-south-1' }]);
    assert.ok(!JSON.stringify(cfg).includes('very-secret'), 'credentials are not in narado.json');
    assert.equal(a.settings.get('NARADO_SECRETS_AWS_PROD_SECRET_ACCESS_KEY'), 'very-secret');
    const raw = fs.readFileSync(path.join(a.dataDir, 'narado.db'));
    assert.ok(!raw.includes('very-secret') && !raw.includes('AKIATEST'), 'credentials are encrypted');

    // Saving with the secret left empty keeps it; the page never shows it.
    await wait(400);
    await a.post('/admin/secrets/aws-prod/save', { region: 'eu-west-1', cred_ACCESS_KEY_ID: 'AKIANEW', cred_SECRET_ACCESS_KEY: '' }, cookie);
    assert.equal(a.settings.get('NARADO_SECRETS_AWS_PROD_SECRET_ACCESS_KEY'), 'very-secret');
    assert.equal(a.settings.get('NARADO_SECRETS_AWS_PROD_ACCESS_KEY_ID'), 'AKIANEW');
    await wait(400);
    const html = await (await fetch(`${a.publicUrl}/admin`, { headers: cookie })).text();
    assert.ok(!html.includes('very-secret'));
    assert.match(html, /AWS Secrets Manager/);
    assert.match(html, /region eu-west-1/);

    // A Google key that isn't a service account key is refused; a duplicate ID too.
    const badKey = await a.post('/admin/secrets/add', { type: 'gcp', id: 'gcp', project: 'acme', cred_CREDENTIALS: '{"nope":1}' }, cookie);
    assert.match(await badKey.text(), /paste the service account/);
    const dup = await a.post('/admin/secrets/add', { type: 'aws', id: 'aws-prod', region: 'x' }, cookie);
    assert.match(await dup.text(), /already a store called aws-prod/);

    // Vault signing in as each person: no credentials, a JWT role.
    await a.post('/admin/secrets/add', { type: 'vault', id: 'vault', url: 'https://vault.acme.internal/', authMethod: 'jwt', role: '' }, cookie);
    await wait(400);
    const stores = JSON.parse(fs.readFileSync(path.join(a.dataDir, 'narado.json'), 'utf8')).secrets.stores;
    assert.deepEqual(stores[1], { id: 'vault', type: 'vault', url: 'https://vault.acme.internal', auth: { method: 'jwt', role: 'narado' } });

    // Removing a store removes its access rules and credentials.
    const file = path.join(a.dataDir, 'narado.json');
    const withRule = JSON.parse(fs.readFileSync(file, 'utf8'));
    withRule.secrets.access = [{ store: 'aws-prod', paths: ['payments/*'] }, { store: 'vault', paths: ['x'] }];
    fs.writeFileSync(file, JSON.stringify(withRule));
    await a.post('/admin/secrets/aws-prod/remove', {}, cookie);
    const after = JSON.parse(fs.readFileSync(file, 'utf8')).secrets;
    assert.deepEqual(after.stores.map((x) => x.id), ['vault']);
    assert.deepEqual(after.access, [{ store: 'vault', paths: ['x'] }]);
    assert.equal(a.settings.get('NARADO_SECRETS_AWS_PROD_SECRET_ACCESS_KEY'), undefined);
  } finally {
    await a.close();
  }
});

test('secrets stores: Test connection shows a count only, and explains failures', async () => {
  const users = { alice: { id: 'alice', name: 'Alice', email: 'alice@acme.com' } };
  const dataDir = tmp();
  fs.writeFileSync(path.join(dataDir, 'narado.json'), JSON.stringify({ secrets: { stores: [{ id: 'aws', type: 'aws', region: 'x' }, { id: 'broken', type: 'aws', region: 'y' }] } }));
  const secrets = {
    stores: new Map([
      ['aws', { perPerson: false, configured: () => true, list: async () => [{ path: 'payments/stripe' }, { path: 'payments/adyen' }] }],
      ['broken', { perPerson: false, configured: () => false, list: async () => { throw new Error('needs NARADO_SECRETS_BROKEN_ACCESS_KEY_ID'); } }]
    ])
  };
  const a = await startAdmin({ users, env: { NARADO_ADMINS: 'alice@acme.com' }, dataDir, secrets });
  try {
    const ok = await (await a.post('/admin/secrets/aws/test', {}, { cookie: 'sid=alice' })).text();
    assert.match(ok, /aws answered: 2 entries at the top level/);
    assert.ok(!ok.includes('payments/stripe'), 'names are not shown');
    const bad = await (await a.post('/admin/secrets/broken/test', {}, { cookie: 'sid=alice' })).text();
    assert.match(bad, /broken didn&#39;t answer: needs NARADO_SECRETS_BROKEN_ACCESS_KEY_ID/);
    assert.match(bad, /Needs credentials/);
  } finally {
    await a.close();
  }
});

test('access rules: added, edited and deleted from the admin page, and checked like a real read', async () => {
  const users = { alice: { id: 'alice', name: 'Alice', email: 'alice@acme.com' } };
  const dataDir = tmp();
  const file = path.join(dataDir, 'narado.json');
  fs.writeFileSync(file, JSON.stringify({ secrets: { stores: [{ id: 'aws', type: 'aws', region: 'x' }, { id: 'vault', type: 'vault', url: 'https://v', auth: { method: 'jwt', role: 'narado' } }] } }));
  const a = await startAdmin({ users, env: { NARADO_ADMINS: 'alice@acme.com' }, dataDir });
  const cookie = { cookie: 'sid=alice' };
  const rules = () => JSON.parse(fs.readFileSync(file, 'utf8')).secrets.access;
  const check = async (form) => (/data-testid="check-result">([^<]*)</.exec(await (await a.post('/admin/secrets/check', form, cookie)).text())[1]).replace(/&#39;/g, "'");
  try {
    await a.post('/admin/secrets/rules/add', { store: 'aws', paths: 'payments/staging/*', repos: 'github:acme/payments-api', people: '*@acme.com' }, cookie);
    assert.deepEqual(rules(), [{ store: 'aws', paths: ['payments/staging/*'], repos: ['github:acme/payments-api'], people: ['*@acme.com'] }]);

    // Shown as a sentence.
    await wait(400);
    const html = await (await fetch(`${a.publicUrl}/admin`, { headers: cookie })).text();
    assert.match(html, /People matching <code>\*@acme\.com<\/code> may read <code>payments\/staging\/\*<\/code> from <code>aws<\/code>, from <code>github:acme\/payments-api<\/code>\./);
    assert.match(html, /<code>vault<\/code> signs in as each person/);

    // The checker answers with the same logic as a read.
    assert.match(await check({ person: 'bob@acme.com', store: 'aws', path: 'payments/staging/stripe', repo: 'github:acme/payments-api' }), /allowed, by rule 1/);
    assert.match(await check({ person: 'bob@acme.com', store: 'aws', path: 'payments/prod/stripe', repo: 'github:acme/payments-api' }), /not allowed; no rule matches/);
    assert.match(await check({ person: 'eve@other.com', store: 'aws', path: 'payments/staging/stripe', repo: 'github:acme/payments-api' }), /not allowed/);
    assert.match(await check({ person: 'bob@acme.com', store: 'aws', path: 'payments/staging/stripe' }), /outside a repository: not allowed/);
    assert.match(await check({ person: 'bob@acme.com', store: 'vault', path: 'anything' }), /left to vault's own policies/);

    // Bad patterns are refused.
    assert.match(await (await a.post('/admin/secrets/rules/add', { repos: 'acme/payments-api' }, cookie)).text(), /Repositories look like github:acme\/payments-api/);
    assert.match(await (await a.post('/admin/secrets/rules/add', { people: 'not an email' }, cookie)).text(), /isn(&#39;|')t a valid pattern/);
    assert.equal(rules().length, 1);

    // Editing: only the rule the page showed.
    const was = JSON.stringify(rules()[0]);
    assert.match(await (await a.post('/admin/secrets/rules/0/save', { was: '{"store":"other"}', store: 'aws', paths: 'x' }, cookie)).text(), /rules changed since this page was loaded/);
    await a.post('/admin/secrets/rules/0/save', { was, store: 'aws', paths: 'payments/*', people: 'alice@acme.com' }, cookie);
    assert.deepEqual(rules(), [{ store: 'aws', paths: ['payments/*'], people: ['alice@acme.com'] }]);

    // A broad rule is flagged; deleting removes it.
    await a.post('/admin/secrets/rules/add', { store: 'vault' }, cookie);
    await wait(400);
    assert.match(await (await fetch(`${a.publicUrl}/admin`, { headers: cookie })).text(), /Anyone signed in may read any secret from <code>vault<\/code>, from any repository or none\. <span class="pill warn"[^>]*>Broad/);
    await a.post('/admin/secrets/rules/1/delete', { was: JSON.stringify(rules()[1]) }, cookie);
    assert.equal(rules().length, 1);
  } finally {
    await a.close();
  }
});

test('admins: added and removed one at a time; nobody removes themselves', async () => {
  const users = { alice: { id: 'alice', name: 'Alice', email: 'alice@acme.com' } };
  const dataDir = tmp();
  new SettingsStore({ dataDir, env: {} }).set({ NARADO_ADMINS: 'alice@acme.com' }, 'test');
  const a = await startAdmin({ users, dataDir });
  const cookie = { cookie: 'sid=alice' };
  try {
    const page = await (await fetch(`${a.publicUrl}/admin`, { headers: cookie })).text();
    assert.match(page, /alice@acme\.com <span class="chip">You<\/span>/);
    assert.match(page, /action="\/admin\/admins\/add"/);
    assert.equal((await a.post('/admin/admins/add', { email: 'bob@acme.com' }, { ...cookie, origin: 'https://evil.example' })).status, 403);
    assert.match(await (await a.post('/admin/admins/add', { email: 'not an email' }, cookie)).text(), /isn’t an email address/);
    // Each change restarts narado (after 200 ms) with the new list.
    const restarted = () => new Promise((r) => setTimeout(r, 350));
    assert.equal((await a.post('/admin/admins/add', { email: 'Bob@acme.com' }, cookie)).status, 200);
    assert.equal(a.settings.get('NARADO_ADMINS'), 'alice@acme.com,bob@acme.com');
    await restarted();
    // Adding someone already listed changes nothing.
    await a.post('/admin/admins/add', { email: 'bob@acme.com' }, cookie);
    assert.equal(a.settings.get('NARADO_ADMINS'), 'alice@acme.com,bob@acme.com');
    await restarted();
    assert.match(await (await a.post('/admin/admins/remove', { email: 'alice@acme.com' }, cookie)).text(), /can&#39;t remove yourself/);
    await a.post('/admin/admins/remove', { email: 'bob@acme.com' }, cookie);
    assert.equal(a.settings.get('NARADO_ADMINS'), 'alice@acme.com');
  } finally {
    await a.close();
  }
});

test('admin console: overview, attention and centred refusals', async () => {
  const users = { alice: { id: 'alice', name: 'Alice', email: 'alice@acme.com' }, eve: { id: 'eve', name: 'Eve', email: 'eve@acme.com' } };
  const a = await startAdmin({ users, env: { NARADO_ADMINS: 'alice@acme.com' } });
  try {
    const page = await (await fetch(`${a.publicUrl}/admin`, { headers: { cookie: 'sid=alice' } })).text();
    assert.match(page, /<section id="overview">/);
    // No sign-in issuer and no Git app here: both are flagged.
    assert.match(page, /data-testid="attention"[\s\S]*Sign-in isn’t set up[\s\S]*No Git connector is set up/);
    assert.match(page, /aria-label="Account"/);
    const denied = await fetch(`${a.publicUrl}/admin`, { headers: { cookie: 'sid=eve' } });
    assert.equal(denied.status, 403);
    assert.match(await denied.text(), /<h1>Admins only<\/h1>/);
  } finally {
    await a.close();
  }
});
