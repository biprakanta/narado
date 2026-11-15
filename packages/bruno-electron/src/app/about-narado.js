/**
 * narado desktop's About window (Help menu). Credits Bruno, which narado is built on (MIT).
 */
const fs = require('node:fs');
const path = require('node:path');

// Bundled into the packaged app, or from the repository when run from source.
const ART = [path.resolve(__dirname, '../../narado/assets/narado-illustration-256.png'), path.resolve(__dirname, '../../../../branding/icons/narado-illustration-256.png')].find((p) => fs.existsSync(p)) || '';

/** narado's and Bruno's versions: from the packaged app's version.json, or the repository. */
const versions = () => {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../narado/version.json'), 'utf8'));
  } catch {
    try {
      return { narado: require('../../../bruno-web-server/package.json').version, bruno: require('../../package.json').version };
    } catch {
      return {};
    }
  }
};

module.exports = function aboutNarado({ version, naradoVersion } = {}) {
  const v = versions();
  naradoVersion = naradoVersion || v.narado;
  version = v.bruno || version;
  let art = '';
  try {
    if (ART) art = `data:image/png;base64,${fs.readFileSync(ART).toString('base64')}`;
  } catch {}
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>About narado</title>
<style>
body{margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;
  font:13px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#EDE4D8;background:#17121F;
  background-image:radial-gradient(30rem 20rem at 70% 0%,rgba(253,110,21,.16),transparent 60%),radial-gradient(25rem 20rem at 0% 100%,rgba(101,7,72,.45),transparent 60%);
  -webkit-user-select:none;user-select:none}
.art{width:104px;height:104px;border-radius:50%;background:radial-gradient(circle at 50% 40%,#3A0F5E 0%,#21004B 62%,#17062E 100%);display:flex;align-items:center;justify-content:center}
.art img{width:88px;height:88px}
h1{margin:4px 0 0;font:700 24px "Space Grotesk",Inter,ui-sans-serif,sans-serif;color:#FDEED2}
.tag{color:#C7BCCB}.ver{color:#958A9B;font-size:12px}.credit{color:#958A9B;font-size:11px;margin-top:6px}
</style></head><body>
${art ? `<div class="art"><img src="${art}" alt=""></div>` : ''}
<h1>narado</h1>
<div class="tag">API collections in Git, for your whole team.</div>
${naradoVersion ? `<div class="credit" style="margin-top:0">Version ${naradoVersion}</div>` : ''}
<div class="credit">Built on Bruno ${version}, the open-source API client (MIT licence).</div>
</body></html>`;
};
