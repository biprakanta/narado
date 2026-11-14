/**
 * Mapping between OpenAPI operations and Bruno requests (design §6.2).
 *
 * The contract (method, path, parameters, name, docs, folder) lives in the spec.
 * Everything a person adds on top (values, body, auth, scripts, tests, client-only
 * headers) lives in `.client/requests/<operationId>.yml`, and only where it differs from
 * what the spec already implies, so most operations need no client file at all.
 */

const BASE_URL_VAR = '{{baseUrl}}';
// Header parameters OpenAPI says to ignore (described elsewhere in the spec).
const IGNORED_HEADER_PARAMS = new Set(['accept', 'content-type', 'authorization']);

const toBrunoPath = (p) => p.replace(/\{([^}]+)\}/g, ':$1');
const toSpecPath = (p) => p.replace(/:([A-Za-z0-9_.-]+)/g, '{$1}');
const templateParams = (p) => [...p.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);

const str = (v) => {
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

const resolveRef = (spec, obj) => {
  if (!obj || typeof obj !== 'object' || typeof obj.$ref !== 'string' || !obj.$ref.startsWith('#/')) return obj;
  let node = spec;
  for (const part of obj.$ref.slice(2).split('/')) {
    node = node ? node[part.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined;
  }
  return node || obj;
};

/** Operation parameters with path-level ones merged in (operation wins), $refs resolved. */
const effectiveParams = (spec, pathParams = [], opParams = []) => {
  const byKey = new Map();
  for (const raw of [...pathParams, ...opParams]) {
    const p = resolveRef(spec, raw);
    if (!p || !p.name || !p.in) continue;
    byKey.set(`${p.in}:${p.in === 'header' ? p.name.toLowerCase() : p.name}`, p);
  }
  return [...byKey.values()];
};

const defaultValue = (p) => {
  if (p.example !== undefined) return p.example;
  if (p.schema && p.schema.example !== undefined) return p.schema.example;
  if (p.schema && p.schema.default !== undefined) return p.schema.default;
  if (p.examples && typeof p.examples === 'object') {
    const first = Object.values(p.examples)[0];
    if (first && first.value !== undefined) return first.value;
  }
  return '';
};

const JSON_TYPES = ['application/json', 'application/*+json'];

const defaultBody = (spec, op) => {
  const rb = resolveRef(spec, op.requestBody);
  if (!rb || !rb.content) return { mode: 'none' };
  const types = Object.keys(rb.content);
  const jsonType = types.find((t) => t === 'application/json' || /\+json$/.test(t));
  if (jsonType) {
    const media = rb.content[jsonType] || {};
    let example = media.example;
    if (example === undefined && media.examples) {
      const first = Object.values(media.examples)[0];
      example = first && first.value;
    }
    if (example === undefined && media.schema) example = resolveRef(spec, media.schema).example;
    return { mode: 'json', json: example === undefined ? '' : JSON.stringify(example, null, 2) };
  }
  if (types.includes('application/x-www-form-urlencoded')) return { mode: 'formUrlEncoded', formUrlEncoded: [] };
  if (types.includes('multipart/form-data')) return { mode: 'multipartForm', multipartForm: [] };
  if (types.some((t) => t.includes('xml'))) return { mode: 'xml', xml: '' };
  return { mode: 'text', text: '' };
};

const contentTypeForBody = (mode) =>
  ({
    json: 'application/json',
    xml: 'application/xml',
    text: 'text/plain',
    formUrlEncoded: 'application/x-www-form-urlencoded',
    multipartForm: 'multipart/form-data',
    graphql: 'application/json'
  })[mode];

const findEntry = (list, type, name) =>
  (list || []).find((e) => (e.type || 'header') === type && (type === 'header' ? e.name.toLowerCase() === name.toLowerCase() : e.name === name));

/**
 * The Bruno request for one operation.
 * @param {object} args
 * @param {object} args.spec    the whole spec as plain JS (for $refs)
 * @param {object} args.op      { path, method, operation, pathParams }
 * @param {object} [args.client] contents of the operation's .client file
 * @param {number} args.seq     default position in its folder
 */
const toBrunoRequest = ({ spec, op, client = {}, seq }) => {
  const operation = op.operation || {};
  const params = effectiveParams(spec, op.pathParams, operation.parameters);

  const brunoParams = [];
  const seen = new Set();
  for (const p of params) {
    if (p.in !== 'query' && p.in !== 'path') continue;
    const c = findEntry(client.params, p.in, p.name);
    brunoParams.push({
      name: p.name,
      value: c ? str(c.value) : str(defaultValue(p)),
      enabled: c ? c.enabled !== false : p.in === 'path' || !!p.required,
      type: p.in
    });
    seen.add(`${p.in}:${p.name}`);
  }
  // Path template variables the spec forgot to declare still need a value slot.
  for (const name of templateParams(op.path)) {
    if (seen.has(`path:${name}`)) continue;
    const c = findEntry(client.params, 'path', name);
    brunoParams.push({ name, value: c ? str(c.value) : '', enabled: true, type: 'path' });
  }

  const headers = [];
  for (const p of params) {
    if (p.in !== 'header' || IGNORED_HEADER_PARAMS.has(p.name.toLowerCase())) continue;
    const c = findEntry(client.headers, 'header', p.name);
    headers.push({ name: p.name, value: c ? str(c.value) : str(defaultValue(p)), enabled: c ? c.enabled !== false : !!p.required });
  }
  for (const h of client.headers || []) {
    if (!headers.some((x) => x.name.toLowerCase() === h.name.toLowerCase())) {
      headers.push({ name: h.name, value: str(h.value), enabled: h.enabled !== false });
    }
  }

  const query = brunoParams
    .filter((p) => p.type === 'query' && p.enabled)
    .map((p) => (p.value === '' ? p.name : `${p.name}=${p.value}`))
    .join('&');
  const url = `${client.baseUrl || BASE_URL_VAR}${toBrunoPath(op.path)}${query ? `?${query}` : ''}`;

  return {
    type: 'http-request',
    name: operation.summary || operation.operationId,
    seq: client.seq !== undefined ? client.seq : seq,
    settings: client.settings || {},
    tags: client.tags || [],
    request: {
      method: op.method.toUpperCase(),
      url,
      params: brunoParams,
      headers,
      auth: client.auth || { mode: 'inherit' },
      body: client.body || defaultBody(spec, operation),
      script: client.script || {},
      vars: client.vars || {},
      assertions: client.assertions || [],
      tests: client.tests || '',
      docs: operation.description || ''
    },
    examples: client.examples || []
  };
};

/** Split a Bruno URL into base (variable or origin) and spec-style path. */
const parseBrunoUrl = (url) => {
  let rest = String(url || '').trim();
  const q = rest.indexOf('?');
  if (q >= 0) rest = rest.slice(0, q);
  let base = '';
  const varMatch = rest.match(/^\{\{[^}]+\}\}/);
  if (varMatch) {
    base = varMatch[0];
    rest = rest.slice(base.length);
  } else {
    const originMatch = rest.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i);
    if (originMatch) {
      base = originMatch[0];
      rest = rest.slice(base.length);
    }
  }
  if (!rest.startsWith('/')) rest = `/${rest}`;
  if (rest.length > 1) rest = rest.replace(/\/+$/, '');
  return { base, path: toSpecPath(rest) };
};

const isEmpty = (v) =>
  v === undefined
  || v === null
  || v === ''
  || (Array.isArray(v) && v.length === 0)
  || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Bodies are equal when the active mode and its content match. Bruno's file format
 * carries empty slots for the other modes, which must not count as a change.
 */
const sameBody = (a = {}, b = {}) => {
  const modeA = a.mode || 'none';
  const modeB = b.mode || 'none';
  if (modeA !== modeB) return false;
  if (modeA === 'none') return true;
  const norm = (v) => (typeof v === 'string' ? v.trim() : JSON.stringify(v === undefined ? null : v));
  const empty = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
  if (empty(a[modeA]) && empty(b[modeB])) return true;
  return norm(a[modeA]) === norm(b[modeB]);
};

/** Keep only the parts of a Bruno script/vars object that hold something. */
const compact = (obj) => {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (!isEmpty(v)) out[k] = v;
  return out;
};

const camel = (text) => {
  const words = String(text || '')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return 'operation';
  const id = words.map((w, i) => (i === 0 ? w[0].toLowerCase() + w.slice(1) : w[0].toUpperCase() + w.slice(1))).join('');
  return /^[0-9]/.test(id) ? `op${id}` : id;
};

/** Stable operationId for an operation that has none, from method and path. */
const operationIdFor = (method, p) =>
  camel(`${method} ${p.replace(/\{([^}]+)\}/g, 'by $1')}`);

const uniqueOperationId = (wanted, taken) => {
  let id = wanted;
  let n = 2;
  while (taken.has(id)) id = `${wanted}${n++}`;
  return id;
};

/**
 * Apply an edited Bruno request to the spec and work out its client file.
 *
 * @param {SpecDoc} specDoc
 * @param {object} args
 * @param {object|null} args.from  the operation's current { path, method } (null for a new one)
 * @param {string} args.operationId
 * @param {object} args.item       Bruno request JSON
 * @param {string|null} args.folder tag name for the request's folder, or null at the root
 * @param {number} args.seq        default position, for deciding whether to store seq
 * @returns {{ path, method, client }} where client is the client-file object (empty when not needed)
 */
const applyBrunoRequest = (specDoc, { from, operationId, item, folder, seq }) => {
  const req = item.request || {};
  const { base, path: newPath } = parseBrunoUrl(req.url);
  const newMethod = String(req.method || 'GET').toLowerCase();
  const opKeys = ['paths', newPath, newMethod];

  if (from && (from.path !== newPath || from.method !== newMethod)) {
    if (specDoc.has(opKeys)) {
      throw new Error(`${newMethod.toUpperCase()} ${newPath} already exists in the spec`);
    }
    specDoc.move(['paths', from.path, from.method], opKeys);
    // Drop the old path item when nothing but its parameters is left.
    const oldItem = specDoc.get(['paths', from.path]);
    if (oldItem && Object.keys(oldItem).every((k) => k === 'parameters' || k.startsWith('x-') || k === 'summary' || k === 'description')) {
      if (!Object.keys(oldItem).some((k) => ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'].includes(k))) {
        specDoc.delete(['paths', from.path]);
      }
    }
  } else if (!from) {
    if (specDoc.has(opKeys)) throw new Error(`${newMethod.toUpperCase()} ${newPath} already exists in the spec`);
    specDoc.set(opKeys, { operationId, responses: { 200: { description: 'OK' } } });
  }

  const opNow = () => specDoc.get(opKeys) || {};
  if (opNow().operationId !== operationId) specDoc.set([...opKeys, 'operationId'], operationId);

  // Name, docs, folder.
  const shownName = opNow().summary || opNow().operationId;
  if (item.name && item.name !== shownName) specDoc.set([...opKeys, 'summary'], item.name);
  const docs = req.docs || '';
  if (docs !== (opNow().description || '')) {
    if (docs) specDoc.set([...opKeys, 'description'], docs);
    else specDoc.delete([...opKeys, 'description']);
  }
  const tags = opNow().tags || [];
  if ((folder || null) !== (tags[0] || null)) {
    // The first tag is the folder; any further tags are kept as they are.
    const rest = tags.slice(1).filter((t) => t !== folder);
    const next = folder ? [folder, ...rest] : rest;
    if (next.length) specDoc.set([...opKeys, 'tags'], next);
    else specDoc.delete([...opKeys, 'tags']);
    if (folder) ensureTag(specDoc, folder);
  }

  // Parameters. Only operation-level, non-$ref parameters are added or removed here.
  syncParameters(specDoc, opKeys, newPath, req);

  // A body sent from Bruno implies the operation takes one.
  const bodyMode = req.body && req.body.mode;
  if (bodyMode && bodyMode !== 'none' && !opNow().requestBody) {
    const ctype = contentTypeForBody(bodyMode);
    if (ctype) specDoc.set([...opKeys, 'requestBody'], { content: { [ctype]: {} } });
  }

  // Client file: whatever differs from what the (updated) spec implies.
  const spec = specDoc.toJS();
  const op = {
    path: newPath,
    method: newMethod,
    operation: spec.paths[newPath][newMethod],
    pathParams: spec.paths[newPath].parameters || []
  };
  const derived = toBrunoRequest({ spec, op, client: {}, seq });
  const client = {};

  if (base && base !== BASE_URL_VAR) client.baseUrl = base;

  const params = [];
  for (const p of req.params || []) {
    const d = derived.request.params.find((x) => x.type === p.type && x.name === p.name);
    if (!d || d.value !== str(p.value) || d.enabled !== (p.enabled !== false)) {
      params.push({ name: p.name, type: p.type, value: str(p.value), ...(p.enabled === false ? { enabled: false } : {}) });
    }
  }
  if (params.length) client.params = params;

  const headers = [];
  for (const h of req.headers || []) {
    const d = derived.request.headers.find((x) => x.name.toLowerCase() === String(h.name).toLowerCase());
    if (!d || d.value !== str(h.value) || d.enabled !== (h.enabled !== false)) {
      headers.push({ name: h.name, value: str(h.value), ...(h.enabled === false ? { enabled: false } : {}) });
    }
  }
  if (headers.length) client.headers = headers;

  if (req.body && !sameBody(req.body, derived.request.body)) {
    client.body = { mode: req.body.mode, ...(req.body[req.body.mode] !== undefined ? { [req.body.mode]: req.body[req.body.mode] } : {}) };
  }
  if (req.auth && req.auth.mode && req.auth.mode !== 'inherit') client.auth = req.auth;
  const script = compact(req.script);
  if (!isEmpty(script)) client.script = script;
  const vars = compact(req.vars);
  if (!isEmpty(vars)) client.vars = vars;
  if (!isEmpty(req.assertions)) client.assertions = req.assertions;
  if (!isEmpty(req.tests)) client.tests = req.tests;
  if (!isEmpty(item.settings)) client.settings = item.settings;
  if (!isEmpty(item.tags)) client.tags = item.tags;
  if (!isEmpty(item.examples)) client.examples = item.examples;
  if (item.seq !== undefined && item.seq !== seq) client.seq = item.seq;

  return { path: newPath, method: newMethod, client };
};

const ensureTag = (specDoc, name) => {
  const tags = specDoc.get(['tags']) || [];
  if (!tags.some((t) => t && t.name === name)) specDoc.set(['tags'], [...tags, { name }]);
};

const syncParameters = (specDoc, opKeys, specPath, req) => {
  const spec = specDoc.toJS();
  const pathItem = spec.paths[specPath] || {};
  const operation = pathItem[opKeys[2]] || {};
  const opParams = operation.parameters || [];
  const declared = effectiveParams(spec, pathItem.parameters, opParams);
  const isDeclared = (inn, name) =>
    declared.some((p) => p.in === inn && (inn === 'header' ? p.name.toLowerCase() === name.toLowerCase() : p.name === name));

  const wantedQuery = (req.params || []).filter((p) => p.type === 'query').map((p) => p.name);
  const wantedPath = templateParams(specPath);
  const wantedHeaders = (req.headers || []).map((h) => String(h.name).toLowerCase());

  const next = [];
  for (const raw of opParams) {
    if (raw && raw.$ref) {
      next.push(raw); // shared parameters are never removed from here
      continue;
    }
    if (raw.in === 'query' && !wantedQuery.includes(raw.name)) continue;
    if (raw.in === 'path' && !wantedPath.includes(raw.name)) continue;
    if (raw.in === 'header' && !IGNORED_HEADER_PARAMS.has(raw.name.toLowerCase()) && !wantedHeaders.includes(raw.name.toLowerCase())) continue;
    next.push(raw);
  }
  for (const name of wantedPath) {
    if (!isDeclared('path', name)) next.push({ name, in: 'path', required: true, schema: { type: 'string' } });
  }
  for (const name of wantedQuery) {
    if (!isDeclared('query', name) && !next.some((p) => p.in === 'query' && p.name === name)) {
      next.push({ name, in: 'query', schema: { type: 'string' } });
    }
  }

  if (!same(next, opParams)) {
    if (next.length) specDoc.set([...opKeys, 'parameters'], next);
    else specDoc.delete([...opKeys, 'parameters']);
  }
};

module.exports = {
  toBrunoRequest,
  applyBrunoRequest,
  parseBrunoUrl,
  operationIdFor,
  uniqueOperationId,
  camel,
  effectiveParams,
  toBrunoPath,
  toSpecPath,
  BASE_URL_VAR
};
