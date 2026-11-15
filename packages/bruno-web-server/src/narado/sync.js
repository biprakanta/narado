/**
 * Sync: a personal copy of a repo's collection in the person's own workspace.
 *
 * One action, no branches: narado reads the collection from the repo's default branch
 * and copies it to <data>/synced/<host>/<repo>/<folder>, where it opens as an ordinary
 * collection. Edits to the copy are the person's own and never go back to Git.
 *
 * Syncing again brings in what changed on the default branch, file by file:
 *   - files the person hasn't touched since the last sync are updated or removed;
 *   - files they edited are kept as they are (and reported), so a sync never loses work;
 *   - files they deleted stay deleted.
 *
 * A copy keeps its repo for safety: request rules (the repo's allowlist) and secrets rules
 * treat it as part of the repo it came from (sourceOf).
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const hash = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
// The view's sync bookkeeping (.narado-view.json) belongs to the repo's view, not the copy.
const SKIP = new Set(['.git', 'node_modules', '.narado-view.json']);

/** Every file under `dir`, as forward-slash relative paths. */
const listFiles = (dir) => {
  const out = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (e.isFile()) out.push(r);
    }
  };
  if (fs.existsSync(dir)) walk(dir, '');
  return out.sort();
};

class SyncManager {
  constructor({ dataDir }) {
    this.root = path.join(dataDir, 'synced');
    this.stateFile = path.join(dataDir, 'synced-state.json');
    this.state = this.load();
  }

  load() {
    try {
      const s = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      if (s && s.version === 1) return s;
    } catch {}
    return { version: 1, copies: {} };
  }

  save() {
    const tmp = `${this.stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 1));
    fs.renameSync(tmp, this.stateFile);
  }

  /** Where the copy of `dir` in a repo lives. One folder per repo and collection. */
  targetFor(hostId, repoPath, dir) {
    if (!/^[A-Za-z0-9_-]+$/.test(hostId)) throw new Error('Invalid host id');
    return path.join(this.root, hostId, encodeURIComponent(repoPath), dir ? encodeURIComponent(dir) : '_root');
  }

  /** The repo a synced copy came from, for request and secrets rules; null for other paths. */
  sourceOf(somePath) {
    const rel = path.relative(this.root, path.resolve(String(somePath || '')));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    const [hostId, encRepo, encDir] = rel.split(path.sep);
    if (!hostId || !encRepo || !encDir) return null;
    let repoPath;
    try {
      repoPath = decodeURIComponent(encRepo);
    } catch {
      return null;
    }
    return { hostId, repoPath, synced: true, path: path.join(this.root, hostId, encRepo, encDir) };
  }

  /** Copies made so far, newest sync first. */
  list() {
    return Object.entries(this.state.copies)
      .map(([key, c]) => ({ ...c, path: path.join(this.root, ...key.split('/')), exists: fs.existsSync(path.join(this.root, ...key.split('/'))) }))
      .filter((c) => c.exists)
      .map(({ files, exists, ...c }) => c)
      .sort((a, b) => b.syncedAt - a.syncedAt);
  }

  /**
   * Bring the copy up to date with `sourceDir` (the collection as it is on the default
   * branch). `rename(relPath, buffer)` may change a file on the way (the collection name).
   */
  sync({ hostId, repoPath, dir, sourceDir, name, commit, branch }) {
    const target = this.targetFor(hostId, repoPath, dir);
    const key = path.relative(this.root, target).split(path.sep).join('/');
    const prev = this.state.copies[key];
    const before = prev ? prev.files : {};
    const files = {};
    const result = { added: 0, updated: 0, removed: 0, kept: [], first: !prev };
    fs.mkdirSync(target, { recursive: true });

    const upstream = listFiles(sourceDir);
    for (const rel of upstream) {
      let content = fs.readFileSync(path.join(sourceDir, ...rel.split('/')));
      if (rel === 'bruno.json') content = this.nameCopy(content, name);
      const want = hash(content);
      const dest = path.join(target, ...rel.split('/'));
      const have = fs.existsSync(dest) ? hash(fs.readFileSync(dest)) : null;
      const last = before[rel];
      if (have === want) {
        files[rel] = want;
      } else if (have === null && last) {
        // The person deleted it from their copy: leave it deleted.
        files[rel] = last;
      } else if (have === null || have === last) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, content);
        files[rel] = want;
        if (have === null) result.added++;
        else result.updated++;
      } else {
        // Edited in the copy since the last sync (or before the first one): keep theirs.
        files[rel] = last || null;
        result.kept.push(rel);
      }
    }
    // Gone from the repo: remove from the copy unless the person changed it.
    const now = new Set(upstream);
    for (const [rel, last] of Object.entries(before)) {
      if (now.has(rel)) continue;
      const dest = path.join(target, ...rel.split('/'));
      if (!fs.existsSync(dest)) continue;
      if (hash(fs.readFileSync(dest)) === last) {
        fs.rmSync(dest);
        result.removed++;
      } else {
        result.kept.push(rel);
      }
    }

    this.state.copies[key] = { hostId, repoPath, dir: dir || '', name, commit, branch, syncedAt: Date.now(), files };
    this.save();
    return { path: target, name: this.copyName(name), commit, ...result };
  }

  copyName(name) {
    return `${name} (synced)`;
  }

  /** The copy's bruno.json, named so it can't be mistaken for the repo's own collection. */
  nameCopy(content, name) {
    try {
      const cfg = JSON.parse(content.toString('utf8'));
      cfg.name = this.copyName(name || cfg.name || 'Collection');
      return Buffer.from(JSON.stringify(cfg, null, 2) + '\n');
    } catch {
      return content;
    }
  }
}

module.exports = { SyncManager, listFiles };
