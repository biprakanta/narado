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
  assert.ok(!fs.existsSync(path.join(repoDir, '.client')), 'no client files needed');
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

test('values and tests go to .client, the spec stays the same', async () => {
  await start();
  const item = readItem('Payments/getPayment.bru');
  item.request.params[0].value = 'pay_999';
  item.request.tests = 'test("found", () => expect(res.status).to.equal(200));';
  writeItem('Payments/getPayment.bru', item);
  const client = path.join(repoDir, '.client', 'requests', 'getPayment.yml');
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
