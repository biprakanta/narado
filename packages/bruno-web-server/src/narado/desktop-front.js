/**
 * narado desktop's front (desktop phase D2, docs/desktop.md 3.1 and 3.5): the calls a
 * worker makes to the server's front (Git tokens, secrets, devices), made over HTTPS with
 * this computer's device session.
 *
 * Signing in: a one-time loopback listener on 127.0.0.1, PKCE and a state, the person
 * signs in and approves this computer in the system browser, then the code is exchanged
 * for a refresh token (rotating, kept encrypted with the OS's secure storage: Keychain,
 * DPAPI or libsecret, through Electron's safeStorage) and an access token (memory only).
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;
const SECRET_OFFLINE_MS = 8 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15 * 1000;

class NeedsSignIn extends Error {
  constructor(message = 'Sign in to your narado server first (Git section, ⋯ menu).') {
    super(message);
    this.code = 'NEEDS_SIGN_IN';
  }
}

class NeedsConnection extends Error {
  constructor(server) {
    super(`Can't reach your narado server (${server}). This needs a connection.`);
    this.code = 'NEEDS_CONNECTION';
  }
}

/** A server address people type: https, or http only for this computer (development). */
const normaliseServer = (input) => {
  let s = String(input || '').trim();
  if (!s) throw new Error('Enter your narado server address');
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new Error(`"${input}" is not a web address`);
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new Error('The narado server address must start with https://');
  if (u.username || u.password || u.search || u.hash) throw new Error('Enter just the server address, like https://narado.example.com');
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
};

/** The page the system browser shows after signing in narado desktop (served on 127.0.0.1). */
const htmlPage = (title, text, server) => {
  const asset = (f) => (server ? `${server}/auth/assets/${f}?v=2` : '');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>${server ? `<link rel="icon" type="image/svg+xml" href="${asset('narado-favicon.svg')}">` : ''}
<style>@font-face{font-family:"Space Grotesk";font-weight:700;src:url(${asset('space-grotesk-700.woff2')}) format("woff2")}@font-face{font-family:Inter;font-weight:400;src:url(${asset('inter-400.woff2')}) format("woff2")}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:15px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#EDE4D8;background:#17121F;background-image:radial-gradient(60rem 40rem at 70% 10%,rgba(253,110,21,.16),transparent 60%),radial-gradient(50rem 40rem at 10% 100%,rgba(101,7,72,.45),transparent 60%)}
main{max-width:400px;text-align:center;padding:24px}img{width:160px;height:160px}h1{margin:0 0 12px;font:700 32px "Space Grotesk",ui-sans-serif,sans-serif;color:#FDEED2}</style></head>
<body><main>${server ? `<img src="${asset('narado-illustration-256.png')}" alt="">` : ''}<h1>narado</h1><p>${text}</p></main></body></html>`;
};

class RemoteFront {
  /**
   * @param dataDir      where the (encrypted) session is kept
   * @param safeStorage  Electron's safeStorage (encryptString / decryptString / isEncryptionAvailable)
   * @param openExternal opens a URL in the system browser
   */
  constructor({ dataDir, safeStorage, openExternal, fetchImpl = fetch, deviceName = os.hostname(), platform = process.platform, log = console }) {
    this.dataDir = dataDir;
    this.safeStorage = safeStorage;
    this.openExternal = openExternal;
    this.fetch = fetchImpl;
    this.deviceName = deviceName;
    this.platform = platform;
    this.log = log;
    this.file = path.join(dataDir, 'desktop-session.bin');
    this.serverFile = path.join(dataDir, 'desktop-server.json');
    this.server = null;
    this.refreshToken = null;
    this.access = null; // { token, exp }
    this.session = null; // { user, device, policy, hosts }
    this.refreshing = null;
    this.online = true; // until a call fails
    this.listeners = new Set();
    this.load();

    const call = (method, ...args) => this.call(method, args);
    // Git access tokens, in memory only, until 5 minutes before they expire (10 minutes
    // at most, so a disconnected account stops working here soon).
    this.gitTokens = new Map();
    this.git = {
      status: () => call('git.status'),
      token: async (hostId, opts = {}) => {
        const hit = this.gitTokens.get(hostId);
        if (hit && !opts.force && hit.until > Date.now()) return hit.value;
        const value = await call('git.token', hostId, opts);
        const until = Math.min(Date.now() + 10 * 60 * 1000, value && value.expiresAt ? value.expiresAt - 5 * 60 * 1000 : Infinity);
        this.gitTokens.set(hostId, { value, until });
        return value;
      }
    };
    this.secrets = {
      stores: () => call('secrets.stores'),
      resolve: (refs, ctx) => call('secrets.resolve', refs, ctx || {}),
      list: (store, prefix, ctx) => call('secrets.list', store, prefix, ctx || {}),
      check: (ref, ctx) => call('secrets.check', ref, ctx || {}),
      reveal: (ref, ctx) => call('secrets.reveal', ref, ctx || {})
    };
    // Offline (desktop phase D3): values resolved earlier in this session stay usable for
    // 8 hours, in memory only, never on disk. Online, every send asks the server again,
    // so its access rules and any change of value apply.
    this.secretCache = new Map(); // `${ctx}|${ref}` -> { value, at }
    this.secrets.resolve = async (refs, ctx = {}) => {
      const scope = `${ctx.hostId || ''}:${ctx.repoPath || ''}`;
      try {
        // The server answers { values, errors }, as SecretsService.resolve does.
        const res = await call('secrets.resolve', refs, ctx);
        const values = (res && res.values) || {};
        for (const ref of refs) if (ref in values) this.secretCache.set(`${scope}|${ref}`, { value: values[ref], at: Date.now() });
        return res;
      } catch (err) {
        if (err.code !== 'NEEDS_CONNECTION') throw err;
        const out = {};
        for (const ref of refs) {
          const hit = this.secretCache.get(`${scope}|${ref}`);
          if (!hit || Date.now() - hit.at > SECRET_OFFLINE_MS) {
            const e = new Error(`${ref} can't be used offline: it wasn't used in the last 8 hours on this computer. Connect to your narado server to use it.`);
            e.code = 'NEEDS_CONNECTION';
            throw e;
          }
          out[ref] = hit.value;
        }
        this.log.log(`[narado] desktop: offline, using ${refs.length} secret value(s) from earlier in this session`);
        return { values: out, errors: {} };
      }
    };
    this.devices = {
      list: () => call('devices.list'),
      revoke: (id) => call('devices.revoke', id)
    };
  }

  /* ------------------------------------------------------------ saved session */

  load() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.serverFile, 'utf8'));
      this.server = saved.server ? normaliseServer(saved.server) : null;
      this.session = saved.session || null; // last known (shown while offline)
    } catch {}
    try {
      if (this.server && fs.existsSync(this.file) && this.safeStorage.isEncryptionAvailable()) {
        this.refreshToken = this.safeStorage.decryptString(fs.readFileSync(this.file));
      }
    } catch (err) {
      this.log.warn(`[narado] desktop: couldn't read the saved sign-in (${err.message}); sign in again`);
      this.refreshToken = null;
    }
  }

  save() {
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.serverFile, JSON.stringify({ server: this.server, session: this.session }, null, 2), { mode: 0o600 });
    if (this.refreshToken) {
      if (!this.safeStorage.isEncryptionAvailable()) throw new Error("This computer's secure storage isn't available, so narado can't keep you signed in");
      fs.writeFileSync(this.file, this.safeStorage.encryptString(this.refreshToken), { mode: 0o600 });
    } else {
      fs.rmSync(this.file, { force: true });
    }
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  changed() {
    for (const fn of this.listeners) {
      try {
        fn(this.status());
      } catch {}
    }
  }

  get signedIn() {
    return !!(this.server && this.refreshToken);
  }

  status() {
    return {
      mode: 'server',
      server: this.server,
      signedIn: this.signedIn,
      user: this.signedIn && this.session ? this.session.user : null,
      device: this.signedIn && this.session ? this.session.device : null,
      policy: this.session ? this.session.policy : null,
      signingIn: !!this.pendingSignIn,
      isAdmin: !!(this.signedIn && this.session && this.session.isAdmin),
      online: this.online
    };
  }

  /* ------------------------------------------------------------------- HTTP */

  /** Whether the server answered last time (or false after a failed attempt). */
  setOnline(online) {
    if (this.online === online) return;
    this.online = online;
    this.log.log(`[narado] desktop: ${online ? 'connected to' : "can't reach"} ${this.server}`);
    this.changed();
  }

  async request(pathname, init) {
    let res;
    try {
      res = await this.fetch(`${this.server}${pathname}`, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch {
      this.setOnline(false);
      throw new NeedsConnection(this.server);
    }
    // Behind a proxy (Caddy, the dev server), a server that's down answers 502-504.
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      this.setOnline(false);
      throw new NeedsConnection(this.server);
    }
    this.setOnline(true);
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  post(pathname, body, token) {
    return this.request(pathname, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body)
    });
  }

  get(pathname, token) {
    return this.request(pathname, { headers: { authorization: `Bearer ${token}` } });
  }

  /** Swap the refresh token (rotating) for a new access token. */
  async refresh() {
    if (!this.signedIn) throw new NeedsSignIn();
    if (!this.refreshing) {
      this.refreshing = (async () => {
        const r = await this.post('/desktop/api/token', { grant_type: 'refresh_token', refresh_token: this.refreshToken });
        if (r.status !== 200) {
          if (r.body.error === 'invalid_grant') {
            this.forget();
            throw new NeedsSignIn(`${r.body.message || 'This computer was signed out.'} Sign in to your narado server again.`);
          }
          throw new Error(r.body.message || `narado server answered ${r.status}`);
        }
        this.accept(r.body);
      })().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  accept(body) {
    this.refreshToken = body.refresh_token;
    this.access = { token: body.access_token, exp: Date.now() + (Number(body.expires_in) || 3600) * 1000 - 60 * 1000 };
    this.session = { ...(this.session || {}), user: body.user, device: body.device };
    this.save();
  }

  async accessToken() {
    if (!this.access || this.access.exp < Date.now()) await this.refresh();
    return this.access.token;
  }

  /** A front call (git.*, secrets.*, devices.*) as this computer's person. */
  async call(method, args = []) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.accessToken();
      const r = await this.post('/desktop/api/call', { method, args }, token);
      if (r.status === 401 && attempt === 0) {
        this.access = null; // e.g. the server restarted
        continue;
      }
      if (r.status !== 200) throw new Error(r.body.message || r.body.error || `narado server answered ${r.status}`);
      return r.body.result;
    }
    throw new NeedsSignIn();
  }

  /** The person, device, policy and Git hosts from the server. */
  async loadSession() {
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await this.get('/desktop/api/session', await this.accessToken());
      if (r.status === 401 && attempt === 0) {
        this.access = null;
        continue;
      }
      if (r.status !== 200) throw new Error(r.body.message || `narado server answered ${r.status}`);
      this.session = r.body;
      this.save();
      this.changed();
      return r.body;
    }
    throw new NeedsSignIn();
  }

  /** Report sends (desktop audit). Failures are left to the caller (queued in D3). */
  async audit(events) {
    if (!this.signedIn || !events.length) return;
    const r = await this.post('/desktop/api/audit', { events }, await this.accessToken());
    if (r.status !== 200) throw new Error(r.body.message || `narado server answered ${r.status}`);
  }

  /* ---------------------------------------------------------------- sign-in */

  /**
   * Sign in to `server` through the system browser. Resolves with the session once the
   * person approved this computer; rejects if they cancel or after 5 minutes.
   */
  async signIn(serverInput) {
    const server = normaliseServer(serverInput || this.server);
    if (this.pendingSignIn) this.pendingSignIn.cancel('Started again');
    const verifier = b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(24));

    let finish;
    const done = new Promise((resolve, reject) => (finish = { resolve, reject }));
    done.catch(() => {}); // the browser may answer before we start waiting; handled below
    const listener = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/callback') return res.writeHead(404).end();
      if (url.searchParams.get('state') !== state) {
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(htmlPage('narado', 'This sign-in is out of date. Start again from narado desktop.', server));
        return;
      }
      const error = url.searchParams.get('error');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(htmlPage('narado', error ? 'Sign-in cancelled. You can close this tab.' : 'narado desktop is signed in. You can close this tab and go back to the app.', server));
      if (error) finish.reject(new Error(error === 'access_denied' ? 'Sign-in was cancelled in the browser' : `Sign-in failed: ${error}`));
      else finish.resolve(url.searchParams.get('code'));
    });
    await new Promise((resolve, reject) => listener.listen(0, '127.0.0.1', resolve).on('error', reject));
    const redirectUri = `http://127.0.0.1:${listener.address().port}/callback`;
    const timer = setTimeout(() => finish.reject(new Error('Sign-in timed out. Start again.')), SIGN_IN_TIMEOUT_MS);
    this.pendingSignIn = { cancel: (why) => finish.reject(new Error(why)) };

    try {
      const start = new URL(`${server}/auth/desktop/start`);
      start.search = new URLSearchParams({
        redirect_uri: redirectUri,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        device_name: this.deviceName,
        platform: this.platform
      }).toString();
      this.pendingSignIn.url = start.toString();
      this.changed();
      // If the browser doesn't open, the interface offers this link to copy.
      await Promise.resolve(this.openExternal(start.toString())).catch((err) => this.log.warn(`[narado] desktop: couldn't open the browser (${err.message})`));
      const code = await done;
      this.server = server;
      const r = await this.post('/desktop/api/token', { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri });
      if (r.status !== 200) throw new Error(r.body.message || `Sign-in failed (${r.status})`);
      this.accept(r.body);
      this.log.log(`[narado] desktop: signed in to ${server} as ${r.body.user.name} (device ${r.body.device.id})`);
      await this.loadSession();
      return this.status();
    } finally {
      clearTimeout(timer);
      listener.close();
      this.pendingSignIn = null;
    }
  }

  /** Sign this computer out (on the server too, when reachable). */
  async signOut() {
    if (this.signedIn) {
      try {
        const token = await this.accessToken();
        await this.post('/desktop/api/logout', {}, token);
      } catch (err) {
        this.log.warn(`[narado] desktop: couldn't tell the server about signing out (${err.message})`);
      }
    }
    this.forget();
    return this.status();
  }

  forget() {
    this.refreshToken = null;
    this.access = null;
    this.gitTokens.clear();
    this.secretCache.clear();
    if (this.session) this.session = { policy: this.session.policy, hosts: this.session.hosts };
    this.save();
    this.changed();
  }

  /** The link for the sign-in in progress, for people whose browser didn't open. */
  signInLink() {
    return this.pendingSignIn && this.pendingSignIn.url ? this.pendingSignIn.url : null;
  }

  /* ---------------------------------------------------------------- updates */

  /** GET an update file from the server, as this device (null when there's no such file). */
  async updateFile(platform, name) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.accessToken();
      let res;
      try {
        res = await this.fetch(`${this.server}/desktop/api/updates/${platform}/${encodeURIComponent(name)}`, { headers: { authorization: `Bearer ${token}` } });
      } catch {
        this.setOnline(false);
        throw new NeedsConnection(this.server);
      }
      this.setOnline(true);
      if (res.status === 401 && attempt === 0) {
        this.access = null;
        continue;
      }
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`narado server answered ${res.status}`);
      return res;
    }
    throw new NeedsSignIn();
  }

  /**
   * The newest narado desktop the server offers for this system and chip:
   * { version, notes, file: { name, size, sha512 } } or null.
   */
  async latestUpdate({ platform, arch, kind }) {
    const res = await this.updateFile(platform, 'latest.json');
    if (!res) return null;
    const manifest = await res.json().catch(() => null);
    if (!manifest || !manifest.version || !Array.isArray(manifest.files)) return null;
    const file = manifest.files.find((f) => f.arch === arch && (!kind || f.kind === kind)) || manifest.files.find((f) => f.arch === arch);
    return file ? { version: String(manifest.version), notes: manifest.notes || null, file } : null;
  }

  /** Download an update to `dir`, checking its SHA-512; returns the file's path. */
  async downloadUpdate(platform, file, dir, onProgress = () => {}) {
    const crypto = require('node:crypto');
    if (!/^[A-Za-z0-9._-]+$/.test(file.name)) throw new Error('Unexpected update file name');
    const res = await this.updateFile(platform, file.name);
    if (!res) throw new Error('The update is no longer on the server');
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, file.name);
    const partial = `${dest}.partial`;
    const hash = crypto.createHash('sha512');
    const out = fs.createWriteStream(partial);
    let got = 0;
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        got += value.length;
        if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
        onProgress(file.size ? got / file.size : null);
      }
    } finally {
      await new Promise((r) => out.end(r));
    }
    if (hash.digest('base64') !== file.sha512) {
      fs.rmSync(partial, { force: true });
      throw new Error("The downloaded update doesn't match its checksum; nothing was installed");
    }
    fs.renameSync(partial, dest);
    return dest;
  }

  /** Where to connect a Git account, in the system browser (the account stays on the server). */
  connectUrl(hostId) {
    if (!this.server) throw new NeedsSignIn();
    return `${this.server}/auth/git/${encodeURIComponent(hostId)}/connect?return=${encodeURIComponent('/auth/desktop/done')}`;
  }
}

module.exports = { RemoteFront, NeedsSignIn, NeedsConnection, normaliseServer };
