/**
 * Each person's own Git accounts (Phase 4c).
 *
 * People connect their GitHub account through narado's GitHub App (user authorisation,
 * with expiring tokens) and their GitLab account through a GitLab OAuth application.
 * narado then acts on Git hosts as that person, so the host's own permissions,
 * branch protection and audit apply to them, not to a shared token.
 *
 *   - Connecting: authorization code flow with PKCE and a one-time state tied to the
 *     narado person who started it.
 *   - Storage: <data>/narado.db, table git_accounts. Access and refresh tokens are
 *     encrypted with AES-256-GCM; the key is NARADO_GIT_TOKEN_KEY (32 bytes, base64)
 *     or <data>/narado-git-key, created on first use.
 *   - Workers never see refresh tokens or app credentials. They ask the front for an
 *     access token when they need one (git.token), and the front refreshes it when it
 *     has less than five minutes left. Both hosts rotate refresh tokens, so refreshes
 *     for one account are serialised.
 *
 * App credentials come from the environment: NARADO_<HOST ID>_APP_CLIENT_ID and
 * NARADO_<HOST ID>_APP_CLIENT_SECRET (for example NARADO_GITHUB_APP_CLIENT_ID), and for
 * GitHub NARADO_<HOST ID>_APP_SLUG for the "install the app" link.
 *
 * One host account can be connected by one narado person only, so that what narado does
 * on the host is always attributed to the person who did it. The host account's verified
 * emails are compared with the person's sign-in email: NARADO_GIT_ACCOUNT_MATCH=warn (the
 * default) shows a mismatch, =require refuses it, =off skips the check.
 *
 * Shared tokens (NARADO_<HOST ID>_TOKEN) still work in single-user local mode. With
 * sign-in on they are not used, unless NARADO_SHARED_GIT_TOKENS=1 (for moving over).
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { ProviderRegistry } = require('./providers');
const { requestJson, HostApiError } = require('./providers/http');

const LOGIN_TTL_MS = 10 * 60 * 1000;
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const b64url = (buf) => Buffer.from(buf).toString('base64url');

class NotConnected extends Error {
  constructor(message) {
    super(message);
    this.code = 'NARADO_GIT_NOT_CONNECTED';
  }
}

const envPrefix = (hostId) => `NARADO_${hostId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_APP_`;

/** Encrypts tokens at rest. */
class TokenBox {
  constructor({ dataDir, env = process.env }) {
    let key;
    if (env.NARADO_GIT_TOKEN_KEY) {
      key = Buffer.from(env.NARADO_GIT_TOKEN_KEY, 'base64');
      if (key.length !== 32) throw new Error('NARADO_GIT_TOKEN_KEY must be 32 bytes, base64-encoded');
    } else {
      const file = path.join(dataDir, 'narado-git-key');
      if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('base64'), { mode: 0o600, flag: 'wx' });
      key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
    }
    this.key = key;
  }

  seal(text, aad) {
    if (text == null) return null;
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from(aad));
    const body = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
    return `v1.${b64url(iv)}.${b64url(c.getAuthTag())}.${b64url(body)}`;
  }

  open(sealed, aad) {
    if (!sealed) return null;
    const [v, iv, tag, body] = String(sealed).split('.');
    if (v !== 'v1') throw new Error('Unknown token format');
    const d = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(body, 'base64url')), d.final()]).toString('utf8');
  }
}

class GitAccountStore {
  constructor({ dataDir, env }) {
    this.box = new TokenBox({ dataDir, env });
    this.db = new DatabaseSync(path.join(dataDir, 'narado.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS git_accounts (
        user_key TEXT NOT NULL,
        host_id TEXT NOT NULL,
        login TEXT,
        account_id TEXT,
        access_token TEXT,
        access_expires_at INTEGER,
        refresh_token TEXT,
        refresh_expires_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_key, host_id)
      )`);
    // Added later: whether the account's verified emails include the person's sign-in email.
    const cols = this.db.prepare('PRAGMA table_info(git_accounts)').all().map((c) => c.name);
    if (!cols.includes('email_match')) this.db.exec('ALTER TABLE git_accounts ADD COLUMN email_match INTEGER');
  }

  aad(userKey, hostId) {
    return `${userKey}\u0000${hostId}`;
  }

  get(userKey, hostId) {
    const r = this.db.prepare('SELECT * FROM git_accounts WHERE user_key = ? AND host_id = ?').get(userKey, hostId);
    if (!r) return null;
    const aad = this.aad(userKey, hostId);
    return {
      login: r.login,
      accountId: r.account_id,
      accessToken: this.box.open(r.access_token, aad),
      accessExpiresAt: r.access_expires_at,
      refreshToken: this.box.open(r.refresh_token, aad),
      refreshExpiresAt: r.refresh_expires_at,
      emailMatch: r.email_match === null || r.email_match === undefined ? null : !!r.email_match,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    };
  }

  save(userKey, hostId, a) {
    const now = Date.now();
    const aad = this.aad(userKey, hostId);
    this.db
      .prepare(
        `INSERT INTO git_accounts (user_key, host_id, login, account_id, access_token, access_expires_at, refresh_token, refresh_expires_at, email_match, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_key, host_id) DO UPDATE SET login = excluded.login, account_id = excluded.account_id,
           access_token = excluded.access_token, access_expires_at = excluded.access_expires_at,
           refresh_token = excluded.refresh_token, refresh_expires_at = excluded.refresh_expires_at,
           email_match = excluded.email_match, updated_at = excluded.updated_at`
      )
      .run(
        userKey,
        hostId,
        a.login || null,
        a.accountId != null ? String(a.accountId) : null,
        this.box.seal(a.accessToken, aad),
        a.accessExpiresAt || null,
        this.box.seal(a.refreshToken, aad),
        a.refreshExpiresAt || null,
        a.emailMatch === null || a.emailMatch === undefined ? null : a.emailMatch ? 1 : 0,
        now,
        now
      );
  }

  /** Who else, if anyone, has this host account connected. */
  ownerOf(hostId, accountId) {
    const r = this.db.prepare('SELECT user_key FROM git_accounts WHERE host_id = ? AND account_id = ?').get(hostId, String(accountId));
    return r ? r.user_key : null;
  }

  remove(userKey, hostId) {
    this.db.prepare('DELETE FROM git_accounts WHERE user_key = ? AND host_id = ?').run(userKey, hostId);
  }
}

/** OAuth endpoints and quirks per host type. */
const oauthFor = (host, provider) => {
  if (host.type === 'github') {
    return {
      authorizeUrl: `${provider.url}/login/oauth/authorize`,
      tokenUrl: `${provider.url}/login/oauth/access_token`,
      scope: null, // a GitHub App's permissions are set on the app
      revoke: async (app, token, fetchImpl) =>
        requestJson(`${provider.apiUrl}/applications/${app.clientId}/grant`, {
          method: 'DELETE',
          body: { access_token: token },
          headers: { authorization: `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString('base64')}`, accept: 'application/vnd.github+json' },
          fetchImpl
        })
    };
  }
  return {
    authorizeUrl: `${provider.url}/oauth/authorize`,
    tokenUrl: `${provider.url}/oauth/token`,
    scope: host.scopes || 'api read_user',
    revoke: async (app, token, fetchImpl) =>
      requestJson(`${provider.url}/oauth/revoke`, { method: 'POST', body: { client_id: app.clientId, client_secret: app.clientSecret, token }, fetchImpl })
  };
};

/**
 * The front's view of people's Git accounts: connect and disconnect routes, and the
 * git.* calls workers make.
 */
class GitAccounts {
  constructor({ dataDir, publicUrl, multiUser, env = process.env, fetchImpl = globalThis.fetch, log = console }) {
    this.registry = new ProviderRegistry({ dataDir, env, fetchImpl });
    this.store = new GitAccountStore({ dataDir, env });
    this.publicUrl = publicUrl.replace(/\/$/, '');
    this.multiUser = !!multiUser;
    this.env = env;
    this.fetch = fetchImpl;
    this.log = log;
    this.sharedTokens = !multiUser || env.NARADO_SHARED_GIT_TOKENS === '1';
    this.pending = new Map(); // state -> { userKey, hostId, verifier, returnTo, at }
    this.refreshing = new Map(); // userKey/hostId -> Promise
  }

  /** Environment variable names workers must not see (shared Git tokens). */
  tokenEnvNames() {
    return this.registry.hosts.map((h) => h.tokenEnv);
  }

  userKey(user) {
    return this.multiUser ? user && user.id : 'local';
  }

  host(hostId) {
    const h = this.registry.hosts.find((x) => x.id === hostId);
    if (!h) throw new NotConnected(`Unknown Git host "${hostId}"`);
    return h;
  }

  app(hostId) {
    const p = envPrefix(hostId);
    const clientId = this.env[`${p}CLIENT_ID`];
    const clientSecret = this.env[`${p}CLIENT_SECRET`];
    return clientId && clientSecret ? { clientId, clientSecret, slug: this.env[`${p}SLUG`] || null } : null;
  }

  callbackUrl(hostId) {
    return `${this.publicUrl}/auth/${hostId}/callback`;
  }

  /** Per host: is it connected for this person, and how. No tokens. */
  status(user) {
    const key = this.userKey(user);
    return this.registry.hosts.map((h) => {
      const p = this.registry.build(h, 'placeholder');
      const app = this.app(h.id);
      const account = key ? this.store.get(key, h.id) : null;
      const shared = this.sharedTokens && !!this.env[h.tokenEnv];
      const expired = account && account.refreshExpiresAt && account.refreshExpiresAt < Date.now();
      return {
        id: h.id,
        type: h.type,
        name: p.name,
        url: p.url,
        connected: !!(account && !expired) || shared,
        via: account && !expired ? 'account' : shared ? 'server' : null,
        login: account && !expired ? account.login : null,
        emailMatch: account && !expired ? account.emailMatch : null,
        canConnect: !!app,
        connectUrl: app ? `/auth/git/${encodeURIComponent(h.id)}/connect` : null,
        installUrl: app && h.type === 'github' && app.slug ? `${p.url}/apps/${app.slug}/installations/new` : null,
        tokenEnv: h.tokenEnv
      };
    });
  }

  /** A usable access token for this person on this host. */
  async token(user, hostId, { force = false } = {}) {
    const h = this.host(hostId);
    const key = this.userKey(user);
    const account = key ? this.store.get(key, hostId) : null;
    if (!account) {
      if (this.sharedTokens && this.env[h.tokenEnv]) return { token: this.env[h.tokenEnv], via: 'server' };
      throw new NotConnected(this.notConnectedText(h));
    }
    const fresh = !account.accessExpiresAt || account.accessExpiresAt - Date.now() > REFRESH_MARGIN_MS;
    if (fresh && !force) return { token: account.accessToken, via: 'account', login: account.login };
    if (!account.refreshToken) {
      if (fresh) return { token: account.accessToken, via: 'account', login: account.login };
      this.store.remove(key, hostId);
      throw new NotConnected(`Your ${h.id} sign-in has expired. ${this.notConnectedText(h)}`);
    }
    const k = `${key}/${hostId}`;
    if (!this.refreshing.has(k)) {
      const p = this.refresh(key, h).finally(() => this.refreshing.delete(k));
      this.refreshing.set(k, p);
    }
    const token = await this.refreshing.get(k);
    return { token, via: 'account', login: account.login };
  }

  /**
   * Can this person read this repository on the host? Asked of the host with their own
   * token, cached for five minutes. Used to check a worker's claim about which repository
   * a request belongs to (secrets rules). False when it can't be confirmed.
   */
  async canRead(user, hostId, repoPath) {
    const key = `${this.userKey(user)}|${hostId}|${repoPath}`;
    this.readCache = this.readCache || new Map();
    const hit = this.readCache.get(key);
    if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.ok;
    let ok = false;
    try {
      const h = this.host(hostId);
      const provider = this.registry.build(h, undefined, (opts) => this.token(user, hostId, opts).then((t) => t.token));
      const repo = await provider.getRepo(repoPath);
      ok = !!repo && repo.access !== 'none';
    } catch {
      ok = false;
    }
    this.readCache.set(key, { at: Date.now(), ok });
    return ok;
  }

  notConnectedText(h) {
    const name = this.registry.build(h, 'placeholder').name;
    return this.app(h.id) ? `Connect your ${name} account in narado (Git section) first.` : `${name} is not set up on this server: it needs ${envPrefix(h.id)}CLIENT_ID and ${envPrefix(h.id)}CLIENT_SECRET.`;
  }

  async tokenRequest(h, params) {
    const app = this.app(h.id);
    const provider = this.registry.build(h, 'placeholder');
    const { tokenUrl } = oauthFor(h, provider);
    const res = await this.fetch(tokenUrl, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: app.clientId, client_secret: app.clientSecret, ...params }).toString(),
      signal: AbortSignal.timeout(15000)
    });
    const data = await res.json().catch(() => ({}));
    // GitHub reports OAuth errors with status 200 and an "error" field.
    if (!res.ok || data.error || !data.access_token) {
      const err = new Error(`${provider.name} refused the token request: ${data.error_description || data.error || res.status}`);
      err.oauthError = data.error || String(res.status);
      throw err;
    }
    const now = Date.now();
    return {
      accessToken: data.access_token,
      accessExpiresAt: data.expires_in ? now + Number(data.expires_in) * 1000 : null,
      refreshToken: data.refresh_token || null,
      refreshExpiresAt: data.refresh_token_expires_in ? now + Number(data.refresh_token_expires_in) * 1000 : null
    };
  }

  async refresh(key, h) {
    const account = this.store.get(key, h.id);
    if (!account) throw new NotConnected(this.notConnectedText(h));
    let t;
    try {
      t = await this.tokenRequest(h, { grant_type: 'refresh_token', refresh_token: account.refreshToken });
    } catch (err) {
      if (['bad_refresh_token', 'invalid_grant', '400', '401'].includes(err.oauthError)) {
        this.store.remove(key, h.id);
        this.log.log(`[narado] ${h.id} account for ${key} could not be refreshed and was disconnected`);
        throw new NotConnected(`Your ${h.id} sign-in has expired. ${this.notConnectedText(h)}`);
      }
      throw err;
    }
    this.store.save(key, h.id, {
      ...account,
      ...t,
      // GitLab keeps the refresh token's lifetime open; GitHub sends a new one each time.
      refreshExpiresAt: t.refreshExpiresAt || (t.refreshToken ? null : account.refreshExpiresAt),
      refreshToken: t.refreshToken || account.refreshToken
    });
    return t.accessToken;
  }

  /** Handles /auth/git/<host>/connect, /auth/git/<host>/disconnect and /auth/<host>/callback. */
  async handle(req, res, { user, allowedOrigins }) {
    const url = new URL(req.url, this.publicUrl);
    const m = /^\/auth\/(?:git\/([^/]+)\/(connect|disconnect)|([^/]+)\/callback)$/.exec(url.pathname);
    if (!m) return false;
    const hostId = decodeURIComponent(m[1] || m[3]);
    const action = m[2] || 'callback';
    if (!this.registry.hosts.some((h) => h.id === hostId)) return false;
    const h = this.host(hostId);
    const key = this.userKey(user);
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const back = (returnTo, params) => {
      const to = new URL(returnTo || '/', this.publicUrl);
      for (const [k, v] of Object.entries(params)) to.searchParams.set(k, v);
      res.writeHead(302, { location: to.pathname + to.search, 'cache-control': 'no-store' });
      res.end();
    };
    if (!key) return send(401, { error: 'Sign in first' }), true;
    const app = this.app(hostId);
    if (!app) return send(404, { error: this.notConnectedText(h) }), true;
    const provider = this.registry.build(h, 'placeholder');
    const oauth = oauthFor(h, provider);

    if (action === 'connect' && req.method === 'GET') {
      for (const [k, v] of this.pending) if (Date.now() - v.at > LOGIN_TTL_MS) this.pending.delete(k);
      const state = b64url(crypto.randomBytes(24));
      const verifier = b64url(crypto.randomBytes(32));
      const ret = url.searchParams.get('return');
      this.pending.set(state, { userKey: key, hostId, verifier, returnTo: typeof ret === 'string' && /^\/(?!\/)/.test(ret) ? ret : '/', at: Date.now() });
      const to = new URL(oauth.authorizeUrl);
      to.searchParams.set('client_id', app.clientId);
      to.searchParams.set('redirect_uri', this.callbackUrl(hostId));
      to.searchParams.set('state', state);
      to.searchParams.set('code_challenge', b64url(crypto.createHash('sha256').update(verifier).digest()));
      to.searchParams.set('code_challenge_method', 'S256');
      if (h.type !== 'github') to.searchParams.set('response_type', 'code');
      if (oauth.scope) to.searchParams.set('scope', oauth.scope);
      res.writeHead(302, { location: to.toString(), 'cache-control': 'no-store' });
      res.end();
      return true;
    }

    if (action === 'callback' && req.method === 'GET') {
      const state = url.searchParams.get('state');
      const p = state && this.pending.get(state);
      this.pending.delete(state);
      // The state must have been started by this same narado person, recently.
      if (!p || p.hostId !== hostId || p.userKey !== key || Date.now() - p.at > LOGIN_TTL_MS) {
        return back('/', { 'git-connect': 'expired', host: hostId }), true;
      }
      if (url.searchParams.get('error')) {
        return back(p.returnTo, { 'git-connect': 'refused', host: hostId }), true;
      }
      try {
        const t = await this.tokenRequest(h, { grant_type: 'authorization_code', code: url.searchParams.get('code') || '', redirect_uri: this.callbackUrl(hostId), code_verifier: p.verifier });
        const hostClient = this.registry.build(h, t.accessToken);
        const me = await hostClient.getCurrentUser();
        // Is this the same person as the sign-in? Compare verified emails with the SSO email.
        const policy = ['off', 'warn', 'require'].includes(this.env.NARADO_GIT_ACCOUNT_MATCH) ? this.env.NARADO_GIT_ACCOUNT_MATCH : 'warn';
        let emailMatch = null;
        if (policy !== 'off' && user && user.email && hostClient.verifiedEmails) {
          try {
            emailMatch = (await hostClient.verifiedEmails()).includes(String(user.email).toLowerCase());
          } catch (err) {
            this.log.warn(`[narado] could not read ${hostId} emails for ${me.login}: ${err.message}`);
          }
          if (policy === 'require' && emailMatch !== true) {
            this.log.warn(`[narado] ${key} tried to connect ${hostId} account ${me.login}, whose verified emails don't include their sign-in email`);
            return back(p.returnTo, { 'git-connect': 'mismatch', host: hostId, login: me.login }), true;
          }
        }
        // One host account belongs to one person, so the host's audit trail names the right one.
        const owner = this.store.ownerOf(hostId, me.id);
        if (owner && owner !== key) {
          this.log.warn(`[narado] ${key} tried to connect ${hostId} account ${me.login}, which another person has connected`);
          return back(p.returnTo, { 'git-connect': 'taken', host: hostId, login: me.login }), true;
        }
        this.store.save(key, hostId, { ...t, login: me.login, accountId: me.id, emailMatch });
        this.log.log(`[narado] ${key} connected ${hostId} account ${me.login}`);
        return back(p.returnTo, { 'git-connect': 'ok', host: hostId, login: me.login }), true;
      } catch (err) {
        this.log.error(`[narado] connecting ${hostId} failed for ${key}: ${err.message}`);
        return back(p.returnTo, { 'git-connect': 'failed', host: hostId }), true;
      }
    }

    if (action === 'disconnect' && req.method === 'POST') {
      const origin = req.headers.origin;
      if (!origin || !allowedOrigins.has(origin)) return send(403, { error: 'Cross-site request refused' }), true;
      const account = this.store.get(key, hostId);
      this.store.remove(key, hostId);
      if (account && account.accessToken) {
        // Also withdraw narado's access on the host; the local record is gone either way.
        await oauth.revoke(app, account.accessToken, this.fetch).catch((err) => this.log.warn(`[narado] could not revoke the ${hostId} grant: ${err.message}`));
      }
      this.log.log(`[narado] ${key} disconnected ${hostId}`);
      return send(200, { ok: true }), true;
    }

    send(405, { error: 'Method not allowed' });
    return true;
  }
}

/** The front's answers to git.* calls from a worker, as that worker's person. */
const gitService = (accounts) => async (user, method, args) => {
  switch (method) {
    case 'git.status':
      return accounts.status(user);
    case 'git.token': {
      const [hostId, opts] = args;
      try {
        return await accounts.token(user, String(hostId), opts || {});
      } catch (err) {
        if (err instanceof HostApiError) throw new Error(err.message);
        throw err;
      }
    }
    default:
      throw new Error(`Unknown call ${method}`);
  }
};

module.exports = { GitAccounts, GitAccountStore, TokenBox, NotConnected, gitService, envPrefix };
