/**
 * GitLab provider for GitLab.com and self-managed instances (design §7.1).
 *
 * It acts with a shared token from configuration (a personal access token with the
 * `api` scope) in local mode, or each person's own OAuth token (Phase 4c).
 */
const { requestJson } = require('./http');
const { fromGitLabAccessLevel, highest } = require('./access');

const MAX_REPO_PAGES = 5; // up to 500 projects

class GitLabProvider {
  /**
   * @param {object} opts
   * @param {string} opts.id      host id in narado's configuration
   * @param {string} [opts.url]   instance URL, default https://gitlab.com
   * @param {string} [opts.token]
   * @param {Function} [opts.getToken]  ({ force }) => Promise<string>, the person's own (Phase 4c)
   * @param {Function} [opts.fetchImpl]
   */
  constructor({ id, name, url = 'https://gitlab.com', token, getToken, fetchImpl }) {
    this.type = 'gitlab';
    this.id = id;
    this.url = url.replace(/\/$/, '');
    this.host = new URL(this.url).host;
    this.name = name || (this.host === 'gitlab.com' ? 'GitLab' : `GitLab (${this.host})`);
    this.apiUrl = `${this.url}/api/v4`;
    this.token = token;
    this.getToken = getToken;
    this.fetchImpl = fetchImpl;
  }

  accessToken(force = false) {
    return this.getToken ? this.getToken({ force }) : this.token;
  }

  async api(path, opts = {}) {
    const go = async (force) =>
      requestJson(`${this.apiUrl}${path}`, {
        ...opts,
        fetchImpl: this.fetchImpl,
        headers: { authorization: `Bearer ${await this.accessToken(force)}`, ...(opts.headers || {}) }
      });
    try {
      return await go(false);
    } catch (err) {
      if (err.status === 401 && this.getToken) return go(true);
      throw err;
    }
  }

  async getCurrentUser() {
    const { data } = await this.api('/user');
    return {
      id: data.id,
      login: data.username,
      name: data.name || data.username,
      email: data.public_email || data.commit_email || data.email || `${data.username}@users.noreply.${this.host}`
    };
  }

  static toRepo(p, provider) {
    const perms = p.permissions || {};
    const access = highest(
      fromGitLabAccessLevel(perms.project_access && perms.project_access.access_level),
      fromGitLabAccessLevel(perms.group_access && perms.group_access.access_level)
    );
    return {
      hostId: provider.id,
      path: p.path_with_namespace,
      name: p.name,
      description: p.description || '',
      private: p.visibility !== 'public',
      defaultBranch: p.default_branch,
      cloneUrl: p.http_url_to_repo,
      webUrl: p.web_url,
      // Membership listing only returns projects the person is a member of.
      access: access === 'none' ? 'read' : access,
      updatedAt: p.last_activity_at,
      id: p.id,
      isFork: !!p.forked_from_project,
      parentPath: p.forked_from_project ? p.forked_from_project.path_with_namespace : null,
      allowForking: p.forking_access_level !== 'disabled',
      importStatus: p.import_status || null
    };
  }

  /** Every file path on `ref`, without cloning (for finding collections). */
  async listFiles(repoPath, ref, { maxPages = 100 } = {}) {
    const files = [];
    const base = `/projects/${encodeURIComponent(repoPath)}/repository/tree?recursive=true&per_page=100&ref=${encodeURIComponent(ref)}`;
    let page = 1;
    for (; page <= maxPages; page++) {
      const { data, headers } = await this.api(`${base}&page=${page}`);
      for (const e of data) if (e.type === 'blob') files.push(e.path);
      // A full page means there may be more; GitLab leaves out paging headers on big listings.
      const next = headers && headers.get ? headers.get('x-next-page') : null;
      if (data.length < 100 || next === '') break;
    }
    return { files, truncated: page > maxPages, commit: null };
  }

  /** Whether changes to `branch` need code-owner approval (true, false, or null when it can't be told). */
  async reviewRules(repoPath, branch) {
    try {
      const { data } = await this.api(`/projects/${encodeURIComponent(repoPath)}/protected_branches/${encodeURIComponent(branch)}`);
      return { protected: true, codeOwnerReview: !!data.code_owner_approval_required, sources: ['protected branch'] };
    } catch (err) {
      if (err.status === 404) return { protected: false, codeOwnerReview: false, sources: [] };
      if (err.status === 403) return { protected: null, codeOwnerReview: null, sources: [] };
      throw err;
    }
  }

  /** The account's confirmed email addresses (primary and secondary). */
  async verifiedEmails() {
    const out = new Set();
    const { data: me } = await this.api('/user');
    if (me && me.email && me.confirmed_at) out.add(String(me.email).toLowerCase());
    try {
      const { data } = await this.api('/user/emails');
      for (const e of data || []) if (e.confirmed_at) out.add(String(e.email).toLowerCase());
    } catch {}
    return [...out];
  }

  /** One file's text on `ref`. */
  async readFile(repoPath, ref, filePath) {
    const { data } = await this.api(`/projects/${encodeURIComponent(repoPath)}/repository/files/${encodeURIComponent(filePath)}/raw?ref=${encodeURIComponent(ref)}`);
    return typeof data === 'string' ? data : JSON.stringify(data);
  }

  /** The signed-in person's fork of `repoPath`, or null. */
  async findFork(repoPath) {
    const { data } = await this.api(`/projects/${encodeURIComponent(repoPath)}/forks?owned=true&per_page=100`);
    return data.length ? GitLabProvider.toRepo(data[0], this) : null;
  }

  /** Find or create the person's fork, waiting while GitLab copies the repository. */
  async ensureFork(repoPath, { pollMs = 2000, attempts = 30, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    const existing = await this.findFork(repoPath);
    if (existing && (!existing.importStatus || ['finished', 'none'].includes(existing.importStatus))) {
      return { fork: existing, created: false };
    }
    let forkPath = existing && existing.path;
    if (!existing) {
      const { data } = await this.api(`/projects/${encodeURIComponent(repoPath)}/fork`, { method: 'POST', body: {} });
      forkPath = data.path_with_namespace;
    }
    for (let i = 0; i < attempts; i++) {
      const fork = await this.getRepo(forkPath);
      if (fork.importStatus === 'failed') throw new Error(`GitLab could not create the fork ${forkPath}`);
      if (!fork.importStatus || ['finished', 'none'].includes(fork.importStatus)) return { fork, created: !existing };
      await sleep(pollMs);
    }
    throw new Error(`GitLab is still creating the fork ${forkPath}. Try again in a minute.`);
  }

  async listRepos() {
    const repos = [];
    for (let page = 1; page <= MAX_REPO_PAGES; page++) {
      const { data } = await this.api(`/projects?membership=true&simple=false&per_page=100&page=${page}&order_by=last_activity_at&archived=false`);
      repos.push(...data.map((p) => GitLabProvider.toRepo(p, this)));
      if (data.length < 100) break;
    }
    return repos;
  }

  /**
   * Repositories in one namespace only (a user or a group, with its subgroups), so a scan
   * can stay out of everything else the account can see.
   */
  async listReposIn(namespace) {
    const ns = String(namespace).replace(/^\/+|\/+$/g, '');
    let kind;
    try {
      ({ data: { kind } } = await this.api(`/namespaces/${encodeURIComponent(ns)}`));
    } catch (err) {
      if (err.status === 404) throw new Error(`No GitLab user or group "${ns}" that you can see`);
      throw err;
    }
    const base = kind === 'user' ? `/users/${encodeURIComponent(ns)}/projects` : `/groups/${encodeURIComponent(ns)}/projects`;
    const repos = [];
    for (let page = 1; page <= MAX_REPO_PAGES; page++) {
      const extra = kind === 'user' ? '' : '&include_subgroups=true';
      const { data } = await this.api(`${base}?simple=false&per_page=100&page=${page}&order_by=last_activity_at&archived=false${extra}`);
      repos.push(...data.map((p) => GitLabProvider.toRepo(p, this)));
      if (data.length < 100) break;
    }
    return repos;
  }

  async getRepo(repoPath) {
    const { data } = await this.api(`/projects/${encodeURIComponent(repoPath)}`);
    return GitLabProvider.toRepo(data, this);
  }

  async gitAuthHeader() {
    const basic = Buffer.from(`oauth2:${await this.accessToken()}`).toString('base64');
    return `Authorization: Basic ${basic}`;
  }

  static toMergeRequest(mr) {
    return {
      number: mr.iid,
      title: mr.title,
      state: mr.state === 'opened' ? 'open' : mr.state, // open | closed | merged | locked
      draft: !!(mr.draft || mr.work_in_progress),
      sourceBranch: mr.source_branch,
      targetBranch: mr.target_branch,
      webUrl: mr.web_url,
      updatedAt: mr.updated_at
    };
  }

  /**
   * Open a merge request into `repoPath`. With `sourceRepoPath` (a fork), it is created
   * on the fork and targets the original project.
   */
  async createMergeRequest(repoPath, { sourceBranch, targetBranch, title, description = '', sourceRepoPath }) {
    const fromFork = sourceRepoPath && sourceRepoPath !== repoPath;
    const body = { source_branch: sourceBranch, target_branch: targetBranch, title, description, remove_source_branch: true };
    if (fromFork) body.target_project_id = (await this.getRepo(repoPath)).id;
    const { data } = await this.api(`/projects/${encodeURIComponent(fromFork ? sourceRepoPath : repoPath)}/merge_requests`, {
      method: 'POST',
      body
    });
    return GitLabProvider.toMergeRequest(data);
  }

  /** Most recent merge request into `repoPath` from this branch (of `sourceRepoPath` if given), or null. */
  async findMergeRequest(repoPath, sourceBranch, { sourceRepoPath } = {}) {
    const { data } = await this.api(
      `/projects/${encodeURIComponent(repoPath)}/merge_requests?source_branch=${encodeURIComponent(sourceBranch)}&order_by=updated_at&per_page=20`
    );
    let match = data[0];
    if (sourceRepoPath && sourceRepoPath !== repoPath) {
      const sourceId = (await this.getRepo(sourceRepoPath)).id;
      match = data.find((mr) => mr.source_project_id === sourceId);
    } else {
      const targetId = data.length ? data[0].target_project_id : null;
      match = data.find((mr) => mr.source_project_id === targetId);
    }
    if (!match) return null;
    const mr = GitLabProvider.toMergeRequest(match);
    return { ...mr, review: await this.getReviewState(repoPath, match.iid) };
  }

  async getReviewState(repoPath, iid) {
    try {
      const { data } = await this.api(`/projects/${encodeURIComponent(repoPath)}/merge_requests/${iid}/approvals`);
      if (data.approved) return 'approved';
      return 'pending';
    } catch {
      // Approvals need a paid tier on some instances; treat as unknown.
      return 'pending';
    }
  }
}

module.exports = { GitLabProvider };
