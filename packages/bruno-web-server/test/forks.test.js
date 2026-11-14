const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WorkspaceManager, runGit } = require('../src/narado/workspaces');
const { GitHubProvider } = require('../src/narado/providers/github');
const { GitLabProvider } = require('../src/narado/providers/gitlab');

const who = { GIT_AUTHOR_NAME: 'Seed', GIT_AUTHOR_EMAIL: 's@example.com', GIT_COMMITTER_NAME: 'Seed', GIT_COMMITTER_EMAIL: 's@example.com' };
const user = { name: 'Rita Reader', email: 'rita@example.com' };

let tmp;
let originUrl;
let forkUrl;
let mgr;

const commitTo = async (url, branch, files, message) => {
  const dir = fs.mkdtempSync(path.join(tmp, 'c-'));
  await runGit(['clone', '--quiet', '--branch', branch, url, dir]);
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), c);
  await runGit(['add', '--all'], { cwd: dir });
  await runGit(['commit', '--quiet', '-m', message], { cwd: dir, env: who });
  await runGit(['push', '--quiet', 'origin', branch], { cwd: dir });
};

const branchHead = async (url, branch) =>
  (await runGit(['ls-remote', url, `refs/heads/${branch}`])).stdout.split('\t')[0] || null;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'narado-fork-'));
  const origin = path.join(tmp, 'origin.git');
  await runGit(['init', '--quiet', '--bare', '--initial-branch=main', origin]);
  originUrl = `file://${origin}`;
  const seed = path.join(tmp, 'seed');
  await runGit(['clone', '--quiet', originUrl, seed]);
  await runGit(['checkout', '--quiet', '-b', 'main'], { cwd: seed });
  fs.writeFileSync(path.join(seed, 'bruno.json'), '{"version":"1","name":"Upstream","type":"collection"}');
  fs.writeFileSync(path.join(seed, 'a.bru'), 'one\n');
  await runGit(['add', '--all'], { cwd: seed });
  await runGit(['commit', '--quiet', '-m', 'seed'], { cwd: seed, env: who });
  await runGit(['push', '--quiet', 'origin', 'main'], { cwd: seed });

  // The person's fork: a copy of the repo under another remote.
  const fork = path.join(tmp, 'fork.git');
  await runGit(['clone', '--quiet', '--bare', originUrl, fork]);
  forkUrl = `file://${fork}`;

  mgr = new WorkspaceManager({ dataDir: path.join(tmp, 'data') });
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const repo = () => ({ hostId: 'local', repoPath: 'acme/upstream', cloneUrl: originUrl, defaultBranch: 'main' });

test('a change made through a fork pushes to the fork, never to the repo', async () => {
  const ws = await mgr.open({ ...repo(), branch: 'narado/rita/fix', via: 'fork', forkCloneUrl: forkUrl });
  assert.equal(ws.via, 'fork');
  fs.writeFileSync(path.join(ws.path, 'a.bru'), 'one\ntwo\n');
  await mgr.commit({ path: ws.path, message: 'fix', user });
  const { remote } = await mgr.push({ ...repo(), path: ws.path, branch: 'narado/rita/fix' });
  assert.equal(remote, 'fork');

  const local = (await runGit(['rev-parse', 'HEAD'], { cwd: ws.path })).stdout.trim();
  assert.equal(await branchHead(forkUrl, 'narado/rita/fix'), local);
  assert.equal(await branchHead(originUrl, 'narado/rita/fix'), null, 'nothing pushed to the original repo');

  const st = await mgr.status({ path: ws.path, defaultBranch: 'main' });
  assert.equal(st.via, 'fork');
  assert.equal(st.upstream, 'fork/narado/rita/fix');
  assert.equal(st.aheadOfDefault, 1);
});

test('updates still come from the original repo while working in a fork', async () => {
  await commitTo(originUrl, 'main', { 'b.bru': 'from upstream\n' }, 'upstream change');
  const ws = await mgr.open({ ...repo(), branch: 'narado/rita/fix', via: 'fork', forkCloneUrl: forkUrl });
  const res = await mgr.updateFromDefault({ ...repo(), path: ws.path, user });
  assert.deepEqual(res, { merged: true, conflicts: [] });
  assert.ok(fs.existsSync(path.join(ws.path, 'b.bru')));
  await mgr.push({ ...repo(), path: ws.path, branch: 'narado/rita/fix' });
  assert.equal(await branchHead(originUrl, 'narado/rita/fix'), null);
});

test('an existing branch in the fork can be opened', async () => {
  await commitTo(forkUrl, 'main', {}, 'noop').catch(() => {});
  // Someone (the same person, elsewhere) pushed a branch to the fork only.
  const dir = fs.mkdtempSync(path.join(tmp, 'f-'));
  await runGit(['clone', '--quiet', forkUrl, dir]);
  await runGit(['checkout', '--quiet', '-b', 'narado/rita/docs'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'docs.md'), '# docs');
  await runGit(['add', '--all'], { cwd: dir });
  await runGit(['commit', '--quiet', '-m', 'docs'], { cwd: dir, env: who });
  await runGit(['push', '--quiet', 'origin', 'narado/rita/docs'], { cwd: dir });

  const ws = await mgr.open({ ...repo(), branch: 'narado/rita/docs', via: 'fork', forkCloneUrl: forkUrl });
  assert.ok(fs.existsSync(path.join(ws.path, 'docs.md')));
  const st = await mgr.status({ path: ws.path, defaultBranch: 'main' });
  assert.equal(st.upstream, 'fork/narado/rita/docs');
});

test('branch changes in the same repo keep pushing to the repo', async () => {
  const ws = await mgr.open({ ...repo(), branch: 'narado/rita/direct' });
  assert.equal(ws.via, 'branch');
  fs.writeFileSync(path.join(ws.path, 'c.bru'), 'direct\n');
  await mgr.commit({ path: ws.path, message: 'direct', user });
  const { remote } = await mgr.push({ ...repo(), path: ws.path, branch: 'narado/rita/direct' });
  assert.equal(remote, 'origin');
  assert.ok(await branchHead(originUrl, 'narado/rita/direct'));
  assert.equal(await branchHead(forkUrl, 'narado/rita/direct'), null);
});

test('a branch cannot be reopened through the other route', async () => {
  await assert.rejects(
    mgr.open({ ...repo(), branch: 'narado/rita/direct', via: 'fork', forkCloneUrl: forkUrl }),
    /already open through the repo/
  );
  await assert.rejects(mgr.open({ ...repo(), branch: 'x/y', via: 'fork' }), /A fork is needed/);
});

/* ---------------------------------------------------------------- providers */

const fakeFetch = (routes) => {
  const calls = [];
  const fn = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ method, url, body: init.body ? JSON.parse(init.body) : undefined });
    const key = Object.keys(routes).find((k) => {
      const [m, p] = k.split(' ');
      return m === method && url.includes(p);
    });
    if (!key) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    const out = routes[key](url, init, calls);
    return new Response(JSON.stringify(out[1]), { status: out[0] });
  };
  fn.calls = calls;
  return fn;
};

const ghRepo = (full, extra = {}) => ({
  full_name: full,
  name: full.split('/')[1],
  private: false,
  default_branch: 'main',
  clone_url: `https://github.com/${full}.git`,
  html_url: `https://github.com/${full}`,
  permissions: { pull: true },
  ...extra
});

test('GitHub: creates a fork when none exists and waits until it is ready', async () => {
  let branchChecks = 0;
  const fetchImpl = fakeFetch({
    'GET /user': () => [200, { login: 'rita', id: 7 }],
    'GET /repos/acme/api/forks': () => [200, []],
    'POST /repos/acme/api/forks': () => [202, ghRepo('rita/api', { fork: true })],
    'GET /repos/rita/api/branches': () => (++branchChecks < 2 ? [404, { message: 'Not Found' }] : [200, [{ name: 'main' }]]),
    'GET /repos/rita/api': (url) =>
      (url.endsWith('/repos/rita/api') ? [200, ghRepo('rita/api', { fork: true, parent: { full_name: 'acme/api' } })] : [404, {}])
  });
  // First lookup of rita/api (before creation) must 404: route it explicitly.
  let first = true;
  const wrapped = async (url, init) => {
    if (first && url.endsWith('/repos/rita/api')) {
      first = false;
      return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    }
    return fetchImpl(url, init);
  };
  const gh = new GitHubProvider({ id: 'github', token: 't', fetchImpl: wrapped });
  const { fork, created } = await gh.ensureFork('acme/api', { pollMs: 0, sleep: async () => {} });
  assert.equal(created, true);
  assert.equal(fork.path, 'rita/api');
  assert.equal(fork.parentPath, 'acme/api');
  assert.ok(fetchImpl.calls.some((c) => c.method === 'POST' && c.url.endsWith('/repos/acme/api/forks')));
});

test('GitHub: reuses an existing fork and opens the pull request from it', async () => {
  const fetchImpl = fakeFetch({
    'GET /user': () => [200, { login: 'rita', id: 7 }],
    'GET /repos/rita/api': () => [200, ghRepo('rita/api', { fork: true, parent: { full_name: 'acme/api' } })],
    'POST /repos/acme/api/pulls': () => [201, { number: 9, title: 't', state: 'open', head: { ref: 'narado/rita/fix' }, base: { ref: 'main' }, html_url: 'u' }],
    'GET /repos/acme/api/pulls?': () => [200, []]
  });
  const gh = new GitHubProvider({ id: 'github', token: 't', fetchImpl });
  const { fork, created } = await gh.ensureFork('acme/api');
  assert.equal(created, false);
  assert.equal(fork.path, 'rita/api');

  await gh.createMergeRequest('acme/api', { sourceBranch: 'narado/rita/fix', targetBranch: 'main', title: 't', sourceRepoPath: 'rita/api' });
  const post = fetchImpl.calls.find((c) => c.method === 'POST');
  assert.equal(post.body.head, 'rita:narado/rita/fix');

  await gh.findMergeRequest('acme/api', 'narado/rita/fix', { sourceRepoPath: 'rita/api' });
  assert.ok(fetchImpl.calls.some((c) => c.url.includes(encodeURIComponent('rita:narado/rita/fix'))));
});

test('GitLab: forks, waits for the import, and opens the merge request on the fork', async () => {
  let polls = 0;
  const glProject = (p, extra = {}) => ({
    id: p === 'acme/api' ? 100 : 200,
    path_with_namespace: p,
    name: 'api',
    visibility: 'public',
    default_branch: 'main',
    http_url_to_repo: `https://gitlab.com/${p}.git`,
    web_url: `https://gitlab.com/${p}`,
    permissions: {},
    ...extra
  });
  const fetchImpl = fakeFetch({
    'GET /projects/acme%2Fapi/forks': () => [200, []],
    'POST /projects/acme%2Fapi/fork': () => [201, glProject('rita/api', { import_status: 'scheduled' })],
    'GET /projects/rita%2Fapi': () => [200, glProject('rita/api', { import_status: ++polls < 3 ? 'started' : 'finished', forked_from_project: { path_with_namespace: 'acme/api' } })],
    'GET /projects/acme%2Fapi/merge_requests?': () => [200, [
      { iid: 1, title: 'same-repo', state: 'opened', source_branch: 'narado/rita/fix', target_branch: 'main', source_project_id: 100, target_project_id: 100, web_url: 'a' },
      { iid: 2, title: 'from-fork', state: 'opened', source_branch: 'narado/rita/fix', target_branch: 'main', source_project_id: 200, target_project_id: 100, web_url: 'b' }
    ]],
    'GET /projects/acme%2Fapi/merge_requests/2/approvals': () => [200, { approved: false }],
    'GET /projects/acme%2Fapi': () => [200, glProject('acme/api')],
    'POST /projects/rita%2Fapi/merge_requests': () => [201, { iid: 2, title: 'from-fork', state: 'opened', source_branch: 'narado/rita/fix', target_branch: 'main', web_url: 'b' }]
  });
  const gl = new GitLabProvider({ id: 'gitlab', token: 't', fetchImpl });
  const { fork, created } = await gl.ensureFork('acme/api', { pollMs: 0, sleep: async () => {} });
  assert.equal(created, true);
  assert.equal(fork.path, 'rita/api');
  assert.equal(fork.parentPath, 'acme/api');
  assert.ok(polls >= 3, 'waited for the import to finish');

  await gl.createMergeRequest('acme/api', { sourceBranch: 'narado/rita/fix', targetBranch: 'main', title: 'from-fork', sourceRepoPath: 'rita/api' });
  const post = fetchImpl.calls.find((c) => c.method === 'POST' && c.url.includes('/merge_requests'));
  assert.ok(post.url.includes('/projects/rita%2Fapi/merge_requests'), 'created on the fork');
  assert.equal(post.body.target_project_id, 100);

  const found = await gl.findMergeRequest('acme/api', 'narado/rita/fix', { sourceRepoPath: 'rita/api' });
  assert.equal(found.title, 'from-fork', 'picks the merge request whose source is the fork');
});
