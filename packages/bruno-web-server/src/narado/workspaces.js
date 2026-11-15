/**
 * Git-backed workspaces (design §7).
 *
 * Layout under <data dir>/git:
 *   <hostId>/<owner>/<repo>.git                     one bare clone per repo, shared by its branches
 *   <hostId>/<owner>/<repo>/worktrees/<branch>/     one working copy per branch (git worktree)
 *
 * Authentication: the host's HTTP header is passed to Git through GIT_CONFIG_* environment
 * variables for each command. Tokens are never written to remote URLs, Git config or disk.
 */
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO_PATH_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)+$/;
const HOST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

class GitError extends Error {
  constructor(message, { code, stdout, stderr } = {}) {
    super(message);
    this.name = 'GitError';
    this.code = code;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

const NETWORK_COMMANDS = new Set(['clone', 'fetch', 'push', 'pull', 'ls-remote']);
const NETWORK_TIMEOUT_MS = 2 * 60 * 1000;
const LOCAL_TIMEOUT_MS = 60 * 1000;

/** Run git and return stdout. Rejects with GitError on a non-zero exit or a timeout. */
const runGit = (args, { cwd, env = {}, allowExit = [] } = {}) =>
  new Promise((resolve, reject) => {
    const timeout = NETWORK_COMMANDS.has(args[0]) ? NETWORK_TIMEOUT_MS : LOCAL_TIMEOUT_MS;
    const child = execFile(
      'git',
      args,
      {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', SSH_ASKPASS: 'echo', LC_ALL: 'C', ...env },
        maxBuffer: 64 * 1024 * 1024,
        timeout,
        killSignal: 'SIGKILL'
      },
      (err, stdout, stderr) => {
        if (err && err.killed) {
          reject(new GitError(`git ${args[0]} timed out after ${Math.round(timeout / 1000)}s`, { code: 'ETIMEDOUT', stdout, stderr }));
          return;
        }
        if (err && !allowExit.includes(err.code)) {
          // Strip anything that looks like an auth header from the message.
          const clean = String(stderr || err.message).replace(/Authorization: \S+ \S+/gi, 'Authorization: [hidden]');
          reject(new GitError(`git ${args[0]} failed: ${clean.trim()}`, { code: err.code, stdout, stderr: clean }));
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr), code: err ? err.code : 0 });
      }
    );
    // Git never needs input from us; an open stdin can leave helpers waiting.
    if (child.stdin) child.stdin.end();
  });

/**
 * Per-command Git config through environment variables: the host's auth header,
 * and aborting transfers that stall (under 1 KB/s for 30 s).
 */
const authEnv = (authHeader) => {
  const entries = [
    // An empty helper clears inherited ones (for example the macOS keychain), so a
    // rejected token fails at once instead of waiting on a prompt nobody can see.
    ['credential.helper', ''],
    ['http.lowSpeedLimit', '1000'],
    ['http.lowSpeedTime', '30']
  ];
  if (authHeader) entries.push(['http.extraHeader', authHeader]);
  const env = { GIT_CONFIG_COUNT: String(entries.length) };
  entries.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  return env;
};

const identityEnv = (user) =>
  user
    ? {
        GIT_AUTHOR_NAME: user.name,
        GIT_AUTHOR_EMAIL: user.email,
        GIT_COMMITTER_NAME: user.name,
        GIT_COMMITTER_EMAIL: user.email
      }
    : {};

/** Turn free text into a safe branch topic: "Add payments API!" -> "add-payments-api". */
const slugify = (text) =>
  String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);

/** Branch name for a person's change, design §7: narado/<login>/<topic>. */
const branchFor = (login, topic) => {
  const t = slugify(topic);
  if (!t) throw new Error('Give the change a short name');
  return `narado/${slugify(login) || 'user'}/${t}`;
};

/** Folder name for a branch's working copy. */
const branchDir = (branch) => branch.replace(/[^A-Za-z0-9._-]+/g, '__');

/** Parse `git status --porcelain=v1 -b -z` output. */
const parseStatus = (out) => {
  const entries = out.split('\0').filter(Boolean);
  const result = { branch: null, upstream: null, ahead: 0, behind: 0, files: [], conflicts: [] };
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.startsWith('## ')) {
      // "## <branch>[...<upstream>][ [ahead N, behind M]]". Branch names cannot contain "..".
      let head = e.slice(3).replace(/^No commits yet on /, '');
      const bracket = head.indexOf(' [');
      const counts = bracket >= 0 ? head.slice(bracket + 2, -1) : '';
      if (bracket >= 0) head = head.slice(0, bracket);
      const [branch, upstream] = head.split('...');
      result.branch = branch;
      result.upstream = upstream || null;
      const ahead = /ahead (\d+)/.exec(counts);
      const behind = /behind (\d+)/.exec(counts);
      result.ahead = ahead ? Number(ahead[1]) : 0;
      result.behind = behind ? Number(behind[1]) : 0;
      continue;
    }
    const xy = e.slice(0, 2);
    const file = e.slice(3);
    if (xy[0] === 'R' || xy[0] === 'C') i++; // rename/copy: next entry is the old path
    const conflicted = ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(xy);
    if (conflicted) result.conflicts.push(file);
    result.files.push({ path: file, status: xy.trim() || xy, conflicted });
  }
  return result;
};

const COLLECTION_MARKERS = ['bruno.json', 'opencollection.yml'];

/** Collection folders in a working copy: the root, or folders up to two levels down. */
const findCollections = (root) => {
  const found = [];
  const isCollection = (dir) => COLLECTION_MARKERS.some((m) => fs.existsSync(path.join(dir, m)));
  if (isCollection(root)) return [root];
  const walk = (dir, depth) => {
    if (depth > 2) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const p = path.join(dir, entry.name);
      if (isCollection(p)) found.push(p);
      else walk(p, depth + 1);
    }
  };
  walk(root, 1);
  return found;
};

class WorkspaceManager {
  /**
   * @param {object} opts
   * @param {string} opts.dataDir
   */
  constructor({ dataDir, authFor = null }) {
    this.root = path.join(dataDir, 'git');
    // Partial clones (code repositories) fetch file contents when Git first needs them, from
    // any command, so every command on one gets the person's token: authFor(hostId) -> header.
    this.authFor = authFor;
    this.partial = new Map(); // base -> boolean
    // Generated Bruno collections for OpenAPI repos, mirroring the worktree layout.
    this.viewsRoot = path.join(dataDir, 'views');
    fs.mkdirSync(this.root, { recursive: true });
    this.locks = new Map();
  }

  /** The bare clone a path belongs to (the clone itself, or one of its worktrees). */
  baseOf(cwd) {
    if (!cwd) return null;
    const loc = this.locate(cwd);
    if (loc) return this.basePath(loc.hostId, loc.repoPath);
    const rel = path.relative(this.root, path.resolve(cwd));
    if (rel.startsWith('..') || path.isAbsolute(rel) || !rel.endsWith('.git')) return null;
    return path.resolve(cwd);
  }

  isPartial(base) {
    if (!this.partial.has(base)) {
      let text = '';
      try {
        text = fs.readFileSync(path.join(base, 'config'), 'utf8');
      } catch {
        return false; // not cloned yet; don't remember
      }
      this.partial.set(base, /^\s*promisor\s*=\s*true/m.test(text));
    }
    return this.partial.get(base);
  }

  /** Environment for Git in `cwd`: the person's token when it is a partial clone. */
  async gitEnvFor(cwd) {
    const base = this.authFor ? this.baseOf(cwd) : null;
    if (!base || !this.isPartial(base)) return {};
    const hostId = path.relative(this.root, base).split(path.sep)[0];
    const header = await Promise.resolve(this.authFor(hostId)).catch(() => null);
    return authEnv(header);
  }

  /** Git, with the person's token when the repository is a partial clone. */
  async git(args, opts = {}) {
    const env = opts.env || {};
    return runGit(args, { ...opts, env: env.GIT_CONFIG_COUNT ? env : { ...(await this.gitEnvFor(opts.cwd)), ...env } });
  }

  /**
   * Add a worktree. With `sparse` (folders), only those folders and the files at the
   * root are checked out (cone mode), which keeps a large code repository small on disk.
   */
  async addWorktree(base, wt, { options = [], commitish }, sparse) {
    const tail = commitish ? [wt, commitish] : [wt];
    if (!sparse || !sparse.length) {
      await this.git(['worktree', 'add', '--quiet', ...options, ...tail], { cwd: base });
      return;
    }
    await this.git(['worktree', 'add', '--quiet', '--no-checkout', ...options, ...tail], { cwd: base });
    await this.git(['sparse-checkout', 'set', '--cone', '--', ...sparse], { cwd: wt });
    await this.git(['checkout', '--quiet'], { cwd: wt });
  }

  /** Folders a worktree checks out, or null when it has everything. */
  async sparseFolders(wt) {
    const { stdout, code } = await this.git(['sparse-checkout', 'list'], { cwd: wt, allowExit: [128] });
    if (code !== 0) return null;
    const enabled = (await this.git(['config', '--bool', 'core.sparseCheckout'], { cwd: wt, allowExit: [1] })).stdout.trim() === 'true';
    return enabled ? stdout.split('\n').filter(Boolean) : null;
  }

  /** Where the Bruno view of a working copy lives (OpenAPI repos only). */
  viewPath(worktreePath) {
    return path.join(this.viewsRoot, path.relative(this.root, worktreePath));
  }

  /** Serialise operations per repo, so two requests never run git on one clone at once. */
  async withLock(key, fn) {
    const prev = this.locks.get(key) || Promise.resolve();
    let release;
    const next = new Promise((r) => (release = r));
    this.locks.set(key, prev.then(() => next));
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(key) === next) this.locks.delete(key);
    }
  }

  checkIds(hostId, repoPath) {
    if (!HOST_ID_RE.test(hostId)) throw new Error(`Invalid host id "${hostId}"`);
    if (!REPO_PATH_RE.test(repoPath) || repoPath.split('/').some((s) => s === '..' || s === '.')) {
      throw new Error(`Invalid repo path "${repoPath}"`);
    }
  }

  basePath(hostId, repoPath) {
    this.checkIds(hostId, repoPath);
    return path.join(this.root, hostId, `${repoPath}.git`);
  }

  worktreePath(hostId, repoPath, branch) {
    this.checkIds(hostId, repoPath);
    return path.join(this.root, hostId, repoPath, 'worktrees', branchDir(branch));
  }

  async checkBranchName(branch) {
    await this.git(['check-ref-format', '--branch', branch]).catch(() => {
      throw new Error(`"${branch}" is not a valid branch name`);
    });
  }

  /**
   * Clone (bare) on first use, then fetch. With `forkCloneUrl`, also keep a `fork`
   * remote pointing at the person's fork. Returns the bare repo path.
   */
  async ensureBase({ hostId, repoPath, cloneUrl, authHeader, forkCloneUrl, partial = false }) {
    const base = this.basePath(hostId, repoPath);
    const env = authEnv(authHeader);
    if (!fs.existsSync(path.join(base, 'HEAD'))) {
      fs.mkdirSync(path.dirname(base), { recursive: true });
      // A code repository is cloned without file contents; Git fetches the ones it needs.
      await this.git(['clone', '--bare', '--quiet', ...(partial ? ['--filter=blob:none'] : []), cloneUrl, base], { env });
      this.partial.delete(base);
      // Bare clones map remote branches straight onto local ones; track them as origin/* instead.
      await this.git(['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'], { cwd: base });
    }
    await this.git(['fetch', '--prune', '--quiet', 'origin'], { cwd: base, env });
    if (forkCloneUrl) await this.setForkRemote(base, forkCloneUrl);
    if (await this.hasRemote(base, 'fork')) {
      await this.git(['fetch', '--prune', '--quiet', 'fork'], { cwd: base, env });
    }
    return base;
  }

  async hasRemote(base, name) {
    const { stdout } = await this.git(['remote'], { cwd: base });
    return stdout.split('\n').includes(name);
  }

  async setForkRemote(base, url) {
    if (await this.hasRemote(base, 'fork')) {
      await this.git(['remote', 'set-url', 'fork', url], { cwd: base });
    } else {
      await this.git(['remote', 'add', 'fork', url], { cwd: base });
    }
    await this.git(['config', 'remote.fork.fetch', '+refs/heads/*:refs/remotes/fork/*'], { cwd: base });
    if (this.isPartial(base)) {
      // Fetch the fork the same way, or Git would download all of its file contents.
      await this.git(['config', 'remote.fork.promisor', 'true'], { cwd: base });
      await this.git(['config', 'remote.fork.partialclonefilter', 'blob:none'], { cwd: base });
    }
  }

  async remoteBranchExists(base, branch, remote = 'origin') {
    const { code } = await this.git(['show-ref', '--verify', '--quiet', `refs/remotes/${remote}/${branch}`], { cwd: base, allowExit: [1] });
    return code === 0;
  }

  /** Where a branch pushes: 'fork' for changes made through a fork, otherwise 'origin'. */
  async pushRemoteFor(cwd, branch) {
    const { stdout, code } = await this.git(['config', '--get', `branch.${branch}.pushRemote`], { cwd, allowExit: [1] });
    return code === 0 && stdout.trim() ? stdout.trim() : 'origin';
  }

  async localBranchExists(base, branch) {
    const { code } = await this.git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: base, allowExit: [1] });
    return code === 0;
  }

  /**
   * Open a branch's working copy, creating it if needed.
   *
   * `via: 'branch'` (default) works on a branch in the repo itself. `via: 'fork'` works on
   * a branch in the person's fork (`forkCloneUrl`): the branch is read from and pushed to the
   * fork, while updates still come from the repo's default branch.
   * A branch that exists on the host is checked out; a new one starts from `defaultBranch`.
   */
  async open({ hostId, repoPath, cloneUrl, authHeader, branch, defaultBranch, via = 'branch', forkCloneUrl, sparse = null }) {
    await this.checkBranchName(branch);
    if (!['branch', 'fork'].includes(via)) throw new Error('via must be "branch" or "fork"');
    if (via === 'fork' && !forkCloneUrl) throw new Error('A fork is needed to work through a fork');
    const remote = via === 'fork' ? 'fork' : 'origin';

    return this.withLock(`${hostId}/${repoPath}`, async () => {
      const base = await this.ensureBase({ hostId, repoPath, cloneUrl, authHeader, forkCloneUrl: via === 'fork' ? forkCloneUrl : undefined, partial: !!sparse });
      const wt = this.worktreePath(hostId, repoPath, branch);

      // A branch belongs to one route (the repo or the fork); never switch it silently.
      if (await this.localBranchExists(base, branch)) {
        const current = await this.pushRemoteFor(base, branch);
        if (current !== remote) {
          throw new Error(`Branch "${branch}" is already open through ${current === 'fork' ? 'your fork' : 'the repo'}`);
        }
      }

      if (!fs.existsSync(path.join(wt, '.git'))) {
        fs.mkdirSync(path.dirname(wt), { recursive: true });
        await this.git(['worktree', 'prune'], { cwd: base });
        if (await this.localBranchExists(base, branch)) {
          await this.addWorktree(base, wt, { commitish: branch }, sparse);
        } else if (await this.remoteBranchExists(base, branch, remote)) {
          await this.addWorktree(base, wt, { options: ['--track', '-b', branch], commitish: `${remote}/${branch}` }, sparse);
        } else {
          if (!(await this.remoteBranchExists(base, defaultBranch))) {
            throw new Error(`The repo has no "${defaultBranch}" branch to start from. Is it empty?`);
          }
          await this.addWorktree(base, wt, { options: ['--no-track', '-b', branch], commitish: `origin/${defaultBranch}` }, sparse);
        }
        if (via === 'fork') {
          await this.git(['config', `branch.${branch}.pushRemote`, 'fork'], { cwd: base });
        }
      } else if (sparse && sparse.length) {
        // An existing sparse worktree also gets collection folders added since it was made.
        const have = await this.sparseFolders(wt);
        const missing = have ? sparse.filter((d) => !have.includes(d)) : [];
        if (missing.length) await this.git(['sparse-checkout', 'add', '--', ...missing], { cwd: wt });
      }

      // The default branch is only ever read from the host, so bring it up to date
      // (fast-forward only, and never over uncommitted edits).
      if (branch === defaultBranch) await this.fastForward(wt, `origin/${defaultBranch}`);

      return { path: wt, branch, via: await this.viaFor(wt, branch), collections: findCollections(wt) };
    });
  }

  /** Fast-forward a clean working copy to `ref`. Returns true if it moved. */
  async fastForward(wt, ref) {
    const st = parseStatus((await this.git(['status', '--porcelain=v1', '-b', '-z'], { cwd: wt })).stdout);
    if (st.files.length) return false;
    const before = (await this.git(['rev-parse', 'HEAD'], { cwd: wt })).stdout.trim();
    const { code } = await this.git(['merge', '--ff-only', '--quiet', ref], { cwd: wt, allowExit: [1, 128] });
    if (code !== 0) return false;
    return (await this.git(['rev-parse', 'HEAD'], { cwd: wt })).stdout.trim() !== before;
  }

  async viaFor(wt, branch) {
    return (await this.pushRemoteFor(wt, branch)) === 'fork' ? 'fork' : 'branch';
  }

  /** Working copies that exist on disk, for reopening after a restart. */
  listOpen() {
    const out = [];
    if (!fs.existsSync(this.root)) return out;
    for (const hostId of fs.readdirSync(this.root)) {
      const hostDir = path.join(this.root, hostId);
      const walk = (dir, parts) => {
        if (parts.length > 4) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const p = path.join(dir, entry.name);
          if (entry.name === 'worktrees' && parts.length >= 2) {
            for (const b of fs.readdirSync(p)) {
              if (fs.existsSync(path.join(p, b, '.git'))) {
                out.push({ hostId, repoPath: parts.join('/'), path: path.join(p, b) });
              }
            }
          } else if (!entry.name.endsWith('.git')) {
            walk(p, [...parts, entry.name]);
          }
        }
      };
      walk(hostDir, []);
    }
    return out;
  }

  /** Which workspace a folder (a working copy, a collection in it, or its view) belongs to, or null. */
  locate(somePath) {
    const resolved = path.resolve(somePath);
    const viewRel = path.relative(this.viewsRoot, resolved);
    if (!viewRel.startsWith('..') && !path.isAbsolute(viewRel)) {
      return this.locate(path.join(this.root, viewRel));
    }
    const rel = path.relative(this.root, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    const parts = rel.split(path.sep);
    const i = parts.indexOf('worktrees');
    if (i < 3 || parts.length < i + 2) return null;
    return {
      hostId: parts[0],
      repoPath: parts.slice(1, i).join('/'),
      path: path.join(this.root, ...parts.slice(0, i + 2))
    };
  }

  async status({ path: wt, defaultBranch }) {
    const { stdout } = await this.git(['status', '--porcelain=v1', '-b', '-z', '--untracked-files=all'], { cwd: wt });
    const status = parseStatus(stdout);
    const gitDir = (await this.git(['rev-parse', '--git-dir'], { cwd: wt })).stdout.trim();
    status.merging = fs.existsSync(path.resolve(wt, gitDir, 'MERGE_HEAD'));
    status.via = status.branch ? await this.viaFor(wt, status.branch) : 'branch';
    status.behindDefault = 0;
    status.aheadOfDefault = 0;
    if (defaultBranch) {
      const { stdout: counts, code } = await this.git(
        ['rev-list', '--left-right', '--count', `HEAD...origin/${defaultBranch}`],
        { cwd: wt, allowExit: [128] }
      );
      if (code === 0) {
        const [ahead, behind] = counts.trim().split(/\s+/).map(Number);
        status.aheadOfDefault = ahead;
        status.behindDefault = behind;
      }
    }
    status.defaultBranch = defaultBranch || null;
    return status;
  }

  /** Stage everything and commit. Returns the new commit's short hash, or null when nothing changed. */
  async commit({ path: wt, message, user }) {
    if (!message || !message.trim()) throw new Error('A commit message is required');
    const st = parseStatus((await this.git(['status', '--porcelain=v1', '-b', '-z'], { cwd: wt })).stdout);
    if (st.conflicts.length) throw new Error(`Resolve conflicts first: ${st.conflicts.join(', ')}`);
    await this.git(['add', '--all'], { cwd: wt });
    const { code } = await this.git(['diff', '--cached', '--quiet'], { cwd: wt, allowExit: [1] });
    if (code === 0) {
      // Nothing staged. Still allow finishing a merge whose conflicts were resolved.
      const gitDir = (await this.git(['rev-parse', '--git-dir'], { cwd: wt })).stdout.trim();
      if (!fs.existsSync(path.resolve(wt, gitDir, 'MERGE_HEAD'))) return null;
    }
    await this.git(['commit', '--quiet', '-m', message.trim()], { cwd: wt, env: identityEnv(user) });
    return (await this.git(['rev-parse', '--short', 'HEAD'], { cwd: wt })).stdout.trim();
  }

  /**
   * Turn uncommitted edits in a default-branch working copy into a change: a new branch
   * (in the repo, or in the person's fork) starting from the same commit, carrying the
   * edits, committed as the person. The default-branch copy is left clean.
   * Returns the new branch's workspace.
   */
  async saveAsChange({ hostId, repoPath, fromPath, branch, via = 'branch', forkCloneUrl, authHeader, message, user }) {
    await this.checkBranchName(branch);
    if (!message || !message.trim()) throw new Error('A commit message is required');
    if (via === 'fork' && !forkCloneUrl) throw new Error('A fork is needed to save through a fork');

    return this.withLock(`${hostId}/${repoPath}`, async () => {
      const base = this.basePath(hostId, repoPath);
      const st = parseStatus((await this.git(['status', '--porcelain=v1', '-b', '-z', '--untracked-files=all'], { cwd: fromPath })).stdout);
      if (!st.files.length) throw new Error('There are no changes to save');
      if (st.conflicts.length) throw new Error(`Resolve conflicts first: ${st.conflicts.join(', ')}`);
      if (await this.localBranchExists(base, branch)) throw new Error(`Branch "${branch}" already exists. Pick another name.`);

      if (via === 'fork') {
        await this.setForkRemote(base, forkCloneUrl);
        await this.git(['fetch', '--prune', '--quiet', 'fork'], { cwd: base, env: authEnv(authHeader) });
      }

      const head = (await this.git(['rev-parse', 'HEAD'], { cwd: fromPath })).stdout.trim();
      const wt = this.worktreePath(hostId, repoPath, branch);
      fs.mkdirSync(path.dirname(wt), { recursive: true });
      await this.git(['worktree', 'prune'], { cwd: base });
      await this.addWorktree(base, wt, { options: ['--no-track', '-b', branch], commitish: head }, await this.sparseFolders(fromPath));
      if (via === 'fork') await this.git(['config', `branch.${branch}.pushRemote`, 'fork'], { cwd: base });

      // The stash is shared by all worktrees of a repo: stash here, apply in the new branch.
      const label = `narado-save-${Date.now()}`;
      await this.git(['stash', 'push', '--include-untracked', '--quiet', '-m', label], { cwd: fromPath, env: identityEnv(user) });
      try {
        await this.git(['stash', 'pop', '--quiet'], { cwd: wt });
      } catch (err) {
        // Put the edits back where they came from rather than lose them.
        await this.git(['stash', 'pop', '--quiet'], { cwd: fromPath }).catch(() => {});
        await this.git(['worktree', 'remove', '--force', wt], { cwd: base }).catch(() => {});
        await this.git(['branch', '-D', branch], { cwd: base }).catch(() => {});
        throw err;
      }

      await this.git(['add', '--all'], { cwd: wt });
      await this.git(['commit', '--quiet', '-m', message.trim()], { cwd: wt, env: identityEnv(user) });
      const sha = (await this.git(['rev-parse', '--short', 'HEAD'], { cwd: wt })).stdout.trim();
      return { path: wt, branch, via, sha, collections: findCollections(wt) };
    });
  }

  /** Push the branch to where it belongs: the repo, or the fork for fork changes. */
  async push({ hostId, repoPath, path: wt, branch, authHeader }) {
    return this.withLock(`${hostId}/${repoPath}`, async () => {
      const remote = await this.pushRemoteFor(wt, branch);
      await this.git(['push', '--quiet', '--set-upstream', remote, `${branch}:${branch}`], { cwd: wt, env: authEnv(authHeader) });
      return { remote };
    });
  }

  /**
   * Bring the default branch into this branch (design §7, "Staying current").
   * Returns { merged: true } or { merged: false, conflicts: [...] } with the merge left in progress.
   */
  async updateFromDefault({ hostId, repoPath, path: wt, defaultBranch, authHeader, user }) {
    return this.withLock(`${hostId}/${repoPath}`, async () => {
      const st = parseStatus((await this.git(['status', '--porcelain=v1', '-b', '-z'], { cwd: wt })).stdout);
      if (st.files.length) throw new Error('Commit or discard your changes before updating');
      await this.git(['fetch', '--prune', '--quiet', 'origin'], { cwd: wt, env: authEnv(authHeader) });
      const { code } = await this.git(['merge', '--no-edit', '--quiet', `origin/${defaultBranch}`], {
        cwd: wt,
        env: identityEnv(user),
        allowExit: [1]
      });
      if (code === 0) return { merged: true, conflicts: [] };
      const conflicts = (await this.git(['diff', '--name-only', '--diff-filter=U', '-z'], { cwd: wt })).stdout.split('\0').filter(Boolean);
      return { merged: false, conflicts };
    });
  }

  /** Resolve one conflicted file by keeping one side: 'mine' (this branch) or 'theirs' (default branch). */
  async resolve({ path: wt, file, side }) {
    if (!['mine', 'theirs'].includes(side)) throw new Error('side must be "mine" or "theirs"');
    const full = path.resolve(wt, file);
    if (!full.startsWith(path.resolve(wt) + path.sep)) throw new Error('File is outside the workspace');
    const flag = side === 'mine' ? '--ours' : '--theirs';
    const { code } = await this.git(['checkout', flag, '--', file], { cwd: wt, allowExit: [1] });
    if (code !== 0) {
      // The chosen side deleted the file.
      await this.git(['rm', '--quiet', '--', file], { cwd: wt });
      return;
    }
    await this.git(['add', '--', file], { cwd: wt });
  }

  async abortMerge({ path: wt }) {
    await this.git(['merge', '--abort'], { cwd: wt });
  }

  /** Write a minimal Bruno collection at the root of an empty working copy. */
  initCollection({ path: wt, name }) {
    const file = path.join(wt, 'bruno.json');
    if (fs.existsSync(file)) return wt;
    fs.writeFileSync(file, JSON.stringify({ version: '1', name, type: 'collection', ignore: ['node_modules', '.git'] }, null, 2) + '\n');
    return wt;
  }
}

module.exports = { WorkspaceManager, GitError, runGit, parseStatus, branchFor, slugify, branchDir, findCollections };
