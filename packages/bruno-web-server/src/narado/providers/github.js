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
      updatedAt: r.pushed_at || r.updated_at
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

  async createMergeRequest(repoPath, { sourceBranch, targetBranch, title, description = '' }) {
    const { data } = await this.api(`/repos/${repoPath}/pulls`, {
      method: 'POST',
      body: { head: sourceBranch, base: targetBranch, title, body: description }
    });
    return GitHubProvider.toMergeRequest(data);
  }

  /** Most recent pull request whose head is this branch, or null. */
  async findMergeRequest(repoPath, sourceBranch) {
    const owner = repoPath.split('/')[0];
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
