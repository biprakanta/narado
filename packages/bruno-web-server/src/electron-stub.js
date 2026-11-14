/**
 * Stand-in for the `electron` module, so Bruno's main-process code
 * (packages/bruno-electron/src) can run in plain Node.js on a server.
 *
 * - ipcMain collects handlers; the WebSocket bridge (bridge.js) calls them.
 * - The single fake BrowserWindow forwards webContents.send() to connected browsers.
 * - Native UI (dialogs, shell) is delegated to the browser through `clientRequest`.
 * - Anything not modelled here is a no-op, so desktop-only features fail quietly.
 */
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = process.env.BRUNO_WEB_DATA_DIR || path.join(os.homedir(), '.bruno-web');
fs.mkdirSync(DATA_DIR, { recursive: true });

// Hooks set by the bridge at startup.
const hooks = {
  broadcast: (_channel, _args) => {},
  clientRequest: async (_kind, _payload) => {
    throw new Error('No browser connected');
  }
};

/**
 * A callable, chainable no-op: any property access or call returns another no-op.
 * Used for Electron objects whose behaviour does not matter on a server.
 */
const noop = () => {
  const fn = function () {
    return proxy;
  };
  const proxy = new Proxy(fn, {
    get: (_target, prop) => {
      if (prop === Symbol.toPrimitive) return () => '';
      if (prop === 'then') return undefined; // never look like a promise
      return proxy;
    },
    apply: () => proxy
  });
  return proxy;
};

/** Wrap an object so that unknown properties become no-ops instead of crashing. */
const withFallback = (target) =>
  new Proxy(target, {
    get: (obj, prop, receiver) => {
      if (prop in obj) return Reflect.get(obj, prop, receiver);
      if (typeof prop === 'symbol' || prop === 'then' || prop === 'toJSON') return undefined;
      return noop();
    }
  });

/* ----------------------------------------------------------------------------
 * ipcMain
 * ------------------------------------------------------------------------- */
class IpcMain extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
    this._handlers = new Map();
  }

  handle(channel, fn) {
    this._handlers.set(channel, fn);
  }

  handleOnce(channel, fn) {
    this._handlers.set(channel, async (...args) => {
      this._handlers.delete(channel);
      return fn(...args);
    });
  }

  removeHandler(channel) {
    this._handlers.delete(channel);
  }

  hasHandler(channel) {
    return this._handlers.has(channel);
  }

  getHandler(channel) {
    return this._handlers.get(channel);
  }
}
const ipcMain = new IpcMain();

/* ----------------------------------------------------------------------------
 * The one window and its webContents
 * ------------------------------------------------------------------------- */
// JSON round-trip, as Bruno's own index.js does for webContents.send.
const toWire = (value) => {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(
      JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
    );
  } catch {
    return null;
  }
};

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
    this.id = 1;
    this._zoom = 0;
    this.mainFrame = { url: 'bruno-web://app', frames: [] };
    this.session = withFallback({ clearCache: async () => {}, clearStorageData: async () => {} });
  }

  send(channel, ...args) {
    hooks.broadcast(channel, args.map(toWire));
  }

  isDestroyed() {
    return false;
  }

  setZoomLevel(level) {
    this._zoom = level;
  }

  getZoomLevel() {
    return this._zoom;
  }

  getURL() {
    return this.mainFrame.url;
  }
}

const webContentsProto = FakeWebContents.prototype;
for (const name of ['toggleDevTools', 'openDevTools', 'closeDevTools', 'reload', 'setWindowOpenHandler', 'focus', 'print']) {
  webContentsProto[name] = () => {};
}

class BrowserWindow extends EventEmitter {
  constructor(options = {}) {
    super();
    this.setMaxListeners(0);
    this.options = options;
    this.webContents = withFallback(new FakeWebContents());
    BrowserWindow._all.push(this);
  }

  static getAllWindows() {
    return BrowserWindow._all.slice();
  }

  static getFocusedWindow() {
    return BrowserWindow._all[0] || null;
  }

  static fromWebContents(webContents) {
    return BrowserWindow._all.find((w) => w.webContents === webContents) || BrowserWindow._all[0] || null;
  }

  isMaximized() {
    return false;
  }

  isMinimized() {
    return false;
  }

  isFullScreen() {
    return false;
  }

  isDestroyed() {
    return false;
  }

  isVisible() {
    return true;
  }

  getBounds() {
    return { x: 0, y: 0, width: 1440, height: 900 };
  }

  loadURL() {
    return Promise.resolve();
  }
}
BrowserWindow._all = [];
for (const name of ['show', 'hide', 'focus', 'restore', 'minimize', 'maximize', 'unmaximize', 'close', 'destroy', 'setFullScreen', 'setTitle', 'setBounds', 'setMenu', 'removeMenu']) {
  BrowserWindow.prototype[name] = () => {};
}

/* ----------------------------------------------------------------------------
 * app
 * ------------------------------------------------------------------------- */
const brunoElectronPkg = require('../../bruno-electron/package.json');
// With several people on one server (narado Phase 4d), each worker's "home" folders are
// inside its own data folder rather than the server account's.
const PERSONAL = process.env.NARADO_MULTI_USER === '1';
const HOME = PERSONAL ? DATA_DIR : os.homedir();
const paths = {
  home: HOME,
  appData: DATA_DIR,
  userData: DATA_DIR,
  sessionData: DATA_DIR,
  temp: os.tmpdir(),
  logs: path.join(DATA_DIR, 'logs'),
  crashDumps: path.join(DATA_DIR, 'crashes'),
  cache: path.join(DATA_DIR, 'cache'),
  documents: path.join(HOME, PERSONAL ? 'collections' : 'Documents'),
  downloads: path.join(HOME, 'Downloads'),
  desktop: path.join(HOME, 'Desktop'),
  exe: process.execPath,
  module: process.execPath
};

class App extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
    this.isPackaged = false;
    this.name = 'Bruno';
    this.commandLine = { appendSwitch: () => {}, hasSwitch: () => false, getSwitchValue: () => '' };
    this.dock = withFallback({});
    this._ready = false;
  }

  getPath(name) {
    const p = paths[name] || path.join(DATA_DIR, name);
    return p;
  }

  setPath(name, value) {
    paths[name] = value;
  }

  getVersion() {
    return brunoElectronPkg.version;
  }

  getName() {
    return this.name;
  }

  getAppPath() {
    return path.resolve(__dirname, '../../bruno-electron');
  }

  getLocale() {
    return 'en-US';
  }

  getAppMetrics() {
    return [];
  }

  isReady() {
    return this._ready;
  }

  whenReady() {
    return Promise.resolve();
  }

  markReady() {
    this._ready = true;
    this.emit('ready');
  }

  requestSingleInstanceLock() {
    return true;
  }

  // Desktop lifecycle and OS integration: no-ops on a server.
  quit() {}
  exit() {}
  relaunch() {}
  focus() {}
  releaseSingleInstanceLock() {}
  setAsDefaultProtocolClient() {
    return false;
  }

  removeAsDefaultProtocolClient() {
    return false;
  }

  addRecentDocument() {}
  clearRecentDocuments() {}
}
const app = new App();

/* ----------------------------------------------------------------------------
 * Native UI, delegated to the browser
 * ------------------------------------------------------------------------- */
// Electron allows dialog.showOpenDialog(win, options) or (options).
const dialogOptions = (a, b) => (b === undefined ? a : b) || {};

const dialog = withFallback({
  async showOpenDialog(a, b) {
    const options = dialogOptions(a, b);
    const result = await hooks.clientRequest('dialog:open', {
      title: options.title,
      defaultPath: options.defaultPath,
      properties: options.properties || [],
      filters: options.filters
    });
    return result || { canceled: true, filePaths: [] };
  },
  async showSaveDialog(a, b) {
    const options = dialogOptions(a, b);
    const result = await hooks.clientRequest('dialog:save', {
      title: options.title,
      defaultPath: options.defaultPath,
      filters: options.filters
    });
    return result || { canceled: true };
  },
  async showMessageBox(a, b) {
    const options = dialogOptions(a, b);
    const result = await hooks.clientRequest('dialog:message', {
      title: options.title,
      message: options.message,
      detail: options.detail,
      buttons: options.buttons || ['OK']
    });
    return result || { response: 0, checkboxChecked: false };
  },
  showErrorBox(title, content) {
    hooks.clientRequest('dialog:message', { title, message: content, buttons: ['OK'] }).catch(() => {});
  }
});

const shell = withFallback({
  async openExternal(url) {
    if (!/^(https?|mailto):/i.test(String(url))) throw new Error('Blocked URL scheme');
    await hooks.clientRequest('shell:open-external', { url });
  },
  showItemInFolder() {},
  async openPath() {
    return 'Opening local paths is not available in the web version';
  },
  async trashItem(p) {
    await fs.promises.rm(p, { recursive: true, force: true });
  },
  beep() {}
});

/* ----------------------------------------------------------------------------
 * safeStorage: AES-256-GCM with a key kept in the data folder.
 * Phase 1 only; the server secrets store replaces this later.
 * ------------------------------------------------------------------------- */
const keyFile = path.join(DATA_DIR, 'safe-storage.key');
const getKey = () => {
  if (!fs.existsSync(keyFile)) {
    fs.writeFileSync(keyFile, crypto.randomBytes(32), { mode: 0o600 });
  }
  return fs.readFileSync(keyFile);
};

const safeStorage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'basic_text',
  encryptString(plain) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
    const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  },
  decryptString(buf) {
    const data = Buffer.from(buf);
    const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
  }
};

/* ----------------------------------------------------------------------------
 * Everything else
 * ------------------------------------------------------------------------- */
const nativeTheme = Object.assign(new EventEmitter(), {
  shouldUseDarkColors: false,
  shouldUseHighContrastColors: false,
  themeSource: 'system'
});

const display = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1080 },
  workAreaSize: { width: 1920, height: 1080 },
  size: { width: 1920, height: 1080 },
  scaleFactor: 1
};
const screen = withFallback({
  getPrimaryDisplay: () => display,
  getAllDisplays: () => [display],
  getDisplayMatching: () => display,
  getDisplayNearestPoint: () => display
});

const session = withFallback({
  defaultSession: withFallback({}),
  fromPartition: () => withFallback({})
});

const protocol = withFallback({
  registerSchemesAsPrivileged: () => {},
  handle: () => {},
  unhandle: () => {},
  isProtocolHandled: () => false
});

const Menu = withFallback({
  buildFromTemplate: () => withFallback({}),
  setApplicationMenu: () => {},
  getApplicationMenu: () => null
});

const globalShortcut = withFallback({ register: () => true, unregister: () => {}, unregisterAll: () => {} });

class Notification extends EventEmitter {
  static isSupported() {
    return false;
  }

  show() {}
  close() {}
}

module.exports = withFallback({
  app,
  ipcMain,
  BrowserWindow,
  dialog,
  shell,
  safeStorage,
  nativeTheme,
  screen,
  session,
  protocol,
  Menu,
  globalShortcut,
  Notification,
  clipboard: withFallback({ writeText: () => {}, readText: () => '' }),
  powerMonitor: Object.assign(new EventEmitter(), { getSystemIdleTime: () => 0 }),
  // Renderer-only APIs: not available on the server.
  ipcRenderer: undefined,
  contextBridge: undefined,
  webUtils: undefined,
  // Hooks for the bridge, not part of Electron's API.
  __web: { hooks, DATA_DIR }
});
