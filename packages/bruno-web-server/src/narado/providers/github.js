/**
 * GitHub provider (design §7.1).
 *
 * Phase 2 authenticates with a token from configuration (a personal access token
 * or a GitHub App user token). Phase 4 replaces this with per-person tokens from
 * the GitHub App's user authorisation.
 */
const { requestJson } = require('./http');
const { fromGitHubPermissions } = require('./access');

const MAX_REPO_PAGES = 5; // up to 500 repos

class GitHubProvider {
  /**
   * @param {object} opts
   * @param {string} opts.id        host id in narado's configuration
   * @param {string} [opts.url]     web URL, default https://github.com
   * @param {string} [opts.apiUrl]  API URL, default https://api.github.com
   * @param {string} opts.token
   * @param {Function} [opts.fetchImpl]
   */
  constructor({ id, name, url = 'https://github.com', apiUrl = 'https://api.github.com', token, fetchImpl }) {
    this.type = 'github';
    this.id = id;
    this.name = name || 'GitHub';
    this.url = url.replace(/\/$/, '');
    this.apiUrl = apiUrl.replace(/\/$/, '');
    this.host = new URL(this.url).host;
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  api(path, opts = {}) {
    return requestJson(`${this.apiUrl}${path}`, {
      ...opts,
      fetchImpl: this.fetchImpl,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(opts.headers || {})
      }
    });
  }

  /** The signed-in account, used for branch names and commit identity. */
  async getCurrentUser() {
    const { data } = await this.api('/user');
    return {
      login: data.login,
      name: data.name || data.login,
      // GitHub's no-reply address when the email is private.
      email: data.email || `${data.id}+${data.login}@users.noreply.github.com`
    };
  }

  static toRepo(r, provider) {
    return {
      hostId: provider.id,
      path: r.full_name,
      name: r.name,
      description: r.description || '',
      private: r.private,
      defaultBranch: r.default_branch,
      cloneUrl: r.clone_url,
      webUrl: r.html_url,
      access: fromGitHubPermissions(r.permissions),
      updatedAt: r.pushed_at || r.updated_at,
      id: r.id,
      isFork: !!r.fork,
      parentPath: r.parent ? r.parent.full_name : null,
      allowForking: r.allow_forking !== false
    };
  }

  async listRepos() {
    const repos = [];
    for (let page = 1; page <= MAX_REPO_PAGES; page++) {
      const { data } = await this.api(`/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`);
      repos.push(...data.map((r) => GitHubProvider.toRepo(r, this)));
      if (data.length < 100) break;
    }
    return repos;
  }

  async getRepo(repoPath) {
    const { data } = await this.api(`/repos/${repoPath}`);
    return GitHubProvider.toRepo(data, this);
  }

  /** The signed-in person's fork of `repoPath`, or null. */
  async findFork(repoPath) {
    const me = await this.getCurrentUser();
    const name = repoPath.split('/')[1];
    // Forks usually keep the repo's name; fall back to scanning the fork list.
    try {
      const { data } = await this.api(`/repos/${me.login}/${name}`);
      if (data.fork && data.parent && data.parent.full_name.toLowerCase() === repoPath.toLowerCase()) {
        return GitHubProvider.toRepo(data, this);
      }
    } catch (err) {
      if (err.status !== 404) throw err;
    }
    for (let page = 1; page <= MAX_REPO_PAGES; page++) {
      const { data } = await this.api(`/repos/${repoPath}/forks?per_page=100&page=${page}`);
      const mine = data.find((f) => f.owner && f.owner.login.toLowerCase() === me.login.toLowerCase());
      if (mine) return this.getRepo(mine.full_name);
      if (data.length < 100) break;
    }
    return null;
  }

  /**
   * Find or create the signed-in person's fork. GitHub creates forks in the background,
   * so this waits until the fork answers (up to about a minute).
   */
  async ensureFork(repoPath, { pollMs = 2000, attempts = 30, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    const existing = await this.findFork(repoPath);
    if (existing) return { fork: existing, created: false };
    const { data } = await this.api(`/repos/${repoPath}/forks`, { method: 'POST', body: { default_branch_only: false } });
    for (let i = 0; i < attempts; i++) {
      try {
        const fork = await this.getRepo(data.full_name);
        // A fork is usable once its branches have been copied.
        await this.api(`/repos/${data.full_name}/branches?per_page=1`);
        return { fork, created: true };
      } catch (err) {
        if (err.status !== 404 && err.status !== 409) throw err;
      }
      await sleep(pollMs);
    }
    throw new Error(`GitHub is still creating the fork ${data.full_name}. Try again in a minute.`);
  }

  /** HTTP header value Git uses to authenticate over HTTPS. */
  gitAuthHeader() {
    const basic = Buffer.from(`x-access-token:${this.token}`).toString('base64');
    return `Authorization: Basic ${basic}`;
  }

  static toMergeRequest(pr) {
    return {
      number: pr.number,
      title: pr.title,
      state: pr.merged_at ? 'merged' : pr.state, // open | closed | merged
      draft: !!pr.draft,
      sourceBranch: pr.head && pr.head.ref,
      targetBranch: pr.base && pr.base.ref,
      webUrl: pr.html_url,
      updatedAt: pr.updated_at
    };
  }

  /**
   * Open a pull request into `repoPath`. With `sourceRepoPath` (a fork), the head
   * branch is taken from the fork.
   */
  async createMergeRequest(repoPath, { sourceBranch, targetBranch, title, description = '', sourceRepoPath }) {
    const head = sourceRepoPath && sourceRepoPath !== repoPath ? `${sourceRepoPath.split('/')[0]}:${sourceBranch}` : sourceBranch;
    const { data } = await this.api(`/repos/${repoPath}/pulls`, {
      method: 'POST',
      body: { head, base: targetBranch, title, body: description }
    });
    return GitHubProvider.toMergeRequest(data);
  }

  /** Most recent pull request into `repoPath` whose head is this branch (in `sourceRepoPath` if given), or null. */
  async findMergeRequest(repoPath, sourceBranch, { sourceRepoPath } = {}) {
    const owner = (sourceRepoPath || repoPath).split('/')[0];
    const { data } = await this.api(
      `/repos/${repoPath}/pulls?state=all&per_page=10&head=${encodeURIComponent(`${owner}:${sourceBranch}`)}`
    );
    if (!data.length) return null;
    const mr = GitHubProvider.toMergeRequest(data[0]);
    return { ...mr, review: await this.getReviewState(repoPath, data[0].number) };
  }

  /** Summarised review state: approved, changes_requested, or pending. */
  async getReviewState(repoPath, number) {
    const { data } = await this.api(`/repos/${repoPath}/pulls/${number}/reviews?per_page=100`);
    const latestByUser = new Map();
    for (const review of data) {
      if (review.user && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) {
        latestByUser.set(review.user.login, review.state);
      }
    }
    const states = [...latestByUser.values()];
    if (states.includes('CHANGES_REQUESTED')) return 'changes_requested';
    if (states.includes('APPROVED')) return 'approved';
    return 'pending';
  }
}

module.exports = { GitHubProvider };
