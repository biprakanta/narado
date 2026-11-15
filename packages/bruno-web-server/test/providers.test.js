const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { GitHubProvider } = require('../src/narado/providers/github');
const { GitLabProvider } = require('../src/narado/providers/gitlab');
const { ProviderRegistry } = require('../src/narado/providers');
const { fromGitHubPermissions, fromGitLabAccessLevel } = require('../src/narado/providers/access');

/** Fake fetch: routes "METHOD url" to handlers, records calls. */
const fakeFetch = (routes) => {
  const calls = [];
  const fn = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ method, url, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const key = Object.keys(routes).find((k) => {
      const [m, p] = k.split(' ');
      return m === method && url.includes(p);
    });
    if (!key) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    const [status, body] = routes[key](url, init);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  fn.calls = calls;
  return fn;
};

test('access levels map as in the design', () => {
  assert.equal(fromGitHubPermissions({ pull: true }), 'read');
  assert.equal(fromGitHubPermissions({ pull: true, triage: true }), 'read');
  assert.equal(fromGitHubPermissions({ pull: true, push: true }), 'write');
  assert.equal(fromGitHubPermissions({ pull: true, push: true, maintain: true }), 'write');
  assert.equal(fromGitHubPermissions({ admin: true }), 'admin');
  assert.equal(fromGitHubPermissions({}), 'none');
  assert.equal(fromGitLabAccessLevel(10), 'read'); // Guest
  assert.equal(fromGitLabAccessLevel(20), 'read'); // Reporter
  assert.equal(fromGitLabAccessLevel(30), 'write'); // Developer
  assert.equal(fromGitLabAccessLevel(40), 'admin'); // Maintainer
  assert.equal(fromGitLabAccessLevel(50), 'admin'); // Owner
  assert.equal(fromGitLabAccessLevel(undefined), 'none');
});

test('GitHub: lists repos with access, sends the token as a bearer header', async () => {
  const fetchImpl = fakeFetch({
    'GET /user/repos': () => [200, [
      { full_name: 'acme/payments', name: 'payments', private: true, default_branch: 'main', clone_url: 'https://github.com/acme/payments.git', html_url: 'https://github.com/acme/payments', permissions: { pull: true, push: true } },
      { full_name: 'acme/docs', name: 'docs', private: false, default_branch: 'trunk', clone_url: 'x', html_url: 'y', permissions: { pull: true } }
    ]]
  });
  const gh = new GitHubProvider({ id: 'github', token: 't0k', fetchImpl });
  const repos = await gh.listRepos();
  assert.deepEqual(repos.map((r) => [r.path, r.access, r.defaultBranch]), [['acme/payments', 'write', 'main'], ['acme/docs', 'read', 'trunk']]);
  assert.equal(fetchImpl.calls[0].headers.authorization, 'Bearer t0k');
});

test('GitHub: opens a pull request and reads its review state', async () => {
  const fetchImpl = fakeFetch({
    'POST /repos/acme/payments/pulls': () => [201, { number: 7, title: 'Refunds', state: 'open', head: { ref: 'narado/alice/refunds' }, base: { ref: 'main' }, html_url: 'https://github.com/acme/payments/pull/7' }],
    'GET /repos/acme/payments/pulls/7/reviews': () => [200, [
      { user: { login: 'bob' }, state: 'CHANGES_REQUESTED' },
      { user: { login: 'bob' }, state: 'APPROVED' },
      { user: { login: 'carol' }, state: 'COMMENTED' }
    ]],
    'GET /repos/acme/payments/pulls?': () => [200, [{ number: 7, title: 'Refunds', state: 'closed', merged_at: '2026-11-14T00:00:00Z', head: { ref: 'narado/alice/refunds' }, base: { ref: 'main' }, html_url: 'u' }]]
  });
  const gh = new GitHubProvider({ id: 'github', token: 't', fetchImpl });
  const mr = await gh.createMergeRequest('acme/payments', { sourceBranch: 'narado/alice/refunds', targetBranch: 'main', title: 'Refunds' });
  assert.equal(mr.number, 7);
  assert.equal(mr.state, 'open');
  assert.deepEqual(fetchImpl.calls[0].body, { head: 'narado/alice/refunds', base: 'main', title: 'Refunds', body: '' });

  const found = await gh.findMergeRequest('acme/payments', 'narado/alice/refunds');
  assert.equal(found.state, 'merged');
  assert.equal(found.review, 'approved', "bob's latest review wins");
  assert.ok(fetchImpl.calls.some((c) => c.url.includes(encodeURIComponent('acme:narado/alice/refunds'))));
});

test('GitHub: git auth header uses x-access-token basic auth', async () => {
  const gh = new GitHubProvider({ id: 'github', token: 'abc' });
  assert.equal(await gh.gitAuthHeader(), `Authorization: Basic ${Buffer.from('x-access-token:abc').toString('base64')}`);
});

test('GitHub: API errors include the status and message but not the token', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ message: 'Validation Failed', errors: [{ message: 'A pull request already exists' }] }), { status: 422 });
  const gh = new GitHubProvider({ id: 'github', token: 'secret-token', fetchImpl });
  await assert.rejects(gh.createMergeRequest('a/b', { sourceBranch: 'x', targetBranch: 'main', title: 't' }), (err) => {
    assert.match(err.message, /422 Validation Failed \(A pull request already exists\)/);
    assert.doesNotMatch(err.message, /secret-token/);
    return true;
  });
});

test('GitLab: self-managed URL, project and group access, merge requests', async () => {
  const fetchImpl = fakeFetch({
    'GET /api/v4/projects?membership': () => [200, [
      { path_with_namespace: 'platform/payments', name: 'payments', visibility: 'private', default_branch: 'main', http_url_to_repo: 'https://gitlab.acme.internal/platform/payments.git', web_url: 'w', permissions: { project_access: { access_level: 30 }, group_access: { access_level: 40 } } },
      { path_with_namespace: 'platform/docs', name: 'docs', visibility: 'internal', default_branch: 'main', http_url_to_repo: 'x', web_url: 'y', permissions: { project_access: null, group_access: null } }
    ]],
    'POST /api/v4/projects/platform%2Fpayments/merge_requests': () => [201, { iid: 3, title: 'Refunds', state: 'opened', source_branch: 'narado/alice/refunds', target_branch: 'main', web_url: 'mr' }],
    'GET /api/v4/projects/platform%2Fpayments/merge_requests?source_branch': () => [200, [{ iid: 3, title: 'Refunds', state: 'merged', source_branch: 'narado/alice/refunds', target_branch: 'main', web_url: 'mr' }]],
    'GET /api/v4/projects/platform%2Fpayments/merge_requests/3/approvals': () => [200, { approved: true }]
  });
  const gl = new GitLabProvider({ id: 'acme', url: 'https://gitlab.acme.internal/', token: 'gl', fetchImpl });
  assert.equal(gl.name, 'GitLab (gitlab.acme.internal)');

  const repos = await gl.listRepos();
  assert.deepEqual(repos.map((r) => [r.path, r.access]), [['platform/payments', 'admin'], ['platform/docs', 'read']]);
  assert.ok(fetchImpl.calls[0].url.startsWith('https://gitlab.acme.internal/api/v4/'));

  const mr = await gl.createMergeRequest('platform/payments', { sourceBranch: 'narado/alice/refunds', targetBranch: 'main', title: 'Refunds' });
  assert.equal(mr.state, 'open');
  assert.equal(mr.number, 3);
  const found = await gl.findMergeRequest('platform/payments', 'narado/alice/refunds');
  assert.equal(found.state, 'merged');
  assert.equal(found.review, 'approved');
  assert.equal(await gl.gitAuthHeader(), `Authorization: Basic ${Buffer.from('oauth2:gl').toString('base64')}`);
});

test('registry: defaults, tokens only from the environment', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'narado-reg-'));
  const reg = new ProviderRegistry({ dataDir: dir, env: { NARADO_GITHUB_TOKEN: 'x' } });
  const hosts = reg.listHosts();
  assert.deepEqual(hosts.map((h) => [h.id, h.connected]), [['github', true], ['gitlab', false]]);
  assert.ok(hosts.every((h) => !('token' in h)));
  assert.equal(reg.get('github').type, 'github');
  assert.throws(() => reg.get('gitlab'), /set NARADO_GITLAB_TOKEN/);

  fs.writeFileSync(path.join(dir, 'narado.json'), JSON.stringify({ hosts: [{ id: 'acme-gitlab', type: 'gitlab', url: 'https://gitlab.acme.internal' }] }));
  const reg2 = new ProviderRegistry({ dataDir: dir, env: { NARADO_ACME_GITLAB_TOKEN: 'y' } });
  assert.deepEqual(reg2.listHosts().map((h) => [h.id, h.name, h.connected]), [['acme-gitlab', 'GitLab (gitlab.acme.internal)', true]]);

  fs.writeFileSync(path.join(dir, 'narado.json'), JSON.stringify({ hosts: [{ id: 'gh', type: 'github', token: 'nope' }] }));
  assert.throws(() => new ProviderRegistry({ dataDir: dir }), /environment variables/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('reads retry after a network failure; writes do not; errors name the host', async () => {
  const { requestJson } = require('../src/narado/providers/http');
  let calls = 0;
  const flaky = async () => {
    calls++;
    if (calls < 3) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    return new Response('{"ok":true}', { status: 200 });
  };
  const { data } = await requestJson('https://api.github.com/user', { fetchImpl: flaky, retryDelays: [0, 0] });
  assert.deepEqual(data, { ok: true });
  assert.equal(calls, 3);

  calls = 0;
  const down = async () => {
    calls++;
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
  };
  await assert.rejects(
    requestJson('https://api.github.com/repos/a/b/pulls', { method: 'POST', body: {}, fetchImpl: down, retryDelays: [0, 0] }),
    /Could not reach api\.github\.com \(ECONNRESET\)/
  );
  assert.equal(calls, 1, 'a POST is never repeated');
});

test('listing and reading files through the host API, for the catalogue', async () => {
  const gh = new GitHubProvider({
    id: 'github',
    token: 't',
    fetchImpl: fakeFetch({
      'GET /repos/acme/svc/git/trees/main?recursive=1': () => [200, { sha: 'abc', truncated: false, tree: [{ path: 'api', type: 'tree' }, { path: 'api/openapi.yaml', type: 'blob' }] }],
      'GET /repos/acme/svc/contents/api/open%20api.yaml?ref=main': () => [200, 'openapi: 3.1.0']
    })
  });
  assert.deepEqual(await gh.listFiles('acme/svc', 'main'), { files: ['api/openapi.yaml'], truncated: false, commit: 'abc' });
  assert.equal(await gh.readFile('acme/svc', 'main', 'api/open api.yaml'), 'openapi: 3.1.0');

  let page = 0;
  const glFetch = fakeFetch({
    'GET /api/v4/projects/acme%2Fsvc/repository/tree': () => {
      page++;
      return [200, page === 1 ? Array.from({ length: 100 }, (_, i) => ({ path: `f${i}`, type: 'blob' })) : [{ path: 'api/openapi.yaml', type: 'blob' }, { path: 'api', type: 'tree' }]];
    },
    'GET /api/v4/projects/acme%2Fsvc/repository/files/api%2Fopenapi.yaml/raw?ref=main': () => [200, { openapi: '3.1.0' }]
  });
  const gl = new GitLabProvider({ id: 'gitlab', token: 't', fetchImpl: glFetch });
  const listed = await gl.listFiles('acme/svc', 'main');
  assert.equal(listed.files.length, 101);
  assert.ok(listed.files.includes('api/openapi.yaml'));
  assert.equal(await gl.readFile('acme/svc', 'main', 'api/openapi.yaml'), '{"openapi":"3.1.0"}');
});

test('code-owner review on the default branch: rulesets, classic protection, or unknown', async () => {
  const gh = (routes) => new GitHubProvider({ id: 'github', token: 't', fetchImpl: fakeFetch(routes) });
  // A ruleset asks for code-owner review.
  let r = await gh({
    'GET /repos/acme/api/branches/main': () => [200, { protected: true }],
    'GET /repos/acme/api/rules/branches/main': () => [200, [{ type: 'pull_request', parameters: { require_code_owner_review: true } }]]
  }).reviewRules('acme/api', 'main');
  assert.deepEqual([r.protected, r.codeOwnerReview, r.sources], [true, true, ['ruleset']]);
  // Classic protection, readable: says no.
  r = await gh({
    'GET /repos/acme/api/branches/main/protection': () => [200, { required_pull_request_reviews: { require_code_owner_reviews: false } }],
    'GET /repos/acme/api/branches/main': () => [200, { protected: true }],
    'GET /repos/acme/api/rules/branches/main': () => [200, []]
  }).reviewRules('acme/api', 'main');
  assert.equal(r.codeOwnerReview, false);
  // Protected, but details need admin rights: unknown.
  r = await gh({
    'GET /repos/acme/api/branches/main/protection': () => [403, { message: 'Must have admin rights' }],
    'GET /repos/acme/api/branches/main': () => [200, { protected: true }],
    'GET /repos/acme/api/rules/branches/main': () => [403, { message: 'Upgrade to GitHub Pro' }]
  }).reviewRules('acme/api', 'main');
  assert.equal(r.codeOwnerReview, null);
  // Not protected at all.
  r = await gh({
    'GET /repos/acme/api/branches/main': () => [200, { protected: false }],
    'GET /repos/acme/api/rules/branches/main': () => [403, { message: 'Upgrade to GitHub Pro' }]
  }).reviewRules('acme/api', 'main');
  assert.equal(r.codeOwnerReview, false);

  const gl = (routes) => new GitLabProvider({ id: 'gitlab', token: 't', fetchImpl: fakeFetch(routes) });
  r = await gl({ 'GET /api/v4/projects/acme%2Fapi/protected_branches/main': () => [200, { name: 'main', code_owner_approval_required: true }] }).reviewRules('acme/api', 'main');
  assert.equal(r.codeOwnerReview, true);
  r = await gl({}).reviewRules('acme/api', 'main');
  assert.deepEqual([r.protected, r.codeOwnerReview], [false, false]);
});
