/**
 * narado desktop, phase D5: what the desktop offers on this computer only.
 *
 *   - Settings kept on this computer (desktop-settings.json in narado's data folder): the
 *     local MCP server (on or off, and its port) and Bruno's terminal (off by default).
 *   - The local MCP server: narado's MCP handler (mcp.js), the same tools and rules as on
 *     the server, listening on 127.0.0.1 only, for assistants on this computer. Tokens are
 *     created in the app and kept on this computer. Browser origins are refused and the
 *     Host header must be 127.0.0.1 or localhost (mcp.js).
 *   - The organisation's desktop policy (from the server) can turn either off: policy.mcp
 *     'off' | 'read' | 'write', policy.terminal false.
 */
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const DEFAULT_MCP_PORT = 4180;
const DEFAULTS = { mcp: { enabled: false, port: DEFAULT_MCP_PORT }, terminal: false };

const validPort = (p) => Number.isInteger(p) && p >= 1024 && p <= 65535;

class DesktopSettings {
  constructor({ dataDir }) {
    this.file = path.join(dataDir, 'desktop-settings.json');
    this.value = this.read();
  }

  read() {
    let saved = {};
    try {
      saved = JSON.parse(fs.readFileSync(this.file, 'utf8')) || {};
    } catch {}
    const mcp = { ...DEFAULTS.mcp, ...(saved.mcp || {}) };
    if (!validPort(mcp.port)) mcp.port = DEFAULT_MCP_PORT;
    return { mcp: { enabled: mcp.enabled === true, port: mcp.port }, terminal: saved.terminal === true };
  }

  get() {
    return JSON.parse(JSON.stringify(this.value));
  }

  /** Change some settings; returns the new ones. */
  update(changes = {}) {
    const next = this.get();
    if (changes.mcp) {
      if ('enabled' in changes.mcp) next.mcp.enabled = changes.mcp.enabled === true;
      if ('port' in changes.mcp) {
        const port = Number(changes.mcp.port);
        if (!validPort(port)) throw new Error('Choose a port from 1024 to 65535');
        next.mcp.port = port;
      }
    }
    if ('terminal' in changes) next.terminal = changes.terminal === true;
    fs.writeFileSync(this.file, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    this.value = next;
    return this.get();
  }
}

/** What the organisation's policy allows: { mcp: 'off'|'read'|'write', terminal: boolean }. */
const allowedByPolicy = (policy) => {
  const p = policy || {};
  const mcp = ['off', 'read', 'write'].includes(p.mcp) ? p.mcp : 'write';
  return { mcp, terminal: p.terminal !== false };
};

/**
 * The local MCP server. `createHandler(port)` returns mcp.js's handler for that port (its
 * allowed Host headers name the port). Starts and stops with the settings and the policy.
 */
class LocalMcp {
  constructor({ createHandler, host = '127.0.0.1', log = console }) {
    this.createHandler = createHandler;
    this.host = host;
    this.log = log;
    this.server = null;
    this.port = null;
    this.handler = null;
    this.error = null;
  }

  get running() {
    return !!this.server;
  }

  get url() {
    return this.port ? `http://127.0.0.1:${this.port}/mcp` : null;
  }

  /** Make the server match `{ enabled, port }`. */
  async apply({ enabled, port }) {
    if (!enabled) return this.stop();
    if (this.server && this.port === port) return;
    await this.stop();
    this.error = null;
    const handler = this.createHandler(port);
    const server = http.createServer(async (req, res) => {
      try {
        if (await handler.handle(req, res)) return;
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'narado desktop serves MCP at /mcp only' }));
      } catch (err) {
        this.log.error('[narado] desktop MCP:', err);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    });
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, this.host, () => {
          server.off('error', reject);
          resolve();
        });
      });
    } catch (err) {
      this.error = err.code === 'EADDRINUSE' ? `Port ${port} is in use by another program. Choose another port.` : err.message;
      this.log.warn(`[narado] desktop: MCP server not started (${this.error})`);
      return;
    }
    this.server = server;
    this.port = port;
    this.handler = handler;
    this.log.log(`[narado] desktop: MCP server at ${this.url}`);
  }

  async stop() {
    const s = this.server;
    this.server = null;
    this.handler = null;
    if (!s) return;
    if (s.closeAllConnections) s.closeAllConnections();
    await new Promise((resolve) => s.close(() => resolve()));
  }
}

module.exports = { DesktopSettings, LocalMcp, allowedByPolicy, DEFAULT_MCP_PORT };
