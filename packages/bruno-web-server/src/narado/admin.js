/**
 * narado's setup and admin pages (/setup, /admin), served by the front process itself, so
 * they work before sign-in is configured and need no worker.
 *
 *   - First start: until admins are named, narado prints a one-time setup link in its log.
 *     Opening it gives that browser a setup session for /admin.
 *   - Afterwards: people listed in NARADO_ADMINS (signed in with SSO) use /admin.
 *   - In single-user local mode (no sign-in, listening on this computer only) /admin is open.
 *
 * What an admin sets here is kept by narado/settings.js under the names of the environment
 * variables it replaces; anything set in the server's environment wins and is shown as such.
 * Saving sign-in or Git settings restarts narado's front in place (restart()).
 *
 * Git apps are created by narado itself, so nobody copies IDs and secrets by hand:
 *   - GitHub (and GitHub Enterprise): GitHub's app-manifest flow. The admin's browser posts
 *     narado's app description to GitHub, GitHub creates the app (in their organisation or
 *     account) and sends back a one-time code that narado exchanges for its credentials.
 *   - Self-managed GitLab: the admin gives an administrator access token once; narado
 *     creates the OAuth application through the API and doesn't keep the token.
 *   - GitLab.com has no API for this, so the page shows exactly what to create and where.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { esc } = require('./pages');
const { ICON, page, messagePage, field, envBadge, copyField, sectionHead, emptyState, dialog, confirmAttrs, initials } = require('./admin-ui');
const { adminsFrom } = require('./settings');
const { DEFAULT_HOSTS, validateHosts } = require('./providers');
const { envPrefix } = require('./git-accounts');

const SETUP_COOKIE = 'narado_setup';
const MANIFEST_TTL_MS = 30 * 60 * 1000;
const setupSessions = new Set(); // survive a restart of the front (same process)
const manifestStates = new Map(); // state -> { hostId, at }

const PLATFORMS = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };
const when = (ms) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) : 'never');

// Brand marks for the connector cards, used to name the services narado connects to.
// GitHub's mark is from GitHub's Octicons (MIT); GitLab's is its tanuki.
const LOGOS = {
  // Secrets stores: simplified marks in each service's colours.
  vault: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#FFD814" d="M2 3.5h20L12 21.5z"/><path fill="#000" d="M10.2 7.2h1.6v1.6h-1.6zm2 0h1.6v1.6h-1.6zm-2 2.2h1.6V11h-1.6zm2 0h1.6V11h-1.6zm-2 2.2h1.6v1.6h-1.6zm2 0h1.6v1.6h-1.6z"/></svg>',
  aws: '<svg viewBox="0 0 48 30" aria-hidden="true"><text x="24" y="17" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-weight="700" font-size="17" fill="#fff">aws</text><path d="M9 21.5c8.5 5 21.5 5 30 0" stroke="#FF9900" stroke-width="2.6" fill="none" stroke-linecap="round"/><path d="M36.2 19.6l3.6 1.6-1.3 3.6" stroke="#FF9900" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  gcp: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke-width="2.2" stroke-linecap="round"><path stroke="#4285F4" d="M6.657 18c-2.572 0-4.657-2.007-4.657-4.483 0-2.475 2.085-4.482 4.657-4.482"/><path stroke="#EA4335" d="M6.657 9.035c.393-1.762 1.794-3.2 3.675-3.773 1.88-.572 3.956-.193 5.444.996"/><path stroke="#FBBC05" d="M15.776 6.258c1.488 1.19 2.162 3.007 1.77 4.769h.99"/><path stroke="#34A853" d="M18.536 11.027c1.913 0 3.464 1.56 3.464 3.486 0 1.927-1.551 3.487-3.465 3.487H6.657"/></svg>',
  azure: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16.555 3.843l3.602 3.602a2.877 2.877 0 0 1 0 4.069l-2.643 2.643a2.877 2.877 0 0 1 -4.069 0l-.301 -.301l-6.558 6.558a2 2 0 0 1 -1.239 .578l-.175 .008h-1.172a1 1 0 0 1 -.993 -.883l-.007 -.117v-1.172a2 2 0 0 1 .467 -1.284l.119 -.13l.414 -.414h2v-2h2v-2l2.144 -2.144l-.301 -.301a2.877 2.877 0 0 1 0 -4.069l2.643 -2.643a2.877 2.877 0 0 1 4.069 0z"/><path d="M15 9h.01"/></svg>',
  github: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"/></svg>',
  gitlab: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#FC6D26" d="m23.6004 9.5927-.0337-.0862L20.3.9814a.851.851 0 0 0-.3362-.405.8748.8748 0 0 0-.9997.0539.8748.8748 0 0 0-.29.4399l-2.2055 6.748H7.5375l-2.2057-6.748a.8573.8573 0 0 0-.29-.4412.8748.8748 0 0 0-.9997-.0537.8585.8585 0 0 0-.3362.4049L.4332 9.5015l-.0325.0862a6.0657 6.0657 0 0 0 2.0119 7.0105l.0113.0087.03.0213 4.976 3.7264 2.462 1.8633 1.4995 1.1321a1.0085 1.0085 0 0 0 1.2197 0l1.4995-1.1321 2.4619-1.8633 5.006-3.7489.0125-.01a6.0682 6.0682 0 0 0 2.0094-7.003z"/></svg>'
};

const readForm = (req, limit = 64 * 1024) =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Form too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });

const cookieOf = (req, name) => {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.cookie || '');
  return m ? decodeURIComponent(m[1]) : null;
};

/**
 * @param env      the environment narado runs with (settings under the real environment)
 * @param realEnv  the server's own environment: what's set there can't be changed here
 */
const createAdmin = ({ settings, env, realEnv = process.env, auth, desktop, gitAccounts, secrets = null, dataDir, localOnly, restart, fetchImpl = fetch, log = console }) => {
  const publicUrl = auth.publicUrl;
  const admins = adminsFrom(env);
  const setupNeeded = !localOnly && (!admins.length || !auth.enabled);

  /** Who may use the admin pages: { name } or null. */
  const adminFor = (req) => {
    if (localOnly) return { name: 'this computer', local: true };
    const user = auth.enabled ? auth.userFor(req) : null;
    if (user && user.email && admins.includes(String(user.email).toLowerCase())) return { name: user.name || user.email, email: user.email, user };
    const sid = cookieOf(req, SETUP_COOKIE);
    if (setupNeeded && sid && setupSessions.has(sid)) return { name: 'setup', setup: true };
    return null;
  };

  const isAdminUser = (user) => !!(user && user.email && admins.includes(String(user.email).toLowerCase()));

  const html = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'", ...headers });
    res.end(body);
  };
  const redirect = (res, location, headers = {}) => {
    res.writeHead(303, { location, 'cache-control': 'no-store', ...headers });
    res.end();
  };
  /** Same-site posts only: the configured address, or (during setup) the address in use. */
  const sameSite = (req, who) => {
    const origin = req.headers.origin;
    if (!origin) return false;
    if (origin === publicUrl) return true;
    if (who.setup || who.local) {
      const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
      return origin === `${proto}://${req.headers.host}`;
    }
    return false;
  };
  /** Saved, then the front restarts: a waiting page that goes back once narado answers again. */
  const savedAndRestart = (res, back) => {
    const wait = `var start=Date.now(),back=${JSON.stringify(back)};function go(){location.href=back;}
setTimeout(function poll(){fetch('/auth/me',{cache:'no-store'}).then(function(r){if(r.status<500)go();else retry();},retry);function retry(){if(Date.now()-start>30000)go();else setTimeout(poll,700);}},900);`;
    html(res, 200, messagePage({ title: 'Saving', heading: 'Applying your changes', text: 'Saved. narado is restarting with the new settings; this page returns to the admin console when it’s back.', loader: true, action: `<noscript><a class="btn secondary" href="${esc(back)}">Continue</a></noscript>`, script: wait }));
    setTimeout(() => restart().catch((err) => log.error('[narado] restart failed:', err)), 200);
  };

  /* ------------------------------------------------------------- Git hosts */

  const hostsFile = path.join(dataDir, 'narado.json');
  const readConfigFile = () => {
    try {
      return JSON.parse(fs.readFileSync(hostsFile, 'utf8'));
    } catch {
      return {};
    }
  };
  const hostList = () => {
    const cfg = readConfigFile();
    return Array.isArray(cfg.hosts) ? cfg.hosts : DEFAULT_HOSTS.map((h) => ({ ...h }));
  };
  const writeHosts = (hosts) => {
    validateHosts(hosts, 'hosts');
    const cfg = readConfigFile();
    cfg.hosts = hosts;
    fs.writeFileSync(hostsFile, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  };
  const webOf = (h) => (h.url ? String(h.url).replace(/\/+$/, '') : h.type === 'github' ? 'https://github.com' : 'https://gitlab.com');
  const githubApiOf = (h) => (h.apiUrl ? h.apiUrl : webOf(h) === 'https://github.com' ? 'https://api.github.com' : `${webOf(h)}/api/v3`);
  const callbackOf = (h) => `${publicUrl}/auth/${encodeURIComponent(h.id)}/callback`;
  const appSet = (h) => {
    const p = envPrefix(h.id);
    return { id: p + 'CLIENT_ID', secret: p + 'CLIENT_SECRET', slug: p + 'SLUG', appId: p + 'ID', key: p + 'PRIVATE_KEY', webhook: p + 'WEBHOOK_SECRET' };
  };

  const logoOf = (h, small = false) => `<div class="logo ${h.type}${small ? ' sm' : ''}">${LOGOS[h.type] || ''}</div>`;
  const keep = (dlg) => `<input type="hidden" name="_dlg" value="${dlg}">`;

  /** A connector card per Git host, and its dialog (connect, install, settings). */
  const hostCard = (h) => {
    const n = appSet(h);
    const configured = !!(env[n.id] && env[n.secret]);
    const fromEnv = settings.source(n.id, realEnv) === 'env';
    const web = webOf(h);
    const hostName = web.replace(/^https?:\/\//, '');
    const id = esc(h.id);
    const dlg = `dlg-${id}`;
    const title = h.name && h.name !== h.id ? h.name : h.type === 'github' ? (hostName === 'github.com' ? 'GitHub' : 'GitHub Enterprise') : hostName === 'gitlab.com' ? 'GitLab' : 'GitLab (self-managed)';
    const isCom = h.type === 'gitlab' && /^https:\/\/gitlab\.com$/i.test(web);
    const installUrl = h.type === 'github' && env[n.slug] ? `${web}/apps/${env[n.slug]}/installations/new` : null;
    const ns = esc((h.exploreNamespaces || []).join(', '));

    let create = '';
    if (!fromEnv && h.type === 'github') {
      create = `<h4>${configured ? 'Create a new GitHub App' : 'Create narado’s GitHub App'}</h4>
<p class="note">GitHub asks you to confirm, then sends narado its credentials. Permissions: contents and pull requests (read and write), metadata and email (read).</p>
<form method="post" action="/admin/git/${id}/github-app">${keep(dlg)}
<div class="row"><label class="f"><span>Organisation on ${esc(hostName)} (empty for your own account)</span><input type="text" name="org" placeholder="acme"></label>
<label class="f"><span>App name</span><input type="text" name="name" value="${esc(`narado (${new URL(publicUrl).host})`)}"></label></div>
<div class="dlg-actions"><button type="submit" class="btn">${configured ? 'Create a new app on GitHub' : 'Continue on GitHub'}</button></div></form>`;
    } else if (!fromEnv && h.type === 'gitlab') {
      create = isCom
        ? `<h4>Create the application on GitLab.com</h4><p class="note">GitLab.com can't create applications through its API, so create one by hand: open <a href="https://gitlab.com/-/user_settings/applications" target="_blank" rel="noopener">your applications</a> (or a group's <em>Settings → Applications</em>), name it narado, set the redirect URI to <code>${esc(callbackOf(h))}</code>, tick <em>Confidential</em> and the scopes <code>api</code> and <code>read_user</code>, then paste its ID and secret below.</p>`
        : `<h4>Create narado’s application</h4><form method="post" action="/admin/git/${id}/gitlab-app">${keep(dlg)}
<label class="f"><span>Administrator access token for ${esc(hostName)} (scope api; used once, not kept)</span><input type="password" name="token" autocomplete="off"></label>
<p class="note">Creates an instance-wide OAuth application named narado with redirect URI <code>${esc(callbackOf(h))}</code>.</p>
<div class="dlg-actions"><button type="submit" class="btn">Create the GitLab application</button></div></form>`;
    }
    const manual = fromEnv
      ? `<div class="alert info">${ICON.lock}<div>This app is set in the server environment (<code>${esc(n.id)}</code>), so it's managed there.</div></div>`
      : `<h4>${isCom ? 'Application ID and secret' : 'Or enter app credentials by hand'}</h4>
<form method="post" action="/admin/git/${id}/manual">${keep(dlg)}
<div class="row">${field({ name: 'clientId', label: 'Client (application) ID', value: env[n.id] })}${field({ name: 'clientSecret', label: 'Client secret', value: env[n.secret], secret: true })}</div>
${h.type === 'github' ? field({ name: 'slug', label: 'App slug (for the install link)', value: env[n.slug] }) : ''}
<label class="f"><span>Callback URL to register</span>${copyField(callbackOf(h))}</label>
<div class="dlg-actions"><button type="submit" class="btn secondary">Save credentials</button></div></form>`;
    const settingsForm = `<h4>Explore APIs</h4><p class="note">Explore lists the API collections and OpenAPI specs in your repositories.</p>
<form method="post" action="/admin/git/${id}/namespaces">${keep(dlg)}<label class="f"><span>Where Explore looks by default</span><input type="text" name="namespaces" value="${ns}" placeholder="acme, acme-platform"><span class="help">Users, organisations or groups, comma-separated. Empty: everything a person can see.</span></label>
<div class="dlg-actions"><button type="submit" class="btn secondary">Save</button>${!['github', 'gitlab'].includes(h.id) ? `<button type="submit" class="btn danger left" formaction="/admin/git/${id}/remove"${confirmAttrs(`Remove ${title}? People can no longer open repositories on ${hostName} through narado.`, { title: `Remove ${title}`, ok: 'Remove' })}>Remove ${esc(title)}</button>` : ''}</div></form>`;

    const status = configured ? '<span class="pill ok">Connected</span>' : '<span class="pill">Not connected</span>';
    const card = `<div class="card conn" data-testid="connector-${id}">
<div class="card-head">${logoOf(h)}<div class="t"><strong>${esc(title)}</strong><span class="sub">${esc(hostName)}</span></div>${status}</div>
<p class="conn-desc">${configured ? `People connect their own ${esc(title)} account and work as themselves.` : `Let people open, review and change API collections in ${esc(title)} repositories, as themselves.`}</p>
<div class="foot"><button type="button" class="btn ${configured ? 'secondary' : ''} sm" onclick="openDlg('${dlg}')">${configured ? 'Manage' : 'Connect'}</button>${installUrl ? `<a class="btn ghost sm" href="${esc(installUrl)}" target="_blank" rel="noopener">Install on repositories${ICON.external}</a>` : ''}${fromEnv ? envBadge(n.id) : ''}</div></div>`;
    const body = `${installUrl ? `<p class="note">Install it on the repositories narado should see: <a href="${esc(installUrl)}" target="_blank" rel="noopener">install ${esc(env[n.slug])}</a>.</p>` : ''}${create}${manual}${settingsForm}`;
    return { card, dialog: dialog(dlg, title, logoOf(h, true), body) };
  };

  /* -------------------------------------------------------- secrets stores */

  /** A store's narado.json entry from a form (keeping what the form doesn't show). */
  const storeFromForm = (type, id, form, prev = {}) => {
    const st = { ...prev, id, type };
    for (const [k, label, , req] of STORE_TYPES[type].fields) {
      const v = String(form.get(k) || '').trim();
      if (req && !v) throw new Error(`${label} is required`);
      if (v) st[k] = v;
      else delete st[k];
    }
    for (const k of ['url', 'vaultUrl', 'endpoint']) {
      if (st[k] && !/^https?:\/\/[^\s]+$/.test(st[k])) throw new Error(`${k === 'endpoint' ? 'The endpoint' : 'The address'} must start with https://`);
      if (st[k]) st[k] = st[k].replace(/\/+$/, '');
    }
    if (type === 'vault') {
      const method = ['jwt', 'approle', 'token'].includes(form.get('authMethod')) ? form.get('authMethod') : 'jwt';
      st.auth = { method };
      if (method === 'jwt') {
        st.auth.role = String(form.get('role') || '').trim() || 'narado';
        const m = String(form.get('authMount') || '').trim();
        if (m) st.auth.mount = m;
      }
    }
    return st;
  };

  /** Credentials from a form, checked; empty fields keep what's there. Saved with saveCreds. */
  const credsFromForm = (st, form) => {
    const values = {};
    for (const [name, label, , kind] of credsOf(st)) {
      const envName = storeEnv(st.id, name);
      if (settings.source(envName, realEnv) === 'env') continue;
      const v = String(form.get(`cred_${name}`) || '').trim();
      if (!v) continue;
      if (kind === 'textarea') {
        let key = null;
        try {
          key = JSON.parse(v);
        } catch {}
        if (!key || !key.client_email || !key.private_key) throw new Error(`${label}: paste the service account's JSON key file`);
      }
      values[envName] = v;
    }
    return values;
  };
  const saveCreds = (values, who) => {
    if (Object.keys(values).length) settings.set(values, who.email || who.name);
  };

  // What each store type needs: settings kept in narado.json, credentials kept encrypted
  // as settings under the names the stores read (secrets/*.js: NARADO_SECRETS_<ID>_<NAME>).
  const STORE_TYPES = {
    vault: {
      name: 'HashiCorp Vault',
      fields: [
        ['url', 'Address', 'https://vault.acme.internal', true],
        ['mount', 'KV v2 mount', 'secret', false],
        ['namespace', 'Namespace (Vault Enterprise, optional)', 'payments', false]
      ]
    },
    aws: { name: 'AWS Secrets Manager', fields: [['region', 'Region', 'ap-south-1', true], ['endpoint', 'Endpoint (optional: VPC endpoint, LocalStack)', '', false]], creds: [['ACCESS_KEY_ID', 'Access key ID', false], ['SECRET_ACCESS_KEY', 'Secret access key', true], ['SESSION_TOKEN', 'Session token (temporary credentials only)', true]] },
    gcp: { name: 'Google Cloud Secret Manager', fields: [['project', 'Project ID', 'acme-payments', true]], creds: [['CREDENTIALS', 'Service account key (JSON)', true, 'textarea']] },
    azure: { name: 'Azure Key Vault', fields: [['vaultUrl', 'Vault URL', 'https://acme.vault.azure.net', true], ['tenant', 'Tenant ID', '', true]], creds: [['CLIENT_ID', 'App (client) ID', false], ['CLIENT_SECRET', 'Client secret', true]] }
  };
  const VAULT_CREDS = { token: [['TOKEN', 'Token', true]], approle: [['ROLE_ID', 'Role ID', false], ['SECRET_ID', 'Secret ID', true]], jwt: [] };
  const credsOf = (st) => (st.type === 'vault' ? VAULT_CREDS[(st.auth && st.auth.method) || 'token'] || [] : STORE_TYPES[st.type].creds);
  const storeEnv = (id, name) => `NARADO_SECRETS_${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_${name}`;

  const readSecretsCfg = () => {
    const cfg = readConfigFile();
    const sec = cfg.secrets || {};
    return { cfg, stores: Array.isArray(sec.stores) ? sec.stores : [], access: Array.isArray(sec.access) ? sec.access : [] };
  };
  /** Write the stores (and rules); narado.json is checked as narado reads it, or left as it was. */
  const writeSecretsCfg = (stores, access) => {
    const before = fs.existsSync(hostsFile) ? fs.readFileSync(hostsFile, 'utf8') : null;
    const cfg = readConfigFile();
    cfg.secrets = { ...(cfg.secrets || {}), stores, access };
    fs.writeFileSync(hostsFile, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    try {
      require('./secrets').loadSecretsConfig(dataDir);
    } catch (err) {
      if (before === null) fs.rmSync(hostsFile, { force: true });
      else fs.writeFileSync(hostsFile, before, { mode: 0o600 });
      throw err;
    }
  };
  const whereOf = (st) => st.url || st.vaultUrl || (st.region ? `region ${st.region}` : '') || (st.project ? `project ${st.project}` : '');
  const storeLogo = (type, small = false) => `<div class="logo ${type}${small ? ' sm' : ''}">${LOGOS[type] || ''}</div>`;

  /** Settings and credentials inputs for a store type (prefix keeps the add dialog's types apart). */
  const storeFields = (type, st = {}, prefix = '') => {
    const t = STORE_TYPES[type];
    const fields = t.fields.map(([k, label, ph, req]) => `<label class="f"><span>${esc(label)}</span><input type="text" name="${prefix}${k}" value="${esc(st[k] || '')}" placeholder="${esc(ph)}"${req && !prefix ? ' required' : ''}></label>`).join('');
    let auth = '';
    if (type === 'vault') {
      const m = (st.auth && st.auth.method) || 'jwt';
      auth = `<label class="f"><span>How narado signs in</span><select name="${prefix}authMethod">
<option value="jwt"${m === 'jwt' ? ' selected' : ''}>As each person (JWT): Vault's policies decide what they can read</option>
<option value="approle"${m === 'approle' ? ' selected' : ''}>As narado (AppRole), with narado's access rules</option>
<option value="token"${m === 'token' ? ' selected' : ''}>As narado (token), with narado's access rules</option></select></label>
<div class="row"><label class="f"><span>JWT role (for "as each person")</span><input type="text" name="${prefix}role" value="${esc((st.auth && st.auth.role) || '')}" placeholder="narado"></label>
<label class="f"><span>JWT auth mount</span><input type="text" name="${prefix}authMount" value="${esc((st.auth && st.auth.mount) || '')}" placeholder="jwt"></label></div>
<p class="note">For "as each person", point Vault's JWT auth method at narado's public key: <code>${esc(publicUrl)}/auth/jwks.json</code>.</p>`;
    }
    return fields + auth;
  };
  const credFields = (id, list) =>
    list
      .map(([name, label, secret, kind]) => {
        const envName = storeEnv(id, name);
        const fromEnv = settings.source(envName, realEnv) === 'env';
        if (kind === 'textarea') {
          return `<label class="f"><span>${esc(label)}${fromEnv ? '<span class="tag">set in the server environment</span>' : ''}</span><textarea class="mono" name="cred_${name}" rows="4" placeholder="${env[envName] ? '•••••••• (kept; paste to replace)' : '{ \"type\": \"service_account\", … }'}"${fromEnv ? ' disabled' : ''}></textarea></label>`;
        }
        return field({ name: `cred_${name}`, label, value: env[envName], source: settings.source(envName, realEnv), secret });
      })
      .join('');

  const storeCard = (st, rules) => {
    const t = STORE_TYPES[st.type] || { name: st.type };
    const id = esc(st.id);
    const dlg = `dlg-store-${id}`;
    const running = secrets && secrets.stores && secrets.stores.get(st.id);
    const configured = running ? running.configured() : false;
    const perPerson = !!(running && running.perPerson);
    const myRules = rules.filter((r) => r.store === st.id || !r.store).length;
    const card = `<div class="card conn" data-testid="store-${id}">
<div class="card-head">${storeLogo(st.type)}<div class="t"><strong>${esc(t.name)}</strong><span class="sub">${esc(st.id)} · ${esc(whereOf(st))}</span></div>
<span class="pill ${configured ? 'ok' : 'warn'}">${configured ? 'Connected' : running ? 'Needs credentials' : 'Restart pending'}</span></div>
<p class="conn-desc">${perPerson ? 'Signs in as each person; the store’s own policies decide what they can read.' : `narado signs in as itself; ${myRules ? `${myRules} access rule${myRules === 1 ? '' : 's'} decide who reads what` : 'nobody can read from it until an access rule allows it'}.`} Requests use <code>secret://${id}/…</code>.</p>
<div class="foot"><button type="button" class="btn secondary sm" onclick="openDlg('${dlg}')">Manage</button>
<form method="post" action="/admin/secrets/${id}/test#secrets" style="display:inline">${keep('')}<button type="submit" class="btn ghost sm">Test connection</button></form></div></div>`;
    const body = `<form method="post" action="/admin/secrets/${id}/save">${keep(dlg)}
<h4>Settings</h4><div class="note">Kept in narado.json on the server.</div>${storeFields(st.type, st)}
${credsOf(st).length ? `<h4>Credentials</h4><p class="note">Kept encrypted on the narado server; never sent to people's browsers or computers.</p>${credFields(st.id, credsOf(st))}` : ''}
<div class="dlg-actions"><button type="submit" class="btn danger left" formaction="/admin/secrets/${id}/remove"${confirmAttrs(`Requests using secret://${st.id}/… stop working, and its access rules are removed too.`, { title: `Remove ${st.id}?`, ok: 'Remove store' })}>Remove</button><button type="submit" class="btn">Save</button></div></form>`;
    return { card, dialog: dialog(dlg, `${t.name} · ${st.id}`, storeLogo(st.type, true), body) };
  };

  /* ---------------------------------------------------------- access rules */

  const listFrom = (text) =>
    String(text || '')
      .split(/[,\n]/)
      .map((x) => x.trim())
      .filter(Boolean);
  const perPersonOf = (st) => {
    const running = secrets && secrets.stores && secrets.stores.get(st.id);
    if (running) return !!running.perPerson;
    return st.type === 'vault' && (!st.auth || st.auth.method === 'jwt');
  };
  const codes = (list) => list.map((x) => `<code>${esc(x)}</code>`).join(', ');
  /** A rule as a sentence. */
  const ruleText = (r) => {
    const who = r.people ? `People matching ${codes(r.people)}` : 'Anyone signed in';
    const what = r.paths ? codes(r.paths) : 'any secret';
    const from = r.store ? `<code>${esc(r.store)}</code>` : 'any store';
    const where = r.repos ? `, from ${codes(r.repos)}` : ', from any repository or none';
    return `${who} may read ${what} from ${from}${where}.`;
  };
  /** A rule from a form; checked. */
  const ruleFromForm = (form, storeIds) => {
    const r = {};
    const store = String(form.get('store') || '');
    if (store) {
      if (!storeIds.includes(store)) throw new Error('Unknown secrets store');
      r.store = store;
    }
    const paths = listFrom(form.get('paths'));
    const repos = listFrom(form.get('repos'));
    const people = listFrom(form.get('people'));
    for (const x of [...paths, ...repos, ...people]) if (/\s/.test(x) || x.length > 200) throw new Error(`"${x}" isn't a valid pattern`);
    for (const x of repos) if (x !== '*' && !/^[\w.*-]+:[^\s:]+$/.test(x)) throw new Error(`Repositories look like github:acme/payments-api (* matches anything): "${x}"`);
    for (const x of people) if (x !== '*' && !/^[^@\s]*@[^@\s]+$|^[\w*-]+$/.test(x)) throw new Error(`People are emails or patterns like *@acme.com: "${x}"`);
    if (paths.length) r.paths = paths;
    if (repos.length) r.repos = repos;
    if (people.length) r.people = people;
    return r;
  };
  const ruleForm = (action, dlg, r, storeIds, extra = '') => `<form method="post" action="${action}">${keep(dlg)}${extra}
<label class="f"><span>Store</span><select name="store"><option value="">Any store</option>${storeIds.map((id) => `<option value="${esc(id)}"${r.store === id ? ' selected' : ''}>${esc(id)}</option>`).join('')}</select></label>
<label class="f"><span>Secrets (paths; * matches anything; empty for any)</span><textarea name="paths" rows="2" placeholder="payments/staging/*">${esc((r.paths || []).join(', '))}</textarea></label>
<label class="f"><span>From repositories (host:owner/repo; empty for any, including none)</span><textarea name="repos" rows="2" placeholder="github:acme/payments-api, gitlab:acme/*">${esc((r.repos || []).join(', '))}</textarea></label>
<label class="f"><span>People (emails or patterns; empty for anyone signed in)</span><textarea name="people" rows="2" placeholder="*@acme.com, alice@acme.com">${esc((r.people || []).join(', '))}</textarea></label>
<div class="dlg-actions"><button type="submit" class="btn">Save rule</button></div></form>`;

  const rulesCard = (stores, access, checked = null) => {
    const ids = stores.map((x) => x.id);
    const items = access
      .map((r, i) => {
        const dlg = `dlg-rule-${i}`;
        const broad = !r.paths && !r.people;
        const was = `<input type="hidden" name="was" value="${esc(JSON.stringify(r))}">`;
        return {
          row: `<div class="li" data-testid="rule-${i}"><div class="grow">${ruleText(r)}${broad ? ' <span class="pill warn" title="Applies to everyone and every secret in its store">Broad</span>' : ''}</div>
<button type="button" class="btn secondary sm" onclick="openDlg('${dlg}')">Edit</button>
<form method="post" action="/admin/secrets/rules/${i}/delete">${was}<button type="submit" class="btn danger sm"${confirmAttrs('Delete this access rule? Reads it allowed are refused from now on.', { title: 'Delete rule', ok: 'Delete' })}>Delete</button></form></div>`,
          dialog: dialog(dlg, 'Edit access rule', '', ruleForm(`/admin/secrets/rules/${i}/save`, dlg, r, ids, was))
        };
      });
    const perPerson = stores.filter(perPersonOf).map((x) => x.id);
    return `<div class="card" style="margin-top:16px" id="rules"><div class="card-head"><div class="t"><strong>Who may read what</strong><span class="sub">For stores narado signs in to as itself. A rule allows a read when everything it names matches.</span></div>
<button type="button" class="btn sm" onclick="openDlg('dlg-add-rule')">${ICON.plus}Add rule</button></div>
${perPerson.length ? `<div class="list"><div class="li note">${codes(perPerson)} sign${perPerson.length === 1 ? 's' : ''} in as each person: the store's own policies decide, and rules naming ${perPerson.length === 1 ? 'it' : 'them'} narrow that further.</div></div>` : ''}
${items.length ? `<div class="list" style="border-top:1px solid var(--line)">${items.map((x) => x.row).join('')}</div>` : emptyState({ icon: 'secrets', title: 'No access rules yet', text: 'Nobody can read from stores narado signs in to as itself until a rule allows it.', compact: true })}
<div class="foot" style="display:block"><strong style="display:block;margin-bottom:10px;font-size:13px">Check access</strong>
<form method="post" action="/admin/secrets/check#rules">${keep('')}<div class="row">
<label class="f"><span>Person (email)</span><input type="text" name="person" placeholder="alice@acme.com" value="${esc(checked ? checked.person : '')}" required></label>
<label class="f"><span>Store</span><select name="store">${ids.map((id) => `<option value="${esc(id)}"${checked && checked.store === id ? ' selected' : ''}>${esc(id)}</option>`).join('')}</select></label>
<label class="f"><span>Secret path</span><input type="text" name="path" placeholder="payments/staging/stripe" value="${esc(checked ? checked.path : '')}" required></label>
<label class="f"><span>Repository (optional)</span><input type="text" name="repo" placeholder="github:acme/payments-api" value="${esc(checked ? checked.repo : '')}"></label></div>
<button type="submit" class="btn secondary sm">Check access</button></form>
${checked ? `<div class="alert ${checked.ok ? 'ok' : 'err'}" role="status" style="margin:12px 0 0">${checked.ok ? ICON.check : ICON.alert}<div data-testid="check-result">${esc(checked.text)}</div></div>` : ''}</div></div>
${items.map((x) => x.dialog).join('')}${dialog('dlg-add-rule', 'Add an access rule', '', ruleForm('/admin/secrets/rules/add', 'dlg-add-rule', {}, ids))}`;
  };

  const addStoreDialog = () =>
    dialog(
      'dlg-add-store',
      'Add a secrets store',
      '',
      `<form method="post" action="/admin/secrets/add" id="add-store">${keep('dlg-add-store')}
<div class="types">${Object.entries(STORE_TYPES)
        .map(([k, t], i) => `<label class="choice"><input type="radio" name="type" value="${k}"${i === 0 ? ' checked' : ''}>${storeLogo(k)}<span>${esc(t.name)}</span></label>`)
        .join('')}</div>
<label class="f"><span>ID (used in references: secret://<em>id</em>/path)</span><input type="text" name="id" placeholder="vault" pattern="[A-Za-z0-9_-]+" required></label>
${Object.keys(STORE_TYPES)
        .map((k) => `<fieldset data-type="${k}"${k === 'vault' ? '' : ' hidden disabled'}>${storeFields(k, {}, '')}${k === 'vault' ? '<p class="note">For AppRole or a token, add the credentials under Manage once it\'s created.</p>' : `<h4>Credentials</h4>${STORE_TYPES[k].creds.map(([name, label, secret, kind]) => (kind === 'textarea' ? `<label class="f"><span>${esc(label)}</span><textarea class="mono" name="cred_${name}" rows="4"></textarea></label>` : `<label class="f"><span>${esc(label)}</span><input type="${secret ? 'password' : 'text'}" name="cred_${name}" autocomplete="off"></label>`)).join('')}`}</fieldset>`)
        .join('')}
<div class="dlg-actions"><button type="submit" class="btn">Add store</button></div></form>`
    );

  /* ------------------------------------------------------------------ page */

  const secretsSection = (checked = null) => {
    const { stores, access } = readSecretsCfg();
    const cards = stores.map((st) => storeCard(st, access));
    const add = `<button type="button" class="btn${stores.length ? ' secondary' : ''}" onclick="openDlg('dlg-add-store')">${ICON.plus}Add store</button>`;
    return `<section id="secrets">${sectionHead('Secrets stores', 'Where requests get <code>secret://</code> values from, just before they’re sent. Values and store credentials stay on the narado server.', stores.length ? add : '')}
${stores.length ? `<div class="grid">${cards.map((x) => x.card).join('\n')}</div>` : `<div class="card">${emptyState({ icon: 'secrets', title: 'No secrets stores yet', text: 'Connect HashiCorp Vault, AWS Secrets Manager, Google Cloud Secret Manager or Azure Key Vault, so requests can use secrets without anyone copying them.', action: add })}</div>`}
${cards.map((x) => x.dialog).join('\n')}${addStoreDialog()}${stores.length ? rulesCard(stores, access, checked) : ''}</section>`;
  };

  /** What <data dir>/desktop-updates/ offers, per system. */
  const desktopUpdates = () =>
    ['mac', 'win', 'linux']
      .map((platform) => {
        try {
          return { platform, m: JSON.parse(fs.readFileSync(path.join(dataDir, 'desktop-updates', platform, 'latest.json'), 'utf8')) };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  const desktopUpdatesList = () => {
    const rows = desktopUpdates();
    return rows.length
      ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>System</th><th>Version</th><th>Files</th><th>Published</th></tr></thead><tbody>${rows
          .map(({ platform, m }) => `<tr><td>${{ mac: 'macOS', win: 'Windows', linux: 'Linux' }[platform]}</td><td class="mono">${esc(m.version)}</td><td class="sub">${esc((m.files || []).map((f) => `${f.arch} ${f.kind}`).join(', '))}</td><td class="sub">${m.publishedAt ? esc(when(Date.parse(m.publishedAt))) : '—'}</td></tr>`)
          .join('')}</tbody></table></div>`
      : emptyState({ icon: 'desktop', title: 'No installers on this server yet', text: 'Download <code>narado-desktop-updates-&lt;version&gt;.zip</code> from narado’s release and unzip it into narado’s data folder. Signed-in copies of narado desktop then offer the update.', compact: true });
  };

  /** Problems an admin should look at, as { text, href }. */
  const attentionOf = ({ oidcOn, hosts, stores }) => {
    const out = [];
    if (!localOnly && !oidcOn) out.push({ text: 'Sign-in isn’t set up, so nobody else can use narado.', href: '#signin' });
    if (!hosts.some((h) => h.configured)) out.push({ text: 'No Git connector is set up: people can’t open repositories yet.', href: '#connectors' });
    for (const st of stores) {
      const running = secrets && secrets.stores && secrets.stores.get(st.id);
      if (running && !running.configured()) out.push({ text: `The ${st.id} secrets store needs credentials.`, href: '#secrets' });
    }
    if (/^http:\/\//.test(publicUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(publicUrl)) out.push({ text: 'narado is served over plain HTTP. Put it behind HTTPS before your team uses it.', href: '#signin' });
    return out;
  };

  const adminPage = (who, notice) => {
    const v = (name) => env[name];
    const src = (name) => settings.source(name, realEnv);
    const oidcOn = !!env.NARADO_OIDC_ISSUER;
    const devices = desktop && auth.enabled ? desktop.adminDevices() : [];
    const hostsRaw = hostList();
    const hosts = hostsRaw.map(hostCard);
    const hostState = hostsRaw.map((h) => {
      const n = appSet(h);
      return { id: h.id, configured: !!(env[n.id] && env[n.secret]) };
    });
    const { stores } = readSecretsCfg();
    const adminList = adminsFrom(env);
    const attention = attentionOf({ oidcOn, hosts: hostState, stores });
    const host = (() => {
      try {
        return new URL(publicUrl).host;
      } catch {
        return '';
      }
    })();

    // First-time setup: three steps, the first two required.
    const steps = who.setup
      ? `<section id="setup">${sectionHead('Set up narado', 'Two steps make narado ready for your team; Git can follow. When both are done, sign in as an admin to finish: this setup link then stops working.')}
<div class="card"><ol class="steps">
<li class="${oidcOn ? 'done' : 'now'}"><span class="n">${oidcOn ? ICON.check : '1'}</span><div class="t"><strong>Sign-in</strong><span>Your organisation’s single sign-on (OpenID Connect).</span></div>${oidcOn ? '<span class="pill ok">Done</span>' : '<a class="btn sm" href="#signin">Set up</a>'}</li>
<li class="${adminList.length ? 'done' : oidcOn ? 'now' : ''}"><span class="n">${adminList.length ? ICON.check : '2'}</span><div class="t"><strong>Admins</strong><span>Who manages narado. Include your own email.</span></div>${adminList.length ? '<span class="pill ok">Done</span>' : '<a class="btn sm secondary" href="#admins">Add admins</a>'}</li>
<li class="${hostState.some((h) => h.configured) ? 'done' : ''}"><span class="n">${hostState.some((h) => h.configured) ? ICON.check : '3'}</span><div class="t"><strong>Git (optional now)</strong><span>Connect GitHub or GitLab so people can open repositories.</span></div>${hostState.some((h) => h.configured) ? '<span class="pill ok">Done</span>' : '<a class="btn sm secondary" href="#connectors">Connect</a>'}</li>
</ol>${oidcOn && adminList.length ? `<div class="foot"><span class="hint">Sign-in and admins are ready.</span><a class="btn" href="/auth/login?return=/admin">Sign in as an admin to finish${ICON.arrow}</a></div>` : ''}</div></section>`
      : '';
    const error = notice && notice.error ? `<div class="alert err" role="alert">${ICON.alert}<div>${esc(notice.text)}</div></div>` : '';
    const info = notice && !notice.error && !notice.checked && notice.inline ? `<div class="alert ok" role="status">${ICON.check}<div>${esc(notice.text)}</div></div>` : '';
    const toast = notice && !notice.error && !notice.checked && !notice.inline ? notice.text : '';

    const overview = who.setup
      ? ''
      : `<section id="overview"><h2 class="sr">Overview</h2>
<div class="tiles">
<a class="card tile" href="#signin"><span class="k">${ICON.signin}Sign-in</span><div class="v">${oidcOn ? esc(v('NARADO_OIDC_PROVIDER_NAME') || 'Single sign-on') : 'Off'}</div><span class="pill ${oidcOn ? 'ok' : 'warn'}">${oidcOn ? 'On' : 'Not set up'}</span></a>
<a class="card tile" href="#admins"><span class="k">${ICON.admins}Admins</span><div class="v">${adminList.length}</div><span class="s">${adminList.length === 1 ? 'person' : 'people'}</span></a>
<a class="card tile" href="#connectors"><span class="k">${ICON.connectors}Git connectors</span><div class="v">${hostState.filter((h) => h.configured).length} of ${hostState.length}</div><span class="pill ${hostState.some((h) => h.configured) ? 'ok' : 'warn'}">${hostState.some((h) => h.configured) ? 'Connected' : 'Not set up'}</span></a>
<a class="card tile" href="#secrets"><span class="k">${ICON.secrets}Secrets stores</span><div class="v">${stores.length}</div><span class="s">${stores.length === 1 ? 'store connected' : 'stores connected'}</span></a>
${auth.enabled ? `<a class="card tile" href="#computers"><span class="k">${ICON.computers}Desktops</span><div class="v">${devices.length}</div><span class="s">signed in</span></a>` : ''}
</div>
${attention.length ? `<div class="card attention" data-testid="attention">${attention.map((x) => `<div class="row-a">${ICON.alert}<span class="grow">${esc(x.text)}</span><a class="btn ghost sm" href="${x.href}">Review</a></div>`).join('')}</div>` : ''}</section>`;

    // Sign-in: what the server environment sets is shown read-only; the rest can be edited.
    const signinNames = ['NARADO_PUBLIC_URL', 'NARADO_OIDC_ISSUER', 'NARADO_OIDC_PROVIDER_NAME', 'NARADO_OIDC_CLIENT_ID', 'NARADO_OIDC_CLIENT_SECRET', 'NARADO_ALLOWED_EMAIL_DOMAINS'];
    const signinEditable = signinNames.some((n) => src(n) !== 'env');
    const signinFromEnv = signinNames.filter((n) => src(n) === 'env');
    const signin = `<section id="signin">${sectionHead('Sign-in', 'Your organisation’s single sign-on (OpenID Connect). Register narado with your identity provider as a confidential web application.')}
<div class="card"><div class="card-head"><div class="t"><strong>${esc(v('NARADO_OIDC_PROVIDER_NAME') || 'Single sign-on')}</strong><span class="sub">${esc(v('NARADO_OIDC_ISSUER') || 'Not configured')}</span></div><span class="pill ${oidcOn ? 'ok' : 'warn'}">${oidcOn ? 'On' : 'Off'}</span></div>
<form method="post" action="/admin/signin"><div class="body">
<label class="f"><span>Redirect URI to register</span>${copyField(`${publicUrl}/auth/callback`)}</label>
${signinFromEnv.length ? `<div style="margin-bottom:${signinEditable ? '16px' : '0'}">${signinNames.filter((n) => src(n) === 'env').map((n) => field({ name: n, label: { NARADO_PUBLIC_URL: 'narado’s address', NARADO_OIDC_ISSUER: 'Issuer URL', NARADO_OIDC_PROVIDER_NAME: 'Shown as', NARADO_OIDC_CLIENT_ID: 'Client ID', NARADO_OIDC_CLIENT_SECRET: 'Client secret', NARADO_ALLOWED_EMAIL_DOMAINS: 'Allowed email domains' }[n], value: n === 'NARADO_PUBLIC_URL' ? v(n) || publicUrl : v(n), source: 'env', secret: n === 'NARADO_OIDC_CLIENT_SECRET' })).join('')}</div>` : ''}
${src('NARADO_PUBLIC_URL') !== 'env' ? field({ name: 'NARADO_PUBLIC_URL', label: 'narado’s address', value: v('NARADO_PUBLIC_URL') || publicUrl, placeholder: 'https://narado.example.com', help: 'The address people open narado at.' }) : ''}
<div class="row">${src('NARADO_OIDC_ISSUER') !== 'env' ? field({ name: 'NARADO_OIDC_ISSUER', label: 'Issuer URL', value: v('NARADO_OIDC_ISSUER'), placeholder: 'https://login.example.com/realms/acme' }) : ''}
${src('NARADO_OIDC_PROVIDER_NAME') !== 'env' ? field({ name: 'NARADO_OIDC_PROVIDER_NAME', label: 'Shown as', value: v('NARADO_OIDC_PROVIDER_NAME'), placeholder: 'Okta, Google, Keycloak…' }) : ''}</div>
<div class="row">${src('NARADO_OIDC_CLIENT_ID') !== 'env' ? field({ name: 'NARADO_OIDC_CLIENT_ID', label: 'Client ID', value: v('NARADO_OIDC_CLIENT_ID') }) : ''}
${src('NARADO_OIDC_CLIENT_SECRET') !== 'env' ? field({ name: 'NARADO_OIDC_CLIENT_SECRET', label: 'Client secret', value: v('NARADO_OIDC_CLIENT_SECRET'), secret: true }) : ''}</div>
${src('NARADO_ALLOWED_EMAIL_DOMAINS') !== 'env' ? field({ name: 'NARADO_ALLOWED_EMAIL_DOMAINS', label: 'Allowed email domains', value: v('NARADO_ALLOWED_EMAIL_DOMAINS'), placeholder: 'acme.com', help: 'Optional, comma-separated. Only people with these email domains may sign in.' }) : ''}
</div>
${signinEditable ? `<div class="foot"><span class="hint">${signinFromEnv.length ? 'Values marked Environment are set in the server environment. ' : ''}narado checks the issuer before saving, then restarts.</span><button type="submit" class="btn">Save sign-in</button></div>` : `<div class="foot"><span class="hint">${ICON.lock} These settings are set in the server environment; change them there and restart narado.</span></div>`}
</form></div></section>`;

    // Admins: a list, with add and remove (nobody removes themselves).
    const adminsFromEnv = src('NARADO_ADMINS') === 'env';
    const me = String(who.email || '').toLowerCase();
    const admins = `<section id="admins">${sectionHead('Admins', 'People who can use the admin console, by the email they sign in with.')}
<div class="card">${adminList.length ? `<div class="list">${adminList
      .map((email) => `<div class="li" data-testid="admin-row"><span class="av">${esc(initials(email))}</span><div class="grow"><div>${esc(email)}${email === me ? ' <span class="chip">You</span>' : ''}</div></div>${
        adminsFromEnv
          ? ''
          : `<form method="post" action="/admin/admins/remove"><input type="hidden" name="email" value="${esc(email)}"><button type="submit" class="btn ghost sm"${email === me || adminList.length === 1 ? ' disabled title="You can’t remove yourself or the last admin"' : confirmAttrs(`${email} can no longer use the admin console.`, { title: 'Remove admin?', ok: 'Remove' })}>Remove</button></form>`
      }</div>`)
      .join('')}</div>` : emptyState({ icon: 'admins', title: 'No admins yet', text: 'Add the people who manage narado, starting with yourself.', compact: true })}
${adminsFromEnv ? `<div class="foot"><span class="hint">${ICON.lock} Admins are set in the server environment (<code>NARADO_ADMINS</code>); change them there and restart narado.</span></div>` : `<form method="post" action="/admin/admins/add" class="foot"><label class="sr" for="add-admin">Email</label><input id="add-admin" type="email" name="email" placeholder="name@company.com" required style="flex:1;min-width:200px"><button type="submit" class="btn">${ICON.plus}Add admin</button></form>`}
</div></section>`;

    const addDlg = dialog(
      'dlg-add',
      'Add a connector',
      '',
      `<p class="note">For GitHub Enterprise or a self-managed GitLab. GitHub.com and GitLab.com are always listed.</p>
<form method="post" action="/admin/git/add">${keep('dlg-add')}<div class="row">
<label class="f"><span>Type</span><select name="type"><option value="gitlab">GitLab (self-managed)</option><option value="github">GitHub Enterprise</option></select></label>
<label class="f"><span>Address</span><input type="url" name="url" placeholder="https://git.acme.com"></label></div>
<label class="f"><span>ID</span><input type="text" name="id" placeholder="gitlab-acme" pattern="[a-z0-9-]+"><span class="help">Short and unique: lower-case letters, digits and dashes. Used in its settings’ names.</span></label>
<div class="dlg-actions"><button type="submit" class="btn">Add connector</button></div></form>`
    );
    const connectors = `<section id="connectors">${sectionHead('Git connectors', 'narado reaches GitHub and GitLab through an app it creates for you. Each person then connects their own account and works as themselves.', `<button type="button" class="btn secondary" onclick="openDlg('dlg-add')">${ICON.plus}Add connector</button>`)}
<div class="grid">${hosts.map((x) => x.card).join('\n')}</div>
${hosts.map((x) => x.dialog).join('\n')}${addDlg}</section>`;

    const sendFromEnv = src('NARADO_DESKTOP_SEND') === 'env';
    const sendNow = v('NARADO_DESKTOP_SEND') || 'any';
    const sendChoices = [
      ['any', 'Private networks and the repository’s allowlist', 'Local and private addresses, and public hosts the repository allows. The default.'],
      ['private-only', 'Private networks only', 'Local and private addresses; no public hosts.'],
      ['allowlist-only', 'The repository’s allowlist only', 'Only hosts a repository allows, private ones included.']
    ];
    const desktopSec = `<section id="desktop">${sectionHead('Desktop', 'What narado desktop may send requests to from people’s computers. Cloud metadata addresses are always refused.')}
<div class="card"><form method="post" action="/admin/desktop"><div class="body">
<fieldset><legend style="font-size:12.5px;font-weight:600;margin-bottom:8px;display:flex;align-items:center;gap:8px;width:100%">Requests may go to${sendFromEnv ? envBadge('NARADO_DESKTOP_SEND') : ''}</legend><div class="choices">
${sendChoices.map(([val, title, text]) => `<label class="choice"><input type="radio" name="NARADO_DESKTOP_SEND" value="${val}"${sendNow === val ? ' checked' : ''}${sendFromEnv ? ' disabled' : ''}><div><strong>${esc(title)}</strong><span>${esc(text)}</span></div></label>`).join('')}
</div></fieldset>
<div style="margin-top:16px">${field({ name: 'NARADO_DESKTOP_MIN_VERSION', label: 'Oldest supported version', value: v('NARADO_DESKTOP_MIN_VERSION'), source: src('NARADO_DESKTOP_MIN_VERSION'), placeholder: '0.1.0', help: 'Older copies of narado desktop are asked to update before they continue.' })}</div>
</div>${sendFromEnv && src('NARADO_DESKTOP_MIN_VERSION') === 'env' ? '' : '<div class="foot"><span class="hint">Applies to every signed-in desktop at its next contact.</span><button type="submit" class="btn">Save</button></div>'}</form></div>
<div class="card" style="margin-top:16px"><div class="card-head"><div class="t"><strong>Installers on this server</strong><span class="sub">What signed-in desktops are offered as an update.</span></div></div>${desktopUpdatesList()}</div></section>`;

    const computers = auth.enabled
      ? `<section id="computers">${sectionHead('Signed-in computers', 'Everyone’s computers using narado desktop. Signing one out stops it at its next contact with narado.')}
<div class="card">${
          devices.length
            ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Computer</th><th>Person</th><th>System</th><th>Last used</th><th class="r"><span class="sr">Actions</span></th></tr></thead><tbody>${devices
                .map(
                  (d) => `<tr><td><strong>${esc(d.name)}</strong></td><td>${esc(d.userName || d.userEmail || '?')}${d.userName && d.userEmail ? `<div class="sub">${esc(d.userEmail)}</div>` : ''}</td><td>${esc(PLATFORMS[d.platform] || d.platform || '?')}</td><td class="sub">${esc(when(d.lastSeenAt))}</td>
<td class="r"><form method="post" action="/admin/devices/${esc(d.id)}/revoke"><button class="btn danger sm" type="submit"${confirmAttrs(`${d.name} stops working with narado at its next contact. Its owner can sign in again.`, { title: `Sign out ${d.name}?`, ok: 'Sign out' })}>Sign out</button></form></td></tr>`
                )
                .join('')}</tbody></table></div>`
            : emptyState({ icon: 'computers', title: 'No computers are signed in', text: 'When people sign in to narado desktop, their computers show here.', compact: true })
        }</div></section>`
      : '';

    const local = localOnly ? `<div class="alert info">${ICON.info}<div>Single-user local mode: no sign-in, listening on this computer only. Set up sign-in to let your team use narado.</div></div>` : '';
    const body = `<div class="page-head"><h1>${who.setup ? 'Welcome to narado' : 'Admin console'}</h1><p>${who.setup ? 'Set up sign-in and admins so your team can start.' : 'Manage sign-in, admins, Git, secrets and desktops for your organisation.'}</p></div>
${error}${info}${local}${steps}${overview}${signin}${admins}${connectors}${secretsSection(notice && notice.checked)}${desktopSec}${computers}`;

    const nav = [
      ...(who.setup ? [{ id: 'setup', label: 'Setup', icon: 'overview' }] : [{ id: 'overview', label: 'Overview', icon: 'overview', attention: attention.length ? `${attention.length} to review` : null }]),
      { id: 'signin', label: 'Sign-in', icon: 'signin', attention: !localOnly && !oidcOn ? 'Not set up' : null },
      { id: 'admins', label: 'Admins', icon: 'admins', meta: adminList.length },
      { id: 'connectors', label: 'Git connectors', icon: 'connectors', meta: `${hostState.filter((h) => h.configured).length}/${hostState.length}` },
      { id: 'secrets', label: 'Secrets stores', icon: 'secrets', meta: stores.length },
      { id: 'desktop', label: 'Desktop', icon: 'desktop' },
      ...(auth.enabled ? [{ id: 'computers', label: 'Computers', icon: 'computers', meta: devices.length }] : [])
    ];
    const reopen = notice && notice.open && /^dlg-[a-z0-9-]+$/.test(notice.open) ? `openDlg(${JSON.stringify(notice.open)});` : '';
    // Answers to a form (a test, an error) show at the form's address: put /admin back, so a
    // reload doesn't send the form again. A "saved" note in the address goes too.
    const back = "if(location.pathname!=='/admin'||location.search)history.replaceState(null,'','/admin'+location.hash);";
    return page({ title: who.setup ? 'Setup' : 'Admin', who, host, nav, body, toast, script: back + reopen });
  };

  /* ------------------------------------------------------------- handlers */

  const signin = async (form, who) => {
    const values = {};
    for (const name of ['NARADO_PUBLIC_URL', 'NARADO_OIDC_ISSUER', 'NARADO_OIDC_PROVIDER_NAME', 'NARADO_OIDC_CLIENT_ID', 'NARADO_ALLOWED_EMAIL_DOMAINS']) {
      if (settings.source(name, realEnv) === 'env' || !form.has(name)) continue;
      values[name] = form.get(name).trim();
    }
    const secret = form.get('NARADO_OIDC_CLIENT_SECRET');
    if (secret && settings.source('NARADO_OIDC_CLIENT_SECRET', realEnv) !== 'env') values.NARADO_OIDC_CLIENT_SECRET = secret.trim();
    if (values.NARADO_PUBLIC_URL) {
      const u = new URL(values.NARADO_PUBLIC_URL);
      if (!/^https?:$/.test(u.protocol) || u.pathname !== '/' || u.search) throw new Error("narado's address must be like https://narado.example.com");
      values.NARADO_PUBLIC_URL = `${u.protocol}//${u.host}`;
    }
    const issuer = values.NARADO_OIDC_ISSUER;
    if (issuer) {
      if (!/^https:\/\//.test(issuer) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(issuer + '/')) throw new Error('The issuer must be an https address');
      const res = await fetchImpl(`${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(8000) }).catch(() => null);
      const doc = res && res.ok ? await res.json().catch(() => null) : null;
      if (!doc || !doc.authorization_endpoint) throw new Error(`Couldn't read ${issuer}/.well-known/openid-configuration. Check the issuer URL.`);
      if (!(values.NARADO_OIDC_CLIENT_ID || env.NARADO_OIDC_CLIENT_ID)) throw new Error('A client ID is needed with the issuer');
    }
    settings.set(values, who.email || who.name);
    log.log(`[narado] admin: ${who.name} changed sign-in settings (${Object.keys(values).join(', ') || 'nothing'})`);
  };

  const githubApp = async (h, form, res, who) => {
    const org = (form.get('org') || '').trim();
    if (org && !/^[A-Za-z0-9-]+$/.test(org)) throw new Error('Not an organisation name');
    const name = (form.get('name') || 'narado').trim().slice(0, 34);
    for (const [k, v] of manifestStates) if (Date.now() - v.at > MANIFEST_TTL_MS) manifestStates.delete(k);
    const state = crypto.randomBytes(18).toString('base64url');
    manifestStates.set(state, { hostId: h.id, at: Date.now(), by: who.name });
    const manifest = {
      name,
      url: publicUrl,
      hook_attributes: { url: `${publicUrl}/auth/${h.id}/webhook`, active: false },
      redirect_url: `${publicUrl}/admin/git/${h.id}/github-app-done`,
      callback_urls: [callbackOf(h)],
      public: false,
      default_permissions: { contents: 'write', pull_requests: 'write', metadata: 'read', emails: 'read' },
      default_events: []
    };
    const web = webOf(h);
    const action = `${web}${org ? `/organizations/${encodeURIComponent(org)}` : ''}/settings/apps/new?state=${encodeURIComponent(state)}`;
    html(
      res,
      200,
      messagePage({
        title: 'Admin',
        heading: 'Continuing on GitHub',
        text: `Taking you to ${esc(web.replace(/^https?:\/\//, ''))} to create narado’s app…`,
        loader: true,
        action: `<form id="go" method="post" action="${esc(action)}"><input type="hidden" name="manifest" value="${esc(JSON.stringify(manifest))}"><button type="submit" class="btn">Continue to GitHub</button></form>`,
        script: "document.getElementById('go').submit();"
      })
    );
  };

  const githubAppDone = async (h, url, who) => {
    const state = url.searchParams.get('state');
    const pending = state && manifestStates.get(state);
    manifestStates.delete(state);
    if (!pending || pending.hostId !== h.id || Date.now() - pending.at > MANIFEST_TTL_MS) throw new Error('This GitHub App link has expired. Start again.');
    const code = url.searchParams.get('code');
    if (!code || !/^[A-Za-z0-9_-]+$/.test(code)) throw new Error('GitHub did not send a code');
    const res = await fetchImpl(`${githubApiOf(h)}/app-manifests/${code}/conversions`, { method: 'POST', headers: { accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) });
    const app = await res.json().catch(() => ({}));
    if (!res.ok || !app.client_id) throw new Error(`GitHub didn't create the app (${res.status}${app.message ? `: ${app.message}` : ''})`);
    const n = appSet(h);
    settings.set({ [n.id]: app.client_id, [n.secret]: app.client_secret, [n.slug]: app.slug, [n.appId]: String(app.id), [n.key]: app.pem, [n.webhook]: app.webhook_secret }, who.email || who.name);
    log.log(`[narado] admin: ${who.name} created GitHub App ${app.slug} (id ${app.id}) for ${h.id}${app.owner ? ` owned by ${app.owner.login}` : ''}`);
    return app;
  };

  const gitlabApp = async (h, form, who) => {
    const token = (form.get('token') || '').trim();
    if (!token) throw new Error('Paste an administrator access token');
    const res = await fetchImpl(`${webOf(h)}/api/v4/applications`, {
      method: 'POST',
      headers: { 'private-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'narado', redirect_uri: callbackOf(h), scopes: h.scopes || 'api read_user', confidential: true }),
      signal: AbortSignal.timeout(15000)
    }).catch(() => null);
    if (!res) throw new Error(`Couldn't reach ${webOf(h)}`);
    const app = await res.json().catch(() => ({}));
    if (res.status === 401 || res.status === 403) throw new Error('That token may not create applications: it needs an administrator of this GitLab, with the api scope. Or create the application by hand.');
    if (!res.ok || !app.application_id) throw new Error(`GitLab didn't create the application (${res.status}${app.message ? `: ${JSON.stringify(app.message)}` : ''})`);
    const n = appSet(h);
    settings.set({ [n.id]: app.application_id, [n.secret]: app.secret }, who.email || who.name);
    log.log(`[narado] admin: ${who.name} created a GitLab application for ${h.id} (${webOf(h)}); the token used wasn't kept`);
  };

  const handle = async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (p !== '/setup' && p !== '/admin' && !p.startsWith('/admin/')) return false;

    // The setup link from the log: a setup session for this browser, without the token in the address.
    if (p === '/setup') {
      if (!setupNeeded) return redirect(res, '/admin'), true;
      if (!settings.checkSetupToken(url.searchParams.get('token'))) {
        return html(res, 403, messagePage({ title: 'Setup', heading: 'This setup link isn’t valid', text: 'Use the latest link from narado’s log: a new one is printed each time narado starts.' })), true;
      }
      const sid = crypto.randomBytes(24).toString('base64url');
      setupSessions.add(sid);
      log.log('[narado] setup link opened');
      return redirect(res, '/admin', { 'set-cookie': `${SETUP_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax${publicUrl.startsWith('https://') ? '; Secure' : ''}; Max-Age=86400` }), true;
    }

    const who = adminFor(req);
    if (!who) {
      if (auth.enabled && !auth.userFor(req)) return redirect(res, `/auth/login?return=${encodeURIComponent(p)}`), true;
      return html(res, 403, messagePage({ title: 'Admin', heading: 'Admins only', text: 'Only narado admins can open the admin console. Ask an admin to add your email.', action: '<a class="btn secondary" href="/">Back to narado</a>' })), true;
    }
    // An admin signed in with SSO: setup is over.
    if (who.user) {
      settings.endSetup();
      setupSessions.clear();
    }

    let openDialog = null;
    try {
      if (p === '/admin' && req.method === 'GET') {
        const saved = url.searchParams.get('saved');
        const notice = saved ? { text: { signin: 'Sign-in saved.', admins: 'Admins saved.', git: 'Git settings saved.', desktop: 'Desktop settings saved.', device: 'Computer signed out.', secrets: 'Secrets store saved.', rules: 'Access rules saved.' }[saved] || 'Saved.' } : null;
        return html(res, 200, adminPage(who, notice)), true;
      }
      const done = /^\/admin\/git\/([a-z0-9-]+)\/github-app-done$/.exec(p);
      if (done && req.method === 'GET') {
        const h = hostList().find((x) => x.id === done[1]);
        if (!h) throw new Error('Unknown host');
        await githubAppDone(h, url, who);
        return savedAndRestart(res, '/admin?saved=git'), true;
      }

      if (req.method !== 'POST') return html(res, 405, messagePage({ title: 'Admin', heading: 'Not allowed', text: 'That isn’t something this page does.', action: '<a class="btn secondary" href="/admin">Admin console</a>' })), true;
      if (!sameSite(req, who)) return html(res, 403, messagePage({ title: 'Admin', heading: 'Request refused', text: 'Cross-site request refused: changes can only be made from narado’s own admin console.', action: '<a class="btn secondary" href="/admin">Admin console</a>' })), true;
      const form = await readForm(req);
      openDialog = form.get('_dlg');

      if (p === '/admin/signin') return await signin(form, who), savedAndRestart(res, '/admin?saved=signin'), true;
      if (p === '/admin/admins' || p === '/admin/admins/add' || p === '/admin/admins/remove') {
        if (settings.source('NARADO_ADMINS', realEnv) === 'env') throw new Error('Admins are set in the server environment');
        const now = adminsFrom(env);
        const email = String(form.get('email') || '').trim().toLowerCase();
        const list =
          p === '/admin/admins/add'
            ? [...new Set([...now, email])]
            : p === '/admin/admins/remove'
              ? now.filter((x) => x !== email)
              : String(form.get('NARADO_ADMINS') || '')
                  .split(/[,\s]+/)
                  .map((x) => x.trim().toLowerCase())
                  .filter(Boolean);
        if (list.some((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))) throw new Error(p === '/admin/admins' ? 'Enter email addresses, separated by commas' : `“${email}” isn’t an email address`);
        if (!list.length) throw new Error('Name at least one admin');
        if (who.email && !list.includes(String(who.email).toLowerCase())) throw new Error("You can't remove yourself; ask another admin");
        settings.set({ NARADO_ADMINS: list.join(',') }, who.email || who.name);
        log.log(`[narado] admin: ${who.name} set the admins (${list.length})`);
        return savedAndRestart(res, '/admin?saved=admins#admins'), true;
      }
      if (p === '/admin/desktop') {
        const value = form.get('NARADO_DESKTOP_SEND');
        if (!['any', 'private-only', 'allowlist-only'].includes(value)) throw new Error('Unknown setting');
        const minimum = String(form.get('NARADO_DESKTOP_MIN_VERSION') || '').trim();
        if (minimum && !/^\d+\.\d+\.\d+$/.test(minimum)) throw new Error('The oldest version looks like 0.1.0');
        const values = { NARADO_DESKTOP_SEND: value === 'any' ? null : value };
        if (settings.source('NARADO_DESKTOP_MIN_VERSION', realEnv) !== 'env') values.NARADO_DESKTOP_MIN_VERSION = minimum || null;
        settings.set(values, who.email || who.name);
        log.log(`[narado] admin: ${who.name} set desktop sends to ${value}`);
        return savedAndRestart(res, '/admin?saved=desktop'), true;
      }
      if (p === '/admin/secrets/add') {
        const type = form.get('type');
        const id = String(form.get('id') || '').trim();
        if (!STORE_TYPES[type]) throw new Error('Choose a type of store');
        if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) throw new Error('The ID can use letters, digits, - and _');
        const { stores, access } = readSecretsCfg();
        if (stores.some((x) => x.id === id)) throw new Error(`There's already a store called ${id}`);
        const st = storeFromForm(type, id, form);
        const creds = credsFromForm(st, form); // checked before anything is saved
        writeSecretsCfg([...stores, st], access);
        saveCreds(creds, who);
        log.log(`[narado] admin: ${who.name} added secrets store ${id} (${type})`);
        return savedAndRestart(res, '/admin?saved=secrets#secrets'), true;
      }
      if (p === '/admin/secrets/rules/add') {
        const { stores, access } = readSecretsCfg();
        const r = ruleFromForm(form, stores.map((x) => x.id));
        writeSecretsCfg(stores, [...access, r]);
        log.log(`[narado] admin: ${who.name} added a secrets access rule: ${JSON.stringify(r)}`);
        return savedAndRestart(res, '/admin?saved=rules#rules'), true;
      }
      const rm = /^\/admin\/secrets\/rules\/(\d+)\/(save|delete)$/.exec(p);
      if (rm) {
        const { stores, access } = readSecretsCfg();
        const i = Number(rm[1]);
        // The rule must still be the one the page showed (someone may have changed them since).
        if (!access[i] || JSON.stringify(access[i]) !== form.get('was')) throw new Error('The rules changed since this page was loaded; reload and try again');
        if (rm[2] === 'delete') {
          log.log(`[narado] admin: ${who.name} deleted a secrets access rule: ${JSON.stringify(access[i])}`);
          writeSecretsCfg(stores, access.filter((_, j) => j !== i));
        } else {
          const r = ruleFromForm(form, stores.map((x) => x.id));
          log.log(`[narado] admin: ${who.name} changed a secrets access rule: ${JSON.stringify(access[i])} -> ${JSON.stringify(r)}`);
          writeSecretsCfg(stores, access.map((x, j) => (j === i ? r : x)));
        }
        return savedAndRestart(res, '/admin?saved=rules#rules'), true;
      }
      if (p === '/admin/secrets/check') {
        const { stores, access } = readSecretsCfg();
        const st = stores.find((x) => x.id === form.get('store'));
        if (!st) throw new Error('Choose a store');
        const email = String(form.get('person') || '').trim().toLowerCase();
        const secretPath = String(form.get('path') || '').trim().replace(/^\/+/, '');
        const repo = String(form.get('repo') || '').trim() || null;
        if (!email || !secretPath) throw new Error('Enter a person and a secret path');
        const { accessMatch } = require('./secrets');
        const i = accessMatch({ access, storeId: st.id, perPerson: perPersonOf(st), user: { id: email, email }, secretPath, repo });
        const ask = `${email} reading ${secretPath} from ${st.id}${repo ? ` in ${repo}` : ' outside a repository'}`;
        const text =
          i === -2
            ? `${ask}: left to ${st.id}'s own policies for that person (no rule narrows it).`
            : i >= 0
              ? `${ask}: allowed, by rule ${i + 1}: ${ruleText(access[i]).replace(/<[^>]+>/g, '')}`
              : `${ask}: not allowed; no rule matches.`;
        return html(res, 200, adminPage(who, { checked: { text, ok: i !== -1, person: email, store: st.id, path: secretPath, repo: repo || '' } })), true;
      }
      const sm = /^\/admin\/secrets\/([A-Za-z0-9_-]+)\/(save|remove|test)$/.exec(p);
      if (sm) {
        const { stores, access } = readSecretsCfg();
        const st = stores.find((x) => x.id === sm[1]);
        if (!st) throw new Error('Unknown secrets store');
        if (sm[2] === 'save') {
          const next = storeFromForm(st.type, st.id, form, st);
          const creds = credsFromForm(next, form);
          writeSecretsCfg(stores.map((x) => (x.id === st.id ? next : x)), access);
          saveCreds(creds, who);
          log.log(`[narado] admin: ${who.name} changed secrets store ${st.id}`);
          return savedAndRestart(res, '/admin?saved=secrets#secrets'), true;
        }
        if (sm[2] === 'remove') {
          writeSecretsCfg(stores.filter((x) => x.id !== st.id), access.filter((r) => r.store !== st.id));
          const names = {};
          for (const [name] of [...(STORE_TYPES[st.type].creds || []), ...Object.values(VAULT_CREDS).flat()]) names[storeEnv(st.id, name)] = null;
          settings.set(names, who.email || who.name);
          log.log(`[narado] admin: ${who.name} removed secrets store ${st.id} and its access rules`);
          return savedAndRestart(res, '/admin?saved=secrets#secrets'), true;
        }
        // Test: list the top level as the store sees narado (or the admin, for per-person
        // stores). Only a count is shown: no names, no values.
        const store = secrets && secrets.stores && secrets.stores.get(st.id);
        if (!store) throw new Error(`narado hasn't loaded ${st.id} yet; save it, then test`);
        if (store.perPerson && !(who.user && who.user.id)) throw new Error(`${st.id} signs in as each person: sign in with SSO as an admin to test it`);
        try {
          const entries = await Promise.race([store.list('', { user: who.user || null }), new Promise((_, rej) => setTimeout(() => rej(new Error('No answer in 10 seconds')), 10000))]);
          log.log(`[narado] admin: ${who.name} tested secrets store ${st.id}: ok`);
          return html(res, 200, adminPage(who, { inline: true, text: `${st.id} answered: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} at the top level${store.perPerson ? ` (as ${who.name})` : ''}.` }) + ''), true;
        } catch (err) {
          log.warn(`[narado] admin: ${who.name} tested secrets store ${st.id}: ${err.message}`);
          throw new Error(`${st.id} didn't answer: ${err.message}`);
        }
      }
      const dev = /^\/admin\/devices\/([\w-]+)\/revoke$/.exec(p);
      if (dev) {
        desktop.adminRevoke(dev[1], who.name);
        return redirect(res, '/admin?saved=device#computers'), true;
      }
      if (p === '/admin/git/add') {
        const id = String(form.get('id') || '').trim();
        const type = form.get('type');
        const u = String(form.get('url') || '').trim().replace(/\/+$/, '');
        if (!/^[a-z0-9-]{2,30}$/.test(id)) throw new Error('The ID must be 2–30 lower-case letters, digits or dashes');
        if (!/^https:\/\/[^/\s]+$/.test(u)) throw new Error('The address must be https://host');
        const hosts = hostList();
        if (hosts.some((x) => x.id === id)) throw new Error(`There's already a host ${id}`);
        writeHosts([...hosts, { id, type, url: u, name: new URL(u).host }]);
        log.log(`[narado] admin: ${who.name} added Git host ${id} (${u})`);
        return savedAndRestart(res, '/admin?saved=git'), true;
      }
      const g = /^\/admin\/git\/([a-z0-9-]+)\/(github-app|gitlab-app|manual|namespaces|remove)$/.exec(p);
      if (g) {
        const hosts = hostList();
        const h = hosts.find((x) => x.id === g[1]);
        if (!h) throw new Error('Unknown host');
        const n = appSet(h);
        if (['github-app', 'gitlab-app', 'manual'].includes(g[2]) && settings.source(n.id, realEnv) === 'env') throw new Error(`${h.id}'s app is set in the server environment`);
        if (g[2] === 'github-app') return await githubApp(h, form, res, who), true;
        if (g[2] === 'gitlab-app') return await gitlabApp(h, form, who), savedAndRestart(res, '/admin?saved=git'), true;
        if (g[2] === 'manual') {
          const values = { [n.id]: String(form.get('clientId') || '').trim() || null };
          if (form.get('clientSecret')) values[n.secret] = form.get('clientSecret').trim();
          if (h.type === 'github') values[n.slug] = String(form.get('slug') || '').trim() || null;
          settings.set(values, who.email || who.name);
          log.log(`[narado] admin: ${who.name} set ${h.id}'s app credentials by hand`);
          return savedAndRestart(res, '/admin?saved=git'), true;
        }
        if (g[2] === 'namespaces') {
          const list = String(form.get('namespaces') || '')
            .split(/[,\s]+/)
            .map((s) => s.trim())
            .filter(Boolean);
          writeHosts(hosts.map((x) => (x.id === h.id ? { ...x, exploreNamespaces: list.length ? list : undefined } : x)));
          return savedAndRestart(res, '/admin?saved=git'), true;
        }
        if (g[2] === 'remove') {
          if (['github', 'gitlab'].includes(h.id)) throw new Error("The built-in hosts can't be removed");
          writeHosts(hosts.filter((x) => x.id !== h.id));
          settings.set({ [n.id]: null, [n.secret]: null, [n.slug]: null }, who.email || who.name);
          log.log(`[narado] admin: ${who.name} removed Git host ${h.id}`);
          return savedAndRestart(res, '/admin?saved=git'), true;
        }
      }
      return html(res, 404, messagePage({ title: 'Admin', heading: 'Not found', text: 'There’s nothing at this address.', action: '<a class="btn secondary" href="/admin">Admin console</a>' })), true;
    } catch (err) {
      log.warn(`[narado] admin: ${err.message}`);
      return html(res, 400, adminPage(who, { text: err.message, error: true, open: openDialog })), true;
    }
  };

  return { handle, setupNeeded, isAdminUser, adminFor };
};

module.exports = { createAdmin, SETUP_COOKIE };
