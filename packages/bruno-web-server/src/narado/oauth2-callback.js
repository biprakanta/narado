/**
 * narado's OAuth 2 callback for APIs (<narado>/oauth2/callback): the default redirect URI for
 * requests' OAuth 2 sign-ins, on the web and on narado desktop, instead of Bruno's
 * oauth.usebruno.com.
 *
 *   GET  /oauth2/callback           the page (pages.js oauth2CallbackPage): reads the code, or
 *                                   the implicit flow's tokens from the #fragment, and posts it here
 *   POST /oauth2/callback/complete  { url } -> { handled }: given to the signed-in person's own
 *                                   worker if it's running and waiting for a sign-in; otherwise
 *                                   the page hands it to narado desktop through narado://
 *
 * narado desktop's in-app sign-in window catches the redirect before this page loads.
 */
const { oauth2CallbackPage } = require('./pages');

const LIMIT = 16 * 1024;

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > LIMIT) {
        reject(new Error('Request too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

/** @param pool  { running(user) -> entry|null, callWorker(entry, path, body) -> Promise } */
const createOauth2Callback = ({ auth, pool, allowedOrigins, log = console }) => {
  const handle = async (req, res) => {
    const { pathname } = new URL(req.url, 'http://x');
    if (pathname === '/oauth2/callback' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
      res.end(oauth2CallbackPage());
      return true;
    }
    if (pathname !== '/oauth2/callback/complete' || req.method !== 'POST') return false;
    const reply = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const origin = req.headers.origin;
    if (!origin || (origin !== auth.publicUrl && !allowedOrigins.has(origin))) return reply(403, { handled: false }), true;
    let url = null;
    try {
      url = JSON.parse(await readBody(req)).url;
    } catch {
      return reply(400, { handled: false }), true;
    }
    let ok = false;
    try {
      ok = typeof url === 'string' && url.length < 8192 && new URL(url).pathname === '/oauth2/callback';
    } catch {}
    // Only the person's own worker, only if it's running (it must have started the sign-in).
    const user = auth.enabled ? auth.userFor(req) : null;
    const entry = ok && (!auth.enabled || user) ? pool.running(user) : null;
    if (!entry) return reply(200, { handled: false }), true;
    try {
      const answer = await pool.callWorker(entry, '/narado/oauth2-callback', { url });
      return reply(200, { handled: !!(answer && answer.handled) }), true;
    } catch (err) {
      log.warn(`[narado] OAuth 2 callback for ${user ? user.name : 'local'}: ${err.message}`);
      return reply(200, { handled: false }), true;
    }
  };
  return { handle };
};

module.exports = { createOauth2Callback };
