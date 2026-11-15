/**
 * Per-repo host allowlists (Phase 4a).
 *
 * A repo's requests may go to the hosts named on its **default branch**, never on a
 * person's own branch, so a new host only counts once its merge request is merged:
 *
 *   - `.client/allowed-hosts.yml`:
 *
 *       hosts:
 *         - api.stripe.com                 # ports 80 and 443
 *         - "*.sandbox.acme.com"           # any subdomain
 *         - api.acme.com:8443              # that port
 *         - host: payments.acme.com        # or in full
 *           ports: [443, 8443]
 *           paths: ["/v1/", "/health"]     # path prefixes
 *
 *   - URLs in the OpenAPI spec's `servers`, and literal URLs in environment files
 *     (host and port only).
 *
 * Review must be enforced on the file: narado reports whether CODEOWNERS covers it.
 */
const path = require('node:path');
const { execFile } = require('node:child_process');
const YAML = require('yaml');

const ALLOW_FILE = '.client/allowed-hosts.yml';
const SPEC_RE = /^(?:.*\/)?openapi\.(?:ya?ml|json)$/i;
const ENV_RE = /(?:^|\/)(?:\.client\/)?environments\/[^/]+\.(?:bru|ya?ml|json)$/i;
const URL_RE = /\b(https?|wss?|grpcs?):\/\/([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::(\d{1,5}))?(\/[^\s"'`{}<>]*)?/g;
const DEFAULT_PORTS = { http: 80, ws: 80, https: 443, wss: 443, grpc: 80, grpcs: 443 };

const git = (args, cwd) =>
  new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 15000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout) => resolve(err ? null : stdout));
  });

const hostPattern = (h) => String(h).trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');

/** One allowlist entry from the YAML file. */
const parseEntry = (e) => {
  if (typeof e === 'string') {
    const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(e.trim());
    if (!m) return null;
    return { host: hostPattern(m[1]), ports: m[2] ? [Number(m[2])] : [80, 443], paths: null, source: ALLOW_FILE };
  }
  if (e && typeof e === 'object' && e.host) {
    const ports = Array.isArray(e.ports) ? e.ports.map(Number).filter((p) => p > 0 && p < 65536) : e.port ? [Number(e.port)] : [80, 443];
    const paths = Array.isArray(e.paths) ? e.paths.map(String).filter((p) => p.startsWith('/')) : null;
    return { host: hostPattern(e.host), ports, paths: paths && paths.length ? paths : null, source: ALLOW_FILE };
  }
  return null;
};

/** Host and port entries for literal URLs in some text (spec servers, environment files). */
const entriesFromUrls = (text, source) => {
  const out = [];
  for (const m of String(text).matchAll(URL_RE)) {
    const scheme = m[1].toLowerCase();
    out.push({ host: hostPattern(m[2]), ports: [m[3] ? Number(m[3]) : DEFAULT_PORTS[scheme]], paths: null, source });
  }
  return out;
};

const hostMatches = (pattern, host) => {
  const h = hostPattern(host);
  if (pattern.startsWith('*.')) return h.endsWith(pattern.slice(1)) && h.length > pattern.length - 1;
  return pattern === h;
};

class RepoRules {
  constructor({ repo, branch, commit, entries, codeowners }) {
    this.repo = repo;
    this.branch = branch;
    this.commit = commit;
    this.entries = entries;
    this.codeowners = codeowners;
  }

  /** May a connection go to host:port? (Connections do not know the path.) */
  allowsHost(host, port) {
    return this.entries.some((e) => hostMatches(e.host, host) && e.ports.includes(Number(port)));
  }

  /** May a request go to host:port/path? */
  allowsRequest(host, port, pathname) {
    return this.entries.some((e) => hostMatches(e.host, host) && e.ports.includes(Number(port)) && (!e.paths || e.paths.some((p) => String(pathname || '/').startsWith(p))));
  }

  summary() {
    return [...new Set(this.entries.map((e) => `${e.host}${e.ports.join('/') === '80/443' ? '' : `:${e.ports.join('/')}`}${e.paths ? ` ${e.paths.join(' ')}` : ''}`))];
  }
}

/** Whether a CODEOWNERS file on the branch assigns owners to the allowlist file. */
const codeownersCovers = (text) => {
  if (!text) return false;
  let covered = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    const re = new RegExp(
      `^${pattern
        .replace(/^\//, '')
        .replace(/\/$/, '')
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '\u0000')
        .replace(/\*/g, '[^/]*')
        .replace(/\u0000/g, '.*')}(?:/.*)?$`
    );
    const matches = pattern === '*' || re.test(ALLOW_FILE) || (!pattern.includes('/') && re.test(path.basename(ALLOW_FILE)));
    if (matches) covered = owners.length > 0; // the last matching line wins, as on GitHub and GitLab
  }
  return covered;
};

/**
 * Reads a repo's rules from its bare clone, cached by the default branch's commit.
 */
class AllowlistReader {
  constructor() {
    this.cache = new Map(); // base -> RepoRules
  }

  async defaultBranch(base) {
    const out = await git(['symbolic-ref', '--short', 'HEAD'], base);
    return out ? out.trim() : null;
  }

  async rulesFor({ base, repo }) {
    const branch = await this.defaultBranch(base);
    if (!branch) return new RepoRules({ repo, branch: null, commit: null, entries: [], codeowners: false });
    const ref = `refs/remotes/origin/${branch}`;
    const commit = ((await git(['rev-parse', '--verify', '--quiet', ref], base)) || '').trim();
    const hit = this.cache.get(base);
    if (hit && hit.commit === commit) return hit;

    const entries = [];
    const files = commit ? ((await git(['ls-tree', '-r', '--name-only', commit], base)) || '').split('\n').filter(Boolean) : [];
    const show = (f) => git(['show', `${commit}:${f}`], base);
    if (files.includes(ALLOW_FILE)) {
      try {
        const data = YAML.parse((await show(ALLOW_FILE)) || '') || {};
        for (const e of Array.isArray(data.hosts) ? data.hosts : []) {
          const parsed = parseEntry(e);
          if (parsed) entries.push(parsed);
        }
      } catch {}
    }
    for (const f of files.filter((x) => SPEC_RE.test(x) && !x.includes('node_modules/')).slice(0, 5)) {
      const text = (await show(f)) || '';
      try {
        const doc = f.endsWith('.json') ? JSON.parse(text) : YAML.parse(text);
        for (const s of (doc && doc.servers) || []) entries.push(...entriesFromUrls(s.url || '', f));
      } catch {}
    }
    for (const f of files.filter((x) => ENV_RE.test(x)).slice(0, 100)) entries.push(...entriesFromUrls((await show(f)) || '', f));

    let owners = null;
    for (const f of ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS', '.gitlab/CODEOWNERS']) {
      if (files.includes(f)) {
        owners = await show(f);
        break;
      }
    }
    const rules = new RepoRules({ repo, branch, commit, entries, codeowners: codeownersCovers(owners) });
    this.cache.set(base, rules);
    return rules;
  }
}

module.exports = { AllowlistReader, RepoRules, parseEntry, entriesFromUrls, hostMatches, codeownersCovers, ALLOW_FILE };
