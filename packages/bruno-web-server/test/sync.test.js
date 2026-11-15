const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SyncManager, listFiles } = require('../src/narado/sync');

const write = (dir, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');

test('sync copies a collection into the workspace and brings later changes in, keeping the person\'s edits', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'narado-sync-'));
  const src = path.join(tmp, 'view');
  write(src, 'bruno.json', JSON.stringify({ version: '1', name: 'Payments API', type: 'collection' }));
  write(src, '.narado-view.json', '{}');
  write(src, 'Payments/getPayment.bru', 'get v1');
  write(src, 'Payments/listPayments.bru', 'list v1');
  write(src, 'health.bru', 'health v1');
  write(src, 'environments/Production.bru', 'baseUrl: https://api.example.test');

  const sync = new SyncManager({ dataDir: path.join(tmp, 'data') });
  const first = sync.sync({ hostId: 'github', repoPath: 'acme/payments', dir: 'services/payments/api', sourceDir: src, name: 'Payments API', commit: 'aaa', branch: 'main' });
  assert.equal(first.first, true);
  assert.equal(first.added, 5);
  assert.equal(first.name, 'Payments API (synced)');
  const dst = first.path;
  assert.ok(dst.startsWith(path.join(tmp, 'data', 'synced', 'github')));
  assert.equal(JSON.parse(read(dst, 'bruno.json')).name, 'Payments API (synced)', 'named as a copy');
  assert.ok(!fs.existsSync(path.join(dst, '.narado-view.json')), "the view's bookkeeping is not copied");

  // The person uses the copy: edits one request, deletes another.
  write(dst, 'Payments/getPayment.bru', 'get v1, my value');
  fs.rmSync(path.join(dst, 'health.bru'));

  // Meanwhile the repo changes: all three requests change, one is removed, one is added.
  write(src, 'Payments/getPayment.bru', 'get v2');
  write(src, 'Payments/listPayments.bru', 'list v2');
  write(src, 'health.bru', 'health v2');
  write(src, 'Refunds/listRefunds.bru', 'refunds v1');
  fs.rmSync(path.join(src, 'environments/Production.bru'));

  const again = sync.sync({ hostId: 'github', repoPath: 'acme/payments', dir: 'services/payments/api', sourceDir: src, name: 'Payments API', commit: 'bbb', branch: 'main' });
  assert.deepEqual({ added: again.added, updated: again.updated, removed: again.removed, kept: again.kept }, { added: 1, updated: 1, removed: 1, kept: ['Payments/getPayment.bru'] });
  assert.equal(read(dst, 'Payments/getPayment.bru'), 'get v1, my value', 'their edit is kept');
  assert.equal(read(dst, 'Payments/listPayments.bru'), 'list v2', 'untouched files update');
  assert.ok(!fs.existsSync(path.join(dst, 'health.bru')), 'what they deleted stays deleted');
  assert.equal(read(dst, 'Refunds/listRefunds.bru'), 'refunds v1');
  assert.ok(!fs.existsSync(path.join(dst, 'environments/Production.bru')), 'removed upstream, unedited: removed');

  // Once they undo their edit, the next sync updates the file again.
  write(dst, 'Payments/getPayment.bru', 'get v2');
  const third = sync.sync({ hostId: 'github', repoPath: 'acme/payments', dir: 'services/payments/api', sourceDir: src, name: 'Payments API', commit: 'bbb', branch: 'main' });
  assert.deepEqual(third.kept, []);
  write(src, 'Payments/getPayment.bru', 'get v3');
  sync.sync({ hostId: 'github', repoPath: 'acme/payments', dir: 'services/payments/api', sourceDir: src, name: 'Payments API', commit: 'ccc', branch: 'main' });
  assert.equal(read(dst, 'Payments/getPayment.bru'), 'get v3');

  const listed = sync.list();
  assert.equal(listed.length, 1);
  assert.deepEqual({ repoPath: listed[0].repoPath, dir: listed[0].dir, commit: listed[0].commit, name: listed[0].name }, { repoPath: 'acme/payments', dir: 'services/payments/api', commit: 'ccc', name: 'Payments API' });
  assert.equal(listed[0].files, undefined, 'no hashes in the list');
});

test('a synced copy maps back to its repo, so the repo\'s request and secrets rules apply', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'narado-sync-'));
  const sync = new SyncManager({ dataDir: tmp });
  const target = sync.targetFor('gitlab', 'acme/platform/payments', 'api');
  assert.deepEqual(
    (({ hostId, repoPath }) => ({ hostId, repoPath }))(sync.sourceOf(path.join(target, 'Payments', 'getPayment.bru'))),
    { hostId: 'gitlab', repoPath: 'acme/platform/payments' }
  );
  assert.equal(sync.sourceOf(path.join(tmp, 'collections', 'mine')), null);
  assert.equal(sync.sourceOf(path.join(tmp, 'synced')), null);
  assert.throws(() => sync.targetFor('../x', 'a/b', ''), /Invalid host id/);
  assert.deepEqual(listFiles(path.join(tmp, 'missing')), []);
});
