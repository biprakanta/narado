/**
 * narado's own sign-in screens (branding/README.md): the sign-in page, the signed-out
 * page and sign-in errors. Served by the server under /auth, with their images from
 * /auth/assets (copied from packages/bruno-app/public/narado).
 */
const fs = require('node:fs');
const path = require('node:path');

const ASSET_DIR = path.resolve(__dirname, '../../../bruno-app/public/narado');
const ASSETS = {
  'narado-illustration-256.png': 'image/png',
  'narado-illustration-512.png': 'image/png',
  'narado-loader-dark.svg': 'image/svg+xml',
  'narado-favicon.svg': 'image/svg+xml',
  'favicon.ico': 'image/x-icon',
  'space-grotesk-700.woff2': 'font/woff2'
};

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Serve /auth/assets/<file> for the files above only. Returns false for other paths. */
const serveAsset = (pathname, res) => {
  const m = /^\/auth\/assets\/([\w.-]+)$/.exec(pathname);
  if (!m) return false;
  const type = ASSETS[m[1]];
  const file = path.join(ASSET_DIR, m[1]);
  if (!type || !fs.existsSync(file)) {
    res.writeHead(404).end();
    return true;
  }
  res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=3600' });
  fs.createReadStream(file).pipe(res);
  return true;
};

const STYLE = `
@font-face{font-family:"Space Grotesk";font-style:normal;font-weight:700;font-display:swap;src:url(/auth/assets/space-grotesk-700.woff2) format("woff2")}
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px;
  font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  color:#EDE4D8;background:#17121F;
  background-image:radial-gradient(60rem 40rem at 70% 10%,rgba(253,110,21,.16),transparent 60%),
    radial-gradient(50rem 40rem at 10% 100%,rgba(101,7,72,.45),transparent 60%)}
main{width:100%;max-width:400px;text-align:center}
.art{width:220px;height:220px;display:block;margin:0 auto 4px}
h1{margin:0;font-family:"Space Grotesk",ui-sans-serif,system-ui,sans-serif;font-size:36px;font-weight:700;letter-spacing:-.2px;color:#FDEED2}
.tagline{margin:8px 0 28px;color:#C7BCCB;font-size:15px;line-height:1.5}
.card{background:rgba(36,29,47,.85);border:1px solid #342B40;border-radius:14px;padding:22px}
.note{margin:0 0 16px;font-size:14px;line-height:1.5;color:#EDE4D8}
.note.error{color:#FDB55A}
.btn{display:block;width:100%;padding:12px 16px;border-radius:10px;border:0;cursor:pointer;
  font:600 15px/1.2 inherit;color:#17121F;text-decoration:none;
  background:linear-gradient(135deg,#FB9B1A,#FD6E15 60%,#EC2B26)}
.btn:hover{filter:brightness(1.06)}
.btn:focus-visible{outline:3px solid #FDEED2;outline-offset:3px}
.loading{display:none;flex-direction:column;align-items:center;gap:6px;color:#C7BCCB;font-size:14px}
.loading img{width:72px;height:72px}
.going .btn{display:none}.going .loading{display:flex}
.foot{margin-top:18px;font-size:12px;color:#958A9B}
.secondary{display:block;width:100%;margin-top:10px;padding:11px 16px;border-radius:10px;cursor:pointer;
  font:600 15px/1.2 inherit;color:#EDE4D8;background:transparent;border:1px solid #4A3F57}
.secondary:hover{background:rgba(255,255,255,.04)}
.device{margin:0 0 18px;font-size:14px;line-height:1.6;color:#C7BCCB;text-align:left}
.device b{color:#EDE4D8;font-weight:600}
`;

const shell = ({ title, body }) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<link rel="icon" type="image/svg+xml" href="/auth/assets/narado-favicon.svg"><link rel="alternate icon" href="/auth/assets/favicon.ico">
<style>${STYLE}</style></head>
<body><main>
<img class="art" src="/auth/assets/narado-illustration-256.png" srcset="/auth/assets/narado-illustration-512.png 2x" alt="narado: the sage Narada with his veena">
<h1>narado</h1>
<p class="tagline">API collections in Git, for your whole team.</p>
${body}
</main></body></html>`;

/**
 * The sign-in page. `startUrl` begins the provider's sign-in; `notice` is shown above the
 * button ({ text, error }).
 */
const signInPage = ({ startUrl, providerName, notice }) =>
  shell({
    title: 'Sign in · narado',
    body: `<div class="card" id="card">
${notice ? `<p class="note${notice.error ? ' error' : ''}" role="${notice.error ? 'alert' : 'status'}">${esc(notice.text)}</p>` : ''}
<a class="btn" id="go" href="${esc(startUrl)}">Sign in with ${esc(providerName)}</a>
<div class="loading" aria-live="polite"><img src="/auth/assets/narado-loader-dark.svg" alt=""><span>Taking you to ${esc(providerName)}…</span></div>
</div>
<p class="foot">Built on Bruno, the open-source API client.</p>
<script>document.getElementById('go').addEventListener('click',function(){document.getElementById('card').classList.add('going')});
window.addEventListener('pageshow',function(e){if(e.persisted)document.getElementById('card').classList.remove('going')});</script>`
  });

/**
 * Approving narado desktop on a computer (desktop sign-in, docs/desktop.md 3.5). The form
 * posts to `action` with the one-time `request` id.
 */
const PLATFORM_NAMES = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

const desktopApprovePage = ({ action, request, deviceName, platform, userName }) =>
  shell({
    title: 'Sign in narado desktop · narado',
    body: `<form class="card" method="post" action="${esc(action)}">
<p class="note">Sign in narado desktop as <b>${esc(userName)}</b>?</p>
<p class="device">Computer: <b>${esc(deviceName || 'Unnamed computer')}</b>${platform ? ` (${esc(PLATFORM_NAMES[platform] || platform)})` : ''}<br>
It will use your Git accounts and secrets for requests sent from that computer. You can sign it out at any time under Devices.</p>
<input type="hidden" name="request" value="${esc(request)}">
<button class="btn" name="decision" value="allow" type="submit">Sign in narado desktop</button>
<button class="secondary" name="decision" value="deny" type="submit">Cancel</button>
</form>
<p class="foot">Only continue if you just started signing in from narado desktop.</p>`
  });

/** A short message page (desktop sign-in finished, cancelled or failed). */
const messagePage = ({ title, text, error = false }) =>
  shell({
    title: `${title} · narado`,
    body: `<div class="card"><p class="note${error ? ' error' : ''}" role="${error ? 'alert' : 'status'}">${esc(text)}</p></div>`
  });

module.exports = { signInPage, desktopApprovePage, messagePage, serveAsset, esc };
