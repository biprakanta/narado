/**
 * IPC handlers for narado's Git workspaces (channels "narado:*").
 *
 * Every handler that takes a folder checks it lies inside a narado working copy
 * (WorkspaceManager.locate), so the browser cannot point Git at other server paths.
 */
const path = require('node:path');
const { ProviderRegistry } = require('./providers');
const { WorkspaceManager, branchFor } = require('./workspaces');

const REPO_TTL_MS = 5 * 60 * 1000;

const registerNaradoIpc = ({ ipcMain, mainWindow, collectionWatcher, openCollection, dataDir, env = process.env }) => {
  const registry = new ProviderRegistry({ dataDir, env });
  const workspaces = new WorkspaceManager({ dataDir });
  const users = new Map(); // hostId -> current user
  const repos = new Map(); // hostId/repoPath -> { repo, at }

  const me = async (hostId) => {
    if (!users.has(hostId)) users.set(hostId, await registry.get(hostId).getCurrentUser());
    return users.get(hostId);
  };

  const repoInfo = async (hostId, repoPath, { fresh = false } = {}) => {
    const key = `${hostId}/${repoPath}`;
    const hit = repos.get(key);
    if (!fresh && hit && Date.now() - hit.at < REPO_TTL_MS) return hit.repo;
    const repo = await registry.get(hostId).getRepo(repoPath);
    repos.set(key, { repo, at: Date.now() });
    return repo;
  };

  /** Resolve a folder from the browser to its workspace, or throw. */
  const workspaceFor = async (folder) => {
    if (typeof folder !== 'string') throw new Error('A workspace path is required');
    const loc = workspaces.locate(folder);
    if (!loc) throw new Error('That folder is not a narado Git workspace');
    const provider = registry.get(loc.hostId);
    const repo = await repoInfo(loc.hostId, loc.repoPath);
    return { ...loc, provider, repo };
  };

  const openCollections = async (paths) => {
    for (const p of paths) {
      await openCollection(mainWindow, collectionWatcher, p);
    }
  };

  ipcMain.handle('narado:hosts', async () => registry.listHosts());

  ipcMain.handle('narado:repos', async (_e, { hostId }) => {
    const list = await registry.get(hostId).listRepos();
    for (const r of list) repos.set(`${hostId}/${r.path}`, { repo: r, at: Date.now() });
    return list;
  });

  ipcMain.handle('narado:me', async (_e, { hostId }) => me(hostId));

  /**
   * Open a repo. `topic` starts a new change on narado/<login>/<topic>; `branch` opens an
   * existing branch; neither opens the default branch for browsing.
   */
  ipcMain.handle('narado:open', async (_e, { hostId, repoPath, branch, topic }) => {
    const provider = registry.get(hostId);
    const repo = await repoInfo(hostId, repoPath, { fresh: true });
    if (repo.access === 'none') throw new Error(`You do not have access to ${repoPath}`);

    let target = branch || repo.defaultBranch;
    if (topic) {
      if (repo.access === 'read') throw new Error(`You have read-only access to ${repoPath}, so you cannot start a change`);
      target = branchFor((await me(hostId)).login, topic);
    }

    const ws = await workspaces.open({
      hostId,
      repoPath,
      cloneUrl: repo.cloneUrl,
      authHeader: provider.gitAuthHeader(),
      branch: target,
      defaultBranch: repo.defaultBranch
    });
    await openCollections(ws.collections);
    return {
      ...ws,
      hostId,
      repoPath,
      defaultBranch: repo.defaultBranch,
      readOnly: target === repo.defaultBranch || repo.access === 'read'
    };
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
  ipcMain.handle('narado:reopen', async (_e, { path: folder }) => {
    const ws = await workspaceFor(folder);
    const { findCollections } = require('./workspaces');
    const collections = findCollections(ws.path);
    await openCollections(collections);
    return { collections };
  });

  ipcMain.handle('narado:status', async (_e, { path: folder }) => {
    const ws = await workspaceFor(folder);
    const status = await workspaces.status({ path: ws.path, defaultBranch: ws.repo.defaultBranch });
    let mergeRequest = null;
    let mergeRequestError = null;
    if (status.branch && status.branch !== ws.repo.defaultBranch && status.upstream) {
      try {
        mergeRequest = await ws.provider.findMergeRequest(ws.repoPath, status.branch);
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
      readOnly: status.branch === ws.repo.defaultBranch || ws.repo.access === 'read',
      mergeRequest,
      mergeRequestError
    };
  });

  const refuseDefaultBranch = async (ws) => {
    const st = await workspaces.status({ path: ws.path });
    if (st.branch === ws.repo.defaultBranch) {
      throw new Error(`Changes to ${ws.repo.defaultBranch} go through a merge request. Start a change first.`);
    }
    if (ws.repo.access === 'read') throw new Error(`You have read-only access to ${ws.repoPath}`);
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
    await workspaces.push({ ...ws, branch: st.branch, authHeader: ws.provider.gitAuthHeader() });
    return { pushed: st.branch };
  });

  /** Push, then open a merge request into the default branch (or return the existing one). */
  ipcMain.handle('narado:create-merge-request', async (_e, { path: folder, title, description }) => {
    const ws = await workspaceFor(folder);
    const st = await refuseDefaultBranch(ws);
    if (st.files.length) throw new Error('Commit your changes before opening a merge request');
    await workspaces.push({ ...ws, branch: st.branch, authHeader: ws.provider.gitAuthHeader() });
    const existing = await ws.provider.findMergeRequest(ws.repoPath, st.branch);
    if (existing && existing.state === 'open') return existing;
    return ws.provider.createMergeRequest(ws.repoPath, {
      sourceBranch: st.branch,
      targetBranch: ws.repo.defaultBranch,
      title: title && title.trim() ? title.trim() : st.branch,
      description: description || 'Opened from narado.'
    });
  });

  ipcMain.handle('narado:update-from-default', async (_e, { path: folder }) => {
    const ws = await workspaceFor(folder);
    await refuseDefaultBranch(ws);
    return workspaces.updateFromDefault({
      ...ws,
      defaultBranch: ws.repo.defaultBranch,
      authHeader: ws.provider.gitAuthHeader(),
      user: await me(ws.hostId)
    });
  });

  /** Refresh a read-only default-branch copy from the host. */
  ipcMain.handle('narado:pull-default', async (_e, { path: folder }) => {
    const ws = await workspaceFor(folder);
    const st = await workspaces.status({ path: ws.path });
    if (st.branch !== ws.repo.defaultBranch) throw new Error('Use "Update from default branch" on a change branch');
    return workspaces.updateFromDefault({
      ...ws,
      defaultBranch: ws.repo.defaultBranch,
      authHeader: ws.provider.gitAuthHeader(),
      user: await me(ws.hostId)
    });
  });

  ipcMain.handle('narado:resolve', async (_e, { path: folder, file, side }) => {
    const ws = await workspaceFor(folder);
    await workspaces.resolve({ path: ws.path, file, side });
    return true;
  });

  ipcMain.handle('narado:abort-merge', async (_e, { path: folder }) => {
    const ws = await workspaceFor(folder);
    await workspaces.abortMerge({ path: ws.path });
    return true;
  });

  return { registry, workspaces };
};

module.exports = { registerNaradoIpc };
