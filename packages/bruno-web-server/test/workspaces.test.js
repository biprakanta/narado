const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WorkspaceManager, runGit, parseStatus, branchFor, findCollections } = require('../src/narado/workspaces');

const user = { name: 'Alice Example', email: 'alice@example.com' };
let tmp;
let originUrl;
let mgr;

// Push a change straight to the "host" repo, as another person would.
const pushToOrigin = async (branch, files, message) => {
  const dir = fs.mkdtempSync(path.join(tmp, 'other-'));
  await runGit(['clone', '--quiet', '--branch', branch, originUrl, dir]);
  for (const [f, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), content);
  await runGit(['add', '--all'], { cwd: dir });
  await runGit(['commit', '--quiet', '-m', message], { cwd: dir, env: { GIT_AUTHOR_NAME: 'Bob', GIT_AUTHOR_EMAIL: 'bob@example.com', GIT_COMMITTER_NAME: 'Bob', GIT_COMMITTER_EMAIL: 'bob@example.com' } });
  await runGit(['push', '--quiet', 'origin', branch], { cwd: dir });
};

const request = (url) => `meta {\n  name: Get user\n  type: http\n  seq: 1\n}\n\nget {\n  url: ${url}\n  body: none\n  auth: none\n}\n`;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'narado-ws-'));
  const origin = path.join(tmp, 'origin.git');
  await runGit(['init', '--quiet', '--bare', '--initial-branch=main', origin]);
  originUrl = `file://${origin}`;

  const seed = path.join(tmp, 'seed');
  await runGit(['clone', '--quiet', originUrl, seed]);
  await runGit(['checkout', '--quiet', '-b', 'main'], { cwd: seed });
  fs.writeFileSync(path.join(seed, 'bruno.json'), JSON.stringify({ version: '1', name: 'Payments', type: 'collection' }));
  fs.writeFileSync(path.join(seed, 'get-user.bru'), request('https://api.example.com/users/1'));
  await runGit(['add', '--all'], { cwd: seed });
  await runGit(['commit', '--quiet', '-m', 'seed'], { cwd: seed, env: { GIT_AUTHOR_NAME: 'Seed', GIT_AUTHOR_EMAIL: 's@example.com', GIT_COMMITTER_NAME: 'Seed', GIT_COMMITTER_EMAIL: 's@example.com' } });
  await runGit(['push', '--quiet', 'origin', 'main'], { cwd: seed });

  mgr = new WorkspaceManager({ dataDir: path.join(tmp, 'data') });
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const repo = () => ({ hostId: 'local', repoPath: 'acme/payments', cloneUrl: originUrl, defaultBranch: 'main' });

test('branchFor builds narado/<login>/<topic>', () => {
  assert.equal(branchFor('Alice', 'Add refunds API!'), 'narado/alice/add-refunds-api');
  assert.throws(() => branchFor('alice', '   '), /short name/);
});

test('rejects unsafe repo paths and branch names', async () => {
  assert.throws(() => mgr.basePath('local', '../etc'), /Invalid repo path/);
  assert.throws(() => mgr.basePath('local', 'acme/../../x'), /Invalid repo path/);
  assert.throws(() => mgr.basePath('../x', 'acme/payments'), /Invalid host id/);
  await assert.rejects(mgr.open({ ...repo(), branch: 'bad..name' }), /not a valid branch name/);
});

test('opens a new branch from the default branch and finds the collection', async () => {
  const ws = await mgr.open({ ...repo(), branch: 'narado/alice/refunds' });
  assert.ok(fs.existsSync(path.join(ws.path, 'get-user.bru')));
  assert.deepEqual(ws.collections, [ws.path]);
  const st = await mgr.status({ path: ws.path, defaultBranch: 'main' });
  assert.equal(st.branch, 'narado/alice/refunds');
  assert.equal(st.files.length, 0);
  assert.equal(st.behindDefault, 0);
});

test('reopening a branch reuses its working copy', async () => {
  const a = await mgr.open({ ...repo(), branch: 'narado/alice/refunds' });
  fs.writeFileSync(path.join(a.path, 'scratch.txt'), 'keep me');
  const b = await mgr.open({ ...repo(), branch: 'narado/alice/refunds' });
  assert.equal(a.path, b.path);
  assert.ok(fs.existsSync(path.join(b.path, 'scratch.txt')));
  fs.rmSync(path.join(b.path, 'scratch.txt'));
});

test('commits with the person as author and pushes the branch', async () => {
  const ws = await mgr.open({ ...repo(), branch: 'narado/alice/refunds' });
  fs.writeFileSync(path.join(ws.path, 'get-user.bru'), request('https://api.example.com/v2/users/1'));
  const before = await mgr.status({ path: ws.path, defaultBranch: 'main' });
  assert.deepEqual(before.files.map((f) => f.path), ['get-user.bru']);

  const sha = await mgr.commit({ path: ws.path, message: 'Use v2 users endpoint', user });
  assert.match(sha, /^[0-9a-f]{7,}$/);
  const author = (await runGit(['log', '-1', '--format=%an <%ae>'], { cwd: ws.path })).stdout.trim();
  assert.equal(author, 'Alice Example <alice@example.com>');

  assert.equal(await mgr.commit({ path: ws.path, message: 'nothing', user }), null, 'empty commit is skipped');

  await mgr.push({ ...repo(), path: ws.path, branch: 'narado/alice/refunds' });
  const remoteSha = (await runGit(['ls-remote', originUrl, 'refs/heads/narado/alice/refunds'])).stdout.split('\t')[0];
  const localSha = (await runGit(['rev-parse', 'HEAD'], { cwd: ws.path })).stdout.trim();
  assert.equal(remoteSha, localSha);
  assert.ok(localSha.startsWith(sha));
  const st = await mgr.status({ path: ws.path, defaultBranch: 'main' });
  assert.equal(st.upstream, 'origin/narado/alice/refunds');
  assert.equal(st.ahead, 0);
  assert.equal(st.aheadOfDefault, 1);
});

test('opens a branch that already exists on the host', async () => {
  await pushToOrigin('main', { 'health.bru': request('https://api.example.com/health') }, 'add health');
  // Bob's branch, pushed from elsewhere.
  const dir = fs.mkdtempSync(path.join(tmp, 'bob-'));
  await runGit(['clone', '--quiet', originUrl, dir]);
  await runGit(['checkout', '--quiet', '-b', 'narado/bob/docs'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'docs.md'), '# Docs');
  await runGit(['add', '--all'], { cwd: dir });
  await runGit(['commit', '--quiet', '-m', 'docs'], { cwd: dir, env: { GIT_AUTHOR_NAME: 'Bob', GIT_AUTHOR_EMAIL: 'b@example.com', GIT_COMMITTER_NAME: 'Bob', GIT_COMMITTER_EMAIL: 'b@example.com' } });
  await runGit(['push', '--quiet', 'origin', 'narado/bob/docs'], { cwd: dir });

  const ws = await mgr.open({ ...repo(), branch: 'narado/bob/docs' });
  assert.ok(fs.existsSync(path.join(ws.path, 'docs.md')));
  const st = await mgr.status({ path: ws.path, defaultBranch: 'main' });
  assert.equal(st.upstream, 'origin/narado/bob/docs');
});

test('update from main merges cleanly when there is no overlap', async () => {
  const ws = await mgr.open({ ...repo(), branch: 'narado/alice/refunds' });
  const st = await mgr.status({ path: ws.path, defaultBranch: 'main' });
  // main gained health.bru in the previous test; status reflects the last fetch.
  const res = await mgr.updateFromDefault({ ...repo(), path: ws.path, user });
  assert.deepEqual(res, { merged: true, conflicts: [] });
  assert.ok(fs.existsSync(path.join(ws.path, 'health.bru')));
  assert.ok(st.behindDefault >= 0);
});

test('conflicts are reported, resolved per file, and committed', async () => {
  const ws = await mgr.open({ ...repo(), branch: 'narado/alice/refunds' });
  await pushToOrigin('main', { 'get-user.bru': request('https://api.example.com/v3/users/1') }, 'v3 on main');

  const res = await mgr.updateFromDefault({ ...repo(), path: ws.path, user });
  assert.equal(res.merged, false);
  assert.deepEqual(res.conflicts, ['get-user.bru']);

  const st = await mgr.status({ path: ws.path, defaultBranch: 'main' });
  assert.equal(st.merging, true);
  assert.deepEqual(st.conflicts, ['get-user.bru']);
  await assert.rejects(mgr.commit({ path: ws.path, message: 'x', user }), /Resolve conflicts first/);

  await mgr.resolve({ path: ws.path, file: 'get-user.bru', side: 'mine' });
  assert.match(fs.readFileSync(path.join(ws.path, 'get-user.bru'), 'utf8'), /v2\/users/);
  const sha = await mgr.commit({ path: ws.path, message: 'Merge main, keep v2', user });
  assert.ok(sha);
  const after = await mgr.status({ path: ws.path, defaultBranch: 'main' });
  assert.equal(after.merging, false);
  assert.equal(after.behindDefault, 0);
});

test('a merge can be abandoned', async () => {
  const ws = await mgr.open({ ...repo(), branch: 'narado/alice/refunds' });
  await pushToOrigin('main', { 'get-user.bru': request('https://api.example.com/v4/users/1') }, 'v4 on main');
  const res = await mgr.updateFromDefault({ ...repo(), path: ws.path, user });
  assert.equal(res.merged, false);
  await mgr.abortMerge({ path: ws.path });
  const st = await mgr.status({ path: ws.path, defaultBranch: 'main' });
  assert.equal(st.merging, false);
  assert.equal(st.files.length, 0);
});

test('resolve refuses paths outside the workspace', async () => {
  const ws = await mgr.open({ ...repo(), branch: 'narado/alice/refunds' });
  await assert.rejects(mgr.resolve({ path: ws.path, file: '../../escape', side: 'mine' }), /outside the workspace/);
});

test('updating with uncommitted changes is refused', async () => {
  const ws = await mgr.open({ ...repo(), branch: 'narado/alice/refunds' });
  fs.writeFileSync(path.join(ws.path, 'wip.txt'), 'wip');
  await assert.rejects(mgr.updateFromDefault({ ...repo(), path: ws.path, user }), /Commit or discard/);
  fs.rmSync(path.join(ws.path, 'wip.txt'));
});

test('listOpen and locate find working copies', async () => {
  const ws = await mgr.open({ ...repo(), branch: 'narado/alice/refunds' });
  const open = mgr.listOpen();
  assert.ok(open.some((o) => o.path === ws.path && o.repoPath === 'acme/payments' && o.hostId === 'local'));
  const loc = mgr.locate(path.join(ws.path, 'sub', 'folder'));
  assert.deepEqual(loc, { hostId: 'local', repoPath: 'acme/payments', path: ws.path });
  assert.equal(mgr.locate(tmp), null);
});

test('findCollections looks two levels down when the root is not a collection', () => {
  const root = fs.mkdtempSync(path.join(tmp, 'multi-'));
  fs.mkdirSync(path.join(root, 'apis', 'payments'), { recursive: true });
  fs.writeFileSync(path.join(root, 'apis', 'payments', 'bruno.json'), '{}');
  fs.mkdirSync(path.join(root, 'orders'));
  fs.writeFileSync(path.join(root, 'orders', 'opencollection.yml'), 'x: 1');
  assert.deepEqual(findCollections(root).sort(), [path.join(root, 'apis', 'payments'), path.join(root, 'orders')].sort());
});

test('parseStatus reads branch, upstream and counts', () => {
  const out = '## narado/a.b/c...origin/narado/a.b/c [ahead 2, behind 1]\0 M x.bru\0UU y.bru\0R  new.bru\0old.bru\0';
  const st = parseStatus(out);
  assert.equal(st.branch, 'narado/a.b/c');
  assert.equal(st.upstream, 'origin/narado/a.b/c');
  assert.equal(st.ahead, 2);
  assert.equal(st.behind, 1);
  assert.deepEqual(st.files.map((f) => f.path), ['x.bru', 'y.bru', 'new.bru']);
  assert.deepEqual(st.conflicts, ['y.bru']);
});
