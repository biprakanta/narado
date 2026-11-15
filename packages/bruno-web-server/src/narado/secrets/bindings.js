/**
 * Secrets bound to a repository through its collections' environments: a secret is bound when
 * an environment file on the repository's default branch references it, as in
 *
 *   payments-api/environments/staging.bru        api_key: secret://vault-svc/payments/staging#stripe
 *   services/orders/.narado/environments/dev.yml
 *
 * Anyone who can read the repository may use the secrets its environments reference (exactly
 * those: store and path), read by narado with the store's service credentials. So adding a
 * secret to an environment goes through the repository's review like any other change.
 *
 * Protected environments: `.narado/environments.yml` at the repository's root says which
 * environments need more than read access to the repository, for example
 *
 *   production: write          # read (the default), write or admin, as narado counts them
 *
 * A secret is usable when the person has the access one of the environments referencing it
 * needs (the lowest, so a secret staging uses is usable with read access). narado learns the
 * person's access from the host, as them. An unreadable environments.yml protects everything
 * (admin) until it's fixed.
 *
 * Read in the front, as the person, from the host's API at the default branch (never from a
 * working copy or another branch). The person's access to the repository is checked by the
 * front, with the host, before a repository is named here (server.js, checkedSecretCalls).
 */
const YAML = require('yaml');
const { parseRef } = require('./refs');
const { rank } = require('../providers/access');

const TTL_MS = 5 * 60 * 1000;
// Environment files of Bruno collections and narado's OpenAPI collections (as requests/allowlist.js).
const ENV_FILE = /(?:^|\/)(?:\.(?:narado|client)\/)?environments\/[^/]+\.(?:bru|ya?ml|json)$/i;
const REF_IN_TEXT = /secret:\/\/[A-Za-z0-9_-]+\/[^\s#"'`,;}\]]+(?:#[^\s"'`,;}\]]+)?/g;
const MAX_FILES = 200;
const PROTECT_FILE = '.narado/environments.yml';
const PROTECT_LEVELS = ['read', 'write', 'admin'];

/** `.narado/environments.yml`'s text -> { environment name (lower case) -> needed level }. Throws if unreadable. */
const parseProtection = (text) => {
  const doc = YAML.parse(String(text || '')) || {};
  if (typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`${PROTECT_FILE} must map environment names to read, write or admin`);
  const out = {};
  for (const [name, level] of Object.entries(doc)) {
    const l = String(level).trim().toLowerCase();
    if (!PROTECT_LEVELS.includes(l)) throw new Error(`${PROTECT_FILE}: "${name}: ${level}" (use read, write or admin)`);
    out[String(name).trim().toLowerCase()] = l;
  }
  return out;
};

/** The secrets an environment file's text references: [{ store, path }]. */
const refsInText = (text) => {
  const out = [];
  for (const m of String(text || '').matchAll(REF_IN_TEXT)) {
    const r = parseRef(m[0]);
    if (r) out.push({ store: r.store, path: r.path });
  }
  return out;
};

/** Which environment a file is: "staging" for .../environments/staging.bru. */
const envNameOf = (file) => file.split('/').pop().replace(/\.[^.]+$/, '');

class RepoBindings {
  /** @param providerFor (user, hostId) -> a host provider acting as the person */
  constructor({ providerFor, log = console }) {
    this.providerFor = providerFor;
    this.log = log;
    this.cache = new Map(); // `${user}|${host}:${repo}` -> { at, bound }
  }

  /**
   * The secrets bound in a repository, for this person:
   *   [{ ref: 'secret://store/path', environments: [{ name, file, needs }], needs, usable }]
   * `needs` is the access the least protected referencing environment needs; `usable` is
   * whether the person has it (the host says, as them).
   */
  async forRepo(user, hostId, repoPath) {
    const key = `${(user && user.id) || 'local'}|${hostId}:${repoPath}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.bound;
    const byRef = new Map();
    let access = 'none';
    let protection = {};
    try {
      const provider = this.providerFor(user, hostId);
      const repo = await provider.getRepo(repoPath);
      access = repo.access || 'none';
      const ref = repo.defaultBranch;
      const { files } = await provider.listFiles(repoPath, ref);
      if (files.includes(PROTECT_FILE)) {
        try {
          protection = parseProtection(await provider.readFile(repoPath, ref, PROTECT_FILE));
        } catch (err) {
          // Fail closed: every environment needs admin until the file is fixed.
          this.log.warn(`[narado] ${hostId}:${repoPath}: ${err.message}; treating every environment as needing admin access`);
          protection = { '*': 'admin' };
        }
      }
      const envFiles = files.filter((f) => ENV_FILE.test(f)).slice(0, MAX_FILES);
      await Promise.all(
        envFiles.map(async (file) => {
          let text = '';
          try {
            text = await provider.readFile(repoPath, ref, file);
          } catch (err) {
            this.log.warn(`[narado] secrets bound in ${hostId}:${repoPath}: couldn't read ${file}: ${err.message}`);
            return;
          }
          for (const r of refsInText(text)) {
            const k = `secret://${r.store}/${r.path}`;
            if (!byRef.has(k)) byRef.set(k, []);
            const name = envNameOf(file);
            byRef.get(k).push({ name, file, needs: protection['*'] || protection[name.toLowerCase()] || 'read' });
          }
        })
      );
    } catch (err) {
      this.log.warn(`[narado] couldn't read the secrets bound in ${hostId}:${repoPath}: ${err.message}`);
    }
    const bound = [...byRef]
      .map(([r, environments]) => {
        const needs = environments.reduce((low, e) => (rank(e.needs) < rank(low) ? e.needs : low), 'admin');
        return { ref: r, environments, needs, usable: rank(access) >= rank(needs) };
      })
      .sort((a, b) => a.ref.localeCompare(b.ref));
    this.cache.set(key, { at: Date.now(), bound });
    return bound;
  }
}

/** The binding for `secret://store/path` (exactly: a #field may be any), or undefined. */
const bindingFor = (bound, store, secretPath) => bound.find((b) => b.ref === `secret://${store}/${secretPath}`);

/** Whether `secret://store/path` is bound and usable by this person. */
const isBound = (bound, store, secretPath) => {
  const b = bindingFor(bound, store, secretPath);
  return !!(b && b.usable !== false);
};

/** Whether a folder holds a bound secret (for browsing in the Secrets dialog). */
const mayHoldBound = (bound, store, folder) => {
  const prefix = `secret://${store}/${folder.replace(/\/+$/, '')}/`;
  return bound.some((b) => b.usable !== false && b.ref.startsWith(prefix));
};

module.exports = { RepoBindings, isBound, bindingFor, mayHoldBound, refsInText, parseProtection, ENV_FILE, PROTECT_FILE };
