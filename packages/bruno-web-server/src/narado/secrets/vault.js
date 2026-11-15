/**
 * HashiCorp Vault, KV version 2.
 *
 *   { "id": "vault", "type": "vault", "url": "https://vault.acme.internal", "mount": "secret",
 *     "namespace": "payments",                      // optional, Vault Enterprise
 *     "auth": { "method": "jwt", "role": "narado", "mount": "jwt" } }
 *
 * Sign-in methods:
 *   - jwt:     per person. narado signs a short-lived token for the signed-in person and Vault's
 *              JWT auth method checks it against narado's public key (/auth/jwks.json), so
 *              Vault's own policies decide what each person may read.
 *   - approle: a service identity: NARADO_SECRETS_<ID>_ROLE_ID and NARADO_SECRETS_<ID>_SECRET_ID.
 *   - token:   a service identity: NARADO_SECRETS_<ID>_TOKEN.
 */
const { SecretError, envName, pickField, jsonFetch, once } = require('./common');

class VaultStore {
  constructor(config, { env, fetchImpl, identity }) {
    if (!config.url) throw new Error(`Secrets store "${config.id}": "url" is required`);
    this.id = config.id;
    this.url = config.url.replace(/\/+$/, '');
    this.mount = (config.mount || 'secret').replace(/^\/+|\/+$/g, '');
    this.namespace = config.namespace || null;
    this.auth = { method: 'token', ...(config.auth || {}) };
    this.env = env;
    this.fetch = jsonFetch(fetchImpl);
    this.identity = identity;
    this.tokens = new Map(); // user id (or '') -> { token, expires }
    this.single = once();
    if (!['token', 'approle', 'jwt'].includes(this.auth.method)) throw new Error(`Secrets store "${this.id}": unknown auth method "${this.auth.method}"`);
    if (this.auth.method === 'jwt' && !this.auth.role) throw new Error(`Secrets store "${this.id}": jwt sign-in needs a "role"`);
  }

  /** Whether Vault itself decides per person (no narado access rules needed). */
  get perPerson() {
    return this.auth.method === 'jwt';
  }

  configured() {
    if (this.auth.method === 'token') return !!this.env[envName(this.id, 'TOKEN')];
    if (this.auth.method === 'approle') return !!(this.env[envName(this.id, 'ROLE_ID')] && this.env[envName(this.id, 'SECRET_ID')]);
    return !!this.identity;
  }

  headers(token) {
    return { 'x-vault-token': token, ...(this.namespace ? { 'x-vault-namespace': this.namespace } : {}) };
  }

  async login(user) {
    const key = this.perPerson ? (user && user.id) || '' : '';
    const cached = this.tokens.get(key);
    if (cached && cached.expires > Date.now() + 30000) return cached.token;
    if (this.auth.method === 'token') {
      const token = this.env[envName(this.id, 'TOKEN')];
      if (!token) throw new SecretError(503, `Secrets store "${this.id}" has no token (${envName(this.id, 'TOKEN')})`);
      return token;
    }
    return this.single(key, () => this.signIn(user, key));
  }

  async signIn(user, key) {
    let body;
    let mount;
    if (this.auth.method === 'approle') {
      const roleId = this.env[envName(this.id, 'ROLE_ID')];
      const secretId = this.env[envName(this.id, 'SECRET_ID')];
      if (!roleId || !secretId) throw new SecretError(503, `Secrets store "${this.id}" needs ${envName(this.id, 'ROLE_ID')} and ${envName(this.id, 'SECRET_ID')}`);
      body = { role_id: roleId, secret_id: secretId };
      mount = this.auth.mount || 'approle';
    } else {
      if (!user) throw new SecretError(401, `Secrets store "${this.id}" reads secrets as the signed-in person; sign in first`);
      body = { role: this.auth.role, jwt: this.identity.sign(user, { audience: this.auth.audience || 'vault', ttlSeconds: 120 }) };
      mount = this.auth.mount || 'jwt';
    }
    const res = await this.fetch(`${this.url}/v1/auth/${mount}/login`, { method: 'POST', headers: this.namespace ? { 'x-vault-namespace': this.namespace } : {}, body });
    if (res.status !== 200 || !res.json || !res.json.auth) {
      throw new SecretError(res.status === 400 || res.status === 403 ? 403 : 502, `Vault sign-in for "${this.id}" failed: ${vaultError(res)}`);
    }
    const { client_token: token, lease_duration: ttl } = res.json.auth;
    this.tokens.set(key, { token, expires: Date.now() + Math.max(60, ttl || 300) * 1000 });
    return token;
  }

  forget(user) {
    this.tokens.delete(this.perPerson ? (user && user.id) || '' : '');
  }

  async read({ path: secretPath, field }, { user }) {
    const token = await this.login(user);
    const res = await this.fetch(`${this.url}/v1/${this.mount}/data/${encodePath(secretPath)}`, { headers: this.headers(token) });
    if (res.status === 404) throw new SecretError(404, `No secret at ${secretPath} in "${this.id}"`);
    if (res.status === 403) {
      this.forget(user); // a revoked or expired sign-in is not reused
      throw new SecretError(403, `Vault refused access to ${secretPath} in "${this.id}"`);
    }
    if (res.status !== 200) throw new SecretError(502, `Vault read of ${secretPath} failed: ${vaultError(res)}`);
    const data = res.json && res.json.data && res.json.data.data;
    return pickField(data, field, `${this.id}/${secretPath}`);
  }

  async list(prefix, { user }) {
    const token = await this.login(user);
    const clean = String(prefix || '').replace(/^\/+|\/+$/g, '');
    const res = await this.fetch(`${this.url}/v1/${this.mount}/metadata/${clean ? `${encodePath(clean)}/` : ''}?list=true`, { headers: this.headers(token) });
    if (res.status === 404) return [];
    if (res.status === 403) this.forget(user);
    if (res.status === 403) throw new SecretError(403, `Vault refused listing ${clean || '/'} in "${this.id}"`);
    if (res.status !== 200) throw new SecretError(502, `Vault list failed: ${vaultError(res)}`);
    return ((res.json && res.json.data && res.json.data.keys) || []).map((k) => ({
      name: k.replace(/\/$/, ''),
      path: clean ? `${clean}/${k.replace(/\/$/, '')}` : k.replace(/\/$/, ''),
      folder: k.endsWith('/')
    }));
  }
}

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');
const vaultError = (res) => (res.json && Array.isArray(res.json.errors) && res.json.errors.length ? res.json.errors.join('; ') : `HTTP ${res.status}`);

module.exports = { VaultStore };
