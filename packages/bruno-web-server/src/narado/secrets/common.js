/** Helpers shared by the secrets store backends. */

class SecretError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** NARADO_SECRETS_<STORE ID>_<NAME>: store credentials only ever come from the environment. */
const envName = (storeId, name) => `NARADO_SECRETS_${storeId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_${name}`;

/**
 * One value out of a secret. A secret may be a single string, or a map of fields (Vault KV,
 * or a JSON object stored in a cloud secret manager); then `#field` picks one. Without a
 * field, a map with a single field, or a "value" field, gives that.
 */
const pickField = (data, field, label) => {
  if (data === undefined || data === null) throw new SecretError(404, `No value at ${label}`);
  if (typeof data === 'string') {
    if (!field) return data;
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      throw new SecretError(400, `${label} is plain text; it has no field "${field}"`);
    }
    return pickField(parsed, field, label);
  }
  if (typeof data !== 'object') return String(data);
  if (field) {
    if (!Object.prototype.hasOwnProperty.call(data, field)) throw new SecretError(404, `${label} has no field "${field}"`);
    const v = data[field];
    return typeof v === 'string' ? v : JSON.stringify(v);
  }
  const keys = Object.keys(data);
  if (keys.length === 1) return pickField(data[keys[0]], null, label);
  if (keys.includes('value')) return pickField(data.value, null, label);
  throw new SecretError(400, `${label} has several fields (${keys.join(', ')}); add #<field> to the reference`);
};

/** fetch wrapper: JSON in and out, with a timeout. Returns {status, json, text}. */
const jsonFetch =
  (fetchImpl = globalThis.fetch) =>
  async (url, { method = 'GET', headers = {}, body, form, timeoutMs = 15000 } = {}) => {
    const h = { accept: 'application/json', ...headers };
    let payload;
    if (form) {
      h['content-type'] = 'application/x-www-form-urlencoded';
      payload = new URLSearchParams(form).toString();
    } else if (body !== undefined) {
      if (typeof body === 'string') payload = body;
      else {
        h['content-type'] = h['content-type'] || 'application/json';
        payload = JSON.stringify(body);
      }
    }
    let res;
    try {
      res = await fetchImpl(url, { method, headers: h, body: payload, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    } catch (err) {
      throw new SecretError(502, `Could not reach ${new URL(url).host}: ${err.cause ? err.cause.message || err.cause.code : err.message}`);
    }
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    return { status: res.status, json, text, headers: res.headers };
  };

/** One call at a time per key: parallel reads share a single sign-in. */
const once = () => {
  const inflight = new Map();
  return (key, fn) => {
    if (inflight.has(key)) return inflight.get(key);
    const p = Promise.resolve().then(fn).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  };
};

module.exports = { SecretError, envName, pickField, jsonFetch, once };
