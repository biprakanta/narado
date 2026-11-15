/**
 * Git host registry.
 *
 * Hosts come from `<data dir>/narado.json`:
 *
 *   { "hosts": [
 *       { "id": "github", "type": "github" },
 *       { "id": "gitlab", "type": "gitlab", "url": "https://gitlab.com" },
 *       { "id": "acme-gitlab", "type": "gitlab", "url": "https://gitlab.acme.internal", "tokenEnv": "ACME_GITLAB_TOKEN" },
 *       { "id": "gitlab", "type": "gitlab", "exploreNamespaces": ["acme", "acme-platform"] }
 *   ] }
 *
 * Without the file, GitHub.com and GitLab.com are configured. Credentials never come
 * from the file. In a worker, tokens come from `tokenFor(hostId, { force })`: the front
 * process answers with the person's own token (src/narado/git-accounts.js) or, in
 * local mode, a shared token from NARADO_<ID>_TOKEN. Without `tokenFor`, the registry
 * reads that variable itself (tests and tools).
 */
const fs = require('node:fs');
const path = require('node:path');
const { GitHubProvider } = require('./github');
const { GitLabProvider } = require('./gitlab');

const DEFAULT_HOSTS = [
  { id: 'github', type: 'github' },
  { id: 'gitlab', type: 'gitlab', url: 'https://gitlab.com' }
];

const tokenEnvFor = (host) => host.tokenEnv || `NARADO_${host.id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_TOKEN`;

const loadHostConfig = (dataDir) => {
  const file = path.join(dataDir, 'narado.json');
  if (!fs.existsSync(file)) return DEFAULT_HOSTS;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (parsed.hosts === undefined) return DEFAULT_HOSTS;
  if (!Array.isArray(parsed.hosts)) throw new Error(`${file}: "hosts" must be an array`);
  for (const h of parsed.hosts) {
    if (!h.id || !['github', 'gitlab'].includes(h.type)) {
      throw new Error(`${file}: each host needs an "id" and a "type" of github or gitlab`);
    }
    if ('token' in h) throw new Error(`${file}: tokens must come from environment variables, not this file`);
    if (h.exploreNamespaces !== undefined && (!Array.isArray(h.exploreNamespaces) || h.exploreNamespaces.some((n) => typeof n !== 'string'))) {
      throw new Error(`${file}: "exploreNamespaces" on host "${h.id}" must be a list of user, organisation or group names`);
    }
  }
  return parsed.hosts;
};

class ProviderRegistry {
  constructor({ dataDir, env = process.env, fetchImpl, tokenFor } = {}) {
    this.hosts = loadHostConfig(dataDir).map((h) => ({ ...h, tokenEnv: tokenEnvFor(h) }));
    this.env = env;
    this.fetchImpl = fetchImpl;
    this.tokenFor = tokenFor;
    this.cache = new Map();
  }

  /** Hosts for the interface, without tokens. */
  listHosts() {
    return this.hosts.map((h) => {
      const p = this.build(h, 'placeholder');
      return {
        id: h.id,
        type: h.type,
        name: p.name,
        url: p.url,
        connected: !!this.env[h.tokenEnv],
        tokenEnv: h.tokenEnv
      };
    });
  }

  build(h, token, getToken) {
    const opts = { ...h, token, getToken, fetchImpl: this.fetchImpl };
    return h.type === 'github' ? new GitHubProvider(opts) : new GitLabProvider(opts);
  }

  get(hostId) {
    const h = this.hosts.find((x) => x.id === hostId);
    if (!h) throw new Error(`Unknown Git host "${hostId}"`);
    if (this.tokenFor) {
      if (!this.cache.has(hostId)) this.cache.set(hostId, this.build(h, undefined, (opts) => this.tokenFor(hostId, opts)));
      return this.cache.get(hostId);
    }
    const token = this.env[h.tokenEnv];
    if (!token) throw new Error(`${h.id} is not connected: set ${h.tokenEnv} on the server`);
    if (!this.cache.has(hostId)) this.cache.set(hostId, this.build(h, token));
    return this.cache.get(hostId);
  }
}

module.exports = { ProviderRegistry, loadHostConfig, tokenEnvFor, DEFAULT_HOSTS };
