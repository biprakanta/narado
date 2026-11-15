/**
 * Where a collection lives, said for people instead of as a server folder. On a narado
 * server, collections sit in each person's data folder (/data/users/<id>/...), a path that
 * means nothing to them. The desktop shows real paths, which are theirs.
 *
 *   .../users/<id>/git/github/acme/payments/worktrees/main/api  ->  github · acme/payments · main · api
 *   .../users/<id>/synced/github/acme%2Fpayments/_root            ->  Synced from github · acme/payments
 *   .../users/<id>/collections/bruno/Sample                      ->  Your collections · Sample
 */
const decode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

export const friendlyPath = (pathname, { web = typeof window !== 'undefined' && !!window.isBrunoWeb && !window.isNaradoDesktop } = {}) => {
  const p = String(pathname || '').replace(/\\/g, '/');
  if (!web) return p;
  const m = /\/users\/[^/]+\/(.+)$/.exec(p);
  if (!m) return p;
  const parts = m[1].split('/').filter(Boolean);
  const [area, host, ...rest] = parts;
  if ((area === 'git' || area === 'views') && host) {
    const wt = rest.indexOf('worktrees');
    if (wt > 0) {
      const repo = rest.slice(0, wt).join('/');
      const branch = rest[wt + 1] ? rest[wt + 1].replace(/__/g, '/') : '';
      const sub = rest.slice(wt + 2).join('/');
      return [host, repo, branch, sub].filter(Boolean).join(' · ');
    }
    return [host, rest.join('/').replace(/\.git$/, '')].filter(Boolean).join(' · ');
  }
  if (area === 'synced' && host) {
    const repo = decode(rest[0] || '');
    const dir = rest[1] && rest[1] !== '_root' ? decode(rest[1]) : '';
    return `Synced from ${host} · ${repo}${dir ? `/${dir}` : ''}`;
  }
  if (area === 'collections') return `Your collections · ${parts[parts.length - 1]}`;
  return `On narado · ${parts.slice(-1)[0]}`;
};
