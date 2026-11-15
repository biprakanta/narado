/**
 * Azure Key Vault.
 *
 *   { "id": "azure", "type": "azure", "vaultUrl": "https://acme-payments.vault.azure.net", "tenant": "<tenant id>" }
 *
 * Credentials: an app registration, NARADO_SECRETS_<ID>_CLIENT_ID and
 * NARADO_SECRETS_<ID>_CLIENT_SECRET. A reference's path is the secret's name, optionally with
 * a version (`secret://azure/stripe-key@<version>`); `#field` reads one key of a JSON secret.
 * "authority" overrides the sign-in URL (sovereign clouds, tests).
 */
const { SecretError, envName, pickField, jsonFetch, once } = require('./common');

const API_VERSION = '7.4';

class AzureKeyVaultStore {
  constructor(config, { env, fetchImpl }) {
    if (!config.vaultUrl || !config.tenant) throw new Error(`Secrets store "${config.id}": "vaultUrl" and "tenant" are required`);
    this.id = config.id;
    this.vaultUrl = config.vaultUrl.replace(/\/+$/, '');
    this.tenant = config.tenant;
    this.authority = (config.authority || 'https://login.microsoftonline.com').replace(/\/+$/, '');
    this.scope = config.scope || 'https://vault.azure.net/.default';
    this.env = env;
    this.fetch = jsonFetch(fetchImpl);
    this.token = null;
    this.single = once();
  }

  get perPerson() {
    return false;
  }

  configured() {
    return !!(this.env[envName(this.id, 'CLIENT_ID')] && this.env[envName(this.id, 'CLIENT_SECRET')]);
  }

  async accessToken() {
    if (this.token && this.token.expires > Date.now() + 60000) return this.token.value;
    return this.single('token', () => this.fetchToken());
  }

  async fetchToken() {
    const clientId = this.env[envName(this.id, 'CLIENT_ID')];
    const clientSecret = this.env[envName(this.id, 'CLIENT_SECRET')];
    if (!clientId || !clientSecret) throw new SecretError(503, `Secrets store "${this.id}" needs ${envName(this.id, 'CLIENT_ID')} and ${envName(this.id, 'CLIENT_SECRET')}`);
    const res = await this.fetch(`${this.authority}/${encodeURIComponent(this.tenant)}/oauth2/v2.0/token`, {
      method: 'POST',
      form: { grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope: this.scope }
    });
    if (res.status !== 200 || !res.json || !res.json.access_token) throw new SecretError(502, `Azure sign-in for "${this.id}" failed: ${(res.json && (res.json.error_description || res.json.error)) || `HTTP ${res.status}`}`);
    this.token = { value: res.json.access_token, expires: Date.now() + (res.json.expires_in || 3600) * 1000 };
    return this.token.value;
  }

  async get(url) {
    const res = await this.fetch(url, { headers: { authorization: `Bearer ${await this.accessToken()}` } });
    if (res.status === 200) return res.json || {};
    const message = (res.json && res.json.error && res.json.error.message) || `HTTP ${res.status}`;
    if (res.status === 404) throw new SecretError(404, `Not found in "${this.id}": ${message}`);
    if (res.status === 403 || res.status === 401) throw new SecretError(403, `Azure refused access in "${this.id}": ${message}`);
    throw new SecretError(502, `Azure Key Vault failed: ${message}`);
  }

  async read({ path: ref, field }) {
    const [name, version] = ref.split('@');
    if (!/^[0-9A-Za-z-]+$/.test(name)) throw new SecretError(400, `Azure secret names may only use letters, digits and "-": ${name}`);
    const out = await this.get(`${this.vaultUrl}/secrets/${name}${version ? `/${encodeURIComponent(version)}` : ''}?api-version=${API_VERSION}`);
    return pickField(out.value, field, `${this.id}/${ref}`);
  }

  async list(prefix) {
    const out = [];
    let next = `${this.vaultUrl}/secrets?api-version=${API_VERSION}&maxresults=25`;
    while (next && out.length < 1000) {
      // Only follow paging links on the vault itself.
      if (new URL(next).origin !== new URL(this.vaultUrl).origin) break;
      const page = await this.get(next);
      for (const s of page.value || []) {
        const name = s.id.split('/').pop();
        if (!prefix || name.startsWith(prefix)) out.push({ name, path: name, folder: false });
      }
      next = page.nextLink || null;
    }
    return out;
  }
}

module.exports = { AzureKeyVaultStore };
