/**
 * A narado worker: Bruno's main process for one person (Phase 4d).
 *
 * The front process (server.js) starts one worker per signed-in person (or one for
 * single-user local mode), each with its own data folder, and relays that person's IPC
 * WebSocket and MCP requests to it. This file runs Bruno's main-process code
 * (packages/bruno-electron/src) in Node.js with `electron` replaced by ./electron-stub.js.
 *
 * It listens on a random loopback port and only accepts requests that carry the secret
 * the front gave it (x-narado-worker). It serves:
 *   /ipc  WebSocket relay to Bruno's IPC handlers
 *   /mcp  narado's MCP server, acting as this worker's person
 *
 * Wire protocol on /ipc (JSON messages):
 *   browser -> server  {t:'invoke', id, ch, args}   reply {t:'res', id, ok, value | error}
 *   browser -> server  {t:'send', ch, args}         one-way, for ipcMain.on listeners
 *   server  -> browser {t:'evt', ch, args}          webContents.send()
 *   server  -> browser {t:'req', id, kind, payload} native UI (dialogs); reply {t:'reqres', id, value}
 *   server  -> browser {t:'instance', id}           sent on connect; a new id means a new worker
 */
const Module = require('node:module');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const SECRET = process.env.NARADO_WORKER_SECRET;
if (!SECRET || typeof process.send !== 'function') {
  console.error('[narado worker] start narado with src/server.js; workers are started by it.');
  process.exit(1);
}
const WORKER_USER = JSON.parse(process.env.NARADO_WORKER_USER || 'null'); // null in local mode
const MULTI_USER = process.env.NARADO_MULTI_USER === '1';
const PUBLIC_PORT = Number(process.env.BRUNO_WEB_PUBLIC_PORT || 4100);
const INSTANCE_ID = crypto.randomUUID();

// Under Node's permission model (sandboxed workers, see src/narado/workers.js) fsync is
// refused outright, and the settings library Bruno uses calls it on every write. Writes
// still happen; only the forced flush to disk is skipped.
if (process.permission) {
  const fs = require('node:fs');
  for (const name of ['fsync', 'fdatasync']) {
    fs[`${name}Sync`] = () => {};
    fs[name] = (fd, cb) => process.nextTick(cb, null);
    if (fs.promises) fs.promises[name] = async () => {};
  }
}

// Run Bruno as a packaged app. In dev mode Bruno answers 'main:renderer-ready' only once per
// process (a guard for React strict mode in its one Electron window); here every page
// load is a new renderer, so a reload would never get its workspaces back.
if (!('ELECTRON_IS_DEV' in process.env)) process.env.ELECTRON_IS_DEV = '0';

/* ---------------------------------------------------------------------------
 * 1. Route `require('electron')` to the stub before any Bruno code loads.
 * ------------------------------------------------------------------------ */
const STUB_PATH = require.resolve('./electron-stub');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return STUB_PATH;
  return originalResolve.call(this, request, ...rest);
};

const electron = require('electron');
const { app, ipcMain, BrowserWindow } = electron;
const { hooks, DATA_DIR } = electron.__web;
const CONFIG_DIR = process.env.NARADO_CONFIG_DIR || DATA_DIR;

const ELECTRON_SRC = path.resolve(__dirname, '../../bruno-electron/src');
const brunoRequire = (rel) => require(path.join(ELECTRON_SRC, rel));
const { SecretRefs, SEND_CHANNELS, collectionPathIn } = require('./narado/secrets/worker-side');
const { RequestGuard, installSendRules } = require('./narado/requests/guard');
const { AllowlistReader } = require('./narado/requests/allowlist');

/* ---------------------------------------------------------------------------
 * 2. Several people on one server: scripts only in the QuickJS sandbox.
 *    Bruno's "developer" mode runs scripts in Node's vm, which a script can escape.
 *    The runtime classes are replaced before any Bruno module destructures them.
 * ------------------------------------------------------------------------ */
if (MULTI_USER) {
  const brunoJs = require(require.resolve('@usebruno/js', { paths: [ELECTRON_SRC] }));
  for (const name of ['ScriptRuntime', 'TestRuntime', 'VarsRuntime', 'AssertRuntime', 'GrpcScriptRuntime']) {
    const Original = brunoJs[name];
    if (typeof Original !== 'function') continue;
    const Safe = class extends Original {
      constructor(props) {
        super({ ...(props || {}), runtime: 'quickjs' });
        Object.defineProperty(this, 'runtime', { get: () => 'quickjs', set: () => {}, configurable: false });
      }
    };
    Object.defineProperty(Safe, 'name', { value: name });
    brunoJs[name] = Safe;
  }
  brunoJs.runScriptInNodeVm = () => {
    throw new Error('Developer-mode scripts are turned off on this server');
  };
}

const optional = (label, fn) => {
  try {
    return fn();
  } catch (err) {
    console.warn(`[bruno-web] ${label} skipped: ${err.message}`);
    return undefined;
  }
};

/** Handlers that let one person run programs or reach outside their own folder. */
const restrictForMultiUser = () => {
  const refuse = (channel, message) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, () => {
      throw new Error(message);
    });
  };
  // npm install runs package install scripts: arbitrary code on the server.
  refuse('renderer:install-postman-packages', 'Installing npm packages is turned off on this narado server');
  for (const ch of ['renderer:clone-git-repository', 'renderer:get-collection-git-remote-url', 'renderer:list-remote-branches-for-url']) {
    if (!ipcMain.getHandler(ch)) ipcMain.handle(ch, () => {
      throw new Error('Use the Git section to open repositories on this narado server');
    });
  }
  // Developer mode would ask for Node's vm; keep collections in Safe Mode.
  const saveSecurity = ipcMain.getHandler('renderer:save-collection-security-config');
  ipcMain.removeHandler('renderer:save-collection-security-config');
  ipcMain.handle('renderer:save-collection-security-config', (event, collectionPath, securityConfig) => {
    if (securityConfig && securityConfig.jsSandboxMode === 'developer') {
      throw new Error('Developer mode is turned off on this narado server; scripts run in Safe Mode');
    }
    return saveSecurity(event, collectionPath, securityConfig);
  });
};

const startBruno = async () => {
  const { initializeShellEnv, waitForShellEnv } = brunoRequire('store/shell-env-state');
  const { transientManager } = brunoRequire('services/transient');
  const collectionWatcher = brunoRequire('app/collection-watcher');
  const WorkspaceWatcher = brunoRequire('app/workspace-watcher');
  const ApiSpecWatcher = brunoRequire('app/apiSpecsWatcher');
  const SystemMonitor = brunoRequire('app/system-monitor');
  const AppDocuments = brunoRequire('app/app-documents');
  const { globalEnvironmentsManager } = brunoRequire('store/workspace-environments');
  const { getDomainsWithCookies } = brunoRequire('utils/cookies');
  const { cookiesStore } = brunoRequire('store/cookies');
  const { getIsRunningInRosetta } = brunoRequire('utils/arch');
  const sqliteService = brunoRequire('services/sqlite');
  const { clearAllRunnerResponses } = brunoRequire('services/runner-exchange');

  const systemMonitor = new SystemMonitor();
  const workspaceWatcher = new WorkspaceWatcher();
  const apiSpecWatcher = new ApiSpecWatcher();
  const appDocuments = new AppDocuments();

  initializeShellEnv();
  await transientManager.clearStale();
  waitForShellEnv()
    .catch(() => {})
    .finally(() => {
      const { fetchSystemProxy } = brunoRequire('store/system-proxy');
      fetchSystemProxy().catch(() => {});
    });

  const mainWindow = new BrowserWindow({});

  // Same registration order as bruno-electron/src/index.js.
  const reg = (rel, ...args) => {
    const mod = brunoRequire(rel);
    const fn = typeof mod === 'function' ? mod : mod.default;
    return fn(...args);
  };
  reg('ipc/network', mainWindow);
  reg('ipc/global-environments', mainWindow, globalEnvironmentsManager);
  reg('ipc/collection', mainWindow, collectionWatcher);
  brunoRequire('ipc/yml-migration').registerYmlMigrationIpc(mainWindow, collectionWatcher);
  reg('ipc/preferences', mainWindow, collectionWatcher);
  reg('ipc/snapshot');
  reg('ipc/workspace', mainWindow, workspaceWatcher);
  reg('ipc/apiSpec', mainWindow, apiSpecWatcher);
  reg('ipc/notifications', mainWindow, collectionWatcher);
  reg('ipc/filesystem', mainWindow);
  reg('ipc/system-monitor', mainWindow, systemMonitor);
  // Bruno's own Git handlers clone into any path and run git against any URL; narado has its
  // own Git workspaces, so these are off when several people share the server.
  if (!MULTI_USER) reg('ipc/git', mainWindow);
  reg('ipc/openapi-sync', mainWindow);
  reg('ipc/mock-server', mainWindow);
  optional('AI', () => reg('ipc/ai', mainWindow));
  optional('AI autocomplete', () => reg('ipc/ai/autocomplete', mainWindow));
  brunoRequire('ipc/mount').registerMountIpc();
  sqliteService.openDatabase();
  clearAllRunnerResponses().catch(() => {});
  brunoRequire('ipc/sqlite').registerSqliteIpc();
  optional('app documents protocol', () => appDocuments.handleProtocol());
  reg('ipc/app-document', appDocuments, mainWindow);
  brunoRequire('ipc/wsdl').registerWsdlIpc();

  // narado: Git-backed workspaces (Phase 2).
  const narado = require('./narado/ipc').registerNaradoIpc({
    ipcMain,
    mainWindow,
    collectionWatcher,
    openCollection: brunoRequire('app/collections').openCollection,
    dataDir: DATA_DIR,
    configDir: CONFIG_DIR,
    git: front.git
  });

  ipcMain.handle('main:cache-clear', async () => {
    ipcMain.emit('internal:snapshot:reset');
  });

  // Window controls from index.js. Harmless no-ops in a browser tab.
  for (const ch of ['renderer:window-minimize', 'renderer:window-maximize', 'renderer:window-close']) {
    ipcMain.on(ch, () => {});
  }
  ipcMain.handle('renderer:window-is-maximized', () => false);
  ipcMain.handle('renderer:window-is-fullscreen', () => false);
  for (const ch of ['renderer:toggle-devtools', 'renderer:reset-zoom', 'renderer:zoom-in', 'renderer:zoom-out', 'renderer:set-zoom-level', 'renderer:toggle-fullscreen']) {
    ipcMain.handle(ch, () => {});
  }
  ipcMain.handle('renderer:open-preferences', () => ipcMain.emit('main:open-preferences'));
  ipcMain.handle('renderer:open-docs', () => ipcMain.emit('main:open-docs'));
  ipcMain.handle('renderer:open-about', () => {});

  if (MULTI_USER) restrictForMultiUser();

  app.markReady();

  // What index.js does once the page has loaded; run for every browser that connects.
  const onBrowserConnected = async () => {
    mainWindow.webContents.emit('did-finish-load');
    try {
      cookiesStore.initializeCookies();
      mainWindow.webContents.send('main:cookies-update', await getDomainsWithCookies());
    } catch (err) {
      console.warn('[bruno-web] cookies:', err.message);
    }
    mainWindow.webContents.send('main:app-loaded', { isRunningInRosetta: getIsRunningInRosetta() });
  };

  return { mainWindow, onBrowserConnected, narado };
};

/* ---------------------------------------------------------------------------
 * 3. WebSocket bridge and MCP, behind the front process.
 * ------------------------------------------------------------------------ */
// JSON turns `undefined` in an array into `null`; Electron's IPC keeps it.
// Messages carry `u`, the positions of undefined arguments, to restore them.
const encodeArgs = (args) => ({
  args: args.map((a) => (a === undefined ? null : a)),
  u: args.reduce((acc, a, i) => (a === undefined ? [...acc, i] : acc), [])
});
const decodeArgs = (args = [], u = []) => {
  const out = args.slice();
  for (const i of u) out[i] = undefined;
  return out;
};

const errorMessage = (channel, err) => {
  // Mirror Electron's rejection text so the interface's error parsing still works.
  const inner = err instanceof Error ? `${err.name || 'Error'}: ${err.message}` : String(err);
  return `Error invoking remote method '${channel}': ${inner}`;
};

const fromFront = (req) => {
  const given = Buffer.from(String(req.headers['x-narado-worker'] || ''));
  const expected = Buffer.from(SECRET);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
};

/** Calls to the front process (token store), answered over the IPC channel fork() set up. */
const front = (() => {
  const waiting = new Map();
  process.on('message', (msg) => {
    if (!msg || msg.type !== 'rpc-result') return;
    const p = waiting.get(msg.id);
    if (!p) return;
    waiting.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg.result);
  });
  const call = (method, ...args) =>
    new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      waiting.set(id, { resolve, reject });
      process.send({ type: 'rpc', id, method, args });
    });
  return {
    tokens: {
      list: () => call('tokens.list'),
      create: (opts) => call('tokens.create', opts),
      revoke: (id) => call('tokens.revoke', id),
      verify: (token) => call('tokens.verify', token),
      touch: (id) => call('tokens.touch', id)
    },
    // The person's own Git tokens (Phase 4c): the front keeps refresh tokens and app credentials.
    git: {
      status: () => call('git.status'),
      token: (hostId, opts) => call('git.token', hostId, opts || {})
    },
    // Secrets stores live in the front; it checks access as this worker's person.
    secrets: {
      stores: () => call('secrets.stores'),
      resolve: (refs, ctx) => call('secrets.resolve', refs, ctx),
      list: (store, prefix, ctx) => call('secrets.list', store, prefix, ctx),
      check: (ref, ctx) => call('secrets.check', ref, ctx)
    }
  };
})();

const main = async () => {
  const { WebSocketServer } = require('ws');
  const { mainWindow, onBrowserConnected, narado } = await startBruno();

  // secret:// references are resolved just before a send, and cleaned from what goes back.
  const secretRefs = new SecretRefs({ secrets: front.secrets, workspaces: narado.workspaces });
  secretRefs.install(ipcMain);

  // Request safety (Phase 4a): with sign-in on, every connection is checked against the
  // platform block list, and sends against their repo's allowlist from its default branch.
  const allowlists = new AllowlistReader();
  const rulesFor = async (collectionPath) => {
    const loc = collectionPath ? narado.workspaces.locate(collectionPath) : null;
    if (!loc) return { rules: null, repo: null };
    const repo = `${loc.hostId}:${loc.repoPath}`;
    return { rules: await allowlists.rulesFor({ base: narado.workspaces.basePath(loc.hostId, loc.repoPath), repo }), repo };
  };
  const rulesOn = process.env.NARADO_REQUEST_RULES ? process.env.NARADO_REQUEST_RULES !== '0' : MULTI_USER;
  if (rulesOn) {
    const trustedHosts = narado.registry
      .listHosts()
      .map((h) => {
        try {
          return new URL(h.url).hostname;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const guard = new RequestGuard({ user: WORKER_USER, trustedHosts });
    guard.install();
    installSendRules({ ipcMain, guard, channels: SEND_CHANNELS, collectionPathIn, rulesFor });
  }
  ipcMain.handle('narado:request-rules', async (_e, { path: p } = {}) => {
    const { rules, repo } = await rulesFor(p);
    return {
      enforced: rulesOn,
      repo,
      branch: rules ? rules.branch : null,
      hosts: rules ? rules.summary() : [],
      codeowners: rules ? rules.codeowners : false
    };
  });

  const sockets = new Set();
  const pending = new Map(); // server -> browser requests awaiting a reply

  hooks.broadcast = (channel, args) => {
    const msg = JSON.stringify({ t: 'evt', ch: channel, ...encodeArgs(secretRefs.clean(args)) });
    for (const ws of sockets) if (ws.readyState === ws.OPEN) ws.send(msg);
  };

  hooks.clientRequest = (kind, payload) => {
    const ws = [...sockets].find((s) => s.readyState === s.OPEN);
    if (!ws) return Promise.reject(new Error('No browser connected'));
    const id = crypto.randomUUID();
    ws.send(JSON.stringify({ t: 'req', id, kind, payload: secretRefs.clean(payload) }));
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`Browser did not answer ${kind}`));
      }, 10 * 60 * 1000);
    });
  };

  // Every call runs as this worker's person (null in single-user local mode).
  const event = () => ({
    narado: { user: WORKER_USER },
    sender: mainWindow.webContents,
    senderFrame: mainWindow.webContents.mainFrame,
    frameId: 1,
    processId: 1,
    returnValue: undefined,
    reply: (ch, ...args) => mainWindow.webContents.send(ch, ...args)
  });

  // The front has already checked the session or token; here the person is fixed.
  const auth = {
    enabled: MULTI_USER,
    users: { getUser: (id) => (WORKER_USER && id === WORKER_USER.id ? WORKER_USER : null) },
    userFor: () => WORKER_USER
  };

  const invoke = (channel, ...args) => {
    const handler = ipcMain.getHandler(channel);
    if (!handler) throw new Error(`No handler for ${channel}`);
    return Promise.resolve(handler(event(), ...args)).then((v) => secretRefs.clean(v));
  };
  const mcp = require('./narado/mcp').createMcpHandler({
    call: invoke,
    callAs: () => invoke,
    auth,
    ipcMain,
    workspaces: narado.workspaces,
    collectionsFor: narado.collectionsFor,
    dataDir: DATA_DIR,
    port: PUBLIC_PORT,
    tokens: front.tokens,
    rulesFor
  });

  const server = http.createServer(async (req, res) => {
    if (!fromFront(req)) {
      res.writeHead(403).end();
      return;
    }
    if (await mcp.handle(req, res)) return;
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://x');
    if (pathname !== '/ipc' || !fromFront(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    sockets.add(ws);
    ws.send(JSON.stringify({ t: 'instance', id: INSTANCE_ID }));

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.t === 'hello') {
        onBrowserConnected().catch((err) => console.error('[bruno-web] startup events:', err));
        return;
      }

      if (msg.t === 'reqres') {
        const p = pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          p.resolve(msg.value);
        }
        return;
      }

      if (msg.t === 'send') {
        ipcMain.emit(msg.ch, event(), ...decodeArgs(msg.args, msg.u));
        return;
      }

      if (msg.t === 'invoke') {
        const handler = ipcMain.getHandler(msg.ch);
        let reply;
        if (!handler) {
          reply = { t: 'res', id: msg.id, ok: false, error: errorMessage(msg.ch, new Error(`No handler registered for '${msg.ch}'`)) };
          console.warn(`[bruno-web] no handler: ${msg.ch}`);
        } else {
          try {
            const value = await handler(event(), ...decodeArgs(msg.args, msg.u));
            reply = { t: 'res', id: msg.id, ok: true, value: secretRefs.clean(value) };
          } catch (err) {
            console.error(`[bruno-web] ${msg.ch} failed:`, err && err.stack ? err.stack : err);
            reply = { t: 'res', id: msg.id, ok: false, error: secretRefs.clean(errorMessage(msg.ch, err)) };
          }
        }
        if (ws.readyState === ws.OPEN) {
          try {
            ws.send(JSON.stringify(reply, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
          } catch (err) {
            ws.send(JSON.stringify({ t: 'res', id: msg.id, ok: false, error: errorMessage(msg.ch, err) }));
          }
        }
      }
    });

    ws.on('close', () => sockets.delete(ws));
  });

  // The front is our parent; when it goes, so do we.
  process.on('disconnect', () => process.exit(0));

  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    process.send({ type: 'ready', port, instance: INSTANCE_ID, handlers: ipcMain._handlers.size });
  });
};

main().catch((err) => {
  console.error('[bruno-web] worker failed to start:', err);
  process.exit(1);
});
