/**
 * narado desktop (docs/desktop.md in the design repo): narado's worker, run inside Electron's
 * main process on the person's computer.
 *
 * Bruno's Electron app (packages/bruno-electron/src/index.js) calls start() after registering
 * Bruno's own handlers, when started as narado (NARADO_DESKTOP=1). This does what
 * src/worker.js does for a person on the server:
 *
 *   - narado's handlers: Git workspaces, OpenAPI views, Explore APIs, Sync (narado/ipc.js);
 *   - secret:// references resolved just before a send, and every reply and event cleaned
 *     so values never reach the window (as the worker cleans what it sends to the browser);
 *   - the Git panel's view of the repo's allowlist.
 *
 * The "front" (Git accounts, secrets stores, MCP tokens) is, for now (desktop phase D1), the
 * same code running here with the desktop's own data folder, as in the server's single-user
 * local mode: Git uses NARADO_<HOST>_TOKEN. Phase D2 replaces it with calls to the team's
 * narado server over HTTPS (sign-in, Git tokens and secrets from the server).
 */
const fs = require('node:fs');
const path = require('node:path');
const { registerNaradoIpc } = require('./narado/ipc');
const { GitAccounts } = require('./narado/git-accounts');
const { SecretsService } = require('./narado/secrets');
const { Identity } = require('./narado/secrets/identity');
const { SecretRefs, REVEAL_CHANNEL } = require('./narado/secrets/worker-side');
const { AllowlistReader } = require('./narado/requests/allowlist');

/** Electron's ipcMain, with the getHandler the shared code expects. */
const withGetHandler = (ipcMain) => {
  if (typeof ipcMain.getHandler === 'function') return ipcMain;
  const handlers = ipcMain._invokeHandlers; // Electron keeps invoke handlers in this Map
  if (!(handlers instanceof Map)) throw new Error('This Electron version does not expose its IPC handlers');
  return {
    handle: (ch, fn) => ipcMain.handle(ch, fn),
    removeHandler: (ch) => ipcMain.removeHandler(ch),
    getHandler: (ch) => handlers.get(ch)
  };
};

/**
 * The front's services, local for now: the calls a worker makes to the server's front,
 * answered in this process for the one person using this computer.
 */
const localFront = ({ dataDir, env }) => {
  const identity = new Identity({ dataDir, issuer: 'narado-desktop' });
  const secrets = new SecretsService({ dataDir, env, identity });
  const gitAccounts = new GitAccounts({ dataDir, publicUrl: 'http://127.0.0.1', multiUser: false, env });
  return {
    secretsService: secrets,
    git: {
      status: async () => gitAccounts.status(null),
      token: async (hostId, opts) => gitAccounts.token(null, hostId, opts || {})
    },
    secrets: {
      stores: async () => secrets.listStores(),
      resolve: async (refs, ctx) => secrets.resolve(null, refs, ctx || {}),
      list: async (store, prefix, ctx) => secrets.list(null, store, prefix, ctx || {}),
      check: async (ref, ctx) => secrets.check(null, ref, ctx || {}),
      reveal: async (ref, ctx) => secrets.reveal(null, ref, ctx || {})
    }
  };
};

/**
 * Clean everything leaving the main process, as the worker does: replies to the window
 * (except a reveal, which carries a value on purpose) and events sent to it.
 */
const cleanOutgoing = ({ ipc, ipcMain, mainWindow, secretRefs }) => {
  const wrap = (ch, fn) => (ch === REVEAL_CHANNEL ? fn : async (event, ...args) => secretRefs.clean(await fn(event, ...args)));
  const handlers = ipcMain._invokeHandlers;
  for (const [ch, fn] of [...handlers.entries()]) {
    ipcMain.removeHandler(ch);
    ipcMain.handle(ch, wrap(ch, fn));
  }
  // Handlers registered later are cleaned too.
  const handle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (ch, fn) => handle(ch, wrap(ch, fn));
  const wc = mainWindow.webContents;
  const send = wc.send.bind(wc);
  wc.send = (channel, ...args) => send(channel, ...secretRefs.clean(args));
  return ipc;
};

const start = async ({ app, ipcMain, mainWindow, collectionWatcher, openCollection, env = process.env, log = console }) => {
  const dataDir = path.join(app.getPath('userData'), 'narado-data');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const ipc = withGetHandler(ipcMain);
  const front = localFront({ dataDir, env });

  const narado = registerNaradoIpc({
    ipcMain,
    mainWindow,
    collectionWatcher,
    openCollection,
    dataDir,
    configDir: dataDir,
    env,
    git: front.git
  });

  // A synced copy counts as part of the repo it came from, for secrets and request rules.
  const locateRepo = (p) => narado.workspaces.locate(p) || narado.sync.sourceOf(p);
  const secretRefs = new SecretRefs({ secrets: front.secrets, workspaces: { locate: locateRepo } });
  secretRefs.install(ipc);

  // The Git panel's "hosts this repo may send to". Request rules for the desktop (cloud
  // metadata refused, public hosts on the allowlist) come in desktop phase D3.
  const allowlists = new AllowlistReader({ envFor: (base) => narado.workspaces.gitEnvFor(base) });
  ipcMain.handle('narado:request-rules', async (_e, { path: p } = {}) => {
    const loc = p ? locateRepo(p) : null;
    if (!loc) return { enforced: false, repo: null, branch: null, hosts: [], codeowners: false, codeOwnerReview: null, protectedBranch: null };
    const rules = await allowlists.rulesFor({ base: narado.workspaces.basePath(loc.hostId, loc.repoPath), repo: `${loc.hostId}:${loc.repoPath}` });
    let review = { protected: null, codeOwnerReview: null };
    try {
      const provider = narado.registry.get(loc.hostId);
      if (provider.reviewRules && rules.branch) review = await provider.reviewRules(loc.repoPath, rules.branch);
    } catch {}
    return {
      enforced: false,
      repo: `${loc.hostId}:${loc.repoPath}`,
      branch: rules.branch,
      hosts: rules.summary(),
      codeowners: rules.codeowners,
      codeOwnerReview: review.codeOwnerReview,
      protectedBranch: review.protected
    };
  });

  // MCP on the desktop (a local MCP server for assistants on this computer) is phase D5.
  ipcMain.handle('narado:mcp-info', async () => ({ available: false, note: 'MCP comes to narado desktop in a later version.' }));
  ipcMain.handle('narado:mcp-tokens', async () => []);

  cleanOutgoing({ ipc, ipcMain, mainWindow, secretRefs });

  const hosts = await front.git.status();
  log.log(`[narado] desktop: data in ${dataDir}`);
  log.log(`[narado] desktop: Git hosts ${hosts.map((h) => `${h.id} (${h.connected ? `connected${h.via === 'server' ? ' with a token' : ''}` : 'not connected'})`).join(', ')}`);
  log.log(`[narado] desktop: secrets stores ${front.secretsService.enabled ? front.secretsService.listStores().map((s) => s.id).join(', ') : 'none'}`);
  return { narado, dataDir };
};

module.exports = { start, withGetHandler, localFront, cleanOutgoing };
