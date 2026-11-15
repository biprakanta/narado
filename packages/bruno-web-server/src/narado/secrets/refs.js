/**
 * Secret references (Phase 4e), shared by the front and the workers.
 *
 * A reference is a whole variable value of the form
 *
 *   secret://<store>/<path>[#<field>]
 *
 * for example `secret://vault/payments/staging#api_key` or `secret://aws/payments/staging-key`.
 * References are committed to Git in environment files; values are only ever fetched on the
 * server, at send time.
 */

const REF_RE = /^secret:\/\/([A-Za-z0-9_-]+)\/([^#\s]+)(?:#([^\s#]+))?$/;

/** {store, path, field} for a reference, or null when `s` is not one. */
const parseRef = (s) => {
  if (typeof s !== 'string') return null;
  const m = REF_RE.exec(s.trim());
  if (!m) return null;
  const segments = m[2].split('/');
  if (segments.some((p) => !p || p === '.' || p === '..')) return null;
  return { store: m[1], path: m[2], field: m[3] || null, ref: s.trim() };
};

const formatRef = ({ store, path, field }) => `secret://${store}/${path}${field ? `#${field}` : ''}`;

/** Every reference string in a value, deeply. */
const findRefs = (value, found = new Set(), seen = new Set()) => {
  if (typeof value === 'string') {
    if (value.startsWith('secret://') && parseRef(value)) found.add(value);
  } else if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const v of Array.isArray(value) ? value : Object.values(value)) findRefs(v, found, seen);
  }
  return found;
};

/**
 * A copy of `value` with references replaced by `values[ref]`. Containers that hold no
 * reference are shared with the original, so large collections are not copied.
 */
const replaceRefs = (value, values, seen = new Map()) => {
  if (typeof value === 'string') return Object.prototype.hasOwnProperty.call(values, value) ? values[value] : value;
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  seen.set(value, value);
  if (Array.isArray(value)) {
    let out = value;
    value.forEach((v, i) => {
      const r = replaceRefs(v, values, seen);
      if (r !== v) {
        if (out === value) out = value.slice();
        out[i] = r;
      }
    });
    seen.set(value, out);
    return out;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return value;
  let out = value;
  for (const [k, v] of Object.entries(value)) {
    const r = replaceRefs(v, values, seen);
    if (r !== v) {
      if (out === value) out = { ...value };
      out[k] = r;
    }
  }
  seen.set(value, out);
  return out;
};

const MASK = '••••••';
const MIN_MASK_LENGTH = 4;

/**
 * Remembers the secret values a worker has used, and cleans anything it sends back to the
 * browser or an assistant:
 *   - a string that is exactly a secret's value turns back into its reference, so an
 *     environment echoed back after a script (and perhaps saved) keeps the reference;
 *   - anywhere else, the value is masked, also in URL and base64 encodings.
 */
class Masker {
  constructor({ ttlMs = 60 * 60 * 1000, max = 500 } = {}) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.values = new Map(); // value -> { ref, used }
    this.re = undefined;
  }

  add(value, ref) {
    if (typeof value !== 'string' || value.length < MIN_MASK_LENGTH) return;
    this.values.delete(value);
    this.values.set(value, { ref, used: Date.now() });
    while (this.values.size > this.max) this.values.delete(this.values.keys().next().value);
    this.re = undefined;
  }

  get size() {
    return this.values.size;
  }

  pattern() {
    const now = Date.now();
    for (const [v, e] of this.values) {
      if (now - e.used > this.ttlMs) {
        this.values.delete(v);
        this.re = undefined;
      }
    }
    if (this.re !== undefined) return this.re;
    const forms = new Set();
    for (const v of this.values.keys()) {
      forms.add(v);
      forms.add(encodeURIComponent(v));
      forms.add(Buffer.from(v).toString('base64').replace(/=+$/, ''));
    }
    const escaped = [...forms].filter((f) => f.length >= MIN_MASK_LENGTH).sort((a, b) => b.length - a.length).map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    this.re = escaped.length ? new RegExp(escaped.join('|'), 'g') : null;
    return this.re;
  }

  maskText(text) {
    const re = this.pattern();
    if (!re || typeof text !== 'string') return text;
    const exact = this.values.get(text);
    if (exact) return exact.ref || MASK;
    return text.replace(re, MASK);
  }

  /** A copy of `value` with secrets cleaned; untouched parts are shared with the original. */
  clean(value, seen = new Map()) {
    if (!this.pattern()) return value;
    if (typeof value === 'string') return this.maskText(value);
    if (!value || typeof value !== 'object') return value;
    if (seen.has(value)) return seen.get(value);
    seen.set(value, value);
    const proto = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) return value;
    let out = value;
    const entries = Array.isArray(value) ? value.map((v, i) => [i, v]) : Object.entries(value);
    for (const [k, v] of entries) {
      const r = this.clean(v, seen);
      if (r !== v) {
        if (out === value) out = Array.isArray(value) ? value.slice() : { ...value };
        out[k] = r;
      }
    }
    seen.set(value, out);
    return out;
  }
}

module.exports = { parseRef, formatRef, findRefs, replaceRefs, Masker, MASK };
