/**
 * Google Cloud Secret Manager.
 *
 *   { "id": "gcp", "type": "gcp", "project": "acme-payments" }
 *
 * Credentials: NARADO_SECRETS_<ID>_CREDENTIALS, a service account key (JSON). A reference's
 * path is the secret's name, optionally with a version (`secret://gcp/stripe-key@3`; default
 * latest); `#field` reads one key of a JSON secret. "endpoint" and "tokenUrl" override the
 * Google URLs (tests, private endpoints).
 */
const crypto = require('node:crypto');
const { SecretError, envName, pickField, jsonFetch, once } = require('./common');

const b64url = (b) => Buffer.from(b).toString('base64url');

class GcpSecretsStore {
  constructor(config, { env, fetchImpl }) {
    if (!config.project) throw new Error(`Secrets store "${config.id}": "project" is required`);
    this.id = config.id;
    this.project = config.project;
    this.endpoint = (config.endpoint || 'https://secretmanager.googleapis.com').replace(/\/+$/, '');
    this.tokenUrl = config.tokenUrl || null;
    this.env = env;
    this.fetch = jsonFetch(fetchImpl);
    this.token = null;
    this.single = once();
  }

  get perPerson() {
    return false;
  }

  configured() {
    return !!this.env[envName(this.id, 'CREDENTIALS')];
  }

  credentials() {
    const raw = this.env[envName(this.id, 'CREDENTIALS')];
    if (!raw) throw new SecretError(503, `Secrets store "${this.id}" needs ${envName(this.id, 'CREDENTIALS')} (a service account key)`);
    try {
      return JSON.parse(raw);
    } catch {
      throw new SecretError(503, `${envName(this.id, 'CREDENTIALS')} is not a JSON service account key`);
    }
  }

  async accessToken() {
    if (this.token && this.token.expires > Date.now() + 60000) return this.token.value;
    return this.single('token', () => this.fetchToken());
  }

  async fetchToken() {
    const key = this.credentials();
    const tokenUrl = this.tokenUrl || key.token_uri || 'https://oauth2.googleapis.com/token';
    const now = Math.floor(Date.now() / 1000);
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', ...(key.private_key_id ? { kid: key.private_key_id } : {}) }));
    const claims = b64url(JSON.stringify({ iss: key.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform', aud: tokenUrl, iat: now, exp: now + 3600 }));
    const signature = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${claims}`), key.private_key).toString('base64url');
    const res = await this.fetch(tokenUrl, { method: 'POST', form: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${signature}` } });
    if (res.status !== 200 || !res.json || !res.json.access_token) throw new SecretError(502, `Google sign-in for "${this.id}" failed: ${(res.json && (res.json.error_description || res.json.error)) || `HTTP ${res.status}`}`);
    this.token = { value: res.json.access_token, expires: Date.now() + (res.json.expires_in || 3600) * 1000 };
    return this.token.value;
  }

  async get(url) {
    const res = await this.fetch(url, { headers: { authorization: `Bearer ${await this.accessToken()}` } });
    if (res.status === 200) return res.json || {};
    const message = (res.json && res.json.error && res.json.error.message) || `HTTP ${res.status}`;
    if (res.status === 404) throw new SecretError(404, `Not found in "${this.id}": ${message}`);
    if (res.status === 403 || res.status === 401) throw new SecretError(403, `Google refused access in "${this.id}": ${message}`);
    throw new SecretError(502, `Google Secret Manager failed: ${message}`);
  }

  async read({ path: ref, field }) {
    const [name, version = 'latest'] = ref.split('@');
    if (name.includes('/')) throw new SecretError(400, `Google secret names cannot contain "/": ${name}`);
    const out = await this.get(`${this.endpoint}/v1/projects/${encodeURIComponent(this.project)}/secrets/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}:access`);
    const data = out.payload && out.payload.data;
    if (data === undefined) throw new SecretError(404, `${this.id}/${ref} has no value`);
    return pickField(Buffer.from(data, 'base64').toString('utf8'), field, `${this.id}/${ref}`);
  }

  async list(prefix) {
    const out = [];
    let pageToken = '';
    do {
      const page = await this.get(`${this.endpoint}/v1/projects/${encodeURIComponent(this.project)}/secrets?pageSize=250${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`);
      for (const s of page.secrets || []) {
        const name = s.name.split('/').pop();
        if (!prefix || name.startsWith(prefix)) out.push({ name, path: name, folder: false });
      }
      pageToken = page.nextPageToken || '';
    } while (pageToken && out.length < 1000);
    return out;
  }
}

module.exports = { GcpSecretsStore };
