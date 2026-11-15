const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Catalogue, collectionsInTree, shapeOf } = require('../src/narado/catalogue');
const { codeownersCovers } = require('../src/narado/requests/allowlist');

const quiet = { log() {}, warn() {}, error() {} };

test('collections are found anywhere in a code repository, skipping copies and nested parts', () => {
  const found = collectionsInTree([
    'README.md',
    'src/main.go',
    'services/payments/api/openapi.yaml',
    'services/payments/api/.client/requests/listPayments.yml',
    'services/orders/api/openapi.json',
    'services/orders/api/openapi.yml', // .yml wins over .json, as when opening
    'tools/postman-export/bruno.json',
    'tools/postman-export/sub/bruno.json', // a folder of the collection above
    'tools/postman-export/sub/openapi.yaml',
    'node_modules/some-lib/openapi.yaml',
    'web/dist/openapi.yaml',
    '.github/openapi.yaml'
  ]);
  assert.deepEqual(
    found.map((c) => [c.dir, c.kind, c.file]),
    [
      ['services/orders/api', 'openapi', 'services/orders/api/openapi.yml'],
      ['tools/postman-export', 'bruno', 'tools/postman-export/bruno.json'],
      ['services/payments/api', 'openapi', 'services/payments/api/openapi.yaml']
    ]
  );
  assert.equal(shapeOf(found), 'code+api');
  assert.equal(shapeOf(collectionsInTree(['openapi.yaml', '.client/requests/a.yml'])), 'api');
});

test('.narado/config.nar marks a collection first, whatever the spec is called', () => {
  const found = collectionsInTree([
    'svc/api/payments-v2.yaml',
    'svc/api/.narado/config.nar',
    'svc/api/.narado/requests/listPayments.yml',
    'tools/both/.narado/config.nar', // config wins over a Bruno marker in the same folder
    'tools/both/bruno.json',
    'node_modules/x/.narado/config.nar',
    'legacy/openapi.json',
    'legacy/.client/requests/a.yml'
  ]);
  assert.deepEqual(
    found.map((c) => [c.dir, c.kind, c.file, c.config]),
    [
      ['legacy', 'openapi', 'legacy/openapi.json', false],
      ['svc/api', 'openapi', 'svc/api/.narado/config.nar', true],
      ['tools/both', 'openapi', 'tools/both/.narado/config.nar', true]
    ]
  );
  assert.equal(shapeOf(collectionsInTree(['src/index.js'])), 'none');
});

/** A provider double: repos with file lists and file contents. */
const fakeProvider = (repos) => {
  const calls = { list: 0, files: [], read: [] };
  return {
    calls,
    name: 'GitHub',
    listRepos: async () => {
      calls.list++;
      return repos.map((r) => ({ path: r.path, name: r.path.split('/')[1], defaultBranch: 'main', updatedAt: r.updatedAt, access: 'write', private: true }));
    },
    listFiles: async (repoPath) => {
      calls.files.push(repoPath);
      const r = repos.find((x) => x.path === repoPath);
      if (r.fail) throw Object.assign(new Error(r.fail.message), { status: r.fail.status });
      return { files: Object.keys(r.files), truncated: false };
    },
    readFile: async (repoPath, ref, f) => {
      calls.read.push(`${repoPath}:${f}`);
      return repos.find((x) => x.path === repoPath).files[f];
    }
  };
};

test('the catalogue names collections, hides repos without any, and only rereads repos that changed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'narado-cat-'));
  const repos = [
    { path: 'acme/payments-service', updatedAt: '2026-11-10', files: { 'cmd/main.go': '', 'api/openapi.yaml': 'openapi: 3.1.0\ninfo:\n  title: Payments API\n  version: 1\n' } },
    { path: 'acme/partner-collection', updatedAt: '2026-11-12', files: { 'bruno.json': '{"name":"Partner APIs","version":"1"}', 'Get partner.bru': '' } },
    { path: 'acme/website', updatedAt: '2026-11-11', files: { 'index.html': '' } },
    {
      path: 'acme/orders-service',
      updatedAt: '2026-11-09',
      files: {
        'main.go': '',
        'api/orders.yaml': 'openapi: 3.1.0\ninfo: {title: Orders spec, version: 1}\npaths: {}\n',
        'api/.narado/config.nar': 'version: 1\nspec: orders.yaml\n',
        'broken/.narado/config.nar': 'version: 1\nname: Broken\nspec: missing.yaml\n'
      }
    },
    { path: 'acme/empty', updatedAt: '2026-11-01', fail: { status: 409, message: 'Git Repository is empty.' } }
  ];
  const provider = fakeProvider(repos);
  const cat = new Catalogue({ registry: { get: () => provider }, dataDir: dir, log: quiet });

  await cat.scan('github').promise;
  const got = cat.get('github');
  assert.equal(got.scanning, false);
  assert.deepEqual(
    got.repos.map((r) => [r.path, r.shape, r.collections.map((c) => `${c.name}@${c.dir}`)]),
    [
      ['acme/partner-collection', 'api', ['Partner APIs@']],
      ['acme/payments-service', 'code+api', ['Payments API@api']],
      ['acme/orders-service', 'code+api', ['Orders spec@api', 'Broken@broken']]
    ]
  );
  const orders = got.repos.find((r) => r.path === 'acme/orders-service').collections;
  assert.equal(orders[0].spec, 'api/orders.yaml');
  assert.match(orders[1].problem, /missing\.yaml/);
  assert.equal(got.withoutCollections, 2);

  // Same pushes: nothing is read again, even after a restart (the cache is on disk).
  const again = new Catalogue({ registry: { get: () => provider }, dataDir: dir, log: quiet });
  await again.scan('github').promise;
  assert.equal(provider.calls.files.length, 5);
  // A push to one repo: only that one is read again.
  repos[0].updatedAt = '2026-11-15';
  await again.scan('github').promise;
  assert.deepEqual(provider.calls.files.slice(5), ['acme/payments-service']);
});

test('the catalogue stops politely when the host rate-limits, and keeps what it found', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'narado-cat-'));
  const repos = [{ path: 'acme/a', updatedAt: '1', fail: { status: 403, message: 'API rate limit exceeded' } }];
  for (let i = 0; i < 20; i++) repos.push({ path: `acme/r${i}`, updatedAt: '1', files: { 'openapi.yaml': 'info: {title: R}' } });
  const provider = fakeProvider(repos);
  const cat = new Catalogue({ registry: { get: () => provider }, dataDir: dir, concurrency: 1, log: quiet });
  await cat.scan('github').promise;
  const got = cat.get('github');
  assert.match(got.errors[0], /slow down/);
  assert.equal(provider.calls.files.length, 1, 'no more calls after the limit');
  assert.equal(got.notYetScanned, 21);
});

test('CODEOWNERS coverage is checked for allowlists next to collections too', () => {
  const nested = 'services/payments/api/.client/allowed-hosts.yml';
  assert.equal(codeownersCovers('.client/ @acme/api-owners\n', nested), true, 'a directory pattern without a leading slash matches at any depth');
  assert.equal(codeownersCovers('/.client/ @acme/api-owners\n', nested), false, 'a leading slash means the root only');
  assert.equal(codeownersCovers('services/payments/ @acme/payments\n', nested), true);
  assert.equal(codeownersCovers('*.yml @acme/yaml\nservices/payments/api/.client/allowed-hosts.yml\n', nested), false, 'the last match wins, and it has no owner');
});
