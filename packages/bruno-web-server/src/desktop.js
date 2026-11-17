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
 * The "front" (Git accounts, secrets stores, devices) is the team's narado server, reached
 * over HTTPS with this computer's device session (narado/desktop-front.js, desktop phase
 * D2): Git access tokens and secret values come from the server, which keeps refresh
 * tokens and store credentials. Until a server is set (or with none, for development), the
 * same code runs here as in the server's single-user local mode: Git uses NARADO_<HOST>_TOKEN.
 * NARADO_SERVER_URL presets the server address (an organisation's install setting).
 */
const fs = require('node:fs');
const path = require('node:path');
const { registerNaradoIpc } = require('./narado/ipc');
const { GitAccounts } = require('./narado/git-accounts');
const { SecretsService } = require('./narado/secrets');
const { Identity } = require('./narado/secrets/identity');
const { SecretRefs, REVEAL_CHANNEL, SEND_CHANNELS, collectionPathIn } = require('./narado/secrets/worker-side');
const { DesktopGuard } = require('./narado/requests/desktop-guard');
const { compareVersions } = require('./narado/versions');

/** This copy of narado's version: version.json beside the bundle (packaged), or the package. */
const naradoVersion = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'version.json'), 'utf8')).narado;
  } catch {
    return require('../package.json').version;
  }
};
const { installSendRules } = require('./narado/requests/guard');
const { AllowlistReader } = require('./narado/requests/allowlist');
const { RemoteFront, NeedsSignIn, normaliseServer } = require('./narado/desktop-front');
const { DesktopSettings, LocalMcp, allowedByPolicy } = require('./narado/desktop-local');
const { createMcpHandler } = require('./narado/mcp');

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

/**
 * The front in use: the server's once one is set, otherwise the local one. Calls are
 * forwarded at call time, so signing in or out switches without restarting.
 */
const switchingFront = ({ local, remote }) => {
  const current = () => (remote.server ? remote : local);
  const notSignedIn = (fn) => async (...args) => {
    const f = current();
    if (f === remote && !remote.signedIn) throw new NeedsSignIn();
    return fn(f)(...args);
  };
  return {
    current,
    git: {
      status: async () => {
        const f = current();
        if (f === remote && !remote.signedIn) {
          // Show the server's hosts as not connected, so the interface can say why.
          const hosts = (remote.session && remote.session.hosts) || [];
          return hosts.map((h) => ({ id: h.id, type: h.type, name: h.name || h.id, url: h.url, connected: false, needsSignIn: true }));
        }
        return f.git.status();
      },
      token: notSignedIn((f) => f.git.token)
    },
    secrets: {
      stores: notSignedIn((f) => f.secrets.stores),
      resolve: notSignedIn((f) => f.secrets.resolve),
      list: notSignedIn((f) => f.secrets.list),
      check: notSignedIn((f) => f.secrets.check),
      reveal: notSignedIn((f) => f.secrets.reveal)
    }
  };
};

/** Sends made from this computer, reported to the server (person, device, method, host, repo, status). */
const auditSends = ({ ipcMain, remote, locateRepo, log, file = null, intervalMs = 15000 }) => {
  const MAX = 5000;
  // Kept on disk until reported, so reports made offline survive a restart. They hold no
  // paths, headers or bodies: time, method, host, repository and status only.
  let queue = [];
  if (file) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(saved)) queue = saved.slice(-MAX);
    } catch {}
  }
  let saving = null;
  const save = () => {
    if (!file || saving) return;
    saving = setTimeout(() => {
      saving = null;
      try {
        if (queue.length) fs.writeFileSync(file, JSON.stringify(queue), { mode: 0o600 });
        else fs.rmSync(file, { force: true });
      } catch (err) {
        log.warn(`[narado] desktop: couldn't keep send reports (${err.message})`);
      }
    }, 500);
    if (saving.unref) saving.unref();
  };
  const flush = async () => {
    if (!queue.length || !remote.signedIn) return;
    const batch = queue.splice(0, 500);
    try {
      await remote.audit(batch);
      save();
      if (queue.length) return flush();
    } catch (err) {
      queue.unshift(...batch);
      if (queue.length > MAX) queue.splice(0, queue.length - MAX);
      save();
      log.warn(`[narado] desktop: ${queue.length} send report(s) waiting for the server (${err.message})`);
    }
  };
  const timer = setInterval(flush, intervalMs);
  if (timer.unref) timer.unref();
  const handlers = ipcMain._invokeHandlers;
  const original = handlers && handlers.get('send-http-request');
  if (original) {
    ipcMain.removeHandler('send-http-request');
    ipcMain.handle('send-http-request', async (event, item, collection, ...rest) => {
      const res = await original(event, item, collection, ...rest);
      if (remote.signedIn) {
        let host = '(templated)';
        try {
          host = new URL(String((item && item.request && item.request.url) || '')).host || host;
        } catch {}
        const loc = collection && collection.pathname ? locateRepo(collection.pathname) : null;
        queue.push({
          at: Date.now(),
          method: String((item && item.request && item.request.method) || 'GET').toUpperCase(),
          host,
          repo: loc ? `${loc.hostId}:${loc.repoPath}` : null,
          status:
            res && Number.isInteger(res.status)
              ? res.status
              : res && res.error
                ? /ENARADOREFUSED|RequestRefused|narado never sends|allowlist|lets narado desktop/.test(String(res.error)) ? 'refused' : 'error'
                : '?',
          ...(remote.online === false ? { offline: true } : {})
        });
        if (queue.length > MAX) queue.splice(0, queue.length - MAX);
        save();
      }
      return res;
    });
  }
  return { flush, get queue() { return queue; }, stop: () => clearInterval(timer) };
};

const start = async ({ app, ipcMain, mainWindow, collectionWatcher, openCollection, env = process.env, log = console, electron }) => {
  const { shell, safeStorage } = electron || require('electron');
  const dataDir = path.join(app.getPath('userData'), 'narado-data');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const ipc = withGetHandler(ipcMain);
  const local = localFront({ dataDir, env });
  const remote = new RemoteFront({ dataDir, safeStorage, openExternal: (url) => shell.openExternal(url), log });
  if (!remote.server && env.NARADO_SERVER_URL) {
    remote.server = normaliseServer(env.NARADO_SERVER_URL);
    remote.save();
  }
  const front = switchingFront({ local, remote });
  // OAuth 2 sign-ins to APIs come back to the team's narado server, which hands those
  // finished in the system browser to this app through narado:// (bruno-electron/src/index.js).
  const useServerOauth2Callback = () => {
    if (remote.server) env.NARADO_OAUTH2_CALLBACK_URL = process.env.NARADO_OAUTH2_CALLBACK_URL = `${remote.server}/oauth2/callback`;
  };
  useServerOauth2Callback();

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

  // The server's Git hosts (self-managed GitLab included) replace the defaults.
  const useServerHosts = (hosts) => {
    if (!Array.isArray(hosts) || !hosts.length) return;
    try {
      narado.registry.setHosts(hosts);
    } catch (err) {
      log.warn(`[narado] desktop: ignoring the server's Git hosts (${err.message})`);
    }
  };
  if (remote.server && remote.session) useServerHosts(remote.session.hosts);

  // A synced copy counts as part of the repo it came from, for secrets and request rules.
  const locateRepo = (p) => narado.workspaces.locate(p) || narado.sync.sourceOf(p);

  // Request rules on this computer (desktop phase D3, narado/requests/desktop-guard.js):
  // cloud metadata never; public hosts only from the repo's allowlist; private and local
  // addresses allowed; the organisation's policy can narrow it. Installed before secrets,
  // so secret values are fetched from the server outside the send's rules.
  const allowlists = new AllowlistReader({ envFor: (base) => narado.workspaces.gitEnvFor(base) });
  const sendPolicy = () => (remote.server && remote.session && remote.session.policy && remote.session.policy.send) || 'any';
  const hostNameOf = (u) => {
    try {
      return new URL(u).hostname;
    } catch {
      return null;
    }
  };
  const rulesFor = async (collectionPath) => {
    const loc = collectionPath ? locateRepo(collectionPath) : null;
    if (!loc) return { rules: null, repo: null };
    const repo = `${loc.hostId}:${loc.repoPath}`;
    return { rules: await allowlists.rulesFor({ base: narado.workspaces.basePath(loc.hostId, loc.repoPath), repo }), repo };
  };
  const rulesOn = remote.server || env.NARADO_REQUEST_RULES !== '0'; // off only for local development without a server
  if (rulesOn) {
    const guard = new DesktopGuard({
      policy: sendPolicy,
      trusted: () => [hostNameOf(remote.server), ...narado.registry.listHosts().map((h) => hostNameOf(h.url))].filter(Boolean),
      log
    });
    guard.install();
    installSendRules({ ipcMain: ipc, guard, channels: SEND_CHANNELS, collectionPathIn, rulesFor });
  }

  const secretRefs = new SecretRefs({ secrets: front.secrets, workspaces: { locate: locateRepo } });
  secretRefs.install(ipc);

  // The Git panel's "hosts this repo may send to".
  ipcMain.handle('narado:request-rules', async (_e, { path: p } = {}) => {
    const loc = p ? locateRepo(p) : null;
    if (!loc) return { enforced: !!rulesOn, desktop: true, policy: sendPolicy(), repo: null, branch: null, hosts: [], codeowners: false, codeOwnerReview: null, protectedBranch: null };
    const rules = await allowlists.rulesFor({ base: narado.workspaces.basePath(loc.hostId, loc.repoPath), repo: `${loc.hostId}:${loc.repoPath}` });
    let review = { protected: null, codeOwnerReview: null };
    try {
      const provider = narado.registry.get(loc.hostId);
      if (provider.reviewRules && rules.branch) review = await provider.reviewRules(loc.repoPath, rules.branch);
    } catch {}
    return {
      enforced: !!rulesOn,
      // On the desktop, private and local addresses don't need to be listed.
      desktop: true,
      policy: sendPolicy(),
      repo: `${loc.hostId}:${loc.repoPath}`,
      branch: rules.branch,
      hosts: rules.summary(),
      codeowners: rules.codeowners,
      codeOwnerReview: review.codeOwnerReview,
      protectedBranch: review.protected
    };
  });

  // Signing this computer in to the team's narado server (desktop phase D2).
  // Updates (desktop phase D4): the team's server offers installers; see updater below.
  let update = { current: naradoVersion(), available: null, required: null, state: 'idle', progress: null, error: null };
  const status = () => ({ ...(remote.server ? remote.status() : { mode: 'local', server: null, signedIn: false, user: null, device: null, policy: null }), update });
  remote.onChange(() => {
    if (!(mainWindow.isDestroyed && mainWindow.isDestroyed())) mainWindow.webContents.send('narado:desktop-status', status());
  });
  ipcMain.handle('narado:desktop-status', async () => status());
  ipcMain.handle('narado:desktop-sign-in', async (_e, { server } = {}) => {
    await remote.signIn(server);
    useServerHosts(remote.session && remote.session.hosts);
    useServerOauth2Callback();
    checkForUpdate().catch(() => {});
    if (!(mainWindow.isDestroyed && mainWindow.isDestroyed()) && mainWindow.focus) mainWindow.focus();
    return status();
  });
  ipcMain.handle('narado:desktop-sign-in-link', async () => remote.signInLink());
  ipcMain.handle('narado:desktop-sign-out', async () => {
    await audit.flush();
    await remote.signOut();
    return status();
  });
  // The server's admin pages, in the system browser (signed in there with SSO).
  ipcMain.handle('narado:desktop-open-admin', async () => {
    if (!remote.server) throw new NeedsSignIn();
    await shell.openExternal(`${remote.server}/admin`);
    return true;
  });
  ipcMain.handle('narado:desktop-connect-git', async (_e, { hostId } = {}) => {
    if (!remote.signedIn) throw new NeedsSignIn();
    await shell.openExternal(remote.connectUrl(String(hostId || '')));
    return true;
  });
  ipcMain.handle('narado:desktop-disconnect-git', async (_e, { hostId } = {}) => {
    if (!remote.signedIn) throw new NeedsSignIn();
    remote.gitTokens.delete(String(hostId || ''));
    return remote.call('git.disconnect', [String(hostId || '')]);
  });
  ipcMain.handle('narado:devices', async () => {
    if (!remote.signedIn) throw new NeedsSignIn();
    return remote.devices.list();
  });
  ipcMain.handle('narado:device-revoke', async (_e, { id } = {}) => {
    if (!remote.signedIn) throw new NeedsSignIn();
    const ok = await remote.devices.revoke(id);
    // Signing out this computer from its own Devices list.
    if (remote.session && remote.session.device && remote.session.device.id === id) remote.forget();
    return ok;
  });

  /* ---- updates from the team's server ---- */
  const pushStatus = () => {
    if (!(mainWindow.isDestroyed && mainWindow.isDestroyed())) mainWindow.webContents.send('narado:desktop-status', status());
  };
  const platformDir = { darwin: 'mac', win32: 'win', linux: 'linux' }[process.platform];
  // Which installer this copy updates with: an AppImage replaces itself, a .deb install uses .deb.
  const kind = { mac: 'dmg', win: 'exe', linux: process.env.APPIMAGE ? 'AppImage' : 'deb' }[platformDir];
  const checkForUpdate = async () => {
    if (!remote.signedIn || !platformDir) return update;
    const minimum = remote.session && remote.session.server && remote.session.server.minDesktopVersion;
    try {
      const latest = await remote.latestUpdate({ platform: platformDir, arch: process.arch, kind });
      update = {
        ...update,
        available: latest && compareVersions(latest.version, update.current) > 0 ? latest : null,
        required: minimum && compareVersions(update.current, minimum) < 0 ? minimum : null,
        error: null
      };
    } catch (err) {
      update = { ...update, error: err.message };
    }
    pushStatus();
    return update;
  };
  ipcMain.handle('narado:desktop-update-check', async () => checkForUpdate());
  ipcMain.handle('narado:desktop-update-install', async () => {
    if (!update.available) await checkForUpdate();
    const next = update.available;
    if (!next) throw new Error('narado is up to date');
    update = { ...update, state: 'downloading', progress: 0, error: null };
    pushStatus();
    try {
      let last = 0;
      const file = await remote.downloadUpdate(platformDir, next.file, path.join(app.getPath('userData'), 'updates'), (p) => {
        if (p !== null && p - last >= 0.02) {
          last = p;
          update = { ...update, progress: p };
          pushStatus();
        }
      });
      update = { ...update, state: 'installing', progress: 1 };
      pushStatus();
      log.log(`[narado] desktop: installing narado ${next.version} from ${path.basename(file)}`);
      // Hand over to the installer: macOS opens the disk image to drag narado in; Windows
      // runs the installer; Linux opens the package (or swaps in the new AppImage).
      if (kind === 'AppImage' && process.env.APPIMAGE) {
        fs.chmodSync(file, 0o755);
        fs.renameSync(file, process.env.APPIMAGE);
        app.relaunch();
      } else {
        const err = await shell.openPath(file);
        if (err) throw new Error(err);
      }
      setTimeout(() => app.quit(), 1500);
      return { installing: next.version };
    } catch (err) {
      update = { ...update, state: 'idle', progress: null, error: err.message };
      pushStatus();
      throw err;
    }
  });
  const updateTimer = setInterval(() => checkForUpdate().catch(() => {}), 6 * 60 * 60 * 1000);
  if (updateTimer.unref) updateTimer.unref();

  /* ---- this computer's settings: the local MCP server and the terminal (phase D5) ---- */
  const settings = new DesktopSettings({ dataDir });
  const policy = () => allowedByPolicy(remote.server && remote.session && remote.session.policy);
  // Calls the MCP tools make, as the window would make them (and cleaned the same way).
  const windowEvent = () => ({
    sender: mainWindow.webContents,
    senderFrame: mainWindow.webContents.mainFrame,
    reply: (ch, ...args) => mainWindow.webContents.send(ch, ...args)
  });
  const invoke = (channel, ...args) => {
    const handler = ipc.getHandler(channel);
    if (!handler) throw new Error(`No handler for ${channel}`);
    return Promise.resolve(handler(windowEvent(), ...args)).then((v) => secretRefs.clean(v));
  };
  // Bruno's events to the window, for the MCP tools that wait for gRPC and WebSocket replies.
  const eventTaps = new Set();
  const wc = mainWindow.webContents;
  const sendToWindow = wc.send.bind(wc);
  wc.send = (channel, ...args) => {
    for (const tap of eventTaps) {
      try {
        tap(channel, args);
      } catch {}
    }
    return sendToWindow(channel, ...args);
  };
  const mcpHandler = createMcpHandler({
    call: invoke,
    callAs: () => invoke,
    ipcMain,
    workspaces: narado.workspaces,
    collectionsFor: narado.collectionsFor,
    dataDir,
    port: () => settings.get().mcp.port,
    writeAllowed: () => policy().mcp === 'write',
    rulesFor,
    env,
    log,
    onEvent: (fn) => {
      eventTaps.add(fn);
      return () => eventTaps.delete(fn);
    }
  });
  const localMcp = new LocalMcp({ createHandler: () => mcpHandler, log });
  const applyMcp = async () => {
    const { mcp } = settings.get();
    await localMcp.apply({ enabled: mcp.enabled && policy().mcp !== 'off', port: mcp.port });
  };
  const desktopSettings = () => {
    const s = settings.get();
    const allowed = policy();
    return {
      ...s,
      allowed,
      mcpRunning: localMcp.running,
      mcpUrl: `http://127.0.0.1:${s.mcp.port}/mcp`,
      mcpError: localMcp.error,
      terminalOn: s.terminal && allowed.terminal
    };
  };
  // The tokens modal also shows (and switches) the local server on the desktop.
  ipcMain.removeHandler('narado:mcp-info');
  ipcMain.handle('narado:mcp-info', async () => {
    const d = desktopSettings();
    return { url: d.mcpUrl, writeAllowed: mcpHandler.writeAllowed, desktop: true, enabled: d.mcp.enabled, running: d.mcpRunning, port: d.mcp.port, error: d.mcpError, policy: d.allowed.mcp };
  });
  ipcMain.handle('narado:desktop-settings', async () => desktopSettings());
  ipcMain.handle('narado:desktop-settings-update', async (_e, changes = {}) => {
    if (changes.mcp && changes.mcp.enabled && policy().mcp === 'off') throw new Error("Your organisation's policy turns MCP off on narado desktop");
    if (changes.terminal && !policy().terminal) throw new Error("Your organisation's policy turns the terminal off on narado desktop");
    settings.update(changes);
    await applyMcp();
    if (changes.terminal === false) await closeTerminals();
    return desktopSettings();
  });
  // Turning the terminal off (or a policy that forbids it) ends the shells already open.
  const closeTerminals = async () => {
    const list = ipc.getHandler('terminal:list-sessions');
    if (!list) return;
    const sessions = (await list(windowEvent())) || [];
    for (const s of sessions) ipcMain.emit('terminal:kill', windowEvent(), s.sessionId);
  };
  remote.onChange(() => {
    applyMcp().catch((err) => log.warn(`[narado] desktop: ${err.message}`));
    if (!desktopSettings().terminalOn) closeTerminals().catch(() => {});
  });
  if (app.on) {
    app.on('will-quit', () => {
      localMcp.stop().catch(() => {});
    });
  }
  await applyMcp();

  // Bruno's terminal runs a shell on this computer: only when the person turns it on and
  // the organisation's policy allows it.
  const terminalCreate = ipc.getHandler('terminal:create');
  if (terminalCreate) {
    ipcMain.removeHandler('terminal:create');
    ipcMain.handle('terminal:create', async (event, ...args) => {
      if (!desktopSettings().terminalOn) throw new Error('The terminal is off. Turn it on in the Terminal tab.');
      return terminalCreate(event, ...args);
    });
  }

  const audit = auditSends({ ipcMain, remote, locateRepo, log, file: path.join(dataDir, 'pending-send-reports.json') });

  // Offline: look for the server every 30 seconds; when it's back, refresh the session and
  // send the reports made meanwhile.
  const reconnect = setInterval(() => {
    if (!remote.signedIn || remote.online) return;
    remote
      .loadSession()
      .then((s) => {
        useServerHosts(s.hosts);
        return audit.flush();
      })
      .catch(() => {});
  }, 30 * 1000);
  if (reconnect.unref) reconnect.unref();
  remote.onChange((s) => {
    if (s.online) audit.flush();
  });
  cleanOutgoing({ ipc, ipcMain, mainWindow, secretRefs });

  log.log(`[narado] desktop: data in ${dataDir}`);
  if (remote.server) {
    log.log(`[narado] desktop: server ${remote.server} (${remote.signedIn ? 'signed in' : 'not signed in'})`);
    // Refresh the person, policy and hosts in the background; offline keeps the last ones.
    if (remote.signedIn) {
      remote
        .loadSession()
        .then((s) => {
          useServerHosts(s.hosts);
          return checkForUpdate();
        })
        .catch((err) => log.warn(`[narado] desktop: ${err.message}`));
    }
  } else {
    const hosts = await local.git.status();
    log.log(`[narado] desktop: no narado server set; local mode. Git hosts ${hosts.map((h) => `${h.id} (${h.connected ? `connected${h.via === 'server' ? ' with a token' : ''}` : 'not connected'})`).join(', ')}`);
    log.log(`[narado] desktop: secrets stores ${local.secretsService.enabled ? local.secretsService.listStores().map((s) => s.id).join(', ') : 'none'}`);
  }
  // The start-up check CI runs on each system (narado/desktop-smoke.js): check, report, quit.
  if (env.NARADO_DESKTOP_SMOKE === '1') {
    const { runSmoke } = require('./narado/desktop-smoke');
    runSmoke({ ipcMain, getHandler: (ch) => ipc.getHandler(ch), mainWindow, safeStorage, log, env })
      .then((r) => app.exit(r.ok ? 0 : 1))
      .catch((err) => {
        log.error('[narado] desktop smoke check failed:', err);
        app.exit(1);
      });
  }
  return { narado, dataDir, remote, front, audit, settings, localMcp };
};

module.exports = { start, withGetHandler, localFront, cleanOutgoing, switchingFront, auditSends };
