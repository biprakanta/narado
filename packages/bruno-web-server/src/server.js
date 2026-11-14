/**
 * Bruno web server (Phase 1: single user, local folders).
 *
 * Runs Bruno's main-process code (packages/bruno-electron/src) in Node.js with
 * `electron` replaced by ./electron-stub.js, and relays IPC between the browser
 * and those handlers over a WebSocket at /ipc.
 *
 * Wire protocol (JSON messages):
 *   browser -> server  {t:'invoke', id, ch, args}   reply {t:'res', id, ok, value | error}
 *   browser -> server  {t:'send', ch, args}         one-way, for ipcMain.on listeners
 *   server  -> browser {t:'evt', ch, args}          webContents.send()
 *   server  -> browser {t:'req', id, kind, payload} native UI (dialogs); reply {t:'reqres', id, value}
 */
const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');

/* ---------------------------------------------------------------------------
 * 1. Route `require('electron')` to the stub before any Bruno code loads.
 * ------------------------------------------------------------------------ */
const STUB_PATH = require.resolve('./electron-stub');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return STUB_PATH;
  return originalResolve.call(this, request, ...rest);
};

// Run Bruno as a packaged app. In dev mode Bruno answers 'main:renderer-ready' only once per
// process (a guard for React strict mode in its one Electron window); here every page
// load is a new renderer, so a reload would never get its workspaces back.
if (!('ELECTRON_IS_DEV' in process.env)) process.env.ELECTRON_IS_DEV = '0';

const electron = require('electron');
const { app, ipcMain, BrowserWindow } = electron;
const { hooks, DATA_DIR } = electron.__web;

const HOST = process.env.BRUNO_WEB_HOST || '127.0.0.1';
const PORT = Number(process.env.BRUNO_WEB_PORT || 4100);
const STATIC_DIR = path.resolve(__dirname, '../../bruno-app/dist');
// Browser origins allowed to connect. The rsbuild dev server (3000) and this server.
const ALLOWED_ORIGINS = new Set(
  (process.env.BRUNO_WEB_ORIGINS || `http://localhost:3000,http://127.0.0.1:3000,http://localhost:${PORT},http://127.0.0.1:${PORT}`)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

/* ---------------------------------------------------------------------------
 * 2. Load Bruno's main process the way packages/bruno-electron/src/index.js
 *    does inside app.on('ready'), minus windows, menus and the terminal.
 * ------------------------------------------------------------------------ */
const ELECTRON_SRC = path.resolve(__dirname, '../../bruno-electron/src');
const brunoRequire = (rel) => require(path.join(ELECTRON_SRC, rel));

const optional = (label, fn) => {
  try {
    return fn();
  } catch (err) {
    console.warn(`[bruno-web] ${label} skipped: ${err.message}`);
    return undefined;
  }
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
  reg('ipc/git', mainWindow);
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
    dataDir: DATA_DIR
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
 * 3. HTTP (static files of the built app) + WebSocket bridge.
 * ------------------------------------------------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.map': 'application/json'
};

const serveStatic = (req, res) => {
  if (!fs.existsSync(STATIC_DIR)) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('Bruno web server is running. Open the interface from the rsbuild dev server (npm run dev:web), or build it (npm run build:web) to serve it from here.');
    return;
  }
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = path.normalize(path.join(STATIC_DIR, urlPath));
  if (!file.startsWith(STATIC_DIR)) {
    res.writeHead(403).end();
    return;
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(STATIC_DIR, 'index.html');
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
};

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

const main = async () => {
  const { WebSocketServer } = require('ws');
  const { mainWindow, onBrowserConnected, narado } = await startBruno();

  const sockets = new Set();
  const pending = new Map(); // server -> browser requests awaiting a reply

  hooks.broadcast = (channel, args) => {
    const msg = JSON.stringify({ t: 'evt', ch: channel, ...encodeArgs(args) });
    for (const ws of sockets) if (ws.readyState === ws.OPEN) ws.send(msg);
  };

  hooks.clientRequest = (kind, payload) => {
    const ws = [...sockets].find((s) => s.readyState === s.OPEN);
    if (!ws) return Promise.reject(new Error('No browser connected'));
    const id = crypto.randomUUID();
    ws.send(JSON.stringify({ t: 'req', id, kind, payload }));
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`Browser did not answer ${kind}`));
      }, 10 * 60 * 1000);
    });
  };

  // `user` is the signed-in narado user behind the call (null in single-user local mode).
  const event = (user = null) => ({
    narado: { user },
    sender: mainWindow.webContents,
    senderFrame: mainWindow.webContents.mainFrame,
    frameId: 1,
    processId: 1,
    returnValue: undefined,
    reply: (ch, ...args) => mainWindow.webContents.send(ch, ...args)
  });

  // Sign-in (Phase 4b). Without a provider, narado is a single-user local tool and may
  // only listen on a loopback address.
  const auth = require('./narado/auth').createAuth({ dataDir: DATA_DIR, port: PORT });
  if (!auth.enabled && !['127.0.0.1', '::1', 'localhost'].includes(HOST)) {
    throw new Error(`Refusing to listen on ${HOST} without sign-in. Configure NARADO_OIDC_ISSUER, or use 127.0.0.1.`);
  }
  ALLOWED_ORIGINS.add(auth.publicUrl);

  // narado's MCP server at /mcp (token-protected; see src/narado/mcp.js).
  const mcp = require('./narado/mcp').createMcpHandler({
    call: (channel, ...args) => {
      const handler = ipcMain.getHandler(channel);
      if (!handler) throw new Error(`No handler for ${channel}`);
      return handler(event(), ...args);
    },
    callAs: (user) => (channel, ...args) => {
      const handler = ipcMain.getHandler(channel);
      if (!handler) throw new Error(`No handler for ${channel}`);
      return handler(event(user), ...args);
    },
    auth,
    ipcMain,
    workspaces: narado.workspaces,
    collectionsFor: narado.collectionsFor,
    dataDir: DATA_DIR,
    port: PORT
  });

  const server = http.createServer(async (req, res) => {
    if (await auth.handle(req, res)) return;
    if (await mcp.handle(req, res)) return;
    if (auth.enabled && !auth.userFor(req)) {
      const { pathname, search } = new URL(req.url, 'http://x');
      res.writeHead(302, { location: `/auth/login?return=${encodeURIComponent(pathname + search)}`, 'cache-control': 'no-store' });
      res.end();
      return;
    }
    serveStatic(req, res);
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://x');
    const origin = req.headers.origin;
    if (pathname !== '/ipc' || !ALLOWED_ORIGINS.has(origin)) {
      console.warn(`[bruno-web] rejected WebSocket from origin ${origin || '(none)'}`);
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    const user = auth.enabled ? auth.userFor(req) : null;
    if (auth.enabled && !user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.naradoUser = user;
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    sockets.add(ws);
    console.log(`[bruno-web] browser connected (${sockets.size} open)`);

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
        ipcMain.emit(msg.ch, event(ws.naradoUser), ...decodeArgs(msg.args, msg.u));
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
            const value = await handler(event(ws.naradoUser), ...decodeArgs(msg.args, msg.u));
            reply = { t: 'res', id: msg.id, ok: true, value };
          } catch (err) {
            console.error(`[bruno-web] ${msg.ch} failed:`, err && err.stack ? err.stack : err);
            reply = { t: 'res', id: msg.id, ok: false, error: errorMessage(msg.ch, err) };
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

    ws.on('close', () => {
      sockets.delete(ws);
      console.log(`[bruno-web] browser disconnected (${sockets.size} open)`);
    });
  });

  server.listen(PORT, HOST, () => {
    console.log(`[bruno-web] sign-in: ${auth.enabled ? `OIDC (${process.env.NARADO_OIDC_ISSUER}), public URL ${auth.publicUrl}` : 'off (single-user local mode)'}`);
    console.log(`[bruno-web] MCP server at ${mcp.url}; create personal tokens in narado (Git section, MCP tokens)${mcp.writeAllowed ? '' : '; write tokens turned off'}`);
    console.log(`[bruno-web] listening on http://${HOST}:${PORT} (data: ${DATA_DIR})`);
    console.log(`[bruno-web] ${ipcMain._handlers.size} IPC handlers registered`);
  });
};

main().catch((err) => {
  console.error('[bruno-web] failed to start:', err);
  process.exit(1);
});
