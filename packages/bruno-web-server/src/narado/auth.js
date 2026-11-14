/**
 * Sign-in with any OpenID Connect provider (design §8, Phase 4b).
 *
 * - Authorization code flow with PKCE (S256), state and nonce.
 * - ID tokens are verified with the provider's published keys (RS256/ES256/PS256),
 *   issuer, audience, expiry and nonce, using only Node's crypto.
 * - Users and sessions live in SQLite (<data dir>/narado.db). The session cookie holds a
 *   random id; only its SHA-256 hash is stored. Sessions end after 12 hours idle or
 *   7 days in total.
 *
 * Without NARADO_OIDC_ISSUER, narado runs in single-user local mode (no sign-in), which
 * server.js only allows on a loopback address.
 */
const crypto = require('node:crypto');
const { signInPage, serveAsset } = require('./pages');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const COOKIE = 'narado_session';
const IDLE_MS = 12 * 60 * 60 * 1000;
const MAX_MS = 7 * 24 * 60 * 60 * 1000;
const LOGIN_TTL_MS = 10 * 60 * 1000;
const CLOCK_SKEW_S = 60;
const ALGS = {
  RS256: { hash: 'sha256' },
  RS384: { hash: 'sha384' },
  RS512: { hash: 'sha512' },
  PS256: { hash: 'sha256', padding: crypto.constants.RSA_PKCS1_PSS_PADDING },
  ES256: { hash: 'sha256', dsaEncoding: 'ieee-p1363' },
  ES384: { hash: 'sha384', dsaEncoding: 'ieee-p1363' }
};

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const randomId = (bytes = 32) => b64url(crypto.randomBytes(bytes));

class AuthError extends Error {}

/* ----------------------------------------------------------------- OIDC */

class OidcClient {
  constructor({ issuer, clientId, clientSecret, redirectUri, scopes = 'openid profile email', fetchImpl = globalThis.fetch }) {
    this.issuer = issuer.replace(/\/$/, '');
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.redirectUri = redirectUri;
    this.scopes = scopes;
    this.fetch = fetchImpl;
    this.config = null;
    this.keys = new Map();
  }

  async getJson(url, init) {
    const res = await this.fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new AuthError(`${new URL(url).host} returned something that is not JSON (${res.status})`);
    }
    if (!res.ok) throw new AuthError(`${new URL(url).pathname} failed: ${res.status} ${data.error_description || data.error || ''}`.trim());
    return data;
  }

  async discover() {
    if (this.config) return this.config;
    const cfg = await this.getJson(`${this.issuer}/.well-known/openid-configuration`);
    if (cfg.issuer.replace(/\/$/, '') !== this.issuer) {
      throw new AuthError(`The provider calls itself ${cfg.issuer}, not ${this.issuer}`);
    }
    this.config = cfg;
    return cfg;
  }

  async keyFor(kid) {
    if (!this.keys.has(kid)) {
      const { jwks_uri: jwksUri } = await this.discover();
      const { keys = [] } = await this.getJson(jwksUri);
      this.keys = new Map(keys.filter((k) => k.kid).map((k) => [k.kid, k]));
    }
    const jwk = this.keys.get(kid);
    if (!jwk) throw new AuthError('The ID token was signed with a key the provider does not publish');
    return crypto.createPublicKey({ key: jwk, format: 'jwk' });
  }

  /** Start a login: returns the provider URL and what must be remembered until the callback. */
  async start() {
    const cfg = await this.discover();
    const state = randomId();
    const nonce = randomId();
    const verifier = randomId(48);
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const url = new URL(cfg.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      scope: this.scopes,
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256'
    }).toString();
    return { url: url.toString(), state, nonce, verifier };
  }

  async exchange(code, verifier) {
    const cfg = await this.discover();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
      client_id: this.clientId,
      code_verifier: verifier
    });
    const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    if (this.clientSecret) {
      headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(this.clientId)}:${encodeURIComponent(this.clientSecret)}`).toString('base64')}`;
    }
    return this.getJson(cfg.token_endpoint, { method: 'POST', headers, body });
  }

  /** Verify an ID token and return its claims. */
  async verify(idToken, nonce, now = Date.now()) {
    const parts = String(idToken || '').split('.');
    if (parts.length !== 3) throw new AuthError('The provider did not return a valid ID token');
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const alg = ALGS[header.alg];
    if (!alg) throw new AuthError(`ID tokens signed with ${header.alg} are not accepted`);
    const key = await this.keyFor(header.kid);
    const ok = crypto.verify(
      alg.hash,
      Buffer.from(`${parts[0]}.${parts[1]}`),
      { key, padding: alg.padding, dsaEncoding: alg.dsaEncoding },
      Buffer.from(parts[2], 'base64url')
    );
    if (!ok) throw new AuthError('The ID token signature is not valid');

    const nowS = Math.floor(now / 1000);
    if (String(claims.iss).replace(/\/$/, '') !== this.issuer) throw new AuthError('The ID token is from another issuer');
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(this.clientId)) throw new AuthError('The ID token is for another application');
    if (aud.length > 1 && claims.azp && claims.azp !== this.clientId) throw new AuthError('The ID token was issued to another application');
    if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_S < nowS) throw new AuthError('The ID token has expired');
    if (typeof claims.iat === 'number' && claims.iat - CLOCK_SKEW_S > nowS) throw new AuthError('The ID token is from the future');
    if (claims.nonce !== nonce) throw new AuthError('The ID token does not match this sign-in');
    if (!claims.sub) throw new AuthError('The ID token has no subject');
    return claims;
  }

  async logoutUrl(idTokenHint, postLogoutRedirect) {
    const cfg = await this.discover();
    if (!cfg.end_session_endpoint) return null;
    const url = new URL(cfg.end_session_endpoint);
    url.search = new URLSearchParams({
      client_id: this.clientId,
      post_logout_redirect_uri: postLogoutRedirect,
      ...(idTokenHint ? { id_token_hint: idTokenHint } : {})
    }).toString();
    return url.toString();
  }
}

/* ------------------------------------------------------------- storage */

class UserStore {
  constructor({ dataDir }) {
    this.db = new DatabaseSync(path.join(dataDir, 'narado.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        issuer TEXT NOT NULL,
        subject TEXT NOT NULL,
        email TEXT,
        name TEXT,
        created_at INTEGER NOT NULL,
        last_login_at INTEGER NOT NULL,
        UNIQUE (issuer, subject)
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        id_token TEXT
      );
    `);
  }

  upsertUser({ issuer, subject, email, name }, now = Date.now()) {
    const existing = this.db.prepare('SELECT id FROM users WHERE issuer = ? AND subject = ?').get(issuer, subject);
    if (existing) {
      this.db.prepare('UPDATE users SET email = ?, name = ?, last_login_at = ? WHERE id = ?').run(email || null, name || null, now, existing.id);
      return this.getUser(existing.id);
    }
    const id = crypto.randomUUID();
    this.db.prepare('INSERT INTO users (id, issuer, subject, email, name, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, issuer, subject, email || null, name || null, now, now);
    return this.getUser(id);
  }

  getUser(id) {
    const u = this.db.prepare('SELECT id, issuer, subject, email, name, created_at, last_login_at FROM users WHERE id = ?').get(id);
    return u ? { ...u } : null;
  }

  createSession(userId, idToken, now = Date.now()) {
    const sid = randomId();
    this.db.prepare('INSERT INTO sessions (id_hash, user_id, created_at, last_seen_at, id_token) VALUES (?, ?, ?, ?, ?)').run(sha256(sid), userId, now, now, idToken || null);
    return sid;
  }

  /** The session's user, sliding its idle timer; null when missing or expired. */
  sessionUser(sid, now = Date.now()) {
    if (!sid) return null;
    const s = this.db.prepare('SELECT id_hash, user_id, created_at, last_seen_at FROM sessions WHERE id_hash = ?').get(sha256(sid));
    if (!s) return null;
    if (now - s.last_seen_at > IDLE_MS || now - s.created_at > MAX_MS) {
      this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(s.id_hash);
      return null;
    }
    if (now - s.last_seen_at > 60 * 1000) this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?').run(now, s.id_hash);
    return this.getUser(s.user_id);
  }

  endSession(sid) {
    if (!sid) return null;
    const s = this.db.prepare('SELECT id_token FROM sessions WHERE id_hash = ?').get(sha256(sid));
    this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(sha256(sid));
    return s ? s.id_token : null;
  }

  pruneSessions(now = Date.now()) {
    this.db.prepare('DELETE FROM sessions WHERE last_seen_at < ? OR created_at < ?').run(now - IDLE_MS, now - MAX_MS);
  }
}

/* ------------------------------------------------------------- HTTP glue */

const parseCookies = (header) => {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
};

/** Only same-site relative paths may be returned to after sign-in. */
const safeReturn = (p) => (typeof p === 'string' && /^\/(?!\/)/.test(p) && !p.includes('\\') ? p : '/');

/**
 * Sign-in for narado. `enabled` is false when no provider is configured.
 * handle(req, res) serves /auth/*; userFor(req) gives the signed-in user or null.
 */
const createAuth = ({ dataDir, env = process.env, port, fetchImpl, log = console }) => {
  const publicUrl = (env.NARADO_PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, '');
  const enabled = !!env.NARADO_OIDC_ISSUER;
  const secureCookie = publicUrl.startsWith('https://');
  const users = new UserStore({ dataDir });
  const pending = new Map(); // state -> { nonce, verifier, returnTo, at }
  const oidc = enabled
    ? new OidcClient({
        issuer: env.NARADO_OIDC_ISSUER,
        clientId: env.NARADO_OIDC_CLIENT_ID,
        clientSecret: env.NARADO_OIDC_CLIENT_SECRET,
        redirectUri: `${publicUrl}/auth/callback`,
        scopes: env.NARADO_OIDC_SCOPES || undefined,
        fetchImpl
      })
    : null;
  if (enabled && !env.NARADO_OIDC_CLIENT_ID) throw new Error('NARADO_OIDC_CLIENT_ID is required with NARADO_OIDC_ISSUER');
  const allowedDomains = (env.NARADO_ALLOWED_EMAIL_DOMAINS || '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);

  const cookie = (value, maxAgeS) =>
    `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax${secureCookie ? '; Secure' : ''}; Max-Age=${maxAgeS}`;

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  };
  const redirect = (res, location, headers = {}) => {
    res.writeHead(302, { location, 'cache-control': 'no-store', ...headers });
    res.end();
  };
  const providerName = env.NARADO_OIDC_PROVIDER_NAME || 'single sign-on';
  const autoRedirect = env.NARADO_OIDC_AUTO_REDIRECT === '1';
  const startUrl = (returnTo) => `/auth/login/start?return=${encodeURIComponent(safeReturn(returnTo))}`;
  const html = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
  };
  /** A sign-in problem, on the sign-in page with a way to try again. */
  const page = (res, status, message) => html(res, status, signInPage({ startUrl: startUrl('/'), providerName, notice: { text: message, error: true } }));

  const userFor = (req) => {
    if (!enabled) return null;
    return users.sessionUser(parseCookies(req.headers.cookie)[COOKIE]);
  };

  const handle = async (req, res) => {
    const url = new URL(req.url, publicUrl);
    if (!url.pathname.startsWith('/auth/')) return false;

    if (url.pathname === '/auth/me') {
      if (!enabled) return send(res, 200, { mode: 'local', user: null }), true;
      const user = userFor(req);
      return user ? send(res, 200, { mode: 'oidc', user: { id: user.id, name: user.name, email: user.email } }) : send(res, 401, { mode: 'oidc', user: null }), true;
    }

    if (serveAsset(url.pathname, res)) return true;
    if (!enabled) return send(res, 404, { error: 'Sign-in is not configured on this server' }), true;

    try {
      if (url.pathname === '/auth/login' && req.method === 'GET' && !autoRedirect) {
        const notice = url.searchParams.get('signedout') ? { text: 'You have signed out.' } : null;
        html(res, 200, signInPage({ startUrl: startUrl(url.searchParams.get('return')), providerName, notice }));
        return true;
      }

      if ((url.pathname === '/auth/login/start' || url.pathname === '/auth/login') && req.method === 'GET') {
        for (const [k, v] of pending) if (Date.now() - v.at > LOGIN_TTL_MS) pending.delete(k);
        const start = await oidc.start();
        pending.set(start.state, { nonce: start.nonce, verifier: start.verifier, returnTo: safeReturn(url.searchParams.get('return')), at: Date.now() });
        redirect(res, start.url);
        return true;
      }

      if (url.pathname === '/auth/callback' && req.method === 'GET') {
        if (url.searchParams.get('error')) {
          page(res, 400, `The sign-in provider said: ${url.searchParams.get('error_description') || url.searchParams.get('error')}`);
          return true;
        }
        const state = url.searchParams.get('state');
        const login = state && pending.get(state);
        pending.delete(state);
        if (!login || Date.now() - login.at > LOGIN_TTL_MS) {
          page(res, 400, 'This sign-in link has expired or was already used.');
          return true;
        }
        const tokens = await oidc.exchange(url.searchParams.get('code'), login.verifier);
        const claims = await oidc.verify(tokens.id_token, login.nonce);
        const email = claims.email && claims.email_verified !== false ? String(claims.email) : null;
        if (allowedDomains.length && !(email && allowedDomains.includes(email.split('@')[1].toLowerCase()))) {
          page(res, 403, 'Your account is not allowed to use this narado server.');
          return true;
        }
        const name = claims.name || [claims.given_name, claims.family_name].filter(Boolean).join(' ') || claims.preferred_username || email || claims.sub;
        const user = users.upsertUser({ issuer: oidc.issuer, subject: claims.sub, email, name });
        const sid = users.createSession(user.id, tokens.id_token);
        users.pruneSessions();
        log.log(`[narado] signed in: ${user.name} (${user.id})`);
        redirect(res, login.returnTo, { 'set-cookie': cookie(sid, Math.floor(MAX_MS / 1000)) });
        return true;
      }

      if (url.pathname === '/auth/logout' && req.method === 'POST') {
        const origin = req.headers.origin;
        if (origin && origin !== publicUrl) return send(res, 403, { error: 'Cross-site sign-out refused' }), true;
        const idToken = users.endSession(parseCookies(req.headers.cookie)[COOKIE]);
        const next = await oidc.logoutUrl(idToken, `${publicUrl}/auth/login?signedout=1`).catch(() => null);
        send(res, 200, { redirect: next || '/auth/login?signedout=1' }, { 'set-cookie': cookie('', 0) });
        return true;
      }
    } catch (err) {
      log.error('[narado] sign-in failed:', err.message);
      page(res, 502, err instanceof AuthError ? err.message : 'Sign-in failed. Check the server log.');
      return true;
    }

    send(res, 404, { error: 'Not found' });
    return true;
  };

  return { enabled, handle, userFor, users, publicUrl, COOKIE };
};

module.exports = { createAuth, OidcClient, UserStore, AuthError, parseCookies, safeReturn };
