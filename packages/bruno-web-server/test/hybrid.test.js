const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { registerNaradoIpc } = require('../src/narado/ipc');

const SPEC = `openapi: 3.1.0
info:
  title: Payments API
  version: 1.0.0
servers:
  - url: https://api.payments.test
paths:
  /payments:
    get:
      operationId: listPayments
      responses:
        '200':
          description: ok
`;

test('a code repository opens every collection in it: OpenAPI folders get their own views, Bruno ones open as they are', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'narado-hybrid-'));
  const wt = path.join(dataDir, 'git', 'github', 'acme', 'payments-service', 'worktrees', 'main');
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(wt, rel)), { recursive: true });
    fs.writeFileSync(path.join(wt, rel), text);
  };
  write('cmd/server/main.go', 'package main\n');
  write('api/openapi.yaml', SPEC);
  write('services/refunds/api/openapi.yaml', SPEC.replace('Payments API', 'Refunds API').replace('/payments', '/refunds').replace('listPayments', 'listRefunds'));
  write('tools/smoke/bruno.json', '{"version":"1","name":"Smoke tests","type":"collection"}');
  write('node_modules/x/openapi.yaml', SPEC);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: wt });
  fs.writeFileSync(path.join(wt, '.gitignore'), 'node_modules/\n');

  const handlers = new Map();
  const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn) };
  const quietLog = console.warn;
  const narado = registerNaradoIpc({ ipcMain, mainWindow: null, collectionWatcher: null, openCollection: async () => {}, dataDir });
  try {
    const collections = await narado.collectionsFor(wt);
    const views = path.join(dataDir, 'views', 'github', 'acme', 'payments-service', 'worktrees', 'main');
    assert.deepEqual(collections.sort(), [path.join(views, 'api'), path.join(views, 'services', 'refunds', 'api'), path.join(wt, 'tools', 'smoke')].sort());
    // Each view is a Bruno collection named after its spec, with its requests.
    const apiView = JSON.parse(fs.readFileSync(path.join(views, 'api', 'bruno.json'), 'utf8'));
    assert.equal(apiView.name, 'Payments API');
    assert.ok(fs.readdirSync(path.join(views, 'services', 'refunds', 'api'), { recursive: true }).some((f) => String(f).endsWith('.bru')));
    // Views map back to their working copy (request rules, secrets and the Git panel rely on this).
    assert.equal(narado.workspaces.locate(path.join(views, 'services', 'refunds', 'api')).path, wt);

    // A spec folder that goes away stops being a collection.
    fs.rmSync(path.join(wt, 'services'), { recursive: true });
    assert.equal((await narado.collectionsFor(wt)).length, 2);
  } finally {
    await narado.stopViews();
    console.warn = quietLog;
  }
});
