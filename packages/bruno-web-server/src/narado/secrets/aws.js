/**
 * AWS Secrets Manager.
 *
 *   { "id": "aws", "type": "aws", "region": "ap-south-1" }
 *
 * Credentials: NARADO_SECRETS_<ID>_ACCESS_KEY_ID, NARADO_SECRETS_<ID>_SECRET_ACCESS_KEY and,
 * for temporary credentials, NARADO_SECRETS_<ID>_SESSION_TOKEN. A reference's path is the
 * secret's name (`secret://aws/payments/staging-key`); `#field` reads one key of a JSON secret.
 * "endpoint" overrides the service URL (LocalStack, VPC endpoints, tests).
 */
const crypto = require('node:crypto');
const { SecretError, envName, pickField, jsonFetch } = require('./common');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (key, s) => crypto.createHmac('sha256', key).update(s).digest();

/**
 * Signature Version 4 headers for a request.
 * @returns {object} headers to add: authorization, x-amz-date and, if given, x-amz-security-token
 */
const signV4 = ({ method, url, headers = {}, body = '', region, service, accessKeyId, secretAccessKey, sessionToken, date = new Date() }) => {
  const u = new URL(url);
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const all = { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')])), host: u.host, 'x-amz-date': amzDate };
  if (sessionToken) all['x-amz-security-token'] = sessionToken;
  const names = Object.keys(all).sort();
  const query = [...u.searchParams.entries()]
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)])
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonical = [method, u.pathname || '/', query, names.map((n) => `${n}:${all[n]}\n`).join(''), names.join(';'), sha256(body)].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', key).update(toSign).digest('hex');
  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
    'x-amz-date': amzDate,
    ...(sessionToken ? { 'x-amz-security-token': sessionToken } : {})
  };
};

const encodeRfc3986 = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

class AwsSecretsStore {
  constructor(config, { env, fetchImpl }) {
    if (!config.region) throw new Error(`Secrets store "${config.id}": "region" is required`);
    this.id = config.id;
    this.region = config.region;
    this.endpoint = (config.endpoint || `https://secretsmanager.${config.region}.amazonaws.com`).replace(/\/+$/, '');
    this.env = env;
    this.fetch = jsonFetch(fetchImpl);
  }

  get perPerson() {
    return false;
  }

  configured() {
    return !!(this.env[envName(this.id, 'ACCESS_KEY_ID')] && this.env[envName(this.id, 'SECRET_ACCESS_KEY')]);
  }

  async call(target, payload) {
    const accessKeyId = this.env[envName(this.id, 'ACCESS_KEY_ID')];
    const secretAccessKey = this.env[envName(this.id, 'SECRET_ACCESS_KEY')];
    if (!accessKeyId || !secretAccessKey) throw new SecretError(503, `Secrets store "${this.id}" needs ${envName(this.id, 'ACCESS_KEY_ID')} and ${envName(this.id, 'SECRET_ACCESS_KEY')}`);
    const body = JSON.stringify(payload);
    const headers = { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': `secretsmanager.${target}` };
    const url = `${this.endpoint}/`;
    const signed = signV4({ method: 'POST', url, headers, body, region: this.region, service: 'secretsmanager', accessKeyId, secretAccessKey, sessionToken: this.env[envName(this.id, 'SESSION_TOKEN')] });
    const res = await this.fetch(url, { method: 'POST', headers: { ...headers, ...signed }, body });
    if (res.status === 200) return res.json || {};
    const type = String((res.json && (res.json.__type || res.json.code)) || '').split('#').pop();
    const message = (res.json && (res.json.message || res.json.Message)) || `HTTP ${res.status}`;
    if (type === 'ResourceNotFoundException') throw new SecretError(404, `No secret ${payload.SecretId || ''} in "${this.id}"`);
    if (type === 'AccessDeniedException' || res.status === 403) throw new SecretError(403, `AWS refused access in "${this.id}": ${message}`);
    throw new SecretError(502, `AWS Secrets Manager (${target}) failed: ${type ? `${type}: ` : ''}${message}`);
  }

  async read({ path: name, field }) {
    const out = await this.call('GetSecretValue', { SecretId: name });
    const value = out.SecretString !== undefined ? out.SecretString : out.SecretBinary !== undefined ? Buffer.from(out.SecretBinary, 'base64').toString('utf8') : undefined;
    return pickField(value, field, `${this.id}/${name}`);
  }

  async list(prefix) {
    const clean = String(prefix || '').replace(/^\/+/, '');
    const out = [];
    let NextToken;
    do {
      const page = await this.call('ListSecrets', { MaxResults: 100, ...(clean ? { Filters: [{ Key: 'name', Values: [clean] }] } : {}), ...(NextToken ? { NextToken } : {}) });
      for (const s of page.SecretList || []) if (!clean || s.Name.startsWith(clean)) out.push({ name: s.Name, path: s.Name, folder: false });
      NextToken = page.NextToken;
    } while (NextToken && out.length < 1000);
    return out;
  }
}

module.exports = { AwsSecretsStore, signV4 };
