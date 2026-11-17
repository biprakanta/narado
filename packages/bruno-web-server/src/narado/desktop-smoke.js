/**
 * narado desktop's start-up check (desktop phase D5), for CI on macOS, Windows and Linux.
 *
 * With NARADO_DESKTOP_SMOKE=1 the packaged app starts as usual, then checks what only the
 * real app on each system can show, writes a report and quits (exit code 0 when all pass):
 *
 *   - the window loaded narado's interface, with the desktop preload;
 *   - narado's handlers answer in the main process;
 *   - the local MCP server starts on 127.0.0.1, refuses calls without a token and from
 *     browser pages, and stops;
 *   - Bruno's terminal is refused while off, and once on, opens a real shell (the node-pty
 *     native module for this system) that is closed again;
 *   - whether the system keychain can encrypt (reported; CI Linux has no keyring).
 *
 * NARADO_DESKTOP_SMOKE_REPORT names the report file (JSON); it is also printed.
 */
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const post = (port, headers = {}) =>
  new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const req = http.request(
      { host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'content-length': Buffer.byteLength(body), ...headers } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }
    );
    req.on('error', reject);
    req.end(body);
  });

const withTimeout = (promise, ms, what) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} took longer than ${ms / 1000} s`)), ms))]);

const runSmoke = async ({ ipcMain, getHandler, mainWindow, safeStorage, log = console, env = process.env }) => {
  const checks = [];
  const check = async (name, fn) => {
    try {
      const detail = await withTimeout(Promise.resolve().then(fn), 60000, name);
      checks.push({ name, ok: true, ...(detail ? { detail } : {}) });
    } catch (err) {
      checks.push({ name, ok: false, error: err.message });
    }
  };
  const ev = () => ({ sender: mainWindow.webContents, senderFrame: mainWindow.webContents.mainFrame, reply: () => {} });
  const call = (ch, ...args) => {
    const h = getHandler(ch);
    if (!h) throw new Error(`no handler for ${ch}`);
    return h(ev(), ...args);
  };

  await check('the window loads narado with the desktop preload', async () => {
    const wc = mainWindow.webContents;
    if (wc.isLoading()) await new Promise((resolve) => wc.once('did-finish-load', resolve));
    const seen = await wc.executeJavaScript('({ desktop: !!window.isNaradoDesktop, title: document.title, root: !!document.getElementById("root") })');
    if (!seen.desktop) throw new Error('window.isNaradoDesktop is not set: the preload did not run');
    if (!seen.root) throw new Error('the interface did not load');
    return seen.title;
  });

  // Settings as they were, put back at the end (the check turns things on and off).
  const before = await call('narado:desktop-settings');

  await check("narado's handlers answer", async () => {
    const missing = ['narado:hosts', 'narado:open', 'narado:catalogue', 'narado:secrets:stores', 'narado:mcp-tokens', 'narado:request-rules'].filter((ch) => !getHandler(ch));
    if (missing.length) throw new Error(`not registered: ${missing.join(', ')}`);
    const status = await call('narado:desktop-status');
    return `mode ${status.mode || 'server'}; narado ${status.update && status.update.current}`;
  });

  await check('the local MCP server starts on 127.0.0.1, refuses without a token and from pages, and stops', async () => {
    const port = await freePort();
    const on = await call('narado:desktop-settings-update', { mcp: { enabled: true, port } });
    if (!on.mcpRunning) throw new Error(on.mcpError || 'did not start');
    const noToken = await post(port);
    const fromPage = await post(port, { origin: 'https://example.com', authorization: 'Bearer narado_x' });
    const off = await call('narado:desktop-settings-update', { mcp: { enabled: false } });
    if (noToken !== 401) throw new Error(`without a token: ${noToken}, expected 401`);
    if (fromPage !== 403) throw new Error(`from a page: ${fromPage}, expected 403`);
    if (off.mcpRunning) throw new Error('still running after turning it off');
    return `port ${port}`;
  });

  await check("Bruno's terminal: refused while off; a real shell once on", async () => {
    let refused = false;
    try {
      await call('terminal:create', {});
    } catch {
      refused = true;
    }
    if (!refused) throw new Error('a shell opened while the terminal was off');
    await call('narado:desktop-settings-update', { terminal: true });
    const id = await call('terminal:create', {});
    if (!id) throw new Error('no session');
    const sessions = await call('terminal:list-sessions');
    const s = (sessions || []).find((x) => x.sessionId === id);
    await call('narado:desktop-settings-update', { terminal: false });
    if (!s || !s.pid) throw new Error('the shell is not running');
    return `shell pid ${s.pid}`;
  });

  await check('system keychain', async () => (safeStorage && safeStorage.isEncryptionAvailable() ? 'encryption available' : 'not available (sessions would not be kept)'));

  try {
    await call('narado:desktop-settings-update', { mcp: before.mcp, terminal: before.terminal });
  } catch {}

  const report = { ok: checks.every((c) => c.ok), platform: process.platform, arch: process.arch, electron: process.versions.electron, checks };
  const text = JSON.stringify(report, null, 2);
  log.log(`[narado] desktop smoke check:\n${text}`);
  if (env.NARADO_DESKTOP_SMOKE_REPORT) fs.writeFileSync(env.NARADO_DESKTOP_SMOKE_REPORT, text + '\n');
  return report;
};

module.exports = { runSmoke };
