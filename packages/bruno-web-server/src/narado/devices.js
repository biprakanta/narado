/**
 * narado desktop on the server (desktop phase D2, docs/desktop.md 3.5): signing in a
 * computer, its device session, and the narrow HTTPS channel the desktop uses in place of
 * a worker's pipe to the front.
 *
 * Signing in (OAuth 2 for native apps, RFC 8252, with PKCE):
 *   1. The desktop listens on http://127.0.0.1:<port>/callback and opens, in the system
 *      browser, /auth/desktop/start?redirect_uri=...&state=...&code_challenge=...&device_name=...
 *   2. The person signs in to narado as usual (SSO) and approves this computer on a page
 *      here, so a link alone can't sign in a device.
 *   3. narado redirects to the loopback address with a one-time code (1 minute).
 *   4. The desktop exchanges the code and its PKCE verifier at POST /desktop/api/token
 *      for a refresh token (kept with the OS's secure storage) and an access token (1 hour).
 *
 * Device sessions: a device stays signed in while it's used (refresh tokens expire after
 * 30 days unused, 1 year at most) and is listed under Devices, where the person can sign it
 * out. Refresh tokens rotate; reuse of an old one signs the device out, as it means the
 * token was copied.
 *
 * The channel (Bearer access token; requests with a browser Origin are refused):
 *   GET  /desktop/api/session   the person, this device, policy and the Git hosts
 *   POST /desktop/api/call      { method, args }: git.status, git.token, secrets.*, devices.*
 *   POST /desktop/api/audit     { events: [{ at, method, host, repo, status }] }
 *   POST /desktop/api/logout    signs this device out
 */
const crypto = require('node:crypto');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { desktopApprovePage, messagePage } = require('./pages');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomToken = (prefix) => `${prefix}${b64url(crypto.randomBytes(32))}`;

const ACCESS_PREFIX = 'nrd_at_';
const REFRESH_PREFIX = 'nrd_rt_';
const ACCESS_MS = 60 * 60 * 1000;
const REFRESH_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
const REFRESH_MAX_MS = 365 * 24 * 60 * 60 * 1000;
const APPROVE_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 60 * 1000;
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|\[::1\]):(\d{2,5})\/callback$/;
const SEND_POLICIES = ['any', 'private-only', 'allowlist-only'];

/** The calls a desktop may make, as its person (the same ones a worker makes, minus MCP tokens). */
const DESKTOP_CALLS = new Set(['git.status', 'git.token', 'git.disconnect', 'secrets.stores', 'secrets.resolve', 'secrets.list', 'secrets.check', 'secrets.reveal', 'devices.list', 'devices.revoke']);

class DesktopError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const cleanText = (s, max = 80) =>
  String(s == null ? '' : s)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, max);

class DeviceStore {
  constructor({ dataDir }) {
    this.db = new DatabaseSync(path.join(dataDir, 'narado.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        platform TEXT,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        refresh_hash TEXT,
        previous_refresh_hash TEXT,
        refreshed_at INTEGER NOT NULL,
        revoked_at INTEGER,
        revoked_why TEXT
      );
      CREATE INDEX IF NOT EXISTS devices_user ON devices (user_id);
    `);
  }

  row(id) {
    const d = this.db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
    return d ? { ...d } : null;
  }

  static view(d) {
    return { id: d.id, name: d.name, platform: d.platform, createdAt: d.created_at, lastSeenAt: d.last_seen_at, revokedAt: d.revoked_at || null };
  }

  /** A new device for the person; returns it and its first refresh token. */
  create(userId, { name, platform }, now = Date.now()) {
    const id = crypto.randomUUID();
    const refreshToken = randomToken(REFRESH_PREFIX);
    this.db
      .prepare('INSERT INTO devices (id, user_id, name, platform, created_at, last_seen_at, refresh_hash, refreshed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, userId, cleanText(name) || 'Unnamed computer', cleanText(platform, 40) || null, now, now, sha256(refreshToken), now);
    return { device: this.row(id), refreshToken };
  }

  /**
   * Swap a refresh token for a new one. A token used before (the previous one) means it was
   * copied: the device is signed out.
   */
  refresh(refreshToken, now = Date.now()) {
    if (typeof refreshToken !== 'string' || !refreshToken.startsWith(REFRESH_PREFIX)) throw new DesktopError(400, 'invalid_grant', 'Not a narado desktop token');
    const hash = sha256(refreshToken);
    const d = this.db.prepare('SELECT * FROM devices WHERE refresh_hash = ?').get(hash);
    if (!d) {
      const reused = this.db.prepare('SELECT * FROM devices WHERE previous_refresh_hash = ? AND revoked_at IS NULL').get(hash);
      if (reused) this.revokeRow(reused.id, 'an old sign-in token was used again', now);
      throw new DesktopError(400, 'invalid_grant', 'This computer is signed out.');
    }
    if (d.revoked_at) throw new DesktopError(400, 'invalid_grant', 'This computer was signed out.');
    if (now - d.refreshed_at > REFRESH_IDLE_MS || now - d.created_at > REFRESH_MAX_MS) {
      this.revokeRow(d.id, 'expired', now);
      throw new DesktopError(400, 'invalid_grant', 'The sign-in on this computer has expired.');
    }
    const next = randomToken(REFRESH_PREFIX);
    this.db.prepare('UPDATE devices SET refresh_hash = ?, previous_refresh_hash = ?, refreshed_at = ?, last_seen_at = ? WHERE id = ?').run(sha256(next), hash, now, now, d.id);
    return { device: this.row(d.id), refreshToken: next };
  }

  touch(id, now = Date.now()) {
    this.db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ? AND last_seen_at < ?').run(now, id, now - 60 * 1000);
  }

  list(userId) {
    return this.db
      .prepare('SELECT * FROM devices WHERE user_id = ? AND revoked_at IS NULL ORDER BY last_seen_at DESC')
      .all(userId)
      .map((d) => DeviceStore.view(d));
  }

  revokeRow(id, why, now = Date.now()) {
    this.db.prepare('UPDATE devices SET revoked_at = ?, revoked_why = ?, refresh_hash = NULL WHERE id = ? AND revoked_at IS NULL').run(now, why, id);
  }

  /** Sign out one of the person's own devices. */
  revoke(userId, id, why = 'signed out', now = Date.now()) {
    const d = this.row(String(id || ''));
    if (!d || d.user_id !== userId) throw new Error('No such device');
    this.revokeRow(d.id, why, now);
    return true;
  }
}

/** Short-lived access tokens, in memory: a restart just means devices refresh. */
class AccessTokens {
  constructor() {
    this.map = new Map(); // hash -> { deviceId, userId, exp }
  }

  issue(device, now = Date.now()) {
    for (const [k, v] of this.map) if (v.exp < now) this.map.delete(k);
    const token = randomToken(ACCESS_PREFIX);
    this.map.set(sha256(token), { deviceId: device.id, userId: device.user_id, exp: now + ACCESS_MS });
    return { token, expiresIn: ACCESS_MS / 1000 };
  }

  check(token, now = Date.now()) {
    if (typeof token !== 'string' || !token.startsWith(ACCESS_PREFIX)) return null;
    const v = this.map.get(sha256(token));
    if (!v || v.exp < now) return null;
    return v;
  }

  dropDevice(deviceId) {
    for (const [k, v] of this.map) if (v.deviceId === deviceId) this.map.delete(k);
  }
}

const readBody = (req, limit = 256 * 1024) =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new DesktopError(413, 'too_large', 'Request too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

const readJson = async (req) => {
  const text = await readBody(req);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new DesktopError(400, 'invalid_request', 'Expected JSON');
  }
};

/**
 * The desktop's routes. `rpc(user, method, args)` is the server's front service (the same
 * one workers use); `hosts()` gives the Git hosts for the desktop's registry.
 */
const createDesktopAuth = ({ auth, dataDir, rpc, hosts = () => [], env = process.env, log = console }) => {
  const devices = new DeviceStore({ dataDir });
  const access = new AccessTokens();
  const approvals = new Map(); // request id -> { userId, redirectUri, state, challenge, deviceName, platform, at }
  const codes = new Map(); // code hash -> { userId, redirectUri, challenge, deviceName, platform, at }
  const sendPolicy = SEND_POLICIES.includes(env.NARADO_DESKTOP_SEND) ? env.NARADO_DESKTOP_SEND : 'any';
  if (env.NARADO_DESKTOP_SEND && !SEND_POLICIES.includes(env.NARADO_DESKTOP_SEND)) {
    log.warn(`[narado] NARADO_DESKTOP_SEND must be one of ${SEND_POLICIES.join(', ')}; using "any"`);
  }

  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  };
  const html = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" });
    res.end(body);
  };
  const redirect = (res, location) => {
    res.writeHead(302, { location, 'cache-control': 'no-store' });
    res.end();
  };
  const prune = (map, ttl) => {
    const now = Date.now();
    for (const [k, v] of map) if (now - v.at > ttl) map.delete(k);
  };
  const back = (redirectUri, params) => {
    const u = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
    return u.toString();
  };

  const revoke = (user, id, why) => {
    devices.revoke(user.id, id, why);
    access.dropDevice(id);
    log.log(`[narado] desktop signed out: device ${id} of ${user.name} (${why})`);
    return true;
  };

  /** devices.* for the person, from a worker (web) or a desktop. */
  const deviceCalls = (user, method, args) => {
    if (!user) throw new Error('Devices need sign-in');
    if (method === 'devices.list') return devices.list(user.id);
    if (method === 'devices.revoke') return revoke(user, args[0], 'signed out by the person');
    throw new Error(`Unknown call ${method}`);
  };

  const bearer = (req) => {
    const h = String(req.headers.authorization || '');
    const v = h.startsWith('Bearer ') ? access.check(h.slice(7).trim()) : null;
    if (!v) return null;
    const device = devices.row(v.deviceId);
    const user = device && !device.revoked_at ? auth.users.getUser(v.userId) : null;
    if (!user) return null;
    devices.touch(device.id);
    return { user, device };
  };

  const tokenResponse = (res, device, refreshToken, user) => {
    const a = access.issue(device);
    json(res, 200, {
      access_token: a.token,
      token_type: 'Bearer',
      expires_in: a.expiresIn,
      refresh_token: refreshToken,
      device: DeviceStore.view(device),
      user: { id: user.id, name: user.name, email: user.email }
    });
  };

  const exchange = async (req, res) => {
    const body = await readJson(req);
    if (body.grant_type === 'authorization_code') {
      const entry = typeof body.code === 'string' ? codes.get(sha256(body.code)) : null;
      if (entry) codes.delete(sha256(body.code));
      if (!entry || Date.now() - entry.at > CODE_TTL_MS) throw new DesktopError(400, 'invalid_grant', 'This sign-in code has expired or was already used');
      if (body.redirect_uri !== entry.redirectUri) throw new DesktopError(400, 'invalid_grant', 'redirect_uri does not match');
      const verifier = typeof body.code_verifier === 'string' ? body.code_verifier : '';
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || b64url(crypto.createHash('sha256').update(verifier).digest()) !== entry.challenge) {
        throw new DesktopError(400, 'invalid_grant', 'code_verifier does not match');
      }
      const user = auth.users.getUser(entry.userId);
      if (!user) throw new DesktopError(400, 'invalid_grant', 'Unknown person');
      const { device, refreshToken } = devices.create(user.id, { name: entry.deviceName, platform: entry.platform });
      log.log(`[narado] desktop signed in: ${user.name} on "${device.name}" (device ${device.id})`);
      return tokenResponse(res, device, refreshToken, user);
    }
    if (body.grant_type === 'refresh_token') {
      const { device, refreshToken } = devices.refresh(body.refresh_token);
      const user = auth.users.getUser(device.user_id);
      if (!user) throw new DesktopError(400, 'invalid_grant', 'Unknown person');
      return tokenResponse(res, device, refreshToken, user);
    }
    throw new DesktopError(400, 'unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
  };

  const call = async (who, body) => {
    const method = String(body.method || '');
    const args = Array.isArray(body.args) ? body.args : [];
    if (!DESKTOP_CALLS.has(method)) throw new DesktopError(403, 'forbidden', `narado desktop may not call ${method || '(nothing)'}`);
    const where = `${who.user.name} on "${who.device.name}"`;
    if (method === 'git.token') log.log(`[narado] desktop: Git token for ${args[0]} to ${where}`);
    if (method === 'secrets.resolve') log.log(`[narado] desktop: ${Array.isArray(args[0]) ? args[0].length : 0} secret reference(s) resolved for ${where}`);
    if (method === 'secrets.reveal') log.log(`[narado] desktop: secret revealed to ${where}`);
    if (method.startsWith('devices.')) return deviceCalls(who.user, method, args);
    return rpc(who.user, method, args);
  };

  const audit = (who, body) => {
    const events = Array.isArray(body.events) ? body.events.slice(0, 500) : [];
    for (const e of events) {
      if (!e || typeof e !== 'object') continue;
      const status = Number.isInteger(e.status) ? e.status : cleanText(e.status, 20) || '?';
      const at = Number.isFinite(e.at) ? new Date(e.at).toISOString() : '';
      log.log(
        `[narado] desktop send: ${who.user.name} on "${who.device.name}" ${cleanText(e.method, 10) || '?'} ${cleanText(e.host, 255) || '?'}${e.repo ? ` (${cleanText(e.repo, 200)})` : ''} -> ${status}${at ? ` at ${at}` : ''}${e.offline ? ' (offline)' : ''}`
      );
    }
    return { received: events.length };
  };

  /** Serves /auth/desktop/* and /desktop/api/*. Returns false for other paths. */
  const handle = async (req, res) => {
    const url = new URL(req.url, auth.publicUrl);
    const p = url.pathname;
    if (!p.startsWith('/auth/desktop/') && !p.startsWith('/desktop/api/')) return false;
    if (!auth.enabled) return json(res, 404, { error: 'narado desktop needs sign-in to be configured on this server' }), true;

    try {
      if (p === '/auth/desktop/start' && req.method === 'GET') {
        const q = url.searchParams;
        const redirectUri = q.get('redirect_uri') || '';
        const m = LOOPBACK.exec(redirectUri);
        if (!m || Number(m[2]) < 1024 || Number(m[2]) > 65535) return html(res, 400, messagePage({ title: 'Sign-in failed', text: 'This sign-in link is not from narado desktop.', error: true })), true;
        const state = q.get('state') || '';
        const challenge = q.get('code_challenge') || '';
        if (q.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge) || !/^[A-Za-z0-9._~-]{16,128}$/.test(state)) {
          return html(res, 400, messagePage({ title: 'Sign-in failed', text: 'This sign-in link is incomplete. Start again from narado desktop.', error: true })), true;
        }
        const user = auth.userFor(req);
        if (!user) return redirect(res, `/auth/login?return=${encodeURIComponent(p + url.search)}`), true;
        prune(approvals, APPROVE_TTL_MS);
        const request = b64url(crypto.randomBytes(24));
        approvals.set(request, { userId: user.id, redirectUri, state, challenge, deviceName: cleanText(q.get('device_name')), platform: cleanText(q.get('platform'), 40), at: Date.now() });
        html(res, 200, desktopApprovePage({ action: '/auth/desktop/approve', request, deviceName: cleanText(q.get('device_name')), platform: cleanText(q.get('platform'), 40), userName: user.name || user.email }));
        return true;
      }

      // Where connecting a Git account from narado desktop ends, in the system browser.
      if (p === '/auth/desktop/done' && req.method === 'GET') {
        const outcome = url.searchParams.get('git-connect');
        const login = cleanText(url.searchParams.get('login'), 60);
        const host = cleanText(url.searchParams.get('host'), 40);
        const text =
          outcome === 'ok'
            ? `Connected ${host} account ${login}. You can close this tab and go back to narado desktop.`
            : outcome === 'mismatch'
              ? `The ${host} account ${login} doesn't have your sign-in email among its verified emails, so it wasn't connected.`
              : outcome === 'taken'
                ? `The ${host} account ${login} is already connected to another narado person.`
                : `Connecting your ${host || 'Git'} account didn't finish (${cleanText(outcome, 20) || 'unknown'}). Try again from narado desktop.`;
        return html(res, outcome === 'ok' ? 200 : 400, messagePage({ title: 'Git account', text, error: outcome !== 'ok' })), true;
      }

      if (p === '/auth/desktop/approve' && req.method === 'POST') {
        if (req.headers.origin !== auth.publicUrl) return html(res, 403, messagePage({ title: 'Sign-in failed', text: 'Cross-site request refused.', error: true })), true;
        const form = new URLSearchParams(await readBody(req, 4096));
        const request = form.get('request') || '';
        const entry = approvals.get(request);
        approvals.delete(request);
        const user = auth.userFor(req);
        if (!entry || !user || entry.userId !== user.id || Date.now() - entry.at > APPROVE_TTL_MS) {
          return html(res, 400, messagePage({ title: 'Sign-in failed', text: 'This sign-in has expired. Start again from narado desktop.', error: true })), true;
        }
        if (form.get('decision') !== 'allow') return redirect(res, back(entry.redirectUri, { error: 'access_denied', state: entry.state })), true;
        prune(codes, CODE_TTL_MS);
        const code = b64url(crypto.randomBytes(32));
        codes.set(sha256(code), { ...entry, at: Date.now() });
        return redirect(res, back(entry.redirectUri, { code, state: entry.state })), true;
      }

      // The API: for the desktop app, never for pages in a browser.
      if (p.startsWith('/desktop/api/')) {
        if (req.headers.origin) throw new DesktopError(403, 'forbidden', 'Browser origins may not use the desktop API');
        if (p === '/desktop/api/token' && req.method === 'POST') return await exchange(req, res), true;
        const who = bearer(req);
        if (!who) return json(res, 401, { error: 'invalid_token', message: 'Sign in again' }, { 'www-authenticate': 'Bearer' }), true;
        if (p === '/desktop/api/session' && req.method === 'GET') {
          return (
            json(res, 200, {
              user: { id: who.user.id, name: who.user.name, email: who.user.email },
              device: DeviceStore.view(who.device),
              policy: { send: sendPolicy },
              hosts: hosts()
            }),
            true
          );
        }
        if (p === '/desktop/api/call' && req.method === 'POST') {
          const body = await readJson(req);
          return json(res, 200, { result: (await call(who, body)) ?? null }), true;
        }
        if (p === '/desktop/api/audit' && req.method === 'POST') return json(res, 200, audit(who, await readJson(req))), true;
        if (p === '/desktop/api/logout' && req.method === 'POST') return json(res, 200, { ok: revoke(who.user, who.device.id, 'signed out on the computer') }), true;
        return json(res, 404, { error: 'not_found' }), true;
      }
    } catch (err) {
      if (err instanceof DesktopError) return json(res, err.status, { error: err.code, message: err.message }), true;
      log.error('[narado] desktop:', err.message);
      return json(res, 400, { error: 'failed', message: err.message }), true;
    }
    return json(res, 404, { error: 'not_found' }), true;
  };

  return { handle, deviceCalls, devices, access, sendPolicy };
};

module.exports = { createDesktopAuth, DeviceStore, AccessTokens, DesktopError, DESKTOP_CALLS, LOOPBACK };
