/**
 * Request safety in a worker (Phase 4a).
 *
 * Two checks, both inside Node's networking so nothing a send does can go around them
 * (scripts' own requests, redirects, OAuth 2 token calls, WebSockets, gRPC, proxies):
 *
 *   1. Every connection the worker opens is checked against the platform block list, on
 *      the addresses its name resolves to (net.Socket#connect, with a checking `lookup`).
 *      Unix sockets are refused. Configured Git hosts may use private addresses.
 *   2. During a send, connections and HTTP requests must also match the allowlist of the
 *      repo the request belongs to (read from its default branch). The send's repo is
 *      carried by an AsyncLocalStorage context set when a send handler starts, so requests
 *      made later in the same send are checked against the same rules. HTTP requests are
 *      checked one by one (host, port and path), which also covers reused keep-alive sockets.
 *
 * Each request made during a send is logged with the person, method, host and status;
 * never the path's query, headers or body.
 */
const net = require('node:net');
const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const { AsyncLocalStorage } = require('node:async_hooks');
const { AddressPolicy } = require('./blocklist');

class RequestRefused extends Error {
  constructor(message) {
    super(message);
    this.name = 'RequestRefused';
    this.code = 'ENARADOREFUSED';
  }
}

const portOf = (port, secure) => Number(port) || (secure ? 443 : 80);

class RequestGuard {
  /**
   * @param {object} o
   * @param {object}   o.user            the worker's person, for the log
   * @param {string[]} o.trustedHosts    host names of configured Git hosts
   * @param {boolean}  o.outsideRepos    'allow' (block list only) or 'refuse' for collections outside Git
   */
  constructor({ env = process.env, user = null, trustedHosts = [], outsideRepos, log = console } = {}) {
    this.addresses = new AddressPolicy({ env });
    this.user = user;
    this.trusted = new Set(trustedHosts.map((h) => h.toLowerCase()));
    this.outsideRepos = outsideRepos || (env.NARADO_REQUESTS_OUTSIDE_REPOS === 'refuse' ? 'refuse' : 'allow');
    this.als = new AsyncLocalStorage();
    this.log = log;
    this.installed = false;
  }

  /** The current send's context: { rules, repo } or undefined outside a send. */
  current() {
    return this.als.getStore();
  }

  /** Run `fn` as a send governed by `rules` (null for a collection outside Git). */
  runSend({ rules, repo }, fn) {
    return this.als.run({ rules, repo }, fn);
  }

  describeRepo(ctx) {
    return ctx.repo ? `${ctx.repo}` : 'this collection';
  }

  /** Throws if a connection to host:port is not allowed (name check, before DNS). */
  checkHost(host, port) {
    const ctx = this.current();
    if (!ctx) return;
    if (!ctx.rules) {
      if (this.outsideRepos === 'refuse') throw new RequestRefused(`Requests from collections outside a Git workspace are turned off on this server (${host})`);
      return;
    }
    if (!ctx.rules.allowsHost(host, port)) {
      throw new RequestRefused(
        `${host}:${port} is not on the allowlist of ${ctx.rules.repo} (its ${ctx.rules.branch || 'default'} branch). Add it to .narado/allowed-hosts.yml through a merge request.`
      );
    }
  }

  checkAddress(address, host) {
    const why = this.addresses.check(address, { trusted: this.trusted.has(String(host || '').toLowerCase()) });
    if (why) throw new RequestRefused(`${host && host !== address ? `${host} (${address})` : address} is a ${why}; narado does not send requests there`);
  }

  /** A dns.lookup-compatible function that refuses blocked addresses. */
  checkingLookup(original, host) {
    const guard = this;
    return function lookup(hostname, options, callback) {
      if (typeof options === 'function') {
        callback = options;
        options = {};
      }
      const opts = typeof options === 'number' ? { family: options } : options || {};
      (original || dns.lookup)(hostname, opts, (err, address, family) => {
        if (err) return callback(err, address, family);
        try {
          for (const a of Array.isArray(address) ? address.map((x) => x.address) : [address]) guard.checkAddress(a, host || hostname);
        } catch (e) {
          return callback(e);
        }
        callback(null, address, family);
      });
    };
  }

  install() {
    if (this.installed) return;
    this.installed = true;
    const guard = this;

    const originalConnect = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function connect(...args) {
      let options;
      let cb;
      if (Array.isArray(args[0])) [options, cb] = args[0];
      else if (args[0] && typeof args[0] === 'object') [options, cb] = [args[0], args[1]];
      else if (typeof args[0] === 'string' && !/^\d+$/.test(args[0])) [options, cb] = [{ path: args[0] }, args[1]];
      else {
        options = { port: args[0], host: typeof args[1] === 'string' ? args[1] : undefined };
        cb = args.find((a) => typeof a === 'function');
      }
      if (typeof cb !== 'function') cb = undefined;
      const fail = (err) => {
        process.nextTick(() => this.destroy(err));
        return this;
      };
      if (options.path) return fail(new RequestRefused('Connections to local sockets are not allowed'));
      const host = String(options.host || 'localhost').replace(/^\[|\]$/g, '');
      const secure = !!(this.encrypted || options.servername || this._tlsOptions);
      try {
        guard.checkHost(host, portOf(options.port, secure));
        if (net.isIP(host)) guard.checkAddress(host, host);
      } catch (err) {
        return fail(err);
      }
      const next = net.isIP(host) ? options : { ...options, lookup: guard.checkingLookup(options.lookup, host) };
      return cb ? originalConnect.call(this, next, cb) : originalConnect.call(this, next);
    };

    // HTTP requests during a send: host, port and path against the repo's rules, and a log line.
    const wrap = (mod, secure) => {
      for (const name of ['request', 'get']) {
        const original = mod[name];
        mod[name] = function request(...args) {
          const ctx = guard.current();
          if (ctx) guard.checkRequest(ctx, args, secure);
          const req = original.apply(this, args);
          if (ctx) guard.logRequest(req, args, secure);
          return req;
        };
      }
    };
    wrap(http, false);
    wrap(https, true);
  }

  /** {host, port, path, method} of http.request's arguments. */
  static target(args, secure) {
    let url = null;
    let opts = {};
    if (typeof args[0] === 'string' || args[0] instanceof URL) {
      url = new URL(String(args[0]));
      if (args[1] && typeof args[1] === 'object') opts = args[1];
    } else if (args[0] && typeof args[0] === 'object') opts = args[0];
    const host = String(opts.hostname || opts.host || (url && url.hostname) || 'localhost').replace(/^\[|\]$/g, '').replace(/:\d+$/, '');
    const port = portOf(opts.port || (url && url.port), url ? url.protocol === 'https:' : secure);
    let p = opts.path || (url ? url.pathname + url.search : '/');
    let target = { host, port, path: String(p).split('?')[0], method: String(opts.method || 'GET').toUpperCase() };
    // Through a plain HTTP proxy, the path is the full URL of the real target.
    if (/^https?:\/\//i.test(p)) {
      const real = new URL(p);
      target = { ...target, via: { host, port }, host: real.hostname, port: portOf(real.port, real.protocol === 'https:'), path: real.pathname };
    }
    return target;
  }

  checkRequest(ctx, args, secure) {
    const t = RequestGuard.target(args, secure);
    if (!ctx.rules) return this.checkHost(t.host, t.port);
    if (!ctx.rules.allowsRequest(t.host, t.port, t.path)) {
      this.log.log(`[narado] refused ${t.method} ${t.host}:${t.port} for ${this.who()} in ${this.describeRepo(ctx)}: not on the allowlist`);
      throw new RequestRefused(
        `${t.host}:${t.port}${t.path} is not on the allowlist of ${ctx.rules.repo} (its ${ctx.rules.branch || 'default'} branch). Add it to .narado/allowed-hosts.yml through a merge request.`
      );
    }
  }

  who() {
    return this.user ? this.user.email || this.user.id : 'local';
  }

  logRequest(req, args, secure) {
    const t = RequestGuard.target(args, secure);
    const ctx = this.current();
    const line = (outcome) => this.log.log(`[narado] request ${t.method} ${t.host}:${t.port} for ${this.who()} in ${this.describeRepo(ctx)}: ${outcome}`);
    req.once('response', (res) => line(res.statusCode));
    req.once('upgrade', (res) => line(res.statusCode));
    req.once('error', (err) => line(err instanceof RequestRefused || err.code === 'ENARADOREFUSED' ? `refused (${err.message})` : `error ${err.code || err.message}`));
  }
}

module.exports = { RequestGuard, RequestRefused };

/**
 * Wrap Bruno's send handlers so each runs inside a send context for its collection's repo.
 * `rulesFor(collectionPath)` gives { rules, repo } (rules null outside a Git workspace).
 */
const installSendRules = ({ ipcMain, guard, channels, collectionPathIn, rulesFor }) => {
  for (const ch of channels) {
    const original = ipcMain.getHandler(ch);
    if (!original) continue;
    ipcMain.removeHandler(ch);
    ipcMain.handle(ch, async (event, ...args) => {
      const ctx = await rulesFor(collectionPathIn(args));
      return guard.runSend(ctx, () => original(event, ...args));
    });
  }
};

module.exports.installSendRules = installSendRules;
