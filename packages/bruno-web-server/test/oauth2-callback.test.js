const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { createOauth2Callback } = require('../src/narado/oauth2-callback');

const quiet = { log() {}, warn() {}, error() {} };

/** A front with the callback routes; cookie "sid=<id>" signs in; `waiting` users' workers have a sign-in pending. */
const start = async ({ enabled = true, waiting = new Set(), running = new Set(['alice', 'bob']) } = {}) => {
  const users = { alice: { id: 'alice', name: 'Alice' }, bob: { id: 'bob', name: 'Bob' } };
  const delivered = [];
  let publicUrl;
  const pool = {
    running: (user) => (running.has(user ? user.id : 'local') ? { id: user ? user.id : 'local' } : null),
    callWorker: async (entry, pathname, body) => {
      delivered.push({ to: entry.id, pathname, url: body.url });
      return { handled: waiting.has(entry.id) };
    }
  };
  let cb;
  const server = http.createServer(async (req, res) => {
    if (!(await cb.handle(req, res))) res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  publicUrl = `http://127.0.0.1:${server.address().port}`;
  cb = createOauth2Callback({
    auth: {
      enabled,
      publicUrl,
      userFor: (req) => {
        const m = /sid=(\w+)/.exec(req.headers.cookie || '');
        return m ? users[m[1]] : null;
      }
    },
    pool,
    allowedOrigins: new Set(),
    log: quiet
  });
  const complete = (url, { cookie, origin = publicUrl } = {}) =>
    fetch(`${publicUrl}/oauth2/callback/complete`, { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}) }, body: JSON.stringify({ url }) });
  return { publicUrl, delivered, complete, close: () => new Promise((r) => server.close(r)) };
};

test('the callback page reads the result, offers it to the web session, then hands it to narado desktop', async () => {
  const s = await start();
  try {
    const res = await fetch(`${s.publicUrl}/oauth2/callback?code=abc&state=xyz`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    const html = await res.text();
    assert.match(html, /fetch\('\/oauth2\/callback\/complete'/);
    assert.match(html, /narado:\/\/app\/oauth2\/callback'\+query\+hash/);
    assert.match(html, /history\.replaceState/, 'the code is cleared from the address bar');
    assert.ok(!html.includes('usebruno'));
    // The page's script must be valid JavaScript.
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
    assert.doesNotThrow(() => new Function(script));
  } finally {
    await s.close();
  }
});

test("a sign-in goes only to the signed-in person's own running worker", async () => {
  const s = await start({ waiting: new Set(['alice']) });
  try {
    const url = `${s.publicUrl}/oauth2/callback?code=abc&state=xyz`;
    assert.deepEqual(await (await s.complete(url, { cookie: 'sid=alice' })).json(), { handled: true });
    assert.deepEqual(s.delivered, [{ to: 'alice', pathname: '/narado/oauth2-callback', url }]);
    // Bob's worker isn't waiting: not handled (the page then hands it to narado desktop).
    assert.deepEqual(await (await s.complete(url, { cookie: 'sid=bob' })).json(), { handled: false });
    // Not signed in: nobody's worker.
    assert.deepEqual(await (await s.complete(url)).json(), { handled: false });
    assert.equal(s.delivered.length, 2);
  } finally {
    await s.close();
  }
});

test('the hand-off refuses other sites and other addresses', async () => {
  const s = await start({ waiting: new Set(['alice']) });
  try {
    const url = `${s.publicUrl}/oauth2/callback?code=abc`;
    assert.equal((await s.complete(url, { cookie: 'sid=alice', origin: 'https://evil.example' })).status, 403);
    assert.equal((await s.complete(url, { cookie: 'sid=alice', origin: null })).status, 403);
    assert.deepEqual(await (await s.complete(`${s.publicUrl}/somewhere-else?code=abc`, { cookie: 'sid=alice' })).json(), { handled: false });
    assert.equal(s.delivered.length, 0);
  } finally {
    await s.close();
  }
});

test("single-user local mode: the one worker, if it's running", async () => {
  const s = await start({ enabled: false, waiting: new Set(['local']), running: new Set(['local']) });
  try {
    assert.deepEqual(await (await s.complete(`${s.publicUrl}/oauth2/callback?code=abc`)).json(), { handled: true });
  } finally {
    await s.close();
  }
  const idle = await start({ enabled: false, running: new Set() });
  try {
    assert.deepEqual(await (await idle.complete(`${idle.publicUrl}/oauth2/callback?code=abc`)).json(), { handled: false });
  } finally {
    await idle.close();
  }
});

test("Bruno's handler takes narado's callback address: code, state check, and implicit tokens", async () => {
  const handler = require(path.resolve(__dirname, '../../bruno-electron/src/utils/oauth2-protocol-handler'));
  const code = new Promise((resolve, reject) => handler.registerOauth2AuthorizationRequest(resolve, reject, null, 'xyz'));
  assert.equal(handler.isOauth2AuthorizationRequestInProgress(), true);
  handler.handleOauth2ProtocolUrl('https://narado.example.com/oauth2/callback?code=abc&state=xyz');
  assert.equal(await code, 'abc');

  const forged = new Promise((resolve, reject) => handler.registerOauth2AuthorizationRequest(resolve, reject, null, 'xyz'));
  handler.handleOauth2ProtocolUrl('https://narado.example.com/oauth2/callback?code=evil&state=other');
  await assert.rejects(forged, /state mismatch/);

  // Implicit flow, handed to narado desktop: tokens (and state) in the fragment.
  const tokens = new Promise((resolve, reject) => handler.registerOauth2AuthorizationRequest(resolve, reject, null, 's1'));
  handler.handleOauth2ProtocolUrl('narado://app/oauth2/callback#access_token=t0k&token_type=bearer&state=s1');
  assert.match(JSON.stringify(await tokens), /t0k/);
});
