const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { stringifyRequest, stringifyEnvironment } = require('@usebruno/filestore');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { createMcpHandler, maskItem } = require('../src/narado/mcp');
const { TokenStore } = require('../src/narado/mcp-tokens');

let tmp;
let wsPath;
const sent = [];

/** A server with the MCP handler and stand-ins for narado's workspaces, Git identity and Bruno's runner. */
let currentLogin = 'alice';
const startServer = async (env = {}) => {
  const workspaces = { locate: (p) => (path.resolve(p) === wsPath ? { hostId: 'github', repoPath: 'acme/api', path: wsPath } : null) };
  const call = async (channel, ...args) => {
    if (channel === 'narado:hosts') return [{ id: 'github', connected: true }, { id: 'gitlab', connected: false }];
    if (channel === 'narado:me') return { login: currentLogin, name: currentLogin === 'alice' ? 'Alice Example' : 'Bob' };
    if (channel === 'narado:workspaces') return [{ path: wsPath, hostId: 'github', repoPath: 'acme/api', branch: 'main' }];
    if (channel === 'send-http-request') {
      sent.push(args);
      return { status: 200, statusText: 'OK', headers: { 'set-cookie': 'a=b', 'content-type': 'application/json' }, data: { ok: true }, duration: 5 };
    }
    throw new Error(`unexpected ${channel}`);
  };
  const handlers = {};
  const ipcMain = { handle: (ch, fn) => (handlers[ch] = fn) };
  const server = http.createServer(async (req, res) => {
    if (!(await handler.handle(req, res))) res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const handler = createMcpHandler({ call, ipcMain, workspaces, collectionsFor: async () => [wsPath], dataDir: tmp, port, env, log: { error() {}, warn() {} } });
  const ipc = (ch, args) => handlers[ch]({}, args);
  const close = () => {
    server.closeAllConnections();
    server.close();
  };
  return { close, port, ipc, url: `http://127.0.0.1:${port}/mcp` };
};

const connect = async (url, token) => {
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
};

const json = (result) => JSON.parse(result.content[0].text);

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'narado-mcp-'));
  wsPath = path.join(tmp, 'ws');
  fs.mkdirSync(path.join(wsPath, 'environments'), { recursive: true });
  fs.mkdirSync(path.join(wsPath, 'Users'));
  fs.writeFileSync(path.join(wsPath, 'bruno.json'), '{"version":"1","name":"API","type":"collection"}');
  fs.writeFileSync(
    path.join(wsPath, 'environments', 'Production.bru'),
    stringifyEnvironment({ variables: [{ name: 'baseUrl', value: 'https://api.acme.test/v1', enabled: true, secret: false, type: 'text' }, { name: 'apiToken', value: 'super-secret', enabled: true, secret: true, type: 'text' }] }, { format: 'bru' })
  );
  const item = (name, url, extra = {}) => ({
    type: 'http-request',
    name,
    seq: 1,
    request: { method: 'GET', url, params: [], headers: [{ name: 'Authorization', value: 'Bearer {{apiToken}}', enabled: true }], body: { mode: 'none' }, auth: { mode: 'inherit' }, script: { req: 'bru.setVar("x", 1)' }, tests: 'test("t", () => {})', ...extra }
  });
  fs.writeFileSync(path.join(wsPath, 'Users', 'getUser.bru'), stringifyRequest(item('Get user', '{{baseUrl}}/users/:id', { params: [{ name: 'id', value: '1', enabled: true, type: 'path' }] }), { format: 'bru' }));
  fs.writeFileSync(path.join(wsPath, 'metadata.bru'), stringifyRequest(item('Metadata', 'http://169.254.169.254/latest/meta-data'), { format: 'bru' }));
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('refuses missing, unknown and browser requests', async () => {
  const srv = await startServer();
  const { token } = await srv.ipc('narado:mcp-tokens:create', { name: 'laptop', scope: 'read' });
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  assert.equal((await fetch(srv.url, { method: 'POST', headers, body })).status, 401);
  assert.equal((await fetch(srv.url, { method: 'POST', headers: { ...headers, authorization: 'Bearer narado_nope' }, body })).status, 401);
  assert.equal((await fetch(srv.url, { method: 'POST', headers: { ...headers, authorization: `Bearer ${token}`, origin: 'https://evil.test' }, body })).status, 403);
  srv.close();
});

test('tokens are created by their owner, stored only as hashes, listed and revoked', async () => {
  const srv = await startServer();
  const { token, record } = await srv.ipc('narado:mcp-tokens:create', { name: 'Claude Code', scope: 'write' });
  assert.match(token, /^narado_[0-9a-f]{48}$/);
  assert.deepEqual(record.owner, { name: 'Alice Example', hosts: { github: 'alice' } });
  const file = fs.readFileSync(path.join(tmp, 'mcp-tokens.json'), 'utf8');
  assert.ok(!file.includes(token), 'the token itself is never stored');
  assert.equal(fs.statSync(path.join(tmp, 'mcp-tokens.json')).mode & 0o777, 0o600);
  const listed = (await srv.ipc('narado:mcp-tokens')).find((t) => t.id === record.id);
  assert.equal(listed.name, 'Claude Code');
  assert.ok(!('hash' in listed));

  const c = await connect(srv.url, token);
  await c.listTools();
  await c.close();
  assert.ok((await srv.ipc('narado:mcp-tokens')).find((t) => t.id === record.id).lastUsedAt, 'use is recorded');

  await srv.ipc('narado:mcp-tokens:revoke', { id: record.id });
  const res = await fetch(srv.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: '{}' });
  assert.equal(res.status, 401, 'revoked tokens stop working');
  await assert.rejects(srv.ipc('narado:mcp-tokens:create', { name: '', scope: 'read' }), /name/);
  srv.close();
});

test('a token acts only as its owner', async () => {
  const srv = await startServer();
  const { token } = await srv.ipc('narado:mcp-tokens:create', { name: 'laptop', scope: 'read' });
  currentLogin = 'bob';
  const res = await fetch(srv.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.equal(res.status, 401);
  assert.match((await res.json()).error.message, /belongs to alice on github, but narado is now connected as bob/);
  currentLogin = 'alice';
  srv.close();
});

test('read tokens get read tools; write tokens also get write tools, unless the server forbids them', async () => {
  const srv = await startServer();
  const read = await srv.ipc('narado:mcp-tokens:create', { name: 'r', scope: 'read' });
  const write = await srv.ipc('narado:mcp-tokens:create', { name: 'w', scope: 'write' });
  const names = async (token) => {
    const c = await connect(srv.url, token);
    const n = (await c.listTools()).tools.map((t) => t.name);
    await c.close();
    return n;
  };
  const r = await names(read.token);
  assert.ok(r.includes('send_request') && !r.includes('update_request') && !r.includes('save_changes'));
  const w = await names(write.token);
  assert.ok(w.includes('update_request') && w.includes('save_changes'));
  srv.close();

  const locked = await startServer({ NARADO_MCP_ALLOW_WRITE: '0' });
  const c = await connect(locked.url, write.token);
  const n = (await c.listTools()).tools.map((t) => t.name);
  await c.close();
  assert.ok(!n.includes('update_request'), 'server ceiling wins over the token');
  await assert.rejects(locked.ipc('narado:mcp-tokens:create', { name: 'x', scope: 'write' }), /turned off/);
  assert.deepEqual(await locked.ipc('narado:mcp-info'), { url: `http://127.0.0.1:${locked.port}/mcp`, writeAllowed: false });
  locked.close();
});

test('lists requests and masks secrets', async () => {
  const srv = await startServer();
  const { token } = await srv.ipc('narado:mcp-tokens:create', { name: 't', scope: 'read' });
  const c = await connect(srv.url, token);
  const ws = json(await c.callTool({ name: 'list_workspaces', arguments: {} }));
  assert.equal(ws[0].workspace, wsPath);
  const reqs = json(await c.callTool({ name: 'list_requests', arguments: { workspace: wsPath } }));
  assert.deepEqual(reqs.map((r) => r.request), ['Users/getUser.bru', 'metadata.bru']);
  const one = json(await c.callTool({ name: 'get_request', arguments: { workspace: wsPath, request: 'Users/getUser.bru' } }));
  assert.equal(one.headers[0].value, '••••••', 'Authorization header masked');
  const envs = json(await c.callTool({ name: 'list_environments', arguments: { workspace: wsPath } }));
  // Bruno never writes secret values to environment files, so they come back empty.
  assert.deepEqual(envs[0].variables, [{ name: 'baseUrl', value: 'https://api.acme.test/v1' }, { name: 'apiToken', value: '' }]);
  const outside = await c.callTool({ name: 'get_request', arguments: { workspace: wsPath, request: '../../etc/passwd' } });
  assert.equal(outside.isError, true);
  const unknown = await c.callTool({ name: 'list_requests', arguments: { workspace: '/somewhere/else' } });
  assert.equal(unknown.isError, true);
  await c.close();
  srv.close();
});

test('send_request runs without scripts, only to hosts the workspace names', async () => {
  const srv = await startServer();
  const { token } = await srv.ipc('narado:mcp-tokens:create', { name: 't', scope: 'read' });
  const c = await connect(srv.url, token);
  sent.length = 0;
  const ok = json(await c.callTool({ name: 'send_request', arguments: { workspace: wsPath, request: 'Users/getUser.bru', params: { id: '42', expand: 'roles' } } }));
  assert.equal(ok.status, 200);
  assert.equal(ok.scriptsRun, false);
  assert.equal(ok.headers['set-cookie'], '••••••');
  const [item, collection, env] = sent[0];
  assert.deepEqual(item.request.script, {});
  assert.equal(item.request.tests, '');
  assert.equal(item.request.url, '{{baseUrl}}/users/:id?expand=roles');
  assert.equal(item.request.params.find((p) => p.name === 'id').value, '42');
  assert.equal(collection.pathname, wsPath);
  assert.equal(env.name, 'Production');

  const blocked = await c.callTool({ name: 'send_request', arguments: { workspace: wsPath, request: 'metadata.bru' } });
  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0].text, /169\.254\.169\.254 is not a host this workspace names\. Allowed: api\.acme\.test/);
  assert.equal(sent.length, 1, 'the blocked request was never sent');

  fs.mkdirSync(path.join(wsPath, '.client'), { recursive: true });
  fs.writeFileSync(path.join(wsPath, '.client', 'allowed-hosts.yml'), 'hosts:\n  - 169.254.169.254\n');
  const allowed = await c.callTool({ name: 'send_request', arguments: { workspace: wsPath, request: 'metadata.bru' } });
  assert.notEqual(allowed.isError, true, 'allowed once listed in .client/allowed-hosts.yml');
  fs.rmSync(path.join(wsPath, '.client'), { recursive: true });
  await c.close();
  srv.close();
});

test('maskItem hides auth details', () => {
  const masked = maskItem({ name: 'x', request: { method: 'GET', url: 'u', auth: { mode: 'bearer', bearer: { token: 'abc' } }, headers: [], params: [] } });
  assert.deepEqual(masked.auth, { mode: 'bearer', details: '••••••' });
});

test('with sign-in on, tokens belong to a narado user: own list, own revoke, gone user refused', async () => {
  const users = new Map([['u-alice', { id: 'u-alice', name: 'Alice Example', email: 'alice@acme.test' }], ['u-bob', { id: 'u-bob', name: 'Bob', email: 'bob@acme.test' }]]);
  const auth = { enabled: true, users: { getUser: (id) => users.get(id) || null } };
  const handlers = {};
  const ipcMain = { handle: (ch, fn) => (handlers[ch] = fn) };
  const dataDir = fs.mkdtempSync(path.join(tmp, 'signed-'));
  const call = async (channel) => {
    if (channel === 'narado:hosts') return [{ id: 'github', connected: true }];
    if (channel === 'narado:me') return { login: 'alice', name: 'Alice Example' };
    if (channel === 'narado:workspaces') return [];
    throw new Error(`unexpected ${channel}`);
  };
  let calledAs = null;
  const callAs = (user) => async (channel, ...args) => {
    calledAs = user;
    return call(channel, ...args);
  };
  const server = http.createServer(async (req, res) => {
    if (!(await handler.handle(req, res))) res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const handler = createMcpHandler({ call, callAs, auth, ipcMain, workspaces: { locate: () => null }, collectionsFor: async () => [], dataDir, port, env: {}, log: { error() {}, warn() {} } });
  const as = (id) => ({ narado: { user: users.get(id) } });

  await assert.rejects(handlers['narado:mcp-tokens:create']({ narado: { user: null } }, { name: 'x', scope: 'read' }), /Sign in/);
  const { token, record } = await handlers['narado:mcp-tokens:create'](as('u-alice'), { name: 'alice laptop', scope: 'read' });
  assert.equal(record.owner.userId, 'u-alice');
  assert.equal((await handlers['narado:mcp-tokens'](as('u-alice'))).length, 1);
  assert.equal((await handlers['narado:mcp-tokens'](as('u-bob'))).length, 0, "bob cannot see alice's tokens");
  await assert.rejects(handlers['narado:mcp-tokens:revoke'](as('u-bob'), { id: record.id }), /No such token/);

  const c = await connect(`http://127.0.0.1:${port}/mcp`, token);
  await c.callTool({ name: 'list_workspaces', arguments: {} });
  await c.close();
  assert.equal(calledAs && calledAs.id, 'u-alice', 'tools run as the token owner');

  users.delete('u-alice');
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.equal(res.status, 401);
  assert.match((await res.json()).error.message, /does not belong to a narado user/);
  server.closeAllConnections();
  server.close();
});
