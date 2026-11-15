const { test } = require('node:test');
const assert = require('node:assert/strict');
const { RepoBindings } = require('../src/narado/secrets/bindings');
const { SecretsService } = require('../src/narado/secrets');

const quiet = { log() {}, warn() {}, error() {} };

/** A host with a repository whose default branch is main; files per branch. */
const fakeHost = (branches) => ({
  getRepo: async () => ({ defaultBranch: 'main' }),
  listFiles: async (_repo, ref) => ({ files: Object.keys(branches[ref] || {}) }),
  readFile: async (_repo, ref, file) => branches[ref][file]
});

const host = fakeHost({
  main: {
    'payments-api/environments/staging.bru': 'vars {\n  baseUrl: https://staging.acme.com\n  api_key: secret://svc/payments/staging#stripe\n}\n',
    'payments-api/environments/prod.bru': 'vars {\n  api_key: secret://svc/payments/prod#stripe\n}\n',
    'orders/.narado/environments/dev.yml': 'variables:\n  - name: token\n    value: secret://person/orders/dev\n',
    'payments-api/requests/charge.bru': 'headers {\n  x: secret://svc/not-an-environment\n}\n'
  },
  'feature/sneaky': { 'payments-api/environments/staging.bru': 'vars {\n  k: secret://svc/everything/else\n}\n' }
});

test("bound secrets: exactly those the default branch's environments reference", async () => {
  const b = new RepoBindings({ providerFor: () => host, log: quiet });
  const bound = await b.forRepo({ id: 'alice' }, 'github', 'acme/payments');
  assert.deepEqual(bound.map((x) => x.ref), ['secret://person/orders/dev', 'secret://svc/payments/prod', 'secret://svc/payments/staging']);
  assert.deepEqual(bound.find((x) => x.ref === 'secret://svc/payments/staging').environments, [{ name: 'staging', file: 'payments-api/environments/staging.bru' }]);
});

test('reads: a bound secret is allowed without a rule, for service-identity stores, in its repository only', async () => {
  const stores = {
    svc: class {
      constructor(c) {
        this.id = c.id;
      }
      get perPerson() {
        return false;
      }
      configured() {
        return true;
      }
      async read({ path }) {
        return `value:${path}`;
      }
      async list() {
        return [{ path: 'payments/staging' }, { path: 'payments/prod' }, { path: 'cards/visa' }];
      }
    }
  };
  stores.person = class extends stores.svc {
    get perPerson() {
      return true;
    }
    async read({ path }, { user }) {
      if (!user) throw new Error('no person');
      return `person:${path}`;
    }
  };
  const repoBindings = new RepoBindings({ providerFor: () => host, log: quiet });
  const service = new SecretsService({
    config: { stores: [{ id: 'svc', type: 'aws', region: 'x' }, { id: 'person', type: 'vault', url: 'https://v', auth: { method: 'jwt', role: 'narado' } }], access: [] },
    bindings: (user, ctx) => repoBindings.forRepo(user, ctx.hostId, ctx.repoPath),
    log: quiet,
    cacheSeconds: 0
  });
  // Swap in the fake store types.
  service.stores = new Map([
    ['svc', new stores.svc({ id: 'svc' })],
    ['person', new stores.person({ id: 'person' })]
  ]);
  const alice = { id: 'alice', email: 'alice@acme.com' };
  const repo = { hostId: 'github', repoPath: 'acme/payments' };

  const ok = await service.resolve(alice, ['secret://svc/payments/staging#stripe'], repo);
  assert.equal(ok.values['secret://svc/payments/staging#stripe'], 'value:payments/staging');
  // Not referenced by an environment (a request file and another branch don't count).
  const no = await service.resolve(alice, ['secret://svc/not-an-environment', 'secret://svc/everything/else', 'secret://svc/cards/visa'], repo);
  assert.deepEqual(Object.keys(no.values), []);
  assert.match(no.errors['secret://svc/cards/visa'], /bind it in an environment of the repository|access rule/);
  // Without a repository (or one the front couldn't confirm the person reads), nothing is bound.
  assert.deepEqual(Object.keys((await service.resolve(alice, ['secret://svc/payments/staging'], {})).values), []);
  // Browsing shows only what's bound.
  assert.deepEqual((await service.list(alice, 'svc', '', repo)).map((e) => e.path), ['payments/staging', 'payments/prod']);
  // A per-person store isn't opened by binding: with no rule naming it, it decides itself
  // (here it allows, as the person).
  assert.equal((await service.resolve(alice, ['secret://person/orders/dev'], repo)).values['secret://person/orders/dev'], 'person:orders/dev');
});
