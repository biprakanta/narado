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
 * Read in the front, as the person, from the host's API at the default branch (never from a
 * working copy or another branch). The person's access to the repository is checked by the
 * front, with the host, before a repository is named here (server.js, checkedSecretCalls).
 */
const { parseRef } = require('./refs');

const TTL_MS = 5 * 60 * 1000;
// Environment files of Bruno collections and narado's OpenAPI collections (as requests/allowlist.js).
const ENV_FILE = /(?:^|\/)(?:\.(?:narado|client)\/)?environments\/[^/]+\.(?:bru|ya?ml|json)$/i;
const REF_IN_TEXT = /secret:\/\/[A-Za-z0-9_-]+\/[^\s#"'`,;}\]]+(?:#[^\s"'`,;}\]]+)?/g;
const MAX_FILES = 200;

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
   * The secrets bound in a repository: [{ ref: 'secret://store/path', environments: [{ name, file }] }].
   */
  async forRepo(user, hostId, repoPath) {
    const key = `${(user && user.id) || 'local'}|${hostId}:${repoPath}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.bound;
    const byRef = new Map();
    try {
      const provider = this.providerFor(user, hostId);
      const repo = await provider.getRepo(repoPath);
      const ref = repo.defaultBranch;
      const { files } = await provider.listFiles(repoPath, ref);
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
            byRef.get(k).push({ name: envNameOf(file), file });
          }
        })
      );
    } catch (err) {
      this.log.warn(`[narado] couldn't read the secrets bound in ${hostId}:${repoPath}: ${err.message}`);
    }
    const bound = [...byRef].map(([r, environments]) => ({ ref: r, environments })).sort((a, b) => a.ref.localeCompare(b.ref));
    this.cache.set(key, { at: Date.now(), bound });
    return bound;
  }
}

/** Whether `secret://store/path` is bound (exactly: a #field may be any). */
const isBound = (bound, store, secretPath) => bound.some((b) => b.ref === `secret://${store}/${secretPath}`);

/** Whether a folder holds a bound secret (for browsing in the Secrets dialog). */
const mayHoldBound = (bound, store, folder) => {
  const prefix = `secret://${store}/${folder.replace(/\/+$/, '')}/`;
  return bound.some((b) => b.ref.startsWith(prefix));
};

module.exports = { RepoBindings, isBound, mayHoldBound, refsInText, ENV_FILE };
