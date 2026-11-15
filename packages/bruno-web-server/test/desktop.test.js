const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { start, withGetHandler } = require('../src/desktop');

/** Just enough of Electron's ipcMain: handlers in a Map, as Electron keeps them. */
const fakeIpcMain = () => {
  const m = { _invokeHandlers: new Map() };
  m.handle = (ch, fn) => {
    if (m._invokeHandlers.has(ch)) throw new Error(`Attempted to register a second handler for '${ch}'`);
    m._invokeHandlers.set(ch, fn);
  };
  m.removeHandler = (ch) => m._invokeHandlers.delete(ch);
  m.on = () => {};
  return m;
};

const fakeWindow = () => {
  const sent = [];
  return { sent, webContents: { send: (ch, ...args) => sent.push([ch, args]) } };
};

const quiet = { log() {}, warn() {}, error() {} };

test('narado desktop: narado\'s handlers run in Electron\'s main process, with its own data folder', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'narado-desktop-'));
  const ipcMain = fakeIpcMain();
  // A Bruno handler registered before narado starts, and a send channel to wrap.
  ipcMain.handle('renderer:ready', async () => ({ ok: true }));
  ipcMain.handle('send-http-request', async (_e, item) => ({ status: 200, data: { echoed: item.request.headers } }));
  const mainWindow = fakeWindow();
  const app = { getPath: () => userData };
  const { dataDir } = await start({ app, ipcMain, mainWindow, collectionWatcher: {}, openCollection: async () => {}, env: { NARADO_GITHUB_TOKEN: 'local-token' }, log: quiet });

  assert.equal(dataDir, path.join(userData, 'narado-data'));
  for (const ch of ['narado:hosts', 'narado:catalogue', 'narado:open', 'narado:sync', 'narado:synced', 'narado:request-rules', 'narado:secrets:stores', 'narado:secrets:reveal']) {
    assert.ok(ipcMain._invokeHandlers.has(ch), `${ch} is registered`);
  }
  const hosts = await ipcMain._invokeHandlers.get('narado:hosts')({});
  assert.deepEqual(hosts.filter((h) => h.connected).map((h) => [h.id, h.via]), [['github', 'server']], 'single-user, with the local token');
  assert.deepEqual(await ipcMain._invokeHandlers.get('renderer:ready')({}), { ok: true }, "Bruno's own handlers still answer");

  // Handlers registered later are wrapped too, and events to the window go through the cleaner.
  ipcMain.handle('later:handler', async () => 'fine');
  assert.equal(await ipcMain._invokeHandlers.get('later:handler')({}), 'fine');
  mainWindow.webContents.send('main:collection-opened', '/x', 'uid', { name: 'x' });
  assert.equal(mainWindow.sent.length, 1);
});

test('withGetHandler gives Electron\'s ipcMain the lookup the shared code uses', () => {
  const ipcMain = fakeIpcMain();
  const fn = async () => 1;
  ipcMain.handle('a', fn);
  const ipc = withGetHandler(ipcMain);
  assert.equal(ipc.getHandler('a'), fn);
  ipc.removeHandler('a');
  assert.equal(ipc.getHandler('a'), undefined);
  assert.throws(() => withGetHandler({ handle() {}, removeHandler() {} }), /does not expose its IPC handlers/);
});

test('replies and events leave the main process cleaned; only a reveal carries a value', async () => {
  const { cleanOutgoing } = require('../src/desktop');
  const ipcMain = fakeIpcMain();
  ipcMain.handle('send-http-request', async () => ({ headers: { authorization: 'Bearer sk_live_1' } }));
  ipcMain.handle('narado:secrets:reveal', async () => ({ value: 'sk_live_1' }));
  const mainWindow = fakeWindow();
  const secretRefs = { clean: (v) => JSON.parse(JSON.stringify(v).replace(/sk_live_1/g, '••••••')) };
  cleanOutgoing({ ipc: withGetHandler(ipcMain), ipcMain, mainWindow, secretRefs });
  assert.deepEqual(await ipcMain._invokeHandlers.get('send-http-request')({}), { headers: { authorization: 'Bearer ••••••' } });
  assert.deepEqual(await ipcMain._invokeHandlers.get('narado:secrets:reveal')({}), { value: 'sk_live_1' });
  ipcMain.handle('later', async () => 'token sk_live_1');
  assert.equal(await ipcMain._invokeHandlers.get('later')({}), 'token ••••••');
  mainWindow.webContents.send('main:ws:message', 'id', 'c', { message: 'sk_live_1' });
  assert.deepEqual(mainWindow.sent[0], ['main:ws:message', ['id', 'c', { message: '••••••' }]]);
});
