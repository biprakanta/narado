const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');
const { parseRequest, stringifyRequest } = require('@usebruno/filestore');
const { Projection } = require('../src/narado/openapi/projection');

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'payments.openapi.yaml'), 'utf8');
const quiet = { log() {}, warn() {}, error() {} };

let tmp;
let repoDir;
let viewDir;
let proj;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (check, what, timeout = 5000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (check()) return;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${what}`);
};
const specText = () => fs.readFileSync(path.join(repoDir, 'openapi.yaml'), 'utf8');
const viewFile = (rel) => path.join(viewDir, rel);
const readItem = (rel) => parseRequest(fs.readFileSync(viewFile(rel), 'utf8'), { format: 'bru' });
const writeItem = (rel, item) => {
  fs.mkdirSync(path.dirname(viewFile(rel)), { recursive: true });
  fs.writeFileSync(viewFile(rel), stringifyRequest(item, { format: 'bru' }));
};

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'narado-proj-'));
  repoDir = path.join(tmp, 'repo');
  viewDir = path.join(tmp, 'view');
  fs.mkdirSync(repoDir);
  fs.writeFileSync(path.join(repoDir, 'openapi.yaml'), FIXTURE);
});

afterEach(async () => {
  if (proj) await proj.stop();
  proj = null;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const start = async () => {
  proj = new Projection({ repoDir, viewDir, log: quiet });
  await proj.start();
  return proj;
};

test('generates a Bruno collection: folders per tag, one environment per server', async () => {
  await start();
  assert.deepEqual(JSON.parse(fs.readFileSync(viewFile('bruno.json'), 'utf8')).name, 'Payments API');
  assert.deepEqual(fs.readdirSync(viewFile('environments')).sort(), ['Production.bru', 'Sandbox.bru']);
  assert.deepEqual(fs.readdirSync(viewFile('Payments')).sort(), ['createPayment.bru', 'getPayment.bru', 'listPayments.bru']);
  assert.deepEqual(fs.readdirSync(viewFile('Refunds')), ['createRefund.bru']);
  assert.ok(fs.existsSync(viewFile('health.bru')));
  assert.equal(readItem('Payments/getPayment.bru').request.url, '{{baseUrl}}/payments/:paymentId');
  assert.equal(specText(), FIXTURE, 'the repo is not touched');
  assert.ok(!fs.existsSync(path.join(repoDir, '.narado')), 'no narado files needed');
});

test('saving a request in Bruno updates the spec by one line, and nothing echoes back', async () => {
  await start();
  const item = readItem('Payments/listPayments.bru');
  item.name = 'List all payments';
  writeItem('Payments/listPayments.bru', item);
  await waitFor(() => specText().includes('summary: List all payments'), 'the spec to change');
  await sleep(600);
  await proj.settle();
  const changed = FIXTURE.split('\n').filter((l, i) => specText().split('\n')[i] !== l);
  assert.deepEqual(changed, ['      summary: List payments']);
  assert.equal(readItem('Payments/listPayments.bru').name, 'List all payments', 'view not rewritten');
});

test('values and tests go to .narado, the spec stays the same', async () => {
  await start();
  const item = readItem('Payments/getPayment.bru');
  item.request.params[0].value = 'pay_999';
  item.request.tests = 'test("found", () => expect(res.status).to.equal(200));';
  writeItem('Payments/getPayment.bru', item);
  const client = path.join(repoDir, '.narado', 'requests', 'getPayment.yml');
  await waitFor(() => fs.existsSync(client), 'the client file');
  const data = YAML.parse(fs.readFileSync(client, 'utf8'));
  assert.deepEqual(data.params, [{ name: 'paymentId', type: 'path', value: 'pay_999' }]);
  assert.match(data.tests, /found/);
  await proj.settle();
  assert.equal(specText(), FIXTURE);
});

test('deleting a request removes the operation; adding one creates an operation', async () => {
  await start();
  fs.rmSync(viewFile('health.bru'));
  await waitFor(() => !specText().includes('/health:'), 'the operation to be removed');

  writeItem('Refunds/listRefunds.bru', {
    type: 'http-request',
    name: 'List refunds',
    seq: 2,
    request: { method: 'GET', url: '{{baseUrl}}/refunds', params: [], headers: [], body: { mode: 'none' }, auth: { mode: 'inherit' } }
  });
  await waitFor(() => specText().includes('operationId: listRefunds'), 'the new operation');
  const spec = YAML.parse(specText());
  assert.deepEqual(spec.paths['/refunds'].get.tags, ['Refunds']);
  assert.equal(spec.paths['/refunds'].get.summary, 'List refunds');
});

test('moving a request to another folder keeps its operation', async () => {
  await start();
  const item = readItem('Payments/getPayment.bru');
  fs.rmSync(viewFile('Payments/getPayment.bru'));
  writeItem('Refunds/getPayment.bru', item);
  await waitFor(() => /tags: \[Refunds\]\n      responses:\n        '200':\n          description: The payment/.test(specText()) || YAML.parse(specText()).paths['/payments/{paymentId}'].get.tags?.[0] === 'Refunds', 'the tag to change');
  const spec = YAML.parse(specText());
  assert.equal(spec.paths['/payments/{paymentId}'].get.operationId, 'getPayment', 'same operation, not a new one');
  assert.equal(Object.values(spec.paths).filter((p) => p.get && p.get.operationId && p.get.operationId.startsWith('getPayment')).length, 1);
});

test('changes to the repo (for example a Git update) refresh the view', async () => {
  await start();
  fs.writeFileSync(path.join(repoDir, 'openapi.yaml'), FIXTURE.replace('summary: Get a payment', 'summary: Fetch a payment'));
  await waitFor(() => readItem('Payments/getPayment.bru').name === 'Fetch a payment', 'the view to refresh');

  fs.writeFileSync(path.join(repoDir, 'openapi.yaml'), FIXTURE.replace(/  \/health:\n    get:\n      operationId: health\n      responses:\n        '200':\n          description: OK\n/, ''));
  await waitFor(() => !fs.existsSync(viewFile('health.bru')), 'the removed request to disappear');
});

test('operations without an operationId get one', async () => {
  fs.writeFileSync(path.join(repoDir, 'openapi.yaml'), FIXTURE.replace('      operationId: health\n', ''));
  await start();
  assert.ok(specText().includes('operationId: getHealth'));
  assert.ok(fs.existsSync(viewFile('getHealth.bru')));
});

test('a 3.0 spec is upgraded to 3.1 on the first edit', async () => {
  const v30 = FIXTURE.replace('openapi: 3.1.0', 'openapi: 3.0.3').replace(
    '        currency:\n          type: string\n',
    '        currency:\n          type: string\n          nullable: true\n'
  );
  fs.writeFileSync(path.join(repoDir, 'openapi.yaml'), v30);
  await start();
  assert.equal(specText(), v30, 'opening does not upgrade');
  const item = readItem('health.bru');
  item.name = 'Health check';
  writeItem('health.bru', item);
  await waitFor(() => specText().includes('openapi: 3.1.0'), 'the upgrade');
  const spec = YAML.parse(specText());
  assert.deepEqual(spec.components.schemas.NewPayment.properties.currency, { type: ['string', 'null'] });
  assert.equal(spec.paths['/health'].get.summary, 'Health check');
});

test('collections made before .narado keep using .client', async () => {
  fs.mkdirSync(path.join(repoDir, '.client', 'requests'), { recursive: true });
  await start();
  const item = readItem('Payments/getPayment.bru');
  item.request.params[0].value = 'pay_legacy';
  writeItem('Payments/getPayment.bru', item);
  const client = path.join(repoDir, '.client', 'requests', 'getPayment.yml');
  await waitFor(() => fs.existsSync(client), 'the client file in .client');
  assert.ok(!fs.existsSync(path.join(repoDir, '.narado')));
});

test('.narado/config.nar names the spec (any file name) and the collection', async () => {
  fs.renameSync(path.join(repoDir, 'openapi.yaml'), path.join(repoDir, 'payments-v2.yaml'));
  fs.mkdirSync(path.join(repoDir, '.narado'));
  fs.writeFileSync(path.join(repoDir, '.narado', 'config.nar'), 'version: 1\nname: Payments (team)\nspec: payments-v2.yaml\n');
  await start();
  assert.equal(proj.specPath, path.join(repoDir, 'payments-v2.yaml'));
  assert.equal(JSON.parse(fs.readFileSync(viewFile('bruno.json'), 'utf8')).name, 'Payments (team)');
  assert.ok(fs.existsSync(viewFile('Payments/getPayment.bru')));
});

const GRAPHQL = 'meta {\n  name: Payment by id (GraphQL)\n  type: graphql\n  seq: 5\n}\n\npost {\n  url: {{baseUrl}}/graphql\n  body: graphql\n  auth: inherit\n}\n\nbody:graphql {\n  query { payment(id: "pay_1") { id amount } }\n}\n';
const GRPC = 'meta {\n  name: Get payment (gRPC)\n  type: grpc\n  seq: 6\n}\n\ngrpc {\n  url: grpcs://payments.example.test:443\n  method: /payments.v1.Payments/GetPayment\n  body: grpc\n  auth: inherit\n}\n';
const WS = 'meta {\n  name: Payment events\n  type: ws\n  seq: 7\n}\n\nws {\n  url: wss://events.example.test/payments\n  body: ws\n  auth: inherit\n}\n';

test('GraphQL, gRPC and WebSocket requests are kept in .narado/extra/, and the spec is untouched', async () => {
  await start();
  fs.mkdirSync(viewFile('Realtime'), { recursive: true });
  fs.writeFileSync(viewFile('Payments/paymentById.bru'), GRAPHQL);
  fs.writeFileSync(viewFile('Payments/getPaymentGrpc.bru'), GRPC);
  fs.writeFileSync(viewFile('Realtime/paymentEvents.bru'), WS);
  const extra = (rel) => path.join(repoDir, '.narado', 'extra', ...rel.split('/'));
  await waitFor(() => ['Payments/paymentById.bru', 'Payments/getPaymentGrpc.bru', 'Realtime/paymentEvents.bru'].every((r) => fs.existsSync(extra(r))), 'the extra files');
  assert.equal(fs.readFileSync(extra('Payments/getPaymentGrpc.bru'), 'utf8'), GRPC, 'stored as they are');
  await proj.settle();
  assert.equal(specText(), FIXTURE, 'nothing of them goes into the spec');

  // Edited in the repo (a teammate's change pulled in): the view follows.
  fs.writeFileSync(extra('Realtime/paymentEvents.bru'), WS.replace('/payments', '/payments/v2'));
  await waitFor(() => fs.readFileSync(viewFile('Realtime/paymentEvents.bru'), 'utf8').includes('/payments/v2'), 'the view to update');

  // Deleted in the view: gone from the repo too.
  fs.rmSync(viewFile('Payments/paymentById.bru'));
  await waitFor(() => !fs.existsSync(extra('Payments/paymentById.bru')), 'the extra file to go');

  // A fresh view (another person, another server) gets them back from the repo.
  await proj.stop();
  fs.rmSync(viewDir, { recursive: true, force: true });
  await start();
  assert.ok(fs.existsSync(viewFile('Payments/getPaymentGrpc.bru')));
  assert.ok(fs.existsSync(viewFile('Realtime/paymentEvents.bru')));
  assert.ok(!fs.existsSync(viewFile('Payments/paymentById.bru')));
});

test('gRPC proto files come from config.nar, and choosing them in the collection settings writes them back', async () => {
  const root = tmp; // the working copy; repoDir is a collection folder inside it
  fs.mkdirSync(path.join(root, 'proto', 'payments'), { recursive: true });
  fs.writeFileSync(path.join(root, 'proto', 'payments', 'v1.proto'), 'syntax = "proto3";\n');
  fs.mkdirSync(path.join(repoDir, '.narado'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, '.narado', 'config.nar'), '# our payments API\nversion: 1\ngrpc:\n  protoFiles: [../proto/payments/v1.proto]\n  importPaths: [../proto]\n');
  proj = new Projection({ repoDir, viewDir, root, log: quiet });
  await proj.start();
  const cfg = JSON.parse(fs.readFileSync(viewFile('bruno.json'), 'utf8'));
  assert.deepEqual(cfg.protobuf.protoFiles.map((f) => path.resolve(viewDir, f.path)), [path.join(root, 'proto', 'payments', 'v1.proto')]);
  assert.deepEqual(cfg.protobuf.importPaths.map((f) => path.resolve(viewDir, f.path)), [path.join(root, 'proto')]);

  // Bruno's protobuf settings add a second proto file: config.nar gets it, comments kept.
  fs.writeFileSync(path.join(root, 'proto', 'payments', 'events.proto'), 'syntax = "proto3";\n');
  cfg.protobuf.protoFiles.push({ path: path.relative(viewDir, path.join(root, 'proto', 'payments', 'events.proto')), type: 'file' });
  fs.writeFileSync(viewFile('bruno.json'), JSON.stringify(cfg, null, 2));
  const nar = () => fs.readFileSync(path.join(repoDir, '.narado', 'config.nar'), 'utf8');
  await waitFor(() => nar().includes('events.proto'), 'config.nar to list the new proto file');
  assert.match(nar(), /# our payments API/);
  assert.deepEqual(YAML.parse(nar()).grpc.protoFiles, ['../proto/payments/v1.proto', '../proto/payments/events.proto']);

  // A proto path outside the working copy is ignored.
  fs.writeFileSync(path.join(repoDir, '.narado', 'config.nar'), 'version: 1\ngrpc:\n  protoFiles: [../../../etc/x.proto]\n');
  await waitFor(() => !JSON.parse(fs.readFileSync(viewFile('bruno.json'), 'utf8')).protobuf, 'the outside path to be dropped');
});
