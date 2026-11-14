/**
 * Git host registry.
 *
 * Hosts come from `<data dir>/narado.json`:
 *
 *   { "hosts": [
 *       { "id": "github", "type": "github" },
 *       { "id": "gitlab", "type": "gitlab", "url": "https://gitlab.com" },
 *       { "id": "acme-gitlab", "type": "gitlab", "url": "https://gitlab.acme.internal", "tokenEnv": "ACME_GITLAB_TOKEN" }
 *   ] }
 *
 * Without the file, GitHub.com and GitLab.com are configured. Tokens are only ever
 * read from environment variables (default NARADO_<ID>_TOKEN), never from the file.
 * A host without a token is listed as not connected.
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
  if (!Array.isArray(parsed.hosts)) throw new Error(`${file}: "hosts" must be an array`);
  for (const h of parsed.hosts) {
    if (!h.id || !['github', 'gitlab'].includes(h.type)) {
      throw new Error(`${file}: each host needs an "id" and a "type" of github or gitlab`);
    }
    if ('token' in h) throw new Error(`${file}: tokens must come from environment variables, not this file`);
  }
  return parsed.hosts;
};

class ProviderRegistry {
  constructor({ dataDir, env = process.env, fetchImpl } = {}) {
    this.hosts = loadHostConfig(dataDir).map((h) => ({ ...h, tokenEnv: tokenEnvFor(h) }));
    this.env = env;
    this.fetchImpl = fetchImpl;
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

  build(h, token) {
    const opts = { ...h, token, fetchImpl: this.fetchImpl };
    return h.type === 'github' ? new GitHubProvider(opts) : new GitLabProvider(opts);
  }

  get(hostId) {
    const h = this.hosts.find((x) => x.id === hostId);
    if (!h) throw new Error(`Unknown Git host "${hostId}"`);
    const token = this.env[h.tokenEnv];
    if (!token) throw new Error(`${h.id} is not connected: set ${h.tokenEnv} on the server`);
    if (!this.cache.has(hostId)) this.cache.set(hostId, this.build(h, token));
    return this.cache.get(hostId);
  }
}

module.exports = { ProviderRegistry, loadHostConfig, tokenEnvFor, DEFAULT_HOSTS };
