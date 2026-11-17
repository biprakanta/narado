const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { start } = require('../src/desktop');
const { DesktopSettings, LocalMcp, allowedByPolicy, DEFAULT_MCP_PORT } = require('../src/narado/desktop-local');

const fakeIpcMain = () => {
  const m = { _invokeHandlers: new Map(), emitted: [] };
  m.handle = (ch, fn) => {
    if (m._invokeHandlers.has(ch)) throw new Error(`Attempted to register a second handler for '${ch}'`);
    m._invokeHandlers.set(ch, fn);
  };
  m.removeHandler = (ch) => m._invokeHandlers.delete(ch);
  m.on = () => {};
  m.emit = (...args) => m.emitted.push(args);
  return m;
};
const fakeWindow = () => ({ webContents: { send: () => {} } });
const quiet = { log() {}, warn() {}, error() {} };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'narado-d5-'));

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const post = (port, { headers = {}, body = { jsonrpc: '2.0', id: 1, method: 'tools/list' }, pathName = '/mcp' } = {}) =>
  new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, path: pathName, method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'content-length': Buffer.byteLength(data), ...headers } },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, text }));
      }
    );
    req.on('error', reject);
    req.end(data);
  });

const startDesktop = async ({ ipcMain = fakeIpcMain(), userData = tmp(), env = {} } = {}) => {
  const res = await start({ app: { getPath: () => userData }, ipcMain, mainWindow: fakeWindow(), collectionWatcher: {}, openCollection: async () => {}, env: { NARADO_GITHUB_TOKEN: 'local-token', ...env }, log: quiet });
  return { ...res, ipcMain, call: (ch, ...a) => ipcMain._invokeHandlers.get(ch)({}, ...a) };
};

test('desktop settings: MCP and the terminal start off, and bad ports are refused', () => {
  const dir = tmp();
  const s = new DesktopSettings({ dataDir: dir });
  assert.deepEqual(s.get(), { mcp: { enabled: false, port: DEFAULT_MCP_PORT }, terminal: false });
  s.update({ mcp: { enabled: true, port: 5123 }, terminal: true });
  assert.deepEqual(new DesktopSettings({ dataDir: dir }).get(), { mcp: { enabled: true, port: 5123 }, terminal: true }, 'kept on disk');
  assert.throws(() => s.update({ mcp: { port: 80 } }), /1024 to 65535/);
  assert.equal(fs.statSync(path.join(dir, 'desktop-settings.json')).mode & 0o777, 0o600);
});

test('the organisation\'s policy: MCP off, read or write; the terminal allowed unless turned off', () => {
  assert.deepEqual(allowedByPolicy(null), { mcp: 'write', terminal: true });
  assert.deepEqual(allowedByPolicy({ mcp: 'read', terminal: false }), { mcp: 'read', terminal: false });
  assert.deepEqual(allowedByPolicy({ mcp: 'nonsense' }), { mcp: 'write', terminal: true });
});

test('LocalMcp listens on 127.0.0.1 only and says when its port is taken', async () => {
  const port = await freePort();
  const mcp = new LocalMcp({ createHandler: () => ({ handle: async (req, res) => (res.end('hi'), true) }), log: quiet });
  await mcp.apply({ enabled: true, port });
  assert.equal(mcp.running, true);
  assert.equal(mcp.server.address().address, '127.0.0.1');
  const other = new LocalMcp({ createHandler: () => ({ handle: async () => false }), log: quiet });
  await other.apply({ enabled: true, port });
  assert.equal(other.running, false);
  assert.match(other.error, /in use by another program/);
  await mcp.apply({ enabled: false, port });
  assert.equal(mcp.running, false);
});

test('narado desktop runs the MCP server on this computer when turned on, with tokens made in the app', async () => {
  const port = await freePort();
  const d = await startDesktop();
  let info = await d.call('narado:mcp-info');
  assert.equal(info.desktop, true);
  assert.equal(info.enabled, false);
  assert.equal(info.running, false);

  info = await d.call('narado:desktop-settings-update', { mcp: { enabled: true, port } });
  assert.equal(info.mcpRunning, true);
  assert.equal(info.mcpUrl, `http://127.0.0.1:${port}/mcp`);

  // Without a token, from a browser page, or with another Host: refused.
  assert.equal((await post(port)).status, 401);
  assert.equal((await post(port, { headers: { origin: 'https://evil.example' } })).status, 403);
  // The person narado acts for (normally read from GitHub with their token).
  for (const ch of ['narado:hosts', 'narado:me']) d.ipcMain.removeHandler(ch);
  d.ipcMain._invokeHandlers.set('narado:hosts', async () => [{ id: 'github', connected: true }]);
  d.ipcMain._invokeHandlers.set('narado:me', async () => ({ login: 'alice', name: 'Alice' }));
  const { token } = await d.call('narado:mcp-tokens:create', { name: 'test assistant', scope: 'read' });
  assert.ok(fs.existsSync(path.join(d.dataDir, 'mcp-tokens.json')), 'kept on this computer');
  const ok = await post(port, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(ok.status, 200, ok.text);
  assert.match(ok.text, /list_workspaces/);
  assert.doesNotMatch(ok.text, /"update_request"/, 'a read token gets no write tools');
  const rebinding = await post(port, { headers: { authorization: `Bearer ${token}`, host: `attacker.example:${port}` } });
  assert.notEqual(rebinding.status, 200, 'DNS rebinding is refused');
  assert.equal((await post(port, { pathName: '/other' })).status, 404);

  info = await d.call('narado:desktop-settings-update', { mcp: { enabled: false } });
  assert.equal(info.mcpRunning, false);
  await d.localMcp.stop();
});

test("Bruno's terminal on narado desktop: refused until turned on, and shells end when turned off", async () => {
  const ipcMain = fakeIpcMain();
  let created = 0;
  ipcMain.handle('terminal:create', async () => `session-${++created}`);
  ipcMain.handle('terminal:list-sessions', async () => [{ sessionId: 'session-1' }]);
  const d = await startDesktop({ ipcMain });
  await assert.rejects(d.call('terminal:create', {}), /terminal is off/);
  assert.equal(created, 0);
  const s = await d.call('narado:desktop-settings-update', { terminal: true });
  assert.equal(s.terminalOn, true);
  assert.equal(await d.call('terminal:create', {}), 'session-1');
  await d.call('narado:desktop-settings-update', { terminal: false });
  assert.deepEqual(
    ipcMain.emitted.filter(([ch]) => ch === 'terminal:kill').map(([, , id]) => id),
    ['session-1']
  );
  await assert.rejects(d.call('terminal:create', {}), /terminal is off/);
});
