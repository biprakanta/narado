/**
 * Loading and saving OpenAPI specs without disturbing their formatting (design §6.3).
 *
 * Edits are made on a parsed `yaml` Document. Saving does not simply re-serialise the
 * document, because no serialiser reproduces every author's style (for example a spec
 * mixing `{ a: 1 }` and `{a: 1}`). Instead:
 *   1. serialise the document as loaded (A') and as edited (B'),
 *   2. diff A' against B' line by line, which isolates the real edit,
 *   3. apply that diff to the original text, so untouched lines stay byte-for-byte.
 */
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const SPEC_FILES = ['openapi.yaml', 'openapi.yml', 'openapi.json'];
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

const findSpec = (dir) => {
  for (const name of SPEC_FILES) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
};

/* ------------------------------------------------------------- line diff */

/**
 * Line-level edit script from `a` to `b`: a list of { aStart, aEnd, b: [...] } hunks
 * (replace a[aStart, aEnd) with b lines). Trims the common prefix and suffix, then runs
 * an LCS on the middle. Returns null when the middle is too large to diff cheaply.
 */
const diffLines = (a, b, maxCells = 4_000_000) => {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const m = endA - start;
  const n = endB - start;
  if (m === 0 && n === 0) return [];
  if (m === 0 || n === 0) return [{ aStart: start, aEnd: endA, b: b.slice(start, endB) }];
  if (m * n > maxCells) return null;

  // LCS table over the middle section.
  const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[start + i] === b[start + j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const hunks = [];
  let i = 0;
  let j = 0;
  let cur = null;
  const flush = () => {
    if (cur) hunks.push(cur);
    cur = null;
  };
  while (i < m || j < n) {
    if (i < m && j < n && a[start + i] === b[start + j]) {
      flush();
      i++;
      j++;
    } else if (j < n && (i === m || dp[i][j + 1] >= dp[i + 1][j])) {
      cur = cur || { aStart: start + i, aEnd: start + i, b: [] };
      cur.b.push(b[start + j]);
      j++;
    } else {
      cur = cur || { aStart: start + i, aEnd: start + i, b: [] };
      cur.aEnd = start + i + 1;
      i++;
    }
  }
  flush();
  return hunks;
};

const applyHunks = (lines, hunks) => {
  const out = [];
  let pos = 0;
  for (const h of hunks) {
    out.push(...lines.slice(pos, h.aStart), ...h.b);
    pos = h.aEnd;
  }
  out.push(...lines.slice(pos));
  return out;
};

/* ------------------------------------------------------------- spec doc */

const YAML_STYLES = [
  { lineWidth: 0, flowCollectionPadding: false },
  { lineWidth: 0, flowCollectionPadding: true },
  { lineWidth: 0, flowCollectionPadding: false, indentSeq: false },
  { lineWidth: 0, flowCollectionPadding: true, indentSeq: false }
];

const countSameLines = (a, b) => {
  let same = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] === b[i]) same++;
  return same;
};

class SpecDoc {
  constructor(text, { json = false } = {}) {
    this.original = text;
    this.json = json;
    this.doc = YAML.parseDocument(text, { keepSourceTokens: false, uniqueKeys: false });
    if (this.doc.errors.length) {
      throw new Error(`The spec is not valid ${json ? 'JSON' : 'YAML'}: ${this.doc.errors[0].message}`);
    }
    this.dirty = false;
    if (json) {
      const m = text.match(/\n([ \t]+)"/);
      this.indent = m ? m[1] : '  ';
    } else {
      // Pick the serialiser style closest to the author's, to keep diffs small.
      const lines = text.split('\n');
      let best = YAML_STYLES[0];
      let bestScore = -1;
      for (const style of YAML_STYLES) {
        const score = countSameLines(lines, this.doc.toString(style).split('\n'));
        if (score > bestScore) {
          best = style;
          bestScore = score;
        }
      }
      this.style = best;
    }
    this.baseline = this.serialise();
  }

  static load(file) {
    return new SpecDoc(fs.readFileSync(file, 'utf8'), { json: file.endsWith('.json') });
  }

  serialise() {
    if (this.json) return JSON.stringify(this.doc.toJS(), null, this.indent) + '\n';
    return this.doc.toString(this.style);
  }

  /** Spec as plain JavaScript (for reading). */
  toJS() {
    return this.doc.toJS();
  }

  get(keys) {
    const v = this.doc.getIn(keys, false);
    return v && typeof v.toJSON === 'function' ? v.toJSON() : v;
  }

  has(keys) {
    return this.doc.hasIn(keys);
  }

  /** Set a value only when it differs, so unchanged saves leave the file untouched. */
  set(keys, value) {
    const current = this.get(keys);
    if (JSON.stringify(current) === JSON.stringify(value)) return false;
    this.doc.setIn(keys, value);
    this.dirty = true;
    return true;
  }

  delete(keys) {
    if (!this.doc.hasIn(keys)) return false;
    this.doc.deleteIn(keys);
    this.dirty = true;
    return true;
  }

  /** Move a node, keeping its contents (and comments inside it) intact. */
  move(fromKeys, toKeys) {
    const node = this.doc.getIn(fromKeys, true);
    if (node === undefined) return false;
    this.doc.deleteIn(fromKeys);
    this.doc.setIn(toKeys, node);
    this.dirty = true;
    return true;
  }

  /** The spec's text after edits, changing only the lines the edits touched. */
  toString() {
    if (!this.dirty) return this.original;
    const after = this.serialise();
    const origLines = this.original.split('\n');
    const baseLines = this.baseline.split('\n');
    const afterLines = after.split('\n');
    // The patch maps cleanly only when the baseline lines up with the original line for line.
    if (origLines.length !== baseLines.length) return after;
    const hunks = diffLines(baseLines, afterLines);
    if (!hunks) return after;
    return applyHunks(origLines, hunks).join('\n');
  }

  /** Every operation in document order: { path, method, operation, pathParams }. */
  operations() {
    const paths = this.get(['paths']) || {};
    const out = [];
    for (const [p, item] of Object.entries(paths)) {
      if (!item || typeof item !== 'object') continue;
      for (const method of Object.keys(item)) {
        if (!HTTP_METHODS.includes(method)) continue;
        out.push({ path: p, method, operation: item[method] || {}, pathParams: item.parameters || [] });
      }
    }
    return out;
  }

  version() {
    return String(this.get(['openapi']) || this.get(['swagger']) || '');
  }
}

module.exports = { SpecDoc, findSpec, diffLines, applyHunks, HTTP_METHODS, SPEC_FILES };
