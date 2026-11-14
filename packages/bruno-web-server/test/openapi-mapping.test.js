const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseRequest, stringifyRequest } = require('@usebruno/filestore');
const { SpecDoc } = require('../src/narado/openapi/spec');
const { toBrunoRequest, applyBrunoRequest, parseBrunoUrl } = require('../src/narado/openapi/mapping');

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'payments.openapi.yaml'), 'utf8');

/** Every operation as a Bruno request, sent through Bruno's own .bru format and back. */
const loadAll = (spec, clients = {}) => {
  const js = spec.toJS();
  return spec.operations().map((op, i) => {
    const item = toBrunoRequest({ spec: js, op, client: clients[op.operation.operationId] || {}, seq: i + 1 });
    const viaBru = parseRequest(stringifyRequest(item, { format: 'bru' }), { format: 'bru' });
    return { op, item: viaBru, folder: (op.operation.tags || [])[0] || null, seq: i + 1 };
  });
};

const save = (spec, { op, item, folder, seq }) =>
  applyBrunoRequest(spec, { from: { path: op.path, method: op.method }, operationId: op.operation.operationId, item, folder, seq });

/** Lines changed between two texts, as a compact list. */
const changedLines = (a, b) => {
  const { diffLines } = require('../src/narado/openapi/spec');
  return (diffLines(a.split('\n'), b.split('\n')) || []).map((h) => ({ removed: h.aEnd - h.aStart, added: h.b }));
};

test('saving every request unchanged leaves the spec byte-identical and needs no client files', () => {
  const spec = new SpecDoc(FIXTURE);
  for (const entry of loadAll(spec)) {
    const { client } = save(spec, entry);
    assert.deepEqual(client, {}, `${entry.op.operation.operationId} needs no client file`);
  }
  assert.equal(spec.toString(), FIXTURE);
});

test('requests carry what the spec implies', () => {
  const spec = new SpecDoc(FIXTURE);
  const byId = Object.fromEntries(loadAll(spec).map((e) => [e.op.operation.operationId, e.item]));

  const list = byId.listPayments;
  assert.equal(list.name, 'List payments');
  assert.equal(list.request.method, 'GET');
  assert.equal(list.request.url, '{{baseUrl}}/payments');
  assert.deepEqual(
    list.request.params.map((p) => [p.name, p.type, p.value, p.enabled]),
    [['limit', 'query', '20', false], ['status', 'query', '', false]]
  );
  assert.deepEqual(list.request.headers.map((h) => h.name), ['X-Request-Id'], 'shared $ref header resolved');

  const get = byId.getPayment;
  assert.equal(get.request.url, '{{baseUrl}}/payments/:paymentId');
  assert.deepEqual(get.request.params.map((p) => [p.name, p.type, p.value]), [['paymentId', 'path', 'pay_123']]);
  assert.equal(get.request.docs, 'Returns one payment by its ID.');

  const create = byId.createPayment;
  assert.equal(create.request.body.mode, 'json');
  assert.deepEqual(JSON.parse(create.request.body.json), { amount: 1250, currency: 'INR' });

  assert.equal(byId.health.name, 'health', 'falls back to operationId without a summary');
});

test('renaming a request changes one line', () => {
  const spec = new SpecDoc(FIXTURE);
  const entry = loadAll(spec).find((e) => e.op.operation.operationId === 'listPayments');
  entry.item.name = 'List all payments';
  save(spec, entry);
  assert.deepEqual(changedLines(FIXTURE, spec.toString()), [{ removed: 1, added: ['      summary: List all payments'] }]);
});

test('values, headers, auth and tests go to the client file, not the spec', () => {
  const spec = new SpecDoc(FIXTURE);
  const entry = loadAll(spec).find((e) => e.op.operation.operationId === 'listPayments');
  const limit = entry.item.request.params.find((p) => p.name === 'limit');
  limit.value = '50';
  limit.enabled = true;
  entry.item.request.headers.push({ name: 'Accept-Language', value: 'en-IN', enabled: true });
  entry.item.request.auth = { mode: 'bearer', bearer: { token: '{{token}}' } };
  entry.item.request.tests = 'test("ok", () => expect(res.status).to.equal(200));';

  const { client } = save(spec, entry);
  assert.equal(spec.toString(), FIXTURE, 'spec untouched');
  assert.deepEqual(client.params, [{ name: 'limit', type: 'query', value: '50' }]);
  assert.deepEqual(client.headers, [{ name: 'Accept-Language', value: 'en-IN' }]);
  assert.deepEqual(client.auth, { mode: 'bearer', bearer: { token: '{{token}}' } });
  assert.match(client.tests, /expect\(res.status\)/);

  // Loading again with that client file gives back the edited request.
  const reloaded = loadAll(new SpecDoc(spec.toString()), { listPayments: client }).find((e) => e.op.operation.operationId === 'listPayments');
  assert.equal(reloaded.item.request.params.find((p) => p.name === 'limit').value, '50');
  assert.ok(reloaded.item.request.url.includes('limit=50'));
  assert.equal(reloaded.item.request.auth.mode, 'bearer');
});

test('adding and removing a query parameter changes the contract', () => {
  const spec = new SpecDoc(FIXTURE);
  const entry = loadAll(spec).find((e) => e.op.operation.operationId === 'listPayments');
  entry.item.request.params = entry.item.request.params.filter((p) => p.name !== 'status');
  entry.item.request.params.push({ name: 'cursor', value: '', enabled: false, type: 'query' });
  save(spec, entry);
  const params = spec.get(['paths', '/payments', 'get', 'parameters']);
  assert.deepEqual(params.map((p) => p.$ref || p.name), ['limit', '#/components/parameters/RequestId', 'cursor']);
  assert.deepEqual(params[2], { name: 'cursor', in: 'query', schema: { type: 'string' } });
});

test('changing the URL path moves the operation and keeps its details', () => {
  const spec = new SpecDoc(FIXTURE);
  const entry = loadAll(spec).find((e) => e.op.operation.operationId === 'health');
  entry.item.request.url = '{{baseUrl}}/healthz';
  const res = save(spec, entry);
  assert.equal(res.path, '/healthz');
  assert.equal(spec.has(['paths', '/health']), false, 'old path removed');
  assert.equal(spec.get(['paths', '/healthz', 'get', 'operationId']), 'health');
  assert.deepEqual(spec.get(['paths', '/healthz', 'get', 'responses']), { 200: { description: 'OK' } });
});

test('moving a request to another folder changes its first tag', () => {
  const spec = new SpecDoc(FIXTURE);
  const entry = loadAll(spec).find((e) => e.op.operation.operationId === 'getPayment');
  entry.folder = 'Refunds';
  save(spec, entry);
  assert.deepEqual(spec.get(['paths', '/payments/{paymentId}', 'get', 'tags']), ['Refunds']);

  entry.folder = 'Admin';
  save(spec, entry);
  assert.deepEqual(spec.get(['paths', '/payments/{paymentId}', 'get', 'tags']), ['Admin']);
  assert.ok(spec.get(['tags']).some((t) => t.name === 'Admin'), 'new tag declared');
});

test('a new request becomes a new operation', () => {
  const spec = new SpecDoc(FIXTURE);
  const item = {
    type: 'http-request',
    name: 'Cancel payment',
    seq: 9,
    request: {
      method: 'POST',
      url: '{{baseUrl}}/payments/:paymentId/cancel?reason=duplicate',
      params: [
        { name: 'paymentId', value: 'pay_9', enabled: true, type: 'path' },
        { name: 'reason', value: 'duplicate', enabled: true, type: 'query' }
      ],
      headers: [],
      body: { mode: 'none' },
      auth: { mode: 'inherit' }
    }
  };
  const res = applyBrunoRequest(spec, { from: null, operationId: 'cancelPayment', item, folder: 'Payments', seq: 9 });
  const op = spec.get(['paths', '/payments/{paymentId}/cancel', 'post']);
  assert.equal(op.operationId, 'cancelPayment');
  assert.equal(op.summary, 'Cancel payment');
  assert.deepEqual(op.tags, ['Payments']);
  assert.deepEqual(op.parameters.map((p) => [p.name, p.in]), [['paymentId', 'path'], ['reason', 'query']]);
  assert.deepEqual(res.client.params, [
    { name: 'paymentId', type: 'path', value: 'pay_9' },
    { name: 'reason', type: 'query', value: 'duplicate' }
  ]);
  assert.throws(
    () => applyBrunoRequest(spec, { from: null, operationId: 'again', item, folder: null, seq: 1 }),
    /already exists/
  );
});

test('URLs with a literal host keep that host in the client file', () => {
  assert.deepEqual(parseBrunoUrl('{{baseUrl}}/a/:id?x=1'), { base: '{{baseUrl}}', path: '/a/{id}' });
  assert.deepEqual(parseBrunoUrl('https://httpbin.org/get?from=x'), { base: 'https://httpbin.org', path: '/get' });
  assert.deepEqual(parseBrunoUrl('/plain/'), { base: '', path: '/plain' });

  const spec = new SpecDoc(FIXTURE);
  const entry = loadAll(spec).find((e) => e.op.operation.operationId === 'health');
  entry.item.request.url = 'http://localhost:8080/health';
  const { client } = save(spec, entry);
  assert.equal(client.baseUrl, 'http://localhost:8080');
  assert.equal(spec.toString(), FIXTURE);
});

test('JSON specs keep their indentation', () => {
  const json = JSON.stringify(new SpecDoc(FIXTURE).toJS(), null, 4) + '\n';
  const spec = new SpecDoc(json, { json: true });
  for (const entry of loadAll(spec)) save(spec, entry);
  assert.equal(spec.toString(), json);
  const entry = loadAll(spec).find((e) => e.op.operation.operationId === 'listPayments');
  entry.item.name = 'Payments list';
  save(spec, entry);
  assert.deepEqual(changedLines(json, spec.toString()), [{ removed: 1, added: ['                "summary": "Payments list",'] }]);
});
