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
const { adminsFrom } = require('./settings');
const { DEFAULT_HOSTS, validateHosts } = require('./providers');
const { envPrefix } = require('./git-accounts');

const SETUP_COOKIE = 'narado_setup';
const MANIFEST_TTL_MS = 30 * 60 * 1000;
const setupSessions = new Set(); // survive a restart of the front (same process)
const manifestStates = new Map(); // state -> { hostId, at }

const PLATFORMS = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };
const when = (ms) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) : 'never');

const STYLE = `
@font-face{font-family:"Space Grotesk";font-style:normal;font-weight:700;font-display:swap;src:url(/auth/assets/space-grotesk-700.woff2) format("woff2")}
@font-face{font-family:Inter;font-style:normal;font-weight:400;font-display:swap;src:url(/auth/assets/inter-400.woff2) format("woff2")}
@font-face{font-family:Inter;font-style:normal;font-weight:600;font-display:swap;src:url(/auth/assets/inter-600.woff2) format("woff2")}
:root{color-scheme:dark;--bg:#17121F;--card:#211A2B;--line:#342B40;--text:#EDE4D8;--muted:#B5AABB;--accent:#FD6E15;--warn:#FDB55A;--ok:#7BD88F}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
header{display:flex;align-items:center;gap:10px;padding:14px 20px;border-bottom:1px solid var(--line)}
header img{width:22px;height:22px}
header h1{margin:0;font:700 18px "Space Grotesk",ui-sans-serif,sans-serif;color:#FDEED2}
header .who{margin-left:auto;color:var(--muted);font-size:13px}
main{max-width:820px;margin:0 auto;padding:20px 16px 60px}
.banner{border:1px solid var(--line);border-left:3px solid var(--accent);background:var(--card);border-radius:10px;padding:12px 14px;margin-bottom:16px}
.banner.ok{border-left-color:var(--ok)}.banner.err{border-left-color:var(--warn);color:var(--warn)}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin-bottom:16px}
section h2{margin:0 0 4px;font:700 16px "Space Grotesk",ui-sans-serif,sans-serif}
section .lead{margin:0 0 12px;color:var(--muted)}
label{display:block;margin:10px 0 0}
label>span{display:block;font-size:12px;color:var(--muted);margin-bottom:4px}
label span.tag{display:inline-block;margin:0 0 0 6px;padding:0 7px;font-size:10px}
input[type=text],input[type=password],input[type=url],textarea,select{width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--line);background:#17121F;color:var(--text);font:inherit}
input:disabled,textarea:disabled,select:disabled{opacity:.6}
.row{display:flex;gap:10px;flex-wrap:wrap}.row>*{flex:1 1 220px}
.actions{margin-top:14px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
button,.btn{padding:8px 14px;border-radius:8px;border:0;cursor:pointer;font-family:inherit;font-weight:600;font-size:14px;color:#17121F;background:#FB9B1A;text-decoration:none;display:inline-block}
button.secondary,.btn.secondary{background:transparent;color:var(--text);border:1px solid var(--line)}
button.danger{background:transparent;color:var(--warn);border:1px solid var(--line);padding:4px 10px;font-size:13px}
code,.copy{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;background:#17121F;border:1px solid var(--line);border-radius:6px;padding:2px 6px}
.note{font-size:12px;color:var(--muted);margin-top:6px}
.tag{font-size:11px;border:1px solid var(--line);border-radius:999px;padding:1px 8px;color:var(--muted);margin-left:6px}
.tag.ok{color:var(--ok);border-color:#2f5a3a}.tag.warn{color:var(--warn);border-color:#5a4a2f}
.host{border-top:1px solid var(--line);padding-top:12px;margin-top:12px}
.host:first-of-type{border-top:0;margin-top:0;padding-top:0}
details summary{cursor:pointer;color:var(--muted);margin-top:10px}
table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:6px 4px;border-top:1px solid var(--line);font-size:13px}th{color:var(--muted);font-weight:500}
`;

const page = ({ title, who, body }) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · narado</title><link rel="icon" type="image/svg+xml" href="/auth/assets/narado-favicon.svg?v=2"><link rel="alternate icon" href="/auth/assets/favicon.ico?v=2">
<style>${STYLE}</style></head><body>
<header><img src="/auth/assets/narado-favicon.svg" alt=""><h1>narado</h1><span class="tag">${esc(title)}</span>${who ? `<span class="who">${esc(who)}</span>` : ''}</header>
<main>${body}</main></body></html>`;

/** An input for a setting: shows where its value comes from; secrets are never echoed. */
const field = ({ name, label, value, source, secret = false, placeholder = '', note = '', type = 'text' }) => {
  const fromEnv = source === 'env';
  const shown = secret ? '' : value || '';
  const ph = secret && value ? (fromEnv ? '••••••••' : '•••••••• (kept; type to replace)') : placeholder;
  return `<label><span>${esc(label)}${fromEnv ? '<span class="tag">set in the server environment</span>' : ''}</span>
<input type="${secret ? 'password' : type}" name="${esc(name)}" value="${esc(shown)}" placeholder="${esc(ph)}" autocomplete="off"${fromEnv ? ' disabled' : ''}></label>${note ? `<div class="note">${note}</div>` : ''}`;
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
const createAdmin = ({ settings, env, realEnv = process.env, auth, desktop, gitAccounts, dataDir, localOnly, restart, fetchImpl = fetch, log = console }) => {
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
  /** Saved, then the front restarts; the page comes back after a moment. */
  const savedAndRestart = (res, back) => {
    html(
      res,
      200,
      page({
        title: 'Admin',
        body: `<div class="banner ok">Saved. narado is restarting with the new settings…</div><script>setTimeout(function(){location.href=${JSON.stringify(back)}},2500)</script><noscript><a href="${esc(back)}">Continue</a></noscript>`
      })
    );
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

  const hostCard = (h) => {
    const n = appSet(h);
    const configured = !!(env[n.id] && env[n.secret]);
    const fromEnv = settings.source(n.id, realEnv) === 'env';
    const web = webOf(h);
    const id = esc(h.id);
    const status = configured ? `<span class="tag ok">app set up${fromEnv ? ' (environment)' : ''}</span>` : '<span class="tag warn">not set up</span>';
    const ns = esc((h.exploreNamespaces || []).join(', '));
    let create = '';
    if (!fromEnv && h.type === 'github') {
      create = `<form method="post" action="/admin/git/${id}/github-app">
<div class="row"><label><span>Organisation on ${esc(web.replace(/^https?:\/\//, ''))} (leave empty for your own account)</span><input type="text" name="org" placeholder="acme"></label>
<label><span>App name</span><input type="text" name="name" value="${esc(`narado (${new URL(publicUrl).host})`)}"></label></div>
<div class="actions"><button type="submit">${configured ? 'Create a new GitHub App' : 'Create the GitHub App'}</button>
<span class="note">GitHub asks you to confirm, then sends narado its credentials. Permissions: contents and pull requests (read and write), metadata and email (read).</span></div></form>`;
    } else if (!fromEnv && h.type === 'gitlab') {
      const isCom = /^https:\/\/gitlab\.com$/i.test(web);
      create = isCom
        ? `<p class="note">GitLab.com can't create applications through its API, so create one by hand: open <a href="https://gitlab.com/-/user_settings/applications" target="_blank" rel="noopener">your applications</a> (or a group's <em>Settings → Applications</em>), name it narado, set the redirect URI to <code>${esc(callbackOf(h))}</code>, tick <em>Confidential</em> and the scopes <code>api</code> and <code>read_user</code>, then paste its ID and secret below.</p>`
        : `<form method="post" action="/admin/git/${id}/gitlab-app">
<label><span>Administrator access token for ${esc(web.replace(/^https?:\/\//, ''))} (scope api; used once, not kept)</span><input type="password" name="token" autocomplete="off"></label>
<div class="actions"><button type="submit">Create the GitLab application</button><span class="note">Creates an instance-wide OAuth application named narado with redirect URI <code>${esc(callbackOf(h))}</code>.</span></div></form>`;
    }
    const manual = fromEnv
      ? ''
      : `<details${h.type === 'gitlab' && /gitlab\.com$/i.test(web) && !configured ? ' open' : ''}><summary>${h.type === 'gitlab' && /gitlab\.com$/i.test(web) ? 'Application ID and secret' : 'Or enter app credentials by hand'}</summary>
<form method="post" action="/admin/git/${id}/manual">
<div class="row">${field({ name: 'clientId', label: 'Client (application) ID', value: env[n.id] })}${field({ name: 'clientSecret', label: 'Client secret', value: env[n.secret], secret: true })}</div>
${h.type === 'github' ? field({ name: 'slug', label: 'App slug (for the install link)', value: env[n.slug] }) : ''}
<p class="note">Redirect or callback URL to register: <code>${esc(callbackOf(h))}</code></p>
<div class="actions"><button type="submit" class="secondary">Save</button></div></form></details>`;
    const install = h.type === 'github' && env[n.slug] ? `<p class="note">Install it on the repositories narado should see: <a href="${esc(`${web}/apps/${env[n.slug]}/installations/new`)}" target="_blank" rel="noopener">install ${esc(env[n.slug])}</a>.</p>` : '';
    return `<div class="host"><strong>${esc(h.name || h.id)}</strong> <span class="tag">${esc(h.type)}</span> <span class="tag">${esc(web)}</span> ${status}
${install}${create}${manual}
<form method="post" action="/admin/git/${id}/namespaces"><label><span>Where Explore APIs looks by default (users, organisations or groups; empty for everything a person can see)</span><input type="text" name="namespaces" value="${ns}" placeholder="acme, acme-platform"></label>
<div class="actions"><button type="submit" class="secondary">Save</button>${!['github', 'gitlab'].includes(h.id) ? `<button type="submit" class="danger" formaction="/admin/git/${id}/remove">Remove host</button>` : ''}</div></form></div>`;
  };

  /* ------------------------------------------------------------------ page */

  const adminPage = (who, notice) => {
    const v = (name) => env[name];
    const src = (name) => settings.source(name, realEnv);
    const oidcOn = !!env.NARADO_OIDC_ISSUER;
    const devices = desktop && auth.enabled ? desktop.adminDevices() : [];
    const steps = who.setup
      ? `<div class="banner">First-time setup. 1. Sign-in: your organisation's SSO. 2. Admins: who manages narado (include your own email). 3. Git: can wait. When sign-in and admins are saved, <a href="/auth/login?return=/admin">sign in</a> as an admin to finish; this setup link then stops working.</div>`
      : '';
    const banner = notice ? `<div class="banner ${notice.error ? 'err' : 'ok'}">${esc(notice.text)}</div>` : '';
    const body = `${steps}${banner}
${localOnly ? '<div class="banner">Single-user local mode: no sign-in, listening on this computer only. Set up sign-in to let your team use narado.</div>' : ''}
<section><h2>Sign-in</h2><p class="lead">Your organisation's single sign-on (OpenID Connect). Register narado as a confidential web application with redirect URI <code>${esc(publicUrl)}/auth/callback</code>.</p>
<form method="post" action="/admin/signin">
${field({ name: 'NARADO_PUBLIC_URL', label: "narado's address", value: v('NARADO_PUBLIC_URL') || publicUrl, source: src('NARADO_PUBLIC_URL'), placeholder: 'https://narado.example.com' })}
<div class="row">${field({ name: 'NARADO_OIDC_ISSUER', label: 'Issuer URL', value: v('NARADO_OIDC_ISSUER'), source: src('NARADO_OIDC_ISSUER'), placeholder: 'https://login.example.com/realms/acme' })}
${field({ name: 'NARADO_OIDC_PROVIDER_NAME', label: 'Shown as', value: v('NARADO_OIDC_PROVIDER_NAME'), source: src('NARADO_OIDC_PROVIDER_NAME'), placeholder: 'Okta, Google, Keycloak…' })}</div>
<div class="row">${field({ name: 'NARADO_OIDC_CLIENT_ID', label: 'Client ID', value: v('NARADO_OIDC_CLIENT_ID'), source: src('NARADO_OIDC_CLIENT_ID') })}
${field({ name: 'NARADO_OIDC_CLIENT_SECRET', label: 'Client secret', value: v('NARADO_OIDC_CLIENT_SECRET'), source: src('NARADO_OIDC_CLIENT_SECRET'), secret: true })}</div>
${field({ name: 'NARADO_ALLOWED_EMAIL_DOMAINS', label: 'Allowed email domains (optional, comma-separated)', value: v('NARADO_ALLOWED_EMAIL_DOMAINS'), source: src('NARADO_ALLOWED_EMAIL_DOMAINS'), placeholder: 'acme.com' })}
<div class="actions"><button type="submit">Save sign-in</button><span class="note">${oidcOn ? 'Sign-in is on.' : 'Sign-in is off.'} narado checks the issuer before saving, and restarts.</span></div></form></section>

<section><h2>Admins</h2><p class="lead">People who can use these pages, by the email they sign in with.</p>
<form method="post" action="/admin/admins">
<label><span>Admin emails (comma-separated)${src('NARADO_ADMINS') === 'env' ? '<span class="tag">set in the server environment</span>' : ''}</span>
<textarea name="NARADO_ADMINS" rows="2"${src('NARADO_ADMINS') === 'env' ? ' disabled' : ''}>${esc(v('NARADO_ADMINS') || '')}</textarea></label>
<div class="actions"><button type="submit">Save admins</button></div></form></section>

<section><h2>Git</h2><p class="lead">narado reaches GitHub and GitLab through an app it creates here; each person then connects their own account and works as themselves.</p>
${hostList().map(hostCard).join('\n')}
<details><summary>Add a host (GitHub Enterprise or self-managed GitLab)</summary>
<form method="post" action="/admin/git/add"><div class="row">
<label><span>ID (short, unique)</span><input type="text" name="id" placeholder="gitlab-acme" pattern="[a-z0-9-]+"></label>
<label><span>Type</span><select name="type"><option value="gitlab">GitLab</option><option value="github">GitHub Enterprise</option></select></label>
<label><span>Address</span><input type="url" name="url" placeholder="https://git.acme.com"></label></div>
<div class="actions"><button type="submit" class="secondary">Add host</button></div></form></details></section>

<section><h2>Desktop</h2><p class="lead">What narado desktop may send requests to from people's computers. Cloud metadata addresses are always refused.</p>
<form method="post" action="/admin/desktop"><label><span>Sends allowed${src('NARADO_DESKTOP_SEND') === 'env' ? '<span class="tag">set in the server environment</span>' : ''}</span>
<select name="NARADO_DESKTOP_SEND"${src('NARADO_DESKTOP_SEND') === 'env' ? ' disabled' : ''}>
${[['any', 'Private and local addresses, and public hosts on the repo’s allowlist (default)'], ['private-only', 'Private and local addresses only'], ['allowlist-only', 'Only hosts on a repo’s allowlist, private ones included']].map(([val, text]) => `<option value="${val}"${(v('NARADO_DESKTOP_SEND') || 'any') === val ? ' selected' : ''}>${esc(text)}</option>`).join('')}
</select></label><div class="actions"><button type="submit">Save</button></div></form>
${auth.enabled ? `<h2 style="margin-top:18px">Signed-in computers (${devices.length})</h2>${devices.length ? `<table><tr><th>Computer</th><th>Person</th><th>Last used</th><th></th></tr>${devices
      .map((d) => `<tr><td>${esc(d.name)} <span class="tag">${esc(PLATFORMS[d.platform] || d.platform || '?')}</span></td><td>${esc(d.userName || d.userEmail || '?')}</td><td>${esc(when(d.lastSeenAt))}</td>
<td><form method="post" action="/admin/devices/${esc(d.id)}/revoke" onsubmit="return confirm('Sign out ${esc(d.name).replace(/'/g, '')}?')"><button class="danger" type="submit">Sign out</button></form></td></tr>`)
      .join('')}</table>` : '<p class="note">None yet.</p>'}` : ''}
</section>`;
    return page({ title: who.setup ? 'Setup' : 'Admin', who: who.setup ? 'setup link' : who.name, body });
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
      page({
        title: 'Admin',
        body: `<div class="banner">Taking you to ${esc(web.replace(/^https?:\/\//, ''))} to create the app…</div>
<form id="go" method="post" action="${esc(action)}"><input type="hidden" name="manifest" value="${esc(JSON.stringify(manifest))}"><button type="submit">Continue to GitHub</button></form>
<script>document.getElementById('go').submit()</script>`
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
        return html(res, 403, page({ title: 'Setup', body: '<div class="banner err">This setup link isn\'t valid. Use the latest link from narado\'s log (a new one is printed each time it starts).</div>' })), true;
      }
      const sid = crypto.randomBytes(24).toString('base64url');
      setupSessions.add(sid);
      log.log('[narado] setup link opened');
      return redirect(res, '/admin', { 'set-cookie': `${SETUP_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax${publicUrl.startsWith('https://') ? '; Secure' : ''}; Max-Age=86400` }), true;
    }

    const who = adminFor(req);
    if (!who) {
      if (auth.enabled && !auth.userFor(req)) return redirect(res, `/auth/login?return=${encodeURIComponent(p)}`), true;
      return html(res, 403, page({ title: 'Admin', body: '<div class="banner err">Only narado admins can open this page. Ask an admin to add your email.</div>' })), true;
    }
    // An admin signed in with SSO: setup is over.
    if (who.user) {
      settings.endSetup();
      setupSessions.clear();
    }

    try {
      if (p === '/admin' && req.method === 'GET') {
        const saved = url.searchParams.get('saved');
        const notice = saved ? { text: { signin: 'Sign-in saved.', admins: 'Admins saved.', git: 'Git settings saved.', desktop: 'Desktop settings saved.', device: 'Signed out.' }[saved] || 'Saved.' } : null;
        return html(res, 200, adminPage(who, notice)), true;
      }
      const done = /^\/admin\/git\/([a-z0-9-]+)\/github-app-done$/.exec(p);
      if (done && req.method === 'GET') {
        const h = hostList().find((x) => x.id === done[1]);
        if (!h) throw new Error('Unknown host');
        await githubAppDone(h, url, who);
        return savedAndRestart(res, '/admin?saved=git'), true;
      }

      if (req.method !== 'POST') return html(res, 405, page({ title: 'Admin', body: '<div class="banner err">Not allowed.</div>' })), true;
      if (!sameSite(req, who)) return html(res, 403, page({ title: 'Admin', body: '<div class="banner err">Cross-site request refused.</div>' })), true;
      const form = await readForm(req);

      if (p === '/admin/signin') return await signin(form, who), savedAndRestart(res, '/admin?saved=signin'), true;
      if (p === '/admin/admins') {
        if (settings.source('NARADO_ADMINS', realEnv) === 'env') throw new Error('Admins are set in the server environment');
        const list = String(form.get('NARADO_ADMINS') || '')
          .split(/[,\s]+/)
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean);
        if (list.some((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))) throw new Error('Enter email addresses, separated by commas');
        if (!list.length) throw new Error('Name at least one admin');
        if (who.email && !list.includes(String(who.email).toLowerCase())) throw new Error("You can't remove yourself; ask another admin");
        settings.set({ NARADO_ADMINS: list.join(',') }, who.email || who.name);
        log.log(`[narado] admin: ${who.name} set the admins (${list.length})`);
        return savedAndRestart(res, '/admin?saved=admins'), true;
      }
      if (p === '/admin/desktop') {
        const value = form.get('NARADO_DESKTOP_SEND');
        if (!['any', 'private-only', 'allowlist-only'].includes(value)) throw new Error('Unknown setting');
        settings.set({ NARADO_DESKTOP_SEND: value === 'any' ? null : value }, who.email || who.name);
        log.log(`[narado] admin: ${who.name} set desktop sends to ${value}`);
        return savedAndRestart(res, '/admin?saved=desktop'), true;
      }
      const dev = /^\/admin\/devices\/([\w-]+)\/revoke$/.exec(p);
      if (dev) {
        desktop.adminRevoke(dev[1], who.name);
        return redirect(res, '/admin?saved=device'), true;
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
      return html(res, 404, page({ title: 'Admin', body: '<div class="banner err">Not found.</div>' })), true;
    } catch (err) {
      log.warn(`[narado] admin: ${err.message}`);
      return html(res, 400, adminPage(who, { text: err.message, error: true })), true;
    }
  };

  return { handle, setupNeeded, isAdminUser, adminFor };
};

module.exports = { createAdmin, SETUP_COOKIE };
