const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { parseRef, findRefs, replaceRefs, Masker } = require('../src/narado/secrets/refs');
const { signV4 } = require('../src/narado/secrets/aws');
const { SecretsService, secretsService, loadSecretsConfig } = require('../src/narado/secrets');
const { Identity } = require('../src/narado/secrets/identity');
const { SecretRefs } = require('../src/narado/secrets/worker-side');
const { pickField } = require('../src/narado/secrets/common');

const quiet = { log() {}, warn() {}, error() {} };
const alice = { id: 'u-alice', name: 'Alice', email: 'alice@acme.test' };
const bob = { id: 'u-bob', name: 'Bob', email: 'bob@other.test' };

let tmp;
before(() => (tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'narado-secrets-'))));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A tiny HTTP server; `handler(req, body)` returns [status, json]. */
const fake = async (handler) => {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', async () => {
      calls.push({ method: req.method, url: req.url, headers: req.headers, body });
      const [status, json] = await handler(req, body);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => server.close() };
};

const verifyJwt = (jwt, publicKey) => {
  const [h, b, s] = jwt.split('.');
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${b}`), publicKey, Buffer.from(s, 'base64url'));
  return ok ? JSON.parse(Buffer.from(b, 'base64url').toString()) : null;
};

/* ------------------------------------------------------------------ references */

test('references parse, and only whole values count', () => {
  assert.deepEqual(parseRef('secret://vault/payments/staging#api_key'), { store: 'vault', path: 'payments/staging', field: 'api_key', ref: 'secret://vault/payments/staging#api_key' });
  assert.equal(parseRef('secret://aws/payments/key').field, null);
  for (const bad of ['secret://vault/../etc', 'secret:///x', 'secret://va ult/x', 'Bearer secret://vault/x', 'secret://vault/a//b', 'https://vault/x']) assert.equal(parseRef(bad), null, bad);
  const args = [{ variables: [{ name: 'k', value: 'secret://vault/a#b' }, { name: 'u', value: 'see secret://vault/a#b' }] }, { big: { untouched: true } }];
  assert.deepEqual([...findRefs(args)], ['secret://vault/a#b']);
  const out = replaceRefs(args, { 'secret://vault/a#b': 'VALUE' });
  assert.equal(out[0].variables[0].value, 'VALUE');
  assert.equal(out[0].variables[1].value, 'see secret://vault/a#b');
  assert.equal(out[1], args[1], 'parts without references are not copied');
  assert.equal(args[0].variables[0].value, 'secret://vault/a#b', 'the original is unchanged');
});

test('the masker turns exact values back into references and masks the rest', () => {
  const m = new Masker();
  assert.equal(m.clean('abc'), 'abc');
  m.add('sk_live_123456', 'secret://vault/stripe#key');
  m.add('abc', 'secret://vault/short'); // too short to mask safely
  const out = m.clean({
    env: [{ name: 'key', value: 'sk_live_123456' }],
    header: 'Bearer sk_live_123456',
    url: `https://x.test/?k=${encodeURIComponent('sk_live_123456')}`,
    b64: Buffer.from('sk_live_123456').toString('base64'),
    buf: Buffer.from('raw'),
    n: 5
  });
  assert.equal(out.env[0].value, 'secret://vault/stripe#key');
  assert.equal(out.header, 'Bearer ••••••');
  assert.equal(out.url, 'https://x.test/?k=••••••');
  assert.ok(!out.b64.includes(Buffer.from('sk_live_123456').toString('base64').slice(0, 16)));
  assert.ok(Buffer.isBuffer(out.buf));
  assert.equal(out.n, 5);
});

test('fields: plain text, a map with one field, "value", or #field', () => {
  assert.equal(pickField('plain', null, 'x'), 'plain');
  assert.equal(pickField({ only: 'one' }, null, 'x'), 'one');
  assert.equal(pickField({ value: 'v', other: 'o' }, null, 'x'), 'v');
  assert.equal(pickField('{"a":"1","b":"2"}', 'b', 'x'), '2');
  assert.throws(() => pickField({ a: 1, b: 2 }, null, 'x'), /several fields/);
  assert.throws(() => pickField({ a: 1 }, 'z', 'x'), /no field "z"/);
});

/* ------------------------------------------------------------------ AWS signing */

test('Signature Version 4 matches AWS\'s published example', () => {
  const h = signV4({
    method: 'GET',
    url: 'https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
    region: 'us-east-1',
    service: 'iam',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    date: new Date('2015-08-30T12:36:00Z')
  });
  assert.match(h.authorization, /Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7$/);
});

/* ------------------------------------------------------------------ backends against fakes */

test('Vault: token, AppRole and per-person JWT sign-in; KV v2 read and list', async () => {
  const identity = new Identity({ dataDir: fs.mkdtempSync(path.join(tmp, 'id-')), issuer: 'http://narado.test' });
  const kv = { 'payments/staging': { api_key: 'vault-key-1', user: 'svc' }, 'payments/prod': { value: 'prod-key' } };
  const vault = await fake((req, body) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/v1/auth/approle/login') {
      const b = JSON.parse(body);
      return b.role_id === 'role' && b.secret_id === 'sid' ? [200, { auth: { client_token: 'approle-token', lease_duration: 600 } }] : [400, { errors: ['invalid role or secret ID'] }];
    }
    if (url.pathname === '/v1/auth/jwt/login') {
      const b = JSON.parse(body);
      const claims = verifyJwt(b.jwt, identity.publicKey);
      if (!claims || claims.aud !== 'vault' || b.role !== 'narado') return [400, { errors: ['bad jwt'] }];
      return [200, { auth: { client_token: `person-${claims.email}`, lease_duration: 600 } }];
    }
    const token = req.headers['x-vault-token'];
    if (!['root', 'approle-token', 'person-alice@acme.test', 'person-bob@other.test'].includes(token)) return [403, { errors: ['permission denied'] }];
    // Vault's own policy: bob may not read prod.
    if (url.pathname.startsWith('/v1/secret/data/')) {
      const p = decodeURIComponent(url.pathname.slice('/v1/secret/data/'.length));
      if (token === 'person-bob@other.test' && p.includes('prod')) return [403, { errors: ['permission denied'] }];
      return kv[p] ? [200, { data: { data: kv[p] } }] : [404, { errors: [] }];
    }
    if (url.pathname.startsWith('/v1/secret/metadata/') && url.searchParams.get('list') === 'true') {
      return [200, { data: { keys: ['staging', 'prod', 'cards/'] } }];
    }
    return [404, { errors: [] }];
  });
  try {
    const cfg = (auth) => ({ stores: [{ id: 'vault', type: 'vault', url: vault.url, auth }], access: [{ store: 'vault', paths: ['payments/*'] }] });
    const tokenSvc = new SecretsService({ config: cfg({ method: 'token' }), env: { NARADO_SECRETS_VAULT_TOKEN: 'root' }, log: quiet });
    assert.deepEqual((await tokenSvc.resolve(alice, ['secret://vault/payments/staging#api_key'])).values, { 'secret://vault/payments/staging#api_key': 'vault-key-1' });
    assert.match((await tokenSvc.resolve(alice, ['secret://vault/payments/staging'])).errors['secret://vault/payments/staging'], /several fields/);
    assert.equal((await tokenSvc.resolve(alice, ['secret://vault/payments/prod'])).values['secret://vault/payments/prod'], 'prod-key');
    assert.match((await tokenSvc.resolve(alice, ['secret://vault/payments/none'])).errors['secret://vault/payments/none'], /No secret/);
    assert.deepEqual((await tokenSvc.list(alice, 'vault', 'payments')).map((e) => e.path), ['payments/staging', 'payments/prod', 'payments/cards']);

    const approle = new SecretsService({ config: cfg({ method: 'approle' }), env: { NARADO_SECRETS_VAULT_ROLE_ID: 'role', NARADO_SECRETS_VAULT_SECRET_ID: 'sid' }, log: quiet });
    assert.equal((await approle.resolve(alice, ['secret://vault/payments/prod'])).values['secret://vault/payments/prod'], 'prod-key');
    const wrong = new SecretsService({ config: cfg({ method: 'approle' }), env: { NARADO_SECRETS_VAULT_ROLE_ID: 'role', NARADO_SECRETS_VAULT_SECRET_ID: 'nope' }, log: quiet });
    assert.match((await wrong.resolve(alice, ['secret://vault/payments/prod'])).errors['secret://vault/payments/prod'], /sign-in .* failed: invalid role/);

    // Per person: Vault's policies decide, so bob is refused prod and alice is not.
    const jwtCfg = { stores: [{ id: 'vault', type: 'vault', url: vault.url, auth: { method: 'jwt', role: 'narado' } }], access: [] };
    const perPerson = new SecretsService({ config: jwtCfg, env: {}, identity, log: quiet });
    assert.equal((await perPerson.resolve(alice, ['secret://vault/payments/prod'])).values['secret://vault/payments/prod'], 'prod-key');
    assert.match((await perPerson.resolve(bob, ['secret://vault/payments/prod'])).errors['secret://vault/payments/prod'], /refused access/);
    assert.equal((await perPerson.resolve(bob, ['secret://vault/payments/staging#user'])).values['secret://vault/payments/staging#user'], 'svc');
    assert.match((await perPerson.resolve(null, ['secret://vault/payments/prod'])).errors['secret://vault/payments/prod'], /sign in first/);
    // Alice once; Bob twice, because a refusal (403: a bad token or a policy) drops his cached sign-in.
    assert.equal(vault.calls.filter((c) => c.url === '/v1/auth/jwt/login').length, 3);
  } finally {
    vault.close();
  }
});

test('AWS Secrets Manager: signed calls, JSON fields and listing', async () => {
  const env = { NARADO_SECRETS_AWS_ACCESS_KEY_ID: 'AKIATEST', NARADO_SECRETS_AWS_SECRET_ACCESS_KEY: 'aws-secret', NARADO_SECRETS_AWS_SESSION_TOKEN: 'sess' };
  const secrets = { 'payments/staging-key': '{"key":"aws-value","id":"x"}', 'payments/plain': 'plain-aws' };
  const aws = await fake((req, body) => {
    // Check the signature the way AWS does, from the request as received.
    const date = req.headers['x-amz-date'];
    const expect = signV4({
      method: 'POST',
      url: `http://${req.headers.host}${req.url}`,
      headers: { 'content-type': req.headers['content-type'], 'x-amz-target': req.headers['x-amz-target'] },
      body,
      region: 'ap-south-1',
      service: 'secretsmanager',
      accessKeyId: 'AKIATEST',
      secretAccessKey: 'aws-secret',
      sessionToken: req.headers['x-amz-security-token'],
      date: new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`)
    });
    if (req.headers.authorization !== expect.authorization) return [403, { __type: 'InvalidSignatureException', message: 'signature mismatch' }];
    const b = JSON.parse(body);
    if (req.headers['x-amz-target'] === 'secretsmanager.GetSecretValue') {
      return secrets[b.SecretId] ? [200, { Name: b.SecretId, SecretString: secrets[b.SecretId] }] : [400, { __type: 'ResourceNotFoundException', message: 'not found' }];
    }
    if (req.headers['x-amz-target'] === 'secretsmanager.ListSecrets') {
      const all = Object.keys(secrets).map((Name) => ({ Name }));
      return b.NextToken ? [200, { SecretList: all.slice(1) }] : [200, { SecretList: all.slice(0, 1), NextToken: 'p2' }];
    }
    return [400, { __type: 'UnknownOperationException' }];
  });
  try {
    const svc = new SecretsService({ config: { stores: [{ id: 'aws', type: 'aws', region: 'ap-south-1', endpoint: aws.url }], access: [{ paths: ['payments/*'] }] }, env, log: quiet });
    const { values, errors } = await svc.resolve(alice, ['secret://aws/payments/staging-key#key', 'secret://aws/payments/plain', 'secret://aws/payments/missing']);
    assert.equal(values['secret://aws/payments/staging-key#key'], 'aws-value');
    assert.equal(values['secret://aws/payments/plain'], 'plain-aws');
    assert.match(errors['secret://aws/payments/missing'], /No secret/);
    assert.deepEqual((await svc.list(alice, 'aws', 'payments/')).map((e) => e.name), ['payments/staging-key', 'payments/plain']);
    assert.equal(aws.calls[0].headers['x-amz-security-token'], 'sess');

    const bad = new SecretsService({ config: { stores: [{ id: 'aws', type: 'aws', region: 'ap-south-1', endpoint: aws.url }], access: [{}] }, env: { ...env, NARADO_SECRETS_AWS_SECRET_ACCESS_KEY: 'wrong' }, log: quiet });
    assert.match((await bad.resolve(alice, ['secret://aws/payments/plain'])).errors['secret://aws/payments/plain'], /refused access|InvalidSignature/);
  } finally {
    aws.close();
  }
});

test('Google Secret Manager: service account sign-in, versions and fields', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  let tokenUrl;
  const gcp = await fake((req, body) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/token') {
      const assertion = new URLSearchParams(body).get('assertion');
      const claims = verifyJwt(assertion, publicKey);
      if (!claims || claims.iss !== 'narado@acme.iam.gserviceaccount.com' || claims.aud !== tokenUrl) return [400, { error: 'invalid_grant' }];
      return [200, { access_token: 'gcp-token', expires_in: 3600 }];
    }
    if (req.headers.authorization !== 'Bearer gcp-token') return [401, { error: { message: 'unauthenticated' } }];
    const m = /^\/v1\/projects\/acme\/secrets\/([^/]+)\/versions\/([^:]+):access$/.exec(url.pathname);
    if (m) {
      const data = { 'stripe-key': { latest: 'gcp-latest', 3: 'gcp-v3' }, 'db-creds': { latest: '{"password":"pw-1"}' } }[m[1]];
      return data && data[m[2]] ? [200, { payload: { data: Buffer.from(data[m[2]]).toString('base64') } }] : [404, { error: { message: 'NOT_FOUND' } }];
    }
    if (url.pathname === '/v1/projects/acme/secrets') return [200, { secrets: [{ name: 'projects/acme/secrets/stripe-key' }, { name: 'projects/acme/secrets/db-creds' }] }];
    return [404, { error: { message: 'no' } }];
  });
  tokenUrl = `${gcp.url}/token`;
  try {
    const key = { client_email: 'narado@acme.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: tokenUrl };
    const svc = new SecretsService({ config: { stores: [{ id: 'gcp', type: 'gcp', project: 'acme', endpoint: gcp.url }], access: [{ store: 'gcp' }] }, env: { NARADO_SECRETS_GCP_CREDENTIALS: JSON.stringify(key) }, log: quiet });
    const { values } = await svc.resolve(alice, ['secret://gcp/stripe-key', 'secret://gcp/stripe-key@3', 'secret://gcp/db-creds#password']);
    assert.deepEqual(values, { 'secret://gcp/stripe-key': 'gcp-latest', 'secret://gcp/stripe-key@3': 'gcp-v3', 'secret://gcp/db-creds#password': 'pw-1' });
    assert.deepEqual((await svc.list(alice, 'gcp', 'stripe')).map((e) => e.name), ['stripe-key']);
    assert.equal(gcp.calls.filter((c) => c.url === '/token').length, 1, 'the access token is reused');
  } finally {
    gcp.close();
  }
});

test('Azure Key Vault: client credentials, versions and paging on the vault only', async () => {
  let base;
  const az = await fake((req, body) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/tenant-1/oauth2/v2.0/token') {
      const f = new URLSearchParams(body);
      return f.get('client_secret') === 'az-secret' && f.get('scope') === 'https://vault.azure.net/.default' ? [200, { access_token: 'az-token', expires_in: 3600 }] : [401, { error: 'invalid_client' }];
    }
    if (req.headers.authorization !== 'Bearer az-token') return [401, { error: { message: 'unauthorized' } }];
    if (url.pathname === '/secrets/stripe-key') return [200, { value: 'az-latest' }];
    if (url.pathname === '/secrets/stripe-key/v2') return [200, { value: 'az-v2' }];
    if (url.pathname === '/secrets' && !url.searchParams.get('page')) return [200, { value: [{ id: `${base}/secrets/stripe-key` }], nextLink: `${base}/secrets?api-version=7.4&page=2` }];
    if (url.pathname === '/secrets') return [200, { value: [{ id: `${base}/secrets/other` }], nextLink: 'http://elsewhere.test/secrets' }];
    return [404, { error: { message: 'SecretNotFound' } }];
  });
  base = az.url;
  try {
    const store = { id: 'azure', type: 'azure', vaultUrl: az.url, tenant: 'tenant-1', authority: az.url };
    const env = { NARADO_SECRETS_AZURE_CLIENT_ID: 'app', NARADO_SECRETS_AZURE_CLIENT_SECRET: 'az-secret' };
    const svc = new SecretsService({ config: { stores: [store], access: [{ store: 'azure' }] }, env, log: quiet });
    const { values, errors } = await svc.resolve(alice, ['secret://azure/stripe-key', 'secret://azure/stripe-key@v2', 'secret://azure/missing', 'secret://azure/bad_name']);
    assert.equal(values['secret://azure/stripe-key'], 'az-latest');
    assert.equal(values['secret://azure/stripe-key@v2'], 'az-v2');
    assert.match(errors['secret://azure/missing'], /Not found/);
    assert.match(errors['secret://azure/bad_name'], /letters, digits/);
    assert.deepEqual((await svc.list(alice, 'azure', '')).map((e) => e.name), ['stripe-key', 'other']);
    assert.ok(!az.calls.some((c) => c.headers.host === 'elsewhere.test'));
  } finally {
    az.close();
  }
});

/* ------------------------------------------------------------------ access rules */

test('service-identity stores only give out what an access rule allows', async () => {
  const reads = [];
  const store = { id: 's', perPerson: false, configured: () => true, read: async (p) => (reads.push(p.path), `v:${p.path}`), list: async () => [{ name: 'a', path: 'payments/a' }, { name: 'b', path: 'cards/b' }, { name: 'payments', path: 'payments', folder: true }, { name: 'hr', path: 'hr', folder: true }] };
  const svc = new SecretsService({ config: { stores: [], access: [] }, env: {}, log: quiet });
  svc.stores.set('s', store);
  svc.types.set('s', 'fake');
  const ctx = { hostId: 'github', repoPath: 'acme/payments-api' };

  // No rules: nothing.
  assert.match((await svc.resolve(alice, ['secret://s/payments/a'], ctx)).errors['secret://s/payments/a'], /may not use/);
  assert.equal(reads.length, 0, 'the store is not even asked');

  svc.access = [{ store: 's', paths: ['payments/*'], repos: ['github:acme/payments-*'], people: ['*@acme.test'] }];
  assert.equal((await svc.resolve(alice, ['secret://s/payments/a'], ctx)).values['secret://s/payments/a'], 'v:payments/a');
  assert.ok((await svc.resolve(bob, ['secret://s/payments/a'], ctx)).errors['secret://s/payments/a'], 'other people are refused');
  assert.ok((await svc.resolve(alice, ['secret://s/cards/b'], ctx)).errors['secret://s/cards/b'], 'other paths are refused');
  assert.ok((await svc.resolve(alice, ['secret://s/payments/a'], { hostId: 'github', repoPath: 'acme/hr' })).errors['secret://s/payments/a'], 'other repos are refused');
  assert.ok((await svc.resolve(alice, ['secret://s/payments/a'], {})).errors['secret://s/payments/a'], 'collections outside a repo are refused');
  assert.ok((await svc.resolve(alice, ['secret://nope/x'], ctx)).errors['secret://nope/x'].includes('No secrets store'));
  assert.deepEqual((await svc.list(alice, 's', '', ctx)).map((e) => e.path), ['payments/a', 'payments']);
  assert.deepEqual(await svc.list(bob, 's', '', ctx), []);

  // Cached for a short while, but the rules are checked every time.
  const before = reads.length;
  await svc.resolve(alice, ['secret://s/payments/a'], ctx);
  assert.equal(reads.length, before);
  assert.ok((await svc.resolve(bob, ['secret://s/payments/a'], ctx)).errors['secret://s/payments/a']);

  // The worker-facing calls: the person comes from the front, never from the worker.
  const calls = secretsService(svc);
  assert.equal((await calls(alice, 'secrets.check', ['secret://s/payments/a', ctx])).ok, true);
  assert.equal((await calls(alice, 'secrets.check', ['secret://s/payments/a', ctx])).value, undefined, 'check never returns the value');
  await assert.rejects(calls(alice, 'secrets.resolve', ['secret://s/payments/a', ctx]), /list of references/);
  await assert.rejects(calls(alice, 'secrets.dump', []), /Unknown call/);
});

test('narado.json: stores are checked and credentials refused', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'cfg-'));
  const write = (o) => fs.writeFileSync(path.join(dir, 'narado.json'), JSON.stringify(o));
  write({ secrets: { stores: [{ id: 'vault', type: 'vault', url: 'http://v', auth: { method: 'token', token: 'x' } }] } });
  assert.throws(() => loadSecretsConfig(dir), /environment variables/);
  write({ secrets: { stores: [{ id: 'v', type: 'keepass' }] } });
  assert.throws(() => loadSecretsConfig(dir), /type/);
  write({ secrets: { stores: [{ id: 'v', type: 'vault', url: 'http://v' }], access: [{ store: 'w' }] } });
  assert.throws(() => loadSecretsConfig(dir), /unknown store "w"/);
  write({ secrets: { stores: [{ id: 'v', type: 'vault', url: 'http://v' }] } });
  assert.equal(loadSecretsConfig(dir).stores.length, 1);
  // Hosts still default when narado.json only configures secrets.
  const { ProviderRegistry } = require('../src/narado/providers');
  assert.deepEqual(new ProviderRegistry({ dataDir: dir, env: {} }).listHosts().map((h) => h.id), ['github', 'gitlab']);
});

test("narado's signing key: published as a JWKS, and tokens name the person", () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'id-'));
  const id = new Identity({ dataDir: dir, issuer: 'http://narado.test' });
  const again = new Identity({ dataDir: dir, issuer: 'http://narado.test' });
  assert.equal(again.kid, id.kid, 'the key is kept');
  assert.equal(fs.statSync(path.join(dir, 'narado-identity-key.pem')).mode & 0o777, 0o600);
  const jwk = id.jwks().keys[0];
  assert.equal(jwk.d, undefined, 'no private parts');
  const claims = verifyJwt(id.sign(alice, { audience: 'vault' }), crypto.createPublicKey({ key: jwk, format: 'jwk' }));
  assert.equal(claims.sub, 'u-alice');
  assert.equal(claims.email, 'alice@acme.test');
  assert.equal(claims.iss, 'http://narado.test');
  assert.ok(claims.exp - claims.iat <= 120);
});

/* ------------------------------------------------------------------ in the worker */

test('send handlers get values; saving and other handlers keep references; replies are cleaned', async () => {
  const handlers = new Map();
  const ipcMain = { getHandler: (c) => handlers.get(c), removeHandler: (c) => handlers.delete(c), handle: (c, fn) => handlers.set(c, fn) };
  const seen = {};
  handlers.set('send-http-request', async (_e, item, collection, environment) => {
    seen.send = environment.variables[0].value;
    return { headers: { authorization: `Bearer ${environment.variables[0].value}` }, env: environment };
  });
  handlers.set('renderer:save-environment', async (_e, _path, environment) => (seen.save = environment.variables[0].value));
  const asked = [];
  const front = {
    resolve: async (refs, ctx) => (asked.push({ refs, ctx }), refs.includes('secret://vault/denied') ? { values: {}, errors: { 'secret://vault/denied': 'You may not use vault/denied' } } : { values: { 'secret://vault/pay#key': 'live-value-123' }, errors: {} }),
    stores: async () => [],
    list: async () => [],
    check: async () => ({ ok: true })
  };
  const workspaces = { locate: (p) => (p.startsWith('/w/') ? { hostId: 'github', repoPath: 'acme/payments' } : null) };
  const refs = new SecretRefs({ secrets: front, workspaces });
  refs.install(ipcMain);

  const collection = { uid: 'c1', pathname: '/w/github/acme/payments/worktrees/main', items: [] };
  const env = { name: 'Staging', variables: [{ name: 'key', value: 'secret://vault/pay#key', enabled: true }] };
  const res = await handlers.get('send-http-request')({}, { uid: 'r1' }, collection, env, {});
  assert.equal(seen.send, 'live-value-123');
  assert.deepEqual(asked[0].ctx, { hostId: 'github', repoPath: 'acme/payments' });
  assert.equal(env.variables[0].value, 'secret://vault/pay#key', "the browser's copy is not changed");
  const back = refs.clean(res);
  assert.equal(back.headers.authorization, 'Bearer ••••••');
  assert.equal(back.env.variables[0].value, 'secret://vault/pay#key', 'an echoed environment keeps the reference');

  await handlers.get('renderer:save-environment')({}, '/w/x', env);
  assert.equal(seen.save, 'secret://vault/pay#key', 'saving never resolves');

  await assert.rejects(
    handlers.get('send-http-request')({}, {}, collection, { variables: [{ value: 'secret://vault/denied' }] }),
    /Could not use a secret: secret:\/\/vault\/denied: You may not use/
  );
  assert.ok(handlers.has('narado:secrets:list'));
});

test('reveal: the same access rules as a send, recorded, and can be turned off', async () => {
  const lines = [];
  const log = { log: (l) => lines.push(l), warn() {}, error() {} };
  const svc = new SecretsService({ dataDir: tmp, env: {}, log, config: { stores: [], access: [] } });
  svc.readOne = async (user, ref) => {
    if (user.id !== 'u-alice') throw Object.assign(new Error('You may not use vault/prod/payments'), { status: 403 });
    return 'sk_live_123';
  };
  assert.deepEqual(await svc.reveal(alice, 'secret://vault/prod/payments#key', { hostId: 'github', repoPath: 'acme/api' }), { value: 'sk_live_123' });
  await assert.rejects(svc.reveal(bob, 'secret://vault/prod/payments#key', {}), /may not use/);
  assert.ok(lines.some((l) => /secret secret:\/\/vault\/prod\/payments#key for alice@acme.test in github:acme\/api: revealed/.test(l)));
  assert.ok(lines.some((l) => /for bob@other.test: reveal refused \(403\)/.test(l)));
  assert.ok(!lines.some((l) => l.includes('sk_live_123')), 'the value is never logged');

  const off = new SecretsService({ dataDir: tmp, env: { NARADO_SECRETS_REVEAL: '0' }, log, config: { stores: [], access: [] } });
  off.readOne = svc.readOne;
  await assert.rejects(off.reveal(alice, 'secret://vault/prod/payments#key', {}), /turned off/);

  // Workers ask for it as their own person only.
  const calls = secretsService(svc);
  assert.deepEqual(await calls(alice, 'secrets.reveal', ['secret://vault/prod/payments#key', { hostId: 'github', repoPath: 'acme/api' }]), { value: 'sk_live_123' });
});
