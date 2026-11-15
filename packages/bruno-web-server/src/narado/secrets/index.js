/**
 * Secrets stores (Phase 4e). Runs in the front only: store credentials never reach a worker.
 *
 * Configured in `<data dir>/narado.json`:
 *
 *   "secrets": {
 *     "stores": [
 *       { "id": "vault", "type": "vault", "url": "https://vault.acme.internal", "auth": { "method": "jwt", "role": "narado" } },
 *       { "id": "aws",   "type": "aws",   "region": "ap-south-1" }
 *     ],
 *     "access": [
 *       { "store": "aws", "paths": ["payments/staging/*"], "repos": ["github:acme/payments-api"], "people": ["*@acme.com"] }
 *     ]
 *   }
 *
 * Who may read what:
 *   - Stores that sign in as the person (Vault with "jwt") apply their own policies.
 *   - Stores that use a service identity (tokens, AppRole, cloud credentials) only give out
 *     paths an "access" rule allows. A rule matches when every condition it names holds:
 *     the store, a path pattern (`*` matches anything), the workspace's repo
 *     (`<host id>:<owner>/<repo>`) and the person's email or user id. Without a rule, nothing.
 *   - Rules naming a per-person store narrow it further.
 *
 * Every read is logged with the person, store, path and outcome, never the value.
 */
const fs = require('node:fs');
const path = require('node:path');
const { parseRef } = require('./refs');
const { SecretError } = require('./common');
const { VaultStore } = require('./vault');
const { AwsSecretsStore } = require('./aws');
const { GcpSecretsStore } = require('./gcp');
const { AzureKeyVaultStore } = require('./azure');

const TYPES = { vault: VaultStore, aws: AwsSecretsStore, gcp: GcpSecretsStore, azure: AzureKeyVaultStore };
const STORE_ID_RE = /^[A-Za-z0-9_-]+$/;

const loadSecretsConfig = (dataDir) => {
  const file = path.join(dataDir, 'narado.json');
  if (!fs.existsSync(file)) return { stores: [], access: [] };
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cfg = parsed.secrets || {};
  const stores = cfg.stores || [];
  const access = cfg.access || [];
  if (!Array.isArray(stores) || !Array.isArray(access)) throw new Error(`${file}: "secrets.stores" and "secrets.access" must be arrays`);
  const ids = new Set();
  for (const s of stores) {
    if (!s.id || !STORE_ID_RE.test(s.id) || !TYPES[s.type]) throw new Error(`${file}: each secrets store needs an "id" (letters, digits, - and _) and a "type" of ${Object.keys(TYPES).join(', ')}`);
    if (ids.has(s.id)) throw new Error(`${file}: secrets store "${s.id}" is listed twice`);
    ids.add(s.id);
    for (const k of ['token', 'secret', 'password', 'secretId', 'clientSecret', 'secretAccessKey', 'credentials']) {
      if (k in s || (s.auth && k in s.auth)) throw new Error(`${file}: secrets store "${s.id}": credentials must come from environment variables, not this file`);
    }
  }
  for (const r of access) {
    if (r.store && !ids.has(r.store)) throw new Error(`${file}: an access rule names unknown store "${r.store}"`);
    for (const k of ['paths', 'repos', 'people']) if (k in r && !Array.isArray(r[k])) throw new Error(`${file}: access rule "${k}" must be an array`);
  }
  return { stores, access };
};

const globRe = (pattern) => new RegExp(`^${String(pattern).split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
const matchesAny = (patterns, value) => value != null && patterns.some((p) => globRe(p).test(value));

class SecretsService {
  constructor({ dataDir, env = process.env, fetchImpl, identity = null, cacheSeconds, log = console, config } = {}) {
    const cfg = config || loadSecretsConfig(dataDir);
    this.identity = identity;
    this.stores = new Map(cfg.stores.map((s) => [s.id, new TYPES[s.type](s, { env, fetchImpl, identity })]));
    this.types = new Map(cfg.stores.map((s) => [s.id, s.type]));
    this.access = cfg.access;
    this.cacheMs = (cacheSeconds !== undefined ? cacheSeconds : Number(env.NARADO_SECRETS_CACHE_SECONDS || 60)) * 1000;
    this.cache = new Map();
    this.revealAllowed = env.NARADO_SECRETS_REVEAL !== '0';
    this.log = log;
  }

  get enabled() {
    return this.stores.size > 0;
  }

  repoKey(context) {
    return context && context.hostId && context.repoPath ? `${context.hostId}:${context.repoPath}` : null;
  }

  /** Whether narado's rules let `user` read `secretPath` from `storeId` for this workspace. */
  allowed(user, storeId, secretPath, context) {
    const store = this.stores.get(storeId);
    const rules = this.access.filter((r) => !r.store || r.store === storeId);
    if (store.perPerson && !this.access.some((r) => r.store === storeId)) return true;
    const repo = this.repoKey(context);
    return rules.some(
      (r) =>
        (!r.paths || matchesAny(r.paths, secretPath)) &&
        (!r.repos || matchesAny(r.repos, repo)) &&
        (!r.people || (user && (matchesAny(r.people, user.email) || matchesAny(r.people, user.id))))
    );
  }

  /** Whether a folder may hold something the rules allow (for browsing). */
  mayContain(user, storeId, folder, context) {
    const store = this.stores.get(storeId);
    if (store.perPerson && !this.access.some((r) => r.store === storeId)) return true;
    const repo = this.repoKey(context);
    return this.access
      .filter((r) => (!r.store || r.store === storeId) && (!r.repos || matchesAny(r.repos, repo)) && (!r.people || (user && (matchesAny(r.people, user.email) || matchesAny(r.people, user.id)))))
      .some((r) => {
        if (!r.paths) return true;
        return r.paths.some((p) => {
          const literal = String(p).split('*')[0].toLowerCase();
          const f = `${folder.toLowerCase()}/`;
          return literal.startsWith(f) || f.startsWith(literal) || globRe(p).test(folder);
        });
      });
  }

  storeFor(storeId) {
    const store = this.stores.get(storeId);
    if (!store) throw new SecretError(404, `No secrets store "${storeId}" is configured`);
    return store;
  }

  async readOne(user, ref, context) {
    const parsed = parseRef(ref);
    if (!parsed) throw new SecretError(400, `Not a secret reference: ${ref}`);
    const store = this.storeFor(parsed.store);
    if (!this.allowed(user, parsed.store, parsed.path, context)) {
      throw new SecretError(403, `You may not use ${parsed.store}/${parsed.path}${this.repoKey(context) ? ` in ${this.repoKey(context)}` : ''}; ask a platform admin to add an access rule`);
    }
    const key = JSON.stringify([parsed.store, parsed.path, parsed.field, store.perPerson ? user && user.id : null]);
    const hit = this.cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;
    const value = await store.read(parsed, { user });
    if (this.cacheMs > 0) this.cache.set(key, { value, expires: Date.now() + this.cacheMs });
    return value;
  }

  /**
   * Values for references, as the person, for a workspace.
   * @returns {{values: Object<string,string>, errors: Object<string,string>}}
   */
  async resolve(user, refs, context = {}) {
    const values = {};
    const errors = {};
    await Promise.all(
      [...new Set(refs)].slice(0, 200).map(async (ref) => {
        try {
          values[ref] = await this.readOne(user, ref, context);
          this.audit(user, ref, context, 'read');
        } catch (err) {
          errors[ref] = err.message;
          this.audit(user, ref, context, `refused (${err.status || 500})`);
        }
      })
    );
    return { values, errors };
  }

  audit(user, ref, context, outcome) {
    const who = user ? user.email || user.id : 'local';
    this.log.log(`[narado] secret ${ref} for ${who}${this.repoKey(context) ? ` in ${this.repoKey(context)}` : ''}: ${outcome}`);
  }

  listStores() {
    return [...this.stores.values()].map((s) => ({ id: s.id, type: this.types.get(s.id), configured: s.configured(), perPerson: s.perPerson }));
  }

  /** Secrets and folders under `prefix` that the person may use here. */
  async list(user, storeId, prefix, context = {}) {
    const store = this.storeFor(storeId);
    const entries = await store.list(prefix || '', { user });
    return entries.filter((e) => (e.folder ? this.mayContain(user, storeId, e.path, context) : this.allowed(user, storeId, e.path, context)));
  }

  /**
   * A secret's value, shown to the person on purpose (Secrets, Reveal). Same access rules
   * as a send, recorded in the log, and off when NARADO_SECRETS_REVEAL=0.
   */
  async reveal(user, ref, context = {}) {
    if (!this.revealAllowed) throw new SecretError(403, 'Showing secret values is turned off on this server');
    try {
      const value = await this.readOne(user, ref, context);
      this.audit(user, ref, context, 'revealed');
      return { value };
    } catch (err) {
      this.audit(user, ref, context, `reveal refused (${err.status || 500})`);
      throw err;
    }
  }

  /** Whether a reference resolves, without giving out the value. */
  async check(user, ref, context = {}) {
    try {
      const value = await this.readOne(user, ref, context);
      return { ok: true, length: value.length };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
}

/** The calls a worker may make, always as its own person. */
const secretsService = (service) => async (user, method, args) => {
  const context = (args[args.length - 1] && typeof args[args.length - 1] === 'object' && !Array.isArray(args[args.length - 1]) ? args[args.length - 1] : {}) || {};
  const ctx = { hostId: typeof context.hostId === 'string' ? context.hostId : null, repoPath: typeof context.repoPath === 'string' ? context.repoPath : null };
  switch (method) {
    case 'secrets.stores':
      return service.listStores();
    case 'secrets.resolve':
      if (!Array.isArray(args[0]) || args[0].some((r) => typeof r !== 'string')) throw new Error('Expected a list of references');
      return service.resolve(user, args[0], ctx);
    case 'secrets.list':
      return service.list(user, String(args[0] || ''), String(args[1] || ''), ctx);
    case 'secrets.check':
      return service.check(user, String(args[0] || ''), ctx);
    case 'secrets.reveal':
      return service.reveal(user, String(args[0] || ''), ctx);
    default:
      throw new Error(`Unknown call ${method}`);
  }
};

module.exports = { SecretsService, secretsService, loadSecretsConfig };
