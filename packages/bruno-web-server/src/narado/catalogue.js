/**
 * The API catalogue: which of a person's repositories hold collections, and where.
 *
 * Found through the Git host's API, as the person (their own token), without cloning:
 * one file listing per repository (GitHub's tree API, GitLab's repository tree), then
 * the collection files themselves for names. Results are cached in the person's folder
 * per repository, keyed by its default branch and last push, so a rescan only looks at
 * repositories that changed.
 *
 * A collection is a folder holding:
 *   - bruno.json or opencollection.yml (a Bruno collection), or
 *   - openapi.yaml, openapi.yml or openapi.json (narado's OpenAPI storage, with its
 *     .client/ folder next to it).
 * A repository whose collection is at its root is an "API repo"; one whose collections
 * are in subfolders is "code + API" (a service repository carrying its own API).
 */
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const BRUNO_MARKERS = ['bruno.json', 'opencollection.yml'];
const SPEC_FILES = ['openapi.yaml', 'openapi.yml', 'openapi.json'];
// Folders that hold copies, generated output or other people's code, not a team's API.
const SKIP_DIRS = new Set(['node_modules', 'vendor', 'third_party', 'dist', 'build', 'target', 'out', '.git', 'bower_components']);
const MAX_COLLECTIONS_PER_REPO = 20;
const CACHE_VERSION = 1;

/** Collections in a list of file paths: [{ dir, kind, file }], outermost first. */
const collectionsInTree = (files) => {
  const found = new Map(); // dir -> { dir, kind, file }
  for (const f of files) {
    const parts = f.split('/');
    const base = parts.pop();
    if (parts.some((p) => SKIP_DIRS.has(p) || (p.startsWith('.') && p !== '.client'))) continue;
    const dir = parts.join('/');
    if (BRUNO_MARKERS.includes(base)) found.set(dir, { dir, kind: 'bruno', file: f });
    else if (SPEC_FILES.includes(base) && !(found.get(dir) && found.get(dir).kind === 'bruno')) {
      const prev = found.get(dir);
      // Prefer openapi.yaml over .yml over .json, as findSpec does.
      if (!prev || SPEC_FILES.indexOf(base) < SPEC_FILES.indexOf(path.basename(prev.file))) found.set(dir, { dir, kind: 'openapi', file: f });
    }
  }
  // A collection inside another Bruno collection is part of it (a folder of requests).
  const dirs = [...found.keys()].sort((a, b) => a.length - b.length || a.localeCompare(b));
  const out = [];
  for (const d of dirs) {
    const inside = out.some((o) => o.kind === 'bruno' && (o.dir === '' || d.startsWith(`${o.dir}/`)));
    if (!inside) out.push(found.get(d));
  }
  return out;
};

const shapeOf = (collections) => (!collections.length ? 'none' : collections.some((c) => c.dir === '') ? 'api' : 'code+api');

/** A collection's display name from its marker file. */
const nameFrom = (c, text) => {
  try {
    if (c.kind === 'bruno') {
      const doc = c.file.endsWith('.json') ? JSON.parse(text) : YAML.parse(text);
      return (doc && (doc.name || (doc.info && doc.info.name))) || null;
    }
    const doc = c.file.endsWith('.json') ? JSON.parse(text) : YAML.parse(text);
    return (doc && doc.info && doc.info.title) || null;
  } catch {
    return null;
  }
};

/** Run `fn` over `items`, at most `limit` at a time. */
const pool = async (items, limit, fn) => {
  let i = 0;
  const run = async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
};

class Catalogue {
  /**
   * @param {object} o
   * @param {object} o.registry   ProviderRegistry acting as the person
   * @param {string} o.dataDir    the person's folder (cache file)
   */
  constructor({ registry, dataDir, concurrency = 6, log = console }) {
    this.registry = registry;
    this.file = path.join(dataDir, 'catalogue.json');
    this.concurrency = concurrency;
    this.log = log;
    this.scans = new Map(); // hostId -> { promise, total, done, errors, startedAt }
    this.cache = this.load();
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (data.version === CACHE_VERSION) return data;
    } catch {}
    return { version: CACHE_VERSION, hosts: {} };
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.cache));
    fs.renameSync(tmp, this.file);
  }

  hostCache(hostId) {
    if (!this.cache.hosts[hostId]) this.cache.hosts[hostId] = { repos: {}, listedAt: null };
    return this.cache.hosts[hostId];
  }

  /** Look one repository up and remember its collections. */
  async scanRepo(provider, repo) {
    const ref = repo.defaultBranch;
    const { files, truncated } = await provider.listFiles(repo.path, ref);
    const collections = collectionsInTree(files).slice(0, MAX_COLLECTIONS_PER_REPO);
    for (const c of collections) {
      c.name = nameFrom(c, await provider.readFile(repo.path, ref, c.file).catch(() => '')) || (c.dir ? path.basename(c.dir) : repo.name);
    }
    return { key: `${ref}@${repo.updatedAt}`, collections, truncated, scannedAt: Date.now() };
  }

  /**
   * Start (or join) a scan of the person's repositories on a host. Only repositories
   * that changed since they were last looked at are read again.
   */
  scan(hostId, { force = false } = {}) {
    const running = this.scans.get(hostId);
    if (running && !running.finished) return running;
    const state = { total: 0, done: 0, errors: [], startedAt: Date.now(), finished: false, repos: null };
    state.promise = (async () => {
      const provider = this.registry.get(hostId);
      const list = await provider.listRepos();
      const hc = this.hostCache(hostId);
      state.repos = list;
      hc.listedAt = Date.now();
      hc.list = list.map((r) => ({
        path: r.path,
        name: r.name,
        description: r.description,
        private: r.private,
        access: r.access,
        defaultBranch: r.defaultBranch,
        updatedAt: r.updatedAt,
        webUrl: r.webUrl
      }));
      const todo = list.filter((r) => r.defaultBranch && (force || !hc.repos[r.path] || hc.repos[r.path].key !== `${r.defaultBranch}@${r.updatedAt}`));
      state.total = todo.length;
      let stop = null;
      await pool(todo, this.concurrency, async (r) => {
        if (stop) return;
        try {
          hc.repos[r.path] = await this.scanRepo(provider, r);
        } catch (err) {
          // An empty repository has no tree; anything else is reported.
          if (err.status === 409 || err.status === 404) hc.repos[r.path] = { key: `${r.defaultBranch}@${r.updatedAt}`, collections: [], truncated: false, scannedAt: Date.now() };
          else state.errors.push(`${r.path}: ${err.message}`);
          if (err.status === 403 || err.status === 429) stop = err; // rate limited: try again later
        }
        state.done++;
      });
      // Forget repositories the person no longer sees.
      const seen = new Set(list.map((r) => r.path));
      for (const k of Object.keys(hc.repos)) if (!seen.has(k)) delete hc.repos[k];
      this.save();
      if (stop) state.errors.unshift(`${provider.name} asked narado to slow down; the rest are looked at next time.`);
    })()
      .catch((err) => state.errors.unshift(err.message))
      .finally(() => {
        state.finished = true;
      });
    this.scans.set(hostId, state);
    return state;
  }

  /** What is known now, plus scan progress. Starts a scan when nothing is known or it is stale. */
  get(hostId, { maxAgeMs = 10 * 60 * 1000 } = {}) {
    const hc = this.hostCache(hostId);
    const scan = this.scans.get(hostId);
    if ((!scan || scan.finished) && (!hc.listedAt || Date.now() - hc.listedAt > maxAgeMs)) this.scan(hostId);
    const current = this.scans.get(hostId);
    const repos = [];
    let withoutCollections = 0;
    for (const r of hc.list || []) {
      const info = hc.repos[r.path];
      if (!info) continue;
      if (!info.collections.length) {
        withoutCollections++;
        continue;
      }
      repos.push({ ...r, hostId, shape: shapeOf(info.collections), collections: info.collections.map(({ dir, kind, name }) => ({ dir, kind, name })), truncated: info.truncated });
    }
    repos.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    return {
      hostId,
      repos,
      withoutCollections,
      notYetScanned: (hc.list || []).filter((r) => !hc.repos[r.path]).length,
      scanning: !!(current && !current.finished),
      progress: current && !current.finished ? { done: current.done, total: current.total } : null,
      errors: current ? current.errors.slice(0, 5) : [],
      listedAt: hc.listedAt
    };
  }
}

module.exports = { Catalogue, collectionsInTree, shapeOf, nameFrom, SKIP_DIRS };
