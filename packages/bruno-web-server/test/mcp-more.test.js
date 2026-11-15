const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { stringifyEnvironment } = require('@usebruno/filestore');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { createMcpHandler } = require('../src/narado/mcp');

let tmp;
let wsPath;
let ordersDir;
const calls = [];

const GQL = 'meta {\n  name: Payment by id\n  type: graphql\n  seq: 1\n}\n\npost {\n  url: {{baseUrl}}/graphql\n  body: graphql\n  auth: none\n}\n\nbody:graphql {\n  query { payment(id: "1") { id } }\n}\n';
const WS = 'meta {\n  name: Payment events\n  type: ws\n  seq: 2\n}\n\nws {\n  url: wss://events.acme.test/payments\n  body: ws\n  auth: none\n}\n';
const GRPC = 'meta {\n  name: Get order\n  type: grpc\n  seq: 1\n}\n\ngrpc {\n  url: grpcs://grpc.acme.test:443\n  method: /orders.v1.Orders/GetOrder\n  body: grpc\n  auth: none\n}\n';
const GRPC_ELSEWHERE = GRPC.replace('grpc.acme.test', 'grpc.other.test').replace('Get order', 'Elsewhere');

const startServer = async () => {
  const listeners = new Set();
  const emit = (channel, ...args) => listeners.forEach((l) => l(channel, args));
  const workspaces = { locate: (p) => (path.resolve(p) === wsPath ? { hostId: 'github', repoPath: 'acme/payments', path: wsPath } : null) };
  const call = async (channel, ...args) => {
    calls.push([channel, args]);
    switch (channel) {
      case 'narado:hosts':
        return [{ id: 'github', connected: true }];
      case 'narado:me':
        return { login: 'alice', name: 'Alice Example' };
      case 'narado:catalogue':
        return { repos: [{ path: 'acme/payments', shape: 'code+api', access: 'write', description: 'Payments service', collections: [{ name: 'Payments API', dir: 'api', kind: 'openapi' }, { name: 'Orders', dir: 'services/orders/api', kind: 'openapi' }] }, { path: 'acme/web', shape: 'api', access: 'read', collections: [{ name: 'Web', dir: '', kind: 'bruno' }] }], withoutCollections: 4, scanning: false, errors: [] };
      case 'narado:sync':
        return { name: 'Orders (synced)', commit: 'abc1234', branch: 'main', added: 3, updated: 0, removed: 0, kept: [], first: true };
      case 'send-http-request':
        return { status: 200, statusText: 'OK', headers: {}, data: { data: { payment: { id: '1' } } }, duration: 3 };
      case 'renderer:ws:start-connection': {
        const id = args[0].request.uid;
        setTimeout(() => {
          emit('main:ws:open', id, 'c', { url: 'wss://events.acme.test/payments' });
          emit('main:ws:message', id, 'c', { message: '{"event":"paid"}', type: 'incoming' });
          emit('main:ws:message', 'someone-else', 'c', { message: 'not ours' });
          emit('main:ws:close', id, 'c', { code: 1000 });
        }, 20);
        return { success: true };
      }
      case 'grpc:start-connection': {
        const id = args[0].request.uid;
        setTimeout(() => {
          emit('grpc:response', id, 'c', { res: { id: 'ord_1', total: 12 } });
          emit('grpc:status', id, 'c', { status: { code: 0, details: 'OK' } });
        }, 20);
        return { success: true };
      }
      case 'renderer:ws:close-connection':
      case 'grpc:end-request':
      case 'grpc:cancel-request':
        return { success: true };
      default:
        throw new Error(`unexpected ${channel}`);
    }
  };
  const handlers = {};
  const ipcMain = { handle: (ch, fn) => (handlers[ch] = fn) };
  const server = http.createServer(async (req, res) => {
    if (!(await handler.handle(req, res))) res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const handler = createMcpHandler({
    call,
    ipcMain,
    workspaces,
    collectionsFor: async () => [wsPath, ordersDir],
    dataDir: tmp,
    port,
    onEvent: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    log: { error() {}, warn() {} }
  });
  const { token } = await handlers['narado:mcp-tokens:create']({}, { name: 'test', scope: 'read' });
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return {
    client,
    tool: async (name, args) => client.callTool({ name, arguments: args }),
    close: async () => {
      await client.close();
      server.closeAllConnections();
      server.close();
    }
  };
};

const json = (r) => JSON.parse(r.content[0].text);

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'narado-mcp2-'));
  wsPath = path.join(tmp, 'ws');
  ordersDir = path.join(wsPath, 'services', 'orders', 'api');
  for (const d of [path.join(wsPath, 'environments'), path.join(wsPath, '.narado'), path.join(ordersDir, 'environments')]) fs.mkdirSync(d, { recursive: true });
  const env = stringifyEnvironment({ variables: [{ name: 'baseUrl', value: 'https://api.acme.test', enabled: true, secret: false, type: 'text' }] }, { format: 'bru' });
  fs.writeFileSync(path.join(wsPath, 'environments', 'Production.bru'), env);
  fs.writeFileSync(path.join(ordersDir, 'environments', 'Production.bru'), env);
  fs.writeFileSync(path.join(wsPath, '.narado', 'allowed-hosts.yml'), 'hosts:\n  - events.acme.test\n  - grpc.acme.test:443\n');
  fs.writeFileSync(path.join(wsPath, 'bruno.json'), '{"version":"1","name":"Payments API","type":"collection"}');
  fs.writeFileSync(path.join(ordersDir, 'bruno.json'), '{"version":"1","name":"Orders","type":"collection"}');
  fs.writeFileSync(path.join(wsPath, 'paymentById.bru'), GQL);
  fs.writeFileSync(path.join(wsPath, 'paymentEvents.bru'), WS);
  fs.writeFileSync(path.join(ordersDir, 'getOrder.bru'), GRPC);
  fs.writeFileSync(path.join(ordersDir, 'elsewhere.bru'), GRPC_ELSEWHERE);
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('MCP: collections in a code repository, and request kinds', async () => {
  const srv = await startServer();
  try {
    assert.deepEqual(json(await srv.tool('list_collections', { workspace: wsPath })), [
      { collection: '', name: 'Payments API', requests: 2 },
      { collection: 'services/orders/api', name: 'Orders', requests: 2 }
    ]);
    const orders = json(await srv.tool('list_requests', { workspace: wsPath, collection: 'services/orders/api' }));
    assert.deepEqual(orders.map((r) => [r.request, r.kind]), [['elsewhere.bru', 'grpc'], ['getOrder.bru', 'grpc']]);
    const root = json(await srv.tool('list_requests', { workspace: wsPath }));
    assert.deepEqual(root.map((r) => r.kind).sort(), ['graphql', 'websocket']);
    const bad = await srv.tool('list_requests', { workspace: wsPath, collection: 'nope' });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /list_collections/);
  } finally {
    await srv.close();
  }
});

test('MCP: GraphQL through send_request, with the query and variables given', async () => {
  const srv = await startServer();
  try {
    const r = json(await srv.tool('send_request', { workspace: wsPath, request: 'paymentById.bru', body: 'query($id: ID!) { payment(id: $id) { id } }', variables: '{"id":"7"}' }));
    assert.equal(r.status, 200);
    const [item] = calls.filter(([c]) => c === 'send-http-request').pop()[1];
    assert.equal(item.request.body.mode, 'graphql');
    assert.deepEqual(item.request.body.graphql, { query: 'query($id: ID!) { payment(id: $id) { id } }', variables: '{"id":"7"}' });
    const wrong = await srv.tool('send_request', { workspace: wsPath, request: 'paymentEvents.bru' });
    assert.match(wrong.content[0].text, /use send_websocket/);
  } finally {
    await srv.close();
  }
});

test('MCP: WebSocket and gRPC calls return their events, and follow the host rules', async () => {
  const srv = await startServer();
  try {
    const ws = json(await srv.tool('send_websocket', { workspace: wsPath, request: 'paymentEvents.bru', messages: ['{"subscribe":"payments"}'], listen_seconds: 2 }));
    assert.deepEqual(ws.events.map((e) => e.event), ['open', 'message', 'close'], 'only this connection\'s events');
    const [{ request }] = calls.filter(([c]) => c === 'renderer:ws:start-connection').pop()[1];
    assert.equal(request.request.body.ws[0].content, '{"subscribe":"payments"}');
    assert.deepEqual(request.request.script, {}, 'scripts off');

    const g = json(await srv.tool('call_grpc', { workspace: wsPath, collection: 'services/orders/api', request: 'getOrder.bru', message: '{"id":"ord_1"}' }));
    assert.deepEqual(g.events.map((e) => e.event), ['response', 'status']);
    assert.deepEqual(g.events[0].data, { res: { id: 'ord_1', total: 12 } });

    const refused = await srv.tool('call_grpc', { workspace: wsPath, collection: 'services/orders/api', request: 'elsewhere.bru' });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /grpc\.other\.test is not a host this workspace names/);
  } finally {
    await srv.close();
  }
});

test('MCP: explore APIs and sync a copy', async () => {
  const srv = await startServer();
  try {
    const found = json(await srv.tool('explore_apis', { host: 'github', filter: 'orders' }));
    assert.deepEqual(found.repos.map((r) => r.repo), ['acme/payments']);
    assert.equal(found.repos[0].kind, 'code + API');
    const synced = json(await srv.tool('sync_collection', { host: 'github', repo: 'acme/payments', folder: 'services/orders/api' }));
    assert.equal(synced.name, 'Orders (synced)');
    assert.deepEqual(calls.filter(([c]) => c === 'narado:sync').pop()[1][0], { hostId: 'github', repoPath: 'acme/payments', dir: 'services/orders/api' });
  } finally {
    await srv.close();
  }
});
