const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WorkspaceManager, runGit } = require('../src/narado/workspaces');
const { AllowlistReader } = require('../src/narado/requests/allowlist');

const who = { GIT_AUTHOR_NAME: 'Seed', GIT_AUTHOR_EMAIL: 's@example.com', GIT_COMMITTER_NAME: 'Seed', GIT_COMMITTER_EMAIL: 's@example.com' };
const user = { name: 'Alice Example', email: 'alice@example.com' };

/** A code repository on a "host" that serves partial clones, with its API in subfolders. */
const codeRepo = async (tmp) => {
  const origin = path.join(tmp, 'origin.git');
  await runGit(['init', '--quiet', '--bare', '--initial-branch=main', origin]);
  await runGit(['config', 'uploadpack.allowFilter', 'true'], { cwd: origin });
  await runGit(['config', 'uploadpack.allowAnySHA1InWant', 'true'], { cwd: origin });
  const seed = path.join(tmp, 'seed');
  await runGit(['clone', '--quiet', `file://${origin}`, seed]);
  await runGit(['checkout', '--quiet', '-b', 'main'], { cwd: seed });
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(seed, rel)), { recursive: true });
    fs.writeFileSync(path.join(seed, rel), text);
  };
  write('README.md', '# Payments service\n');
  for (let i = 0; i < 30; i++) write(`src/module${i}/code.bin`, 'x'.repeat(20000) + i);
  write('services/payments/api/openapi.yaml', 'openapi: 3.1.0\ninfo: {title: Payments, version: 1}\nservers: [{url: "https://pay.example.test"}]\npaths: {}\n');
  write('services/payments/api/.client/allowed-hosts.yml', 'hosts:\n  - partner.example.test\n');
  await runGit(['add', '--all'], { cwd: seed });
  await runGit(['commit', '--quiet', '-m', 'seed'], { cwd: seed, env: who });
  await runGit(['push', '--quiet', 'origin', 'main'], { cwd: seed });
  return { url: `file://${origin}`, origin, seed };
};

const files = (dir) =>
  fs
    .readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => !f.startsWith('.git') && fs.statSync(path.join(dir, f)).isFile());

test('a code repository opens as a partial clone with only its collection folders checked out', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'narado-sparse-'));
  try {
    const { url, seed } = await codeRepo(tmp);
    const asked = [];
    const mgr = new WorkspaceManager({
      dataDir: path.join(tmp, 'data'),
      authFor: async (hostId) => {
        asked.push(hostId);
        return 'Authorization: Basic dGVzdA==';
      }
    });
    const repo = { hostId: 'local', repoPath: 'acme/payments-service', cloneUrl: url, defaultBranch: 'main' };
    const sparse = ['services/payments/api'];

    const ws = await mgr.open({ ...repo, branch: 'main', sparse });
    const base = mgr.basePath('local', 'acme/payments-service');
    assert.equal(mgr.isPartial(base), true, 'cloned without file contents');
    assert.deepEqual(files(ws.path).sort(), ['README.md', 'services/payments/api/.client/allowed-hosts.yml', 'services/payments/api/openapi.yaml']);
    assert.ok(asked.length > 0, 'commands that may fetch file contents carry the token');
    assert.deepEqual(await mgr.sparseFolders(ws.path), ['services/payments/api']);

    // A change on a branch keeps the same folders, and commits and pushes as usual.
    const change = await mgr.open({ ...repo, branch: 'narado/alice/refunds', sparse });
    fs.appendFileSync(path.join(change.path, 'services/payments/api/openapi.yaml'), '# refunds\n');
    await mgr.commit({ path: change.path, message: 'Add refunds', user });
    await mgr.push({ ...repo, path: change.path, branch: 'narado/alice/refunds', authHeader: null });
    const { stdout } = await runGit(['ls-remote', url, 'refs/heads/narado/alice/refunds']);
    assert.ok(stdout.trim(), 'the branch reached the host');

    // Edits on the default branch saved as a change keep the sparse folders too.
    fs.appendFileSync(path.join(ws.path, 'services/payments/api/openapi.yaml'), '# from main\n');
    const saved = await mgr.saveAsChange({ ...repo, fromPath: ws.path, branch: 'narado/alice/from-main', message: 'From main', user });
    assert.deepEqual(await mgr.sparseFolders(saved.path), ['services/payments/api']);
    assert.ok(!files(saved.path).some((f) => f.startsWith('src/')));

    // A collection folder added on the host later is added to an existing working copy.
    fs.mkdirSync(path.join(seed, 'services/refunds/api'), { recursive: true });
    fs.writeFileSync(path.join(seed, 'services/refunds/api/openapi.yaml'), 'openapi: 3.1.0\ninfo: {title: Refunds, version: 1}\npaths: {}\n');
    await runGit(['add', '--all'], { cwd: seed });
    await runGit(['commit', '--quiet', '-m', 'refunds api'], { cwd: seed, env: who });
    await runGit(['push', '--quiet', 'origin', 'main'], { cwd: seed });
    const again = await mgr.open({ ...repo, branch: 'main', sparse: ['services/payments/api', 'services/refunds/api'] });
    assert.ok(files(again.path).includes('services/refunds/api/openapi.yaml'));

    // Allowlists are read from the clone, fetching contents with the token as needed.
    const reader = new AllowlistReader({ envFor: (b) => mgr.gitEnvFor(b) });
    const rules = await reader.rulesFor({ base, repo: 'local:acme/payments-service' });
    assert.equal(rules.allowsHost('partner.example.test', 443), true);
    assert.equal(rules.allowsHost('pay.example.test', 443), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('API repos and repos opened without folders are still full clones', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'narado-sparse-'));
  try {
    const { url } = await codeRepo(tmp);
    const mgr = new WorkspaceManager({ dataDir: path.join(tmp, 'data'), authFor: async () => null });
    const ws = await mgr.open({ hostId: 'local', repoPath: 'acme/full', cloneUrl: url, defaultBranch: 'main', branch: 'main' });
    assert.equal(mgr.isPartial(mgr.basePath('local', 'acme/full')), false);
    assert.ok(files(ws.path).some((f) => f.startsWith('src/')));
    assert.equal(await mgr.sparseFolders(ws.path), null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
