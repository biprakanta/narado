/**
 * Projection: a normal Bruno collection ("the view", outside the repo) generated from
 * the repo's spec + .narado/ files, kept in sync both ways (design §6.4). The spec is the
 * file .narado/config.nar names, or openapi.yaml/.yml/.json; older collections keep their
 * files in .client/ instead of .narado/.
 *
 *   repo (spec, .narado/requests/*.yml)  <->  view (bruno.json, <tag>/<operationId>.bru)
 *
 * - Bruno opens and edits the view exactly as any collection.
 * - A saved view file is applied to the spec and its client file (mapping.js).
 * - When the repo files change (Git update, conflict resolution, a hand edit), the view
 *   is regenerated, touching only files whose content changed.
 * - Each side remembers the hash of what it last wrote, so neither reacts to its own
 *   writes and the two cannot ping-pong.
 * - GraphQL, gRPC and WebSocket requests have no place in OpenAPI: they are kept as Bruno
 *   files in .narado/extra/, at the same path as in the view. gRPC proto files and import
 *   paths come from config.nar (grpc:), and choosing them in the collection's settings
 *   writes them back there.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { parseRequest, stringifyRequest, stringifyEnvironment } = require('@usebruno/filestore');
const { SpecDoc, findSpec } = require('./spec');
const { dataDirName, readConfig, writeGrpcConfig, CONFIG_FILE } = require('./config');
const { toBrunoRequest, applyBrunoRequest, operationIdFor, uniqueOperationId, camel, parseBrunoUrl } = require('./mapping');
const { upgradeTo31 } = require('./upgrade');

const STATE_FILE = '.narado-view.json';
const DEBOUNCE_MS = 250;

const hash = (text) => crypto.createHash('sha1').update(text).digest('hex');

/** A Bruno file's request type from its meta block: http, graphql, grpc or ws. */
const requestTypeOf = (text) => {
  const meta = /(?:^|\n)meta\s*\{([\s\S]*?)\n\}/.exec(String(text));
  const m = meta && /\btype:\s*([\w-]+)/.exec(meta[1]);
  return m ? m[1].toLowerCase() : 'http';
};
const isExtraType = (type) => ['graphql', 'grpc', 'ws', 'websocket'].includes(type);
const toPosix = (p) => p.split(path.sep).join('/');

/** Folder name for a tag (tags can hold characters folders cannot). */
const folderFor = (tag) => (tag ? tag.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'untitled' : null);

const writeIfChanged = (file, content) => {
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return true;
};

class Projection {
  /**
   * @param {object} opts
   * @param {string} opts.repoDir  the working copy (holds openapi.yaml)
   * @param {string} opts.viewDir  where the Bruno collection is generated
   */
  constructor({ repoDir, viewDir, root = repoDir, log = console }) {
    this.repoDir = repoDir;
    // The working copy's root: proto files may sit anywhere in it, never outside.
    this.root = root;
    this.viewDir = viewDir;
    this.log = log;
    this.specPath = findSpec(repoDir);
    if (!this.specPath) throw new Error(`No OpenAPI spec in ${repoDir}: add .narado/config.nar naming it, or name it openapi.yaml`);
    // Request files: .narado/requests, or .client/requests for collections made before .narado.
    this.clientDir = path.join(dataDirName(repoDir), 'requests');
    this.extraDir = path.join(dataDirName(repoDir), 'extra');
    this.config = readConfig(repoDir);
    this.state = this.loadState();
    this.watchers = [];
    this.pending = new Map(); // view rel path -> 'change' | 'unlink'
    this.timer = null;
    this.busy = Promise.resolve();
  }

  /* -------------------------------------------------------------- state */

  loadState() {
    const file = path.join(this.viewDir, STATE_FILE);
    const empty = { files: {}, folders: {}, viewHashes: {}, repoHashes: {}, extras: {} };
    if (!fs.existsSync(file)) return empty;
    try {
      return { ...empty, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch {
      return empty;
    }
  }

  saveState() {
    writeIfChanged(path.join(this.viewDir, STATE_FILE), JSON.stringify(this.state, null, 2) + '\n');
  }

  /* ------------------------------------------------------- repo helpers */

  clientFile(operationId) {
    return path.join(this.repoDir, this.clientDir, `${operationId}.yml`);
  }

  readClient(operationId) {
    const file = this.clientFile(operationId);
    if (!fs.existsSync(file)) return {};
    try {
      return YAML.parse(fs.readFileSync(file, 'utf8')) || {};
    } catch (err) {
      this.log.warn(`[narado] ${path.relative(this.repoDir, file)} is not valid YAML: ${err.message}`);
      return {};
    }
  }

  writeRepoFile(file, content) {
    if (writeIfChanged(file, content)) {
      this.state.repoHashes[path.relative(this.repoDir, file)] = hash(content);
    }
  }

  writeClient(operationId, client) {
    const file = this.clientFile(operationId);
    const rel = path.relative(this.repoDir, file);
    if (!client || !Object.keys(client).length) {
      if (fs.existsSync(file)) {
        fs.rmSync(file);
        delete this.state.repoHashes[rel];
      }
      return;
    }
    const text = `# narado client data for operation ${operationId}. See docs/design.md §6.\n${YAML.stringify(client, { lineWidth: 0 })}`;
    this.writeRepoFile(file, text);
  }

  writeSpec(spec) {
    if (!spec.dirty) return;
    this.writeRepoFile(this.specPath, spec.toString());
  }

  /* ---------------------------------------------------------- repo -> view */

  /**
   * Regenerate the view from the repo. Returns the number of view files written or removed.
   * Operations without an operationId get one written into the spec first (design §6.3).
   */
  project() {
    const spec = SpecDoc.load(this.specPath);
    const js = spec.toJS();

    // Give every operation an operationId.
    const taken = new Set(spec.operations().map((o) => o.operation.operationId).filter(Boolean));
    for (const op of spec.operations()) {
      if (op.operation.operationId) continue;
      const id = uniqueOperationId(operationIdFor(op.method, op.path), taken);
      taken.add(id);
      spec.set(['paths', op.path, op.method, 'operationId'], id);
    }
    this.writeSpec(spec);
    const ops = spec.operations();
    const spec2 = spec.toJS();

    const desired = new Map();
    this.config = readConfig(this.repoDir);
    const brunoJson = { version: '1', name: (this.config && this.config.name) || (js.info && js.info.title) || path.basename(this.repoDir), type: 'collection', ignore: ['node_modules', '.git'] };
    const protobuf = this.protobufForView();
    if (protobuf) brunoJson.protobuf = protobuf;
    desired.set('bruno.json', JSON.stringify(brunoJson, null, 2) + '\n');

    const servers = Array.isArray(spec2.servers) && spec2.servers.length ? spec2.servers : [];
    servers.forEach((s, i) => {
      const name = (s.description || `Server ${i + 1}`).replace(/[\\/:*?"<>|]+/g, '-');
      desired.set(
        path.join('environments', `${name}.bru`),
        stringifyEnvironment({ name, variables: [{ name: 'baseUrl', value: s.url, enabled: true, secret: false, type: 'text' }] }, { format: 'bru' })
      );
    });

    const byOpId = Object.fromEntries(Object.entries(this.state.files).map(([rel, id]) => [id, rel]));
    const nextFiles = {};
    const folders = {};
    const seqInFolder = new Map();
    for (const op of ops) {
      const id = op.operation.operationId;
      const tag = (op.operation.tags || [])[0] || null;
      const folder = folderFor(tag);
      if (folder) folders[folder] = tag;
      const n = (seqInFolder.get(folder) || 0) + 1;
      seqInFolder.set(folder, n);

      const wanted = path.join(folder || '', `${id}.bru`);
      // Keep a file's existing name while it stays in the same folder (Bruno may have renamed it).
      const existing = byOpId[id];
      const rel = existing && path.dirname(existing) === (folder || '.') ? existing : wanted;
      const item = toBrunoRequest({ spec: spec2, op, client: this.readClient(id), seq: n });
      desired.set(rel, stringifyRequest(item, { format: 'bru' }));
      nextFiles[rel] = id;
    }

    // GraphQL, gRPC and WebSocket requests, stored as they are in .narado/extra/.
    const nextExtras = {};
    for (const rel of this.listExtras()) {
      if (desired.has(rel)) continue; // an operation's file wins over a same-named extra
      desired.set(rel, fs.readFileSync(path.join(this.repoDir, this.extraDir, rel), 'utf8'));
      nextExtras[rel] = true;
    }
    this.state.extras = nextExtras;

    let touched = 0;
    for (const [rel, content] of desired) {
      const file = path.join(this.viewDir, rel);
      if (writeIfChanged(file, content)) touched++;
      this.state.viewHashes[rel] = hash(content);
    }
    // Remove view files that no longer correspond to an operation.
    for (const rel of this.listViewRequests()) {
      if (!desired.has(rel)) {
        fs.rmSync(path.join(this.viewDir, rel));
        delete this.state.viewHashes[rel];
        touched++;
      }
    }
    this.removeEmptyFolders();
    this.state.files = nextFiles;
    this.state.folders = folders;
    this.state.repoHashes[path.relative(this.repoDir, this.specPath)] = hash(fs.readFileSync(this.specPath, 'utf8'));
    this.saveState();
    return touched;
  }

  /** Bruno files under .narado/extra/, as view-relative paths. */
  listExtras() {
    const base = path.join(this.repoDir, this.extraDir);
    const out = [];
    const walk = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.bru')) out.push(path.relative(base, p));
      }
    };
    walk(base);
    return out.sort();
  }

  /** A repo path from config.nar, if it stays inside the working copy. */
  repoPath(rel) {
    const abs = path.resolve(this.repoDir, rel);
    const inside = path.relative(this.root, abs);
    return inside.startsWith('..') || path.isAbsolute(inside) ? null : abs;
  }

  /** bruno.json's protobuf block: config.nar's paths, made relative to the view. */
  protobufForView() {
    const grpc = this.config && this.config.grpc;
    if (!grpc || (!grpc.protoFiles.length && !grpc.importPaths.length)) return null;
    const viewRel = (p) => {
      const abs = this.repoPath(p);
      if (!abs) {
        this.log.warn(`[narado] ${CONFIG_FILE}: ${p} is outside the repository; ignored`);
        return null;
      }
      return toPosix(path.relative(this.viewDir, abs));
    };
    const protoFiles = grpc.protoFiles.map(viewRel).filter(Boolean).map((p) => ({ path: p, type: 'file' }));
    const importPaths = grpc.importPaths.map(viewRel).filter(Boolean).map((p) => ({ path: p, enabled: true }));
    return protoFiles.length || importPaths.length ? { protoFiles, importPaths } : null;
  }

  /** Proto settings chosen in the collection's settings: write them to config.nar. */
  applyBrunoJson() {
    const file = path.join(this.viewDir, 'bruno.json');
    if (!fs.existsSync(file)) return 0;
    const text = fs.readFileSync(file, 'utf8');
    if (this.state.viewHashes['bruno.json'] === hash(text)) return 0;
    let cfg;
    try {
      cfg = JSON.parse(text);
    } catch {
      return 0;
    }
    const pb = cfg.protobuf || {};
    const repoRel = (p) => {
      const abs = path.resolve(this.viewDir, p);
      const inside = path.relative(this.root, abs);
      if (inside.startsWith('..') || path.isAbsolute(inside)) {
        this.log.warn(`[narado] proto path ${p} is outside the repository; not saved`);
        return null;
      }
      return toPosix(path.relative(this.repoDir, abs));
    };
    const protoFiles = (pb.protoFiles || []).map((f) => f && repoRel(f.path)).filter(Boolean);
    const importPaths = (pb.importPaths || []).filter((f) => f && f.enabled !== false).map((f) => repoRel(f.path)).filter(Boolean);
    const current = (this.config && this.config.grpc) || { protoFiles: [], importPaths: [] };
    this.state.viewHashes['bruno.json'] = hash(text);
    if (JSON.stringify(current.protoFiles) === JSON.stringify(protoFiles) && JSON.stringify(current.importPaths) === JSON.stringify(importPaths)) return 0;
    const written = writeGrpcConfig(this.repoDir, { protoFiles, importPaths });
    this.state.repoHashes[toPosix(path.join('.narado', 'config.nar'))] = hash(written);
    this.config = readConfig(this.repoDir);
    return 1;
  }

  listViewRequests() {
    const out = [];
    const walk = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        const p = path.join(dir, e.name);
        const rel = path.relative(this.viewDir, p);
        if (e.isDirectory()) {
          if (rel !== 'environments') walk(p);
        } else if (e.name.endsWith('.bru') && e.name !== 'collection.bru' && e.name !== 'folder.bru') {
          out.push(rel);
        }
      }
    };
    walk(this.viewDir);
    return out;
  }

  removeEmptyFolders() {
    for (const e of fs.existsSync(this.viewDir) ? fs.readdirSync(this.viewDir, { withFileTypes: true }) : []) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'environments') continue;
      const p = path.join(this.viewDir, e.name);
      const left = fs.readdirSync(p).filter((f) => f !== 'folder.bru');
      if (!left.length) fs.rmSync(p, { recursive: true, force: true });
    }
  }

  /* ---------------------------------------------------------- view -> repo */

  /**
   * Apply a batch of view changes to the repo: Map rel -> 'change' | 'unlink'.
   * A delete and an add of the same method and path in one batch is a rename or move.
   */
  applyViewChanges(batch) {
    let extraApplied = batch.has('bruno.json') ? this.applyBrunoJson() : 0;
    const all = [...batch].filter(([rel]) => rel.endsWith('.bru') && !rel.startsWith('environments') && path.basename(rel) !== 'folder.bru' && path.basename(rel) !== 'collection.bru');
    // GraphQL, gRPC and WebSocket requests go to .narado/extra/ as they are.
    const changes = [];
    for (const [rel, kind] of all) {
      const file = path.join(this.viewDir, rel);
      const exists = kind !== 'unlink' && fs.existsSync(file);
      const text = exists ? fs.readFileSync(file, 'utf8') : null;
      const extra = exists ? isExtraType(requestTypeOf(text)) : !!this.state.extras[rel];
      if (!extra) {
        changes.push([rel, kind]);
        continue;
      }
      const target = path.join(this.repoDir, this.extraDir, rel);
      if (!exists) {
        if (fs.existsSync(target)) fs.rmSync(target);
        delete this.state.repoHashes[toPosix(path.relative(this.repoDir, target))];
        delete this.state.extras[rel];
        delete this.state.viewHashes[rel];
        extraApplied++;
        continue;
      }
      if (this.state.viewHashes[rel] === hash(text)) continue; // our own write
      this.writeRepoFile(target, text);
      this.state.extras[rel] = true;
      this.state.viewHashes[rel] = hash(text);
      extraApplied++;
    }
    if (!changes.length) {
      if (extraApplied) this.saveState();
      return extraApplied;
    }

    let spec = SpecDoc.load(this.specPath);
    if (/^3\.0\./.test(spec.version())) {
      upgradeTo31(spec);
      this.log.log('[narado] upgraded the spec to OpenAPI 3.1 on first edit');
    }

    const unlinked = [];
    const changed = [];
    for (const [rel, kind] of changes) {
      const file = path.join(this.viewDir, rel);
      if (kind === 'unlink' || !fs.existsSync(file)) {
        if (this.state.files[rel]) unlinked.push(rel);
        continue;
      }
      const text = fs.readFileSync(file, 'utf8');
      if (this.state.viewHashes[rel] === hash(text)) continue; // our own write
      let item;
      try {
        item = parseRequest(text, { format: 'bru' });
      } catch (err) {
        this.log.warn(`[narado] could not read ${rel}: ${err.message}`);
        continue;
      }
      changed.push({ rel, item, text });
    }

    const locate = (id) => spec.operations().find((o) => o.operation.operationId === id);
    let applied = 0;

    for (const c of changed) {
      let id = this.state.files[c.rel];
      // A new file that matches a just-removed operation's method and path: a rename or move.
      if (!id) {
        const targetPath = parseBrunoUrl(c.item.request.url).path;
        const targetMethod = String(c.item.request.method).toLowerCase();
        const i = unlinked.findIndex((rel) => {
          const op = locate(this.state.files[rel]);
          return op && op.method === targetMethod && op.path === targetPath;
        });
        if (i >= 0) {
          id = this.state.files[unlinked[i]];
          delete this.state.files[unlinked[i]];
          unlinked.splice(i, 1);
        }
      }
      const from = id ? locate(id) : null;
      if (!id) {
        const taken = new Set(spec.operations().map((o) => o.operation.operationId));
        id = uniqueOperationId(camel(c.item.name) || 'newRequest', taken);
      }
      const folderName = path.dirname(c.rel) === '.' ? null : path.dirname(c.rel).split(path.sep)[0];
      const folder = folderName ? this.state.folders[folderName] || folderName : null;
      try {
        const res = applyBrunoRequest(spec, {
          from: from ? { path: from.path, method: from.method } : null,
          operationId: id,
          item: c.item,
          folder,
          seq: c.item.seq
        });
        this.writeClient(id, res.client);
        this.state.files[c.rel] = id;
        this.state.viewHashes[c.rel] = hash(c.text);
        if (folderName) this.state.folders[folderName] = folder;
        applied++;
      } catch (err) {
        this.log.warn(`[narado] could not save ${c.rel}: ${err.message}`);
      }
    }

    // Deleted requests: remove the operation and its client file.
    for (const rel of unlinked) {
      const id = this.state.files[rel];
      const op = locate(id);
      if (op) {
        spec.delete(['paths', op.path, op.method]);
        const pathItem = spec.get(['paths', op.path]) || {};
        const methods = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
        if (!Object.keys(pathItem).some((k) => methods.includes(k))) spec.delete(['paths', op.path]);
      }
      this.writeClient(id, null);
      delete this.state.files[rel];
      delete this.state.viewHashes[rel];
      applied++;
    }

    this.writeSpec(spec);
    this.saveState();
    return applied + extraApplied;
  }

  /* ---------------------------------------------------------------- watch */

  async start() {
    fs.mkdirSync(this.viewDir, { recursive: true });
    this.project();
    const chokidar = require('chokidar');

    const viewWatcher = chokidar.watch(this.viewDir, {
      ignoreInitial: true,
      ignored: (p) => path.basename(p).startsWith('.') && p !== this.viewDir,
      awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 20 }
    });
    const queue = (kind) => (p) => {
      this.pending.set(path.relative(this.viewDir, p), kind);
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.flushView(), DEBOUNCE_MS);
    };
    viewWatcher.on('add', queue('change')).on('change', queue('change')).on('unlink', queue('unlink'));

    // The spec and narado's folders (.narado/, or .client/ in older collections), which may
    // not exist yet: watch the collection folder, skipping everything else in it.
    const keep = [this.specPath, path.join(this.repoDir, '.narado'), path.join(this.repoDir, '.client')];
    const repoWatcher = chokidar.watch(this.repoDir, {
      ignoreInitial: true,
      ignored: (p) => p !== this.repoDir && !keep.some((k) => p === k || p.startsWith(k + path.sep) || k.startsWith(p + path.sep)),
      awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 20 }
    });
    const onRepo = (p) => {
      const rel = path.relative(this.repoDir, p);
      if (fs.existsSync(p) && this.state.repoHashes[rel] === hash(fs.readFileSync(p, 'utf8'))) return; // ours
      clearTimeout(this.repoTimer);
      this.repoTimer = setTimeout(() => this.run(() => this.project()), DEBOUNCE_MS);
    };
    repoWatcher.on('add', onRepo).on('change', onRepo).on('unlink', onRepo);

    this.watchers.push(viewWatcher, repoWatcher);
    await Promise.all(this.watchers.map((w) => new Promise((r) => w.on('ready', r))));
  }

  /** Run one sync step at a time. */
  run(fn) {
    this.busy = this.busy.then(fn).catch((err) => this.log.error('[narado] sync failed:', err));
    return this.busy;
  }

  flushView() {
    const batch = new Map(this.pending);
    this.pending.clear();
    return this.run(() => this.applyViewChanges(batch));
  }

  /** Wait for queued work (used by tests and before Git operations). */
  async settle() {
    clearTimeout(this.timer);
    if (this.pending.size) await this.flushView();
    await this.busy;
  }

  async stop() {
    clearTimeout(this.timer);
    clearTimeout(this.repoTimer);
    await Promise.all(this.watchers.map((w) => w.close()));
    this.watchers = [];
  }
}

module.exports = { requestTypeOf, Projection, folderFor, STATE_FILE };
