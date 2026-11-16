/**
 * IPC handlers for narado's Git workspaces (channels "narado:*").
 *
 * Every handler that takes a folder checks it lies inside a narado working copy
 * (WorkspaceManager.locate), so the browser cannot point Git at other server paths.
 */
const fs = require('node:fs');
const path = require('node:path');
const { ProviderRegistry } = require('./providers');
const { WorkspaceManager, branchFor, runGit } = require('./workspaces');
const { collectionsInTree, Catalogue } = require('./catalogue');
const { findSpec, readConfig, parseConfig } = require('./openapi/config');
const { SyncManager } = require('./sync');
const { Projection } = require('./openapi/projection');
const { listFolder } = require('./browse');

const REPO_TTL_MS = 5 * 60 * 1000;

const registerNaradoIpc = ({ ipcMain, mainWindow, collectionWatcher, openCollection, dataDir, configDir = dataDir, env = process.env, git = null }) => {
  // Host settings (narado.json) are server-wide; each person's workspaces are under their own dataDir.
  // With `git` (a worker), Git tokens are the person's own, from the front process (Phase 4c).
  const registry = new ProviderRegistry({ dataDir: configDir, env, tokenFor: git ? async (hostId, opts) => (await git.token(hostId, opts)).token : undefined });
  const workspaces = new WorkspaceManager({ dataDir, authFor: async (hostId) => registry.get(hostId).gitAuthHeader() });
  const catalogue = new Catalogue({ registry, dataDir });
  const sync = new SyncManager({ dataDir });
  const users = new Map(); // hostId -> { user, at }
  const repos = new Map(); // hostId/repoPath -> { repo, at }

  const me = async (hostId) => {
    const hit = users.get(hostId);
    if (hit && Date.now() - hit.at < REPO_TTL_MS) return hit.user;
    const user = await registry.get(hostId).getCurrentUser();
    users.set(hostId, { user, at: Date.now() });
    return user;
  };

  const repoInfo = async (hostId, repoPath, { fresh = false } = {}) => {
    const key = `${hostId}/${repoPath}`;
    const hit = repos.get(key);
    if (!fresh && hit && Date.now() - hit.at < REPO_TTL_MS) return hit.repo;
    const repo = await registry.get(hostId).getRepo(repoPath);
    repos.set(key, { repo, at: Date.now() });
    return repo;
  };

  /*
   * Collections in a working copy, anywhere in it: Bruno collections open as they are;
   * each OpenAPI spec folder (Phase 3) gets a generated Bruno view kept in sync with it.
   * A code repository can carry several of either (for example an api/ folder in each service).
   */
  const projections = new Map(); // spec folder -> Projection
  const projectionsIn = (wtPath) => [...projections.entries()].filter(([dir]) => dir === wtPath || dir.startsWith(wtPath + path.sep));

  const collectionsFor = async (wtPath) => {
    const { stdout } = await runGit(['ls-files', '-co', '--exclude-standard', '-z'], { cwd: wtPath });
    // In a sparse working copy Git also lists files that aren't checked out; open only what is there.
    const found = collectionsInTree(stdout.split('\0').filter(Boolean)).filter((c) => fs.existsSync(path.join(wtPath, ...c.file.split('/'))));
    const out = [];
    const live = new Set();
    for (const c of found) {
      const dir = c.dir ? path.join(wtPath, ...c.dir.split('/')) : wtPath;
      if (c.kind === 'bruno') {
        out.push(dir);
        continue;
      }
      live.add(dir);
      let p = projections.get(dir);
      try {
        // config.nar may now name another spec (or a different name): start that view afresh.
        if (p && (findSpec(dir) !== p.specPath || JSON.stringify(readConfig(dir)) !== JSON.stringify(p.config))) {
          await p.stop();
          projections.delete(dir);
          p = null;
        }
        if (!p) {
          p = new Projection({ repoDir: dir, root: wtPath, viewDir: c.dir ? path.join(workspaces.viewPath(wtPath), ...c.dir.split('/')) : workspaces.viewPath(wtPath) });
          await p.start();
          projections.set(dir, p);
        } else {
          await p.run(() => p.project());
        }
      } catch (err) {
        // One broken collection (say, a config.nar naming a missing spec) doesn't stop the others.
        console.warn(`[narado] skipped ${c.dir || 'the root'} collection: ${err.message}`);
        live.delete(dir);
        continue;
      }
      out.push(p.viewDir);
    }
    for (const [dir, p] of projectionsIn(wtPath)) {
      if (!live.has(dir)) {
        if (p.stop) await p.stop();
        projections.delete(dir);
      }
    }
    return out;
  };

  /** Write pending view edits into the repo before Git looks at it. */
  const settle = async (wtPath) => {
    for (const [, p] of projectionsIn(wtPath)) await p.settle();
  };

  /** Regenerate views after Git changed the repo files. */
  const refreshView = async (wtPath) => {
    for (const [, p] of projectionsIn(wtPath)) await p.run(() => p.project());
  };

  /**
   * For a code repository (collections only in subfolders), the folders to check out:
   * the clone then skips file contents and the working copy holds only the collections
   * and the files at the root. null means a full clone (API repos, or when unsure).
   */
  const sparseFor = async (provider, repo, ref) => {
    if (env.NARADO_SPARSE_CLONES === '0' || !provider.listFiles) return null;
    for (const r of [...new Set([ref, repo.defaultBranch])]) {
      try {
        const { files } = await provider.listFiles(repo.path, r);
        const found = collectionsInTree(files);
        if (!found.length || found.some((c) => c.dir === '')) return null;
        const dirs = new Set(found.map((c) => c.dir));
        for (const d of ['.narado', '.client']) if (files.some((f) => f.startsWith(`${d}/`))) dirs.add(d);
        // gRPC proto files and import paths that config.nar names, wherever they are in the repo.
        for (const c of found.filter((x) => x.config)) {
          try {
            const { grpc } = parseConfig(await provider.readFile(repo.path, r, c.file));
            for (const p of [...grpc.protoFiles.map((f) => path.posix.dirname(f)), ...grpc.importPaths]) {
              const inRepo = path.posix.normalize(path.posix.join(c.dir || '.', p));
              if (inRepo && inRepo !== '.' && !inRepo.startsWith('..')) dirs.add(inRepo);
            }
          } catch {}
        }
        return [...dirs].sort();
      } catch (err) {
        if (err.status !== 404) return null; // the branch may only exist in a fork; try the default
      }
    }
    return null;
  };

  /** Resolve a folder from the browser to its workspace, or throw. */
  const workspaceFor = async (folder) => {
    if (typeof folder !== 'string') throw new Error('A workspace path is required');
    const loc = workspaces.locate(folder);
    if (!loc) throw new Error('That folder is not a narado Git workspace');
    const provider = registry.get(loc.hostId);
    const repo = await repoInfo(loc.hostId, loc.repoPath);
    await settle(loc.path);
    return { ...loc, provider, repo };
  };

  const openCollections = async (paths) => {
    for (const p of paths) {
      await openCollection(mainWindow, collectionWatcher, p);
    }
  };

  /**
   * Sync: copy a repo's collection (from its default branch) into the person's own
   * workspace, or bring an existing copy up to date. Edits to the copy are kept.
   */
  ipcMain.handle('narado:sync', async (_e, { hostId, repoPath, dir = '' } = {}) => {
    if (typeof repoPath !== 'string' || typeof dir !== 'string' || dir.split('/').includes('..')) throw new Error('Invalid collection');
    const provider = registry.get(hostId);
    const repo = await repoInfo(hostId, repoPath, { fresh: true });
    if (repo.access === 'none') throw new Error(`You do not have access to ${repoPath}`);
    const ws = await workspaces.open({
      hostId,
      repoPath,
      cloneUrl: repo.cloneUrl,
      authHeader: await provider.gitAuthHeader(),
      branch: repo.defaultBranch,
      defaultBranch: repo.defaultBranch,
      sparse: await sparseFor(provider, repo, repo.defaultBranch)
    });
    const opened = await collectionsFor(ws.path);
    const parts = dir ? dir.split('/') : [];
    const sourceDir = [path.join(workspaces.viewPath(ws.path), ...parts), path.join(ws.path, ...parts)].find((p) => opened.includes(p));
    if (!sourceDir) throw new Error(`${repoPath} has no collection at ${dir || 'its root'} on ${repo.defaultBranch}`);
    let name = dir ? path.basename(dir) : repo.name;
    try {
      name = JSON.parse(fs.readFileSync(path.join(sourceDir, 'bruno.json'), 'utf8')).name || name;
    } catch {}
    const commit = (await runGit(['rev-parse', '--short', 'HEAD'], { cwd: ws.path })).stdout.trim();
    const res = sync.sync({ hostId, repoPath, dir, sourceDir, name, commit, branch: repo.defaultBranch });
    await openCollections([res.path]);
    return { ...res, hostId, repoPath, dir, branch: repo.defaultBranch };
  });

  ipcMain.handle('narado:synced', async () => sync.list());

  // The browser's open and save dialogs: one folder at a time, limited to the person's own
  // folder when sign-in is on (see browse.js).
  ipcMain.handle('narado:list-folder', async (_e, { path: folder } = {}) =>
    listFolder({ path: folder, multiUser: env.NARADO_MULTI_USER === '1', root: dataDir }));

  // Connecting or disconnecting an account happens in the front; start afresh when the interface asks.
  ipcMain.handle('narado:hosts', async () => {
    users.clear();
    repos.clear();
    return git ? git.status() : registry.listHosts();
  });

  ipcMain.handle('narado:repos', async (_e, { hostId }) => {
    const list = await registry.get(hostId).listRepos();
    for (const r of list) repos.set(`${hostId}/${r.path}`, { repo: r, at: Date.now() });
    return list;
  });

  ipcMain.handle('narado:me', async (_e, { hostId }) => me(hostId));

  /** The API catalogue: the person's repositories that hold collections (found through the host's API). */
  /** Which namespaces Explore APIs looks through on a host (empty: everything you can see). */
  ipcMain.handle('narado:catalogue-namespaces', async (_e, { hostId, namespaces } = {}) => {
    registry.get(hostId);
    if (!Array.isArray(namespaces)) throw new Error('namespaces must be a list');
    return catalogue.setNamespaces(hostId, namespaces);
  });

  ipcMain.handle('narado:catalogue', async (_e, { hostId, refresh = false } = {}) => {
    registry.get(hostId); // unknown host -> error
    if (refresh) catalogue.scan(hostId);
    return catalogue.get(hostId);
  });

  /** Look up one repo by path, including public repos the person is not a member of. */
  ipcMain.handle('narado:repo', async (_e, { hostId, repoPath }) => {
    if (typeof repoPath !== 'string' || !/^[^/\s]+(\/[^/\s]+)+$/.test(repoPath.trim())) {
      throw new Error('Enter the repo as owner/name');
    }
    try {
      return await repoInfo(hostId, repoPath.trim(), { fresh: true });
    } catch (err) {
      if (err.status !== 404) throw err;
      // With per-person accounts, a GitHub App only reaches repos it is installed on.
      const app = registry.get(hostId).type === 'github' ? ' If it exists, the narado GitHub App may not be installed on it: use "Give the narado app access to it".' : '';
      throw new Error(`${repoPath.trim()} was not found, or your account can't see it.${app}`);
    }
  });

  const forks = new Map(); // hostId/repoPath -> fork repo

  /** The person's fork of a repo, created on first use. */
  const forkOf = async (hostId, repoPath, { create = false } = {}) => {
    const key = `${hostId}/${repoPath}`;
    if (forks.has(key)) return { fork: forks.get(key), created: false };
    const provider = registry.get(hostId);
    const result = create ? await provider.ensureFork(repoPath) : { fork: await provider.findFork(repoPath), created: false };
    if (result.fork) forks.set(key, result.fork);
    return result;
  };

  /**
   * Open a repo.
   * - `topic` starts a new change on narado/<login>/<topic>; `branch` opens an existing
   *   branch; neither opens the default branch for browsing.
   * - `via: 'branch'` (default) works on a branch in the repo; `via: 'fork'` works on a
   *   branch in the person's fork, creating the fork if needed. People with read-only
   *   access can only change a repo through a fork.
   */
  ipcMain.handle('narado:open', async (_e, { hostId, repoPath, branch, topic, via = 'branch' }) => {
    const provider = registry.get(hostId);
    const repo = await repoInfo(hostId, repoPath, { fresh: true });
    if (repo.access === 'none') throw new Error(`You do not have access to ${repoPath}`);
    if (!['branch', 'fork'].includes(via)) throw new Error('via must be "branch" or "fork"');

    let target = branch || repo.defaultBranch;
    if (topic) target = branchFor((await me(hostId)).login, topic);
    const changing = target !== repo.defaultBranch;

    if (changing && via === 'branch' && repo.access === 'read' && topic) {
      throw new Error(`You have read-only access to ${repoPath}. Start the change in your fork instead.`);
    }

    let fork = null;
    let forkCreated = false;
    if (via === 'fork') {
      if (!changing) throw new Error('Choose a change or a branch to work on in your fork');
      if (repo.allowForking === false) throw new Error(`Forking is turned off for ${repoPath}`);
      ({ fork, created: forkCreated } = await forkOf(hostId, repoPath, { create: true }));
    }

    const ws = await workspaces.open({
      hostId,
      repoPath,
      cloneUrl: repo.cloneUrl,
      authHeader: await provider.gitAuthHeader(),
      branch: target,
      defaultBranch: repo.defaultBranch,
      via,
      forkCloneUrl: fork ? fork.cloneUrl : undefined,
      sparse: await sparseFor(provider, repo, target)
    });
    if (ws.lightened) {
      // The old full clone was replaced by a light one: start this repo's views afresh.
      const repoRoot = path.dirname(workspaces.worktreePath(hostId, repoPath, repo.defaultBranch));
      for (const [dir, p] of [...projections.entries()]) {
        if (dir.startsWith(repoRoot + path.sep)) {
          await p.stop();
          projections.delete(dir);
        }
      }
      console.log(`[narado] ${repoPath} is now a light clone`);
    }
    ws.collections = await collectionsFor(ws.path);
    await openCollections(ws.collections);
    return {
      ...ws,
      hostId,
      repoPath,
      defaultBranch: repo.defaultBranch,
      forkPath: fork ? fork.path : null,
      forkCreated,
      ...saveOptions(repo, target, ws.via)
    };
  });

  /**
   * What a person can do with a working copy.
   * On the default branch, edits are local until saved as a change (branch or fork).
   */
  const saveOptions = (repo, branch, via) => {
    const canWrite = ['write', 'admin'].includes(repo.access);
    const canFork = repo.allowForking !== false;
    const onDefaultBranch = branch === repo.defaultBranch;
    const saveVia = [...(canWrite ? ['branch'] : []), ...(canFork ? ['fork'] : [])];
    return {
      onDefaultBranch,
      saveVia: onDefaultBranch ? saveVia : [],
      readOnly: onDefaultBranch ? saveVia.length === 0 : repo.access === 'read' && via !== 'fork'
    };
  };

  /**
   * Save edits made on the default branch as a change: a new branch in the repo or the
   * person's fork, committed, pushed, and optionally a merge request into the default branch.
   */
  ipcMain.handle('narado:save-as-change', async (_e, { path: folder, topic, via = 'branch', message, openMergeRequest = true, title, description }) => {
    const ws = await workspaceFor(folder);
    const st = await workspaces.status({ path: ws.path });
    if (st.branch !== ws.repo.defaultBranch) throw new Error('Saving as a change starts from the default branch');
    const { saveVia } = saveOptions(ws.repo, st.branch, st.via);
    if (!saveVia.includes(via)) {
      throw new Error(via === 'branch' ? `You have read-only access to ${ws.repoPath}. Save to your fork instead.` : `Forking is turned off for ${ws.repoPath}`);
    }

    const branch = branchFor((await me(ws.hostId)).login, topic);
    let fork = null;
    let forkCreated = false;
    if (via === 'fork') ({ fork, created: forkCreated } = await forkOf(ws.hostId, ws.repoPath, { create: true }));

    const saved = await workspaces.saveAsChange({
      hostId: ws.hostId,
      repoPath: ws.repoPath,
      fromPath: ws.path,
      branch,
      via,
      forkCloneUrl: fork ? fork.cloneUrl : undefined,
      authHeader: await ws.provider.gitAuthHeader(),
      message,
      user: await me(ws.hostId)
    });
    // The change is committed on its branch from here on; a failed push must not hide that.
    let pushError = null;
    try {
      await workspaces.push({ hostId: ws.hostId, repoPath: ws.repoPath, path: saved.path, branch, authHeader: await ws.provider.gitAuthHeader() });
    } catch (err) {
      pushError = `${err.message}. The change is committed on ${branch}; push it again from its Git panel.`;
    }

    let mergeRequest = null;
    let mergeRequestError = null;
    if (openMergeRequest && !pushError) {
      try {
        mergeRequest = await ws.provider.createMergeRequest(ws.repoPath, {
          sourceBranch: branch,
          targetBranch: ws.repo.defaultBranch,
          title: title && title.trim() ? title.trim() : message.trim().split('\n')[0],
          description: description || 'Opened from narado.',
          sourceRepoPath: fork ? fork.path : undefined
        });
      } catch (err) {
        mergeRequestError = err.message;
      }
    }
    await refreshView(ws.path);
    saved.collections = await collectionsFor(saved.path);
    await openCollections(saved.collections);
    return { ...saved, forkPath: fork ? fork.path : null, forkCreated, pushError, mergeRequest, mergeRequestError };
  });

  /** Create a collection in a working copy that has none, then open it. */
  ipcMain.handle('narado:init-collection', async (_e, { path: folder, name }) => {
    const ws = await workspaceFor(folder);
    const created = workspaces.initCollection({ path: ws.path, name: name || path.basename(ws.repoPath) });
    await openCollections([created]);
    return { collections: [created] };
  });

  /** Working copies on disk, with their branch, for the sidebar. */
  ipcMain.handle('narado:workspaces', async () => {
    const list = workspaces.listOpen();
    const hosts = new Map(registry.listHosts().map((h) => [h.id, h]));
    return Promise.all(
      list.map(async (w) => {
        let branch = null;
        try {
          branch = (await workspaces.status({ path: w.path })).branch;
        } catch {}
        return { ...w, branch, hostName: hosts.get(w.hostId)?.name || w.hostId };
      })
    );
  });

  /** Reopen a working copy's collections, for example after a server restart. */
  // Needs nothing from the host, so a working copy opens offline too (narado desktop).
  ipcMain.handle('narado:reopen', async (_e, { path: folder }) => {
    if (typeof folder !== 'string') throw new Error('A workspace path is required');
    const ws = workspaces.locate(folder);
    if (!ws) throw new Error('That folder is not a narado Git workspace');
    await settle(ws.path);
    const collections = await collectionsFor(ws.path);
    await openCollections(collections);
    return { collections };
  });

  ipcMain.handle('narado:status', async (_e, { path: folder }) => {
    const ws = await workspaceFor(folder);
    const status = await workspaces.status({ path: ws.path, defaultBranch: ws.repo.defaultBranch });
    let mergeRequest = null;
    let mergeRequestError = null;
    let forkPath = null;
    if (status.via === 'fork') {
      try {
        forkPath = (await forkOf(ws.hostId, ws.repoPath)).fork?.path || null;
      } catch (err) {
        mergeRequestError = err.message;
      }
    }
    if (status.branch && status.branch !== ws.repo.defaultBranch && status.upstream) {
      try {
        mergeRequest = await ws.provider.findMergeRequest(ws.repoPath, status.branch, { sourceRepoPath: forkPath || undefined });
      } catch (err) {
        mergeRequestError = err.message;
      }
    }
    return {
      ...status,
      hostId: ws.hostId,
      hostType: ws.provider.type,
      hostName: ws.provider.name,
      repoPath: ws.repoPath,
      repoUrl: ws.repo.webUrl,
      access: ws.repo.access,
      path: ws.path,
      forkPath,
      ...saveOptions(ws.repo, status.branch, status.via),
      mergeRequest,
      mergeRequestError
    };
  });

  /** Writes are allowed on a change branch, in the repo (write access) or in the person's fork. */
  const refuseDefaultBranch = async (ws) => {
    const st = await workspaces.status({ path: ws.path });
    if (st.branch === ws.repo.defaultBranch) {
      throw new Error(`Changes to ${ws.repo.defaultBranch} go through a merge request. Start a change first.`);
    }
    if (ws.repo.access === 'read' && st.via !== 'fork') {
      throw new Error(`You have read-only access to ${ws.repoPath}. Start the change in your fork instead.`);
    }
    return st;
  };

  ipcMain.handle('narado:commit', async (_e, { path: folder, message }) => {
    const ws = await workspaceFor(folder);
    await refuseDefaultBranch(ws);
    const sha = await workspaces.commit({ path: ws.path, message, user: await me(ws.hostId) });
    return { sha };
  });

  ipcMain.handle('narado:push', async (_e, { path: folder }) => {
    const ws = await workspaceFor(folder);
    const st = await refuseDefaultBranch(ws);
    const { remote } = await workspaces.push({ ...ws, branch: st.branch, authHeader: await ws.provider.gitAuthHeader() });
    return { pushed: st.branch, to: remote === 'fork' ? 'fork' : 'repo' };
  });

  /**
   * Push, then open a merge request into the default branch (or return the existing one).
   * For a fork change, the merge request goes from the fork's branch into the original repo.
   */
  ipcMain.handle('narado:create-merge-request', async (_e, { path: folder, title, description }) => {
    const ws = await workspaceFor(folder);
    const st = await refuseDefaultBranch(ws);
    if (st.files.length) throw new Error('Commit your changes before opening a merge request');
    await workspaces.push({ ...ws, branch: st.branch, authHeader: await ws.provider.gitAuthHeader() });
    const sourceRepoPath = st.via === 'fork' ? (await forkOf(ws.hostId, ws.repoPath)).fork?.path : undefined;
    if (st.via === 'fork' && !sourceRepoPath) throw new Error('Could not find your fork of this repo');
    const existing = await ws.provider.findMergeRequest(ws.repoPath, st.branch, { sourceRepoPath });
    if (existing && existing.state === 'open') return existing;
    return ws.provider.createMergeRequest(ws.repoPath, {
      sourceBranch: st.branch,
      targetBranch: ws.repo.defaultBranch,
      title: title && title.trim() ? title.trim() : st.branch,
      description: description || 'Opened from narado.',
      sourceRepoPath
    });
  });

  ipcMain.handle('narado:update-from-default', async (_e, { path: folder }) => {
    const ws = await workspaceFor(folder);
    await refuseDefaultBranch(ws);
    const res = await workspaces.updateFromDefault({
      ...ws,
      defaultBranch: ws.repo.defaultBranch,
      authHeader: await ws.provider.gitAuthHeader(),
      user: await me(ws.hostId)
    });
    // While openapi.yaml holds conflict markers the view keeps its last good state.
    if (res.merged) await refreshView(ws.path);
    return res;
  });

  /** Refresh a read-only default-branch copy from the host. */
  ipcMain.handle('narado:pull-default', async (_e, { path: folder }) => {
    const ws = await workspaceFor(folder);
    const st = await workspaces.status({ path: ws.path });
    if (st.branch !== ws.repo.defaultBranch) throw new Error('Use "Update from default branch" on a change branch');
    const res = await workspaces.updateFromDefault({
      ...ws,
      defaultBranch: ws.repo.defaultBranch,
      authHeader: await ws.provider.gitAuthHeader(),
      user: await me(ws.hostId)
    });
    if (res.merged) await refreshView(ws.path);
    return res;
  });

  ipcMain.handle('narado:resolve', async (_e, { path: folder, file, side }) => {
    const ws = await workspaceFor(folder);
    await workspaces.resolve({ path: ws.path, file, side });
    const st = await workspaces.status({ path: ws.path });
    if (!st.conflicts.length) await refreshView(ws.path);
    return true;
  });

  ipcMain.handle('narado:abort-merge', async (_e, { path: folder }) => {
    const ws = await workspaceFor(folder);
    await workspaces.abortMerge({ path: ws.path });
    await refreshView(ws.path);
    return true;
  });

  const stopViews = async () => {
    for (const [dir, p] of [...projections.entries()]) {
      await p.stop();
      projections.delete(dir);
    }
  };

  return { registry, workspaces, collectionsFor, stopViews, sync };
};

module.exports = { registerNaradoIpc };
