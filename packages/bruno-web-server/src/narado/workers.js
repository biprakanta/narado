/**
 * One Bruno process per person (Phase 4d).
 *
 * The front process keeps a pool of workers (src/worker.js), one per signed-in person, or
 * one for single-user local mode. Each worker:
 *   - has its own data folder: <data>/users/<user id> (local mode: <data> itself);
 *   - listens on a random loopback port and accepts only requests with its own secret;
 *   - gets the person's WebSocket and MCP requests relayed by the front, which has already
 *     checked their session or token, with cookies removed;
 *   - with sign-in on, runs under Node's permission model: it may read narado's code, its
 *     own folder and the shared host settings, and write only its own folder;
 *   - reaches the token store through the front, which limits it to its own person's tokens.
 * Idle workers stop after a while; a crashed one is started again on the next request.
 */
const { fork } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const WORKER_SCRIPT = path.resolve(__dirname, '../worker.js');

// Settings the worker must not see: sign-in secrets, Git app credentials and tokens, and
// secrets-store credentials stay in the front. Shared Git tokens are added by name (privateEnv).
const PRIVATE_ENV = /^(NARADO_OIDC_|NARADO_[A-Z0-9_]*_APP_|NARADO_GIT_TOKEN_KEY$|NARADO_SESSION_|NARADO_SECRETS_)/;

class WorkerError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const realpath = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

class WorkerPool {
  /**
   * @param {object} o
   * @param {string}   o.dataDir     narado's data folder (shared settings live here)
   * @param {boolean}  o.multiUser   sign-in is on: per-person folders and the sandbox
   * @param {number}   o.publicPort  the front's port (MCP's allowed Host)
   * @param {Function} o.rpc         (user, method, args) => result, for calls from a worker
   */
  constructor({ dataDir, multiUser, publicPort, rpc, privateEnv = [], env = process.env, script = WORKER_SCRIPT, sandbox, idleMs, maxWorkers, startTimeoutMs = 120000, log = console }) {
    this.dataDir = path.resolve(dataDir);
    this.multiUser = !!multiUser;
    this.publicPort = publicPort;
    this.rpc = rpc;
    this.env = env;
    this.privateEnv = new Set(privateEnv);
    this.script = script;
    this.sandbox = sandbox !== undefined ? sandbox : this.multiUser && env.NARADO_WORKER_SANDBOX !== '0';
    this.idleMs = idleMs !== undefined ? idleMs : Number(env.NARADO_WORKER_IDLE_MINUTES || 30) * 60 * 1000;
    this.maxWorkers = maxWorkers !== undefined ? maxWorkers : Number(env.NARADO_MAX_WORKERS || 50);
    this.startTimeoutMs = startTimeoutMs;
    this.log = log;
    this.workers = new Map(); // key -> entry
    this.sweeper = setInterval(() => this.sweep(), Math.min(60000, Math.max(1000, this.idleMs / 4)));
    this.sweeper.unref();
  }

  keyFor(user) {
    if (!this.multiUser) return 'local';
    if (!user || !user.id) throw new WorkerError(401, 'Sign in first');
    return `user:${user.id}`;
  }

  dirFor(user) {
    if (!this.multiUser) return this.dataDir;
    if (!/^[A-Za-z0-9_-]+$/.test(user.id)) throw new WorkerError(400, 'Unexpected user id');
    return path.join(this.dataDir, 'users', user.id);
  }

  /** The person's worker, started if needed. */
  async get(user) {
    const key = this.keyFor(user);
    const existing = this.workers.get(key);
    if (existing) {
      existing.lastActive = Date.now();
      return existing.ready;
    }
    if (this.workers.size >= this.maxWorkers) {
      const idle = [...this.workers.values()].filter((w) => w.conns === 0 && w.inflight === 0).sort((a, b) => a.lastActive - b.lastActive)[0];
      if (!idle) throw new WorkerError(503, 'narado is at its limit of active people; try again shortly');
      this.stop(idle, 'making room');
    }
    return this.spawn(key, user).ready;
  }

  execArgvFor(dir) {
    if (!this.sandbox) return [];
    const read = [path.join(REPO_ROOT, 'packages'), path.join(REPO_ROOT, 'node_modules'), path.join(REPO_ROOT, 'package.json'), dir, path.join(this.dataDir, 'narado.json')];
    for (const p of read) {
      if (this.dataDir !== dir && realpath(this.dataDir).startsWith(realpath(p) + path.sep)) {
        throw new Error(`The data folder ${this.dataDir} is inside ${p}; move it (BRUNO_WEB_DATA_DIR) so workers can't read each other's files`);
      }
    }
    return [
      '--permission',
      ...read.map((p) => `--allow-fs-read=${realpath(p)}`),
      `--allow-fs-write=${realpath(dir)}`,
      '--allow-child-process', // git, and the shell used to read the environment
      '--allow-addons', // file watching on macOS
      '--allow-worker',
      '--allow-net' // listening for the front, and sending requests (Phase 4a adds rules for where)
    ];
  }

  spawn(key, user) {
    const dir = this.dirFor(user);
    fs.mkdirSync(path.join(dir, 'tmp'), { recursive: true, mode: 0o700 });
    const secret = crypto.randomBytes(32).toString('hex');
    const env = {};
    for (const [k, v] of Object.entries(this.env)) if (!PRIVATE_ENV.test(k) && !this.privateEnv.has(k)) env[k] = v;
    Object.assign(env, {
      NARADO_WORKER_SECRET: secret,
      NARADO_WORKER_USER: JSON.stringify(user ? { id: user.id, name: user.name || null, email: user.email || null } : null),
      NARADO_MULTI_USER: this.multiUser ? '1' : '0',
      BRUNO_WEB_DATA_DIR: dir,
      NARADO_CONFIG_DIR: this.dataDir,
      BRUNO_WEB_PUBLIC_PORT: String(this.publicPort),
      TMPDIR: path.join(dir, 'tmp')
    });
    const label = user ? user.name || user.email || user.id : 'local';
    const child = fork(this.script, [], { env, execArgv: this.execArgvFor(dir), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const prefix = (stream, out) => {
      let buf = '';
      stream.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          out(`[worker ${label}] ${buf.slice(0, i)}`);
          buf = buf.slice(i + 1);
        }
      });
    };
    prefix(child.stdout, (l) => this.log.log(l));
    prefix(child.stderr, (l) => this.log.error(l));

    const entry = { key, user, child, secret, port: null, conns: 0, inflight: 0, lastActive: Date.now(), sockets: new Set(), label };
    entry.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new WorkerError(504, `narado's worker for ${label} did not start in time`));
        this.stop(entry, 'start timed out');
      }, this.startTimeoutMs);
      child.on('message', async (msg) => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'ready') {
          clearTimeout(timer);
          entry.port = msg.port;
          entry.instance = msg.instance;
          this.log.log(`[narado] worker for ${label} ready (pid ${child.pid}, ${msg.handlers} handlers${this.sandbox ? ', sandboxed' : ''})`);
          resolve(entry);
        } else if (msg.type === 'rpc') {
          let reply;
          try {
            reply = { type: 'rpc-result', id: msg.id, result: await this.rpc(user, msg.method, msg.args || []) };
          } catch (err) {
            reply = { type: 'rpc-result', id: msg.id, error: err.message };
          }
          if (child.connected) child.send(reply);
        }
      });
      child.on('exit', (code, signal) => {
        clearTimeout(timer);
        if (this.workers.get(key) === entry) this.workers.delete(key);
        for (const s of entry.sockets) s.destroy();
        if (!entry.stopping) this.log.warn(`[narado] worker for ${label} exited (${signal || code})`);
        reject(new WorkerError(502, `narado's worker for ${label} stopped`));
      });
    });
    entry.ready.catch(() => {});
    this.workers.set(key, entry);
    return entry;
  }

  stop(entry, why) {
    if (entry.stopping) return;
    entry.stopping = true;
    if (this.workers.get(entry.key) === entry) this.workers.delete(entry.key);
    this.log.log(`[narado] stopping worker for ${entry.label} (${why})`);
    entry.child.kill('SIGTERM');
    setTimeout(() => entry.child.exitCode === null && entry.child.kill('SIGKILL'), 5000).unref();
  }

  sweep(now = Date.now()) {
    for (const entry of [...this.workers.values()]) {
      if (entry.port && entry.conns === 0 && entry.inflight === 0 && now - entry.lastActive > this.idleMs) this.stop(entry, 'idle');
    }
  }

  stopAll() {
    clearInterval(this.sweeper);
    for (const entry of [...this.workers.values()]) this.stop(entry, 'shutting down');
  }

  /** Headers to pass on: no cookies or proxy secrets from outside, plus the worker's secret. */
  static forwardHeaders(rawHeaders, secret) {
    const out = [];
    for (let i = 0; i < rawHeaders.length; i += 2) {
      const name = rawHeaders[i].toLowerCase();
      if (name === 'cookie' || name === 'x-narado-worker') continue;
      out.push([rawHeaders[i], rawHeaders[i + 1]]);
    }
    out.push(['x-narado-worker', secret]);
    return out;
  }

  /** Relay a WebSocket upgrade to the worker, byte for byte after the handshake. */
  proxyUpgrade(entry, req, socket, head) {
    const upstream = net.connect(entry.port, '127.0.0.1');
    entry.conns++;
    entry.sockets.add(socket);
    let closed = false;
    const done = () => {
      if (closed) return;
      closed = true;
      entry.conns--;
      entry.lastActive = Date.now();
      entry.sockets.delete(socket);
      upstream.destroy();
      socket.destroy();
    };
    upstream.on('connect', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`, ...WorkerPool.forwardHeaders(req.rawHeaders, entry.secret).map(([k, v]) => `${k}: ${v}`)];
      upstream.write(lines.join('\r\n') + '\r\n\r\n');
      if (head && head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', done);
    upstream.on('close', done);
    socket.on('error', done);
    socket.on('close', done);
  }

  /** Relay an HTTP request (MCP) to the worker. */
  proxyHttp(entry, req, res) {
    entry.inflight++;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      entry.inflight--;
      entry.lastActive = Date.now();
    };
    const headers = {};
    for (const [k, v] of WorkerPool.forwardHeaders(req.rawHeaders, entry.secret)) {
      const key = k.toLowerCase();
      headers[key] = headers[key] !== undefined ? [].concat(headers[key], v) : v;
    }
    const upstream = http.request({ host: '127.0.0.1', port: entry.port, method: req.method, path: req.url, headers }, (up) => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
      up.on('end', finish);
    });
    upstream.on('error', (err) => {
      finish();
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `narado's worker is not available: ${err.message}` }));
    });
    res.on('close', () => {
      finish();
      upstream.destroy();
    });
    req.pipe(upstream);
  }
}

module.exports = { WorkerPool, WorkerError, PRIVATE_ENV };
