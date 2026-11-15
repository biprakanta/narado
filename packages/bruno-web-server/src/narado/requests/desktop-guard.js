/**
 * Request rules on narado desktop (desktop phase D3, docs/desktop.md 3.3).
 *
 * Requests are sent from the person's own computer, so reaching their own environment
 * (localhost, private networks, VPN-only hosts) is the point. What stays:
 *
 *   - Never: cloud metadata and other link-local addresses (169.254.0.0/16, fe80::/10,
 *     fd00:ec2::254), unspecified, multicast and broadcast. For every connection.
 *   - During a send from a repo's collection: a public address only if its host (and the
 *     request's path) is on the repo's allowlist from its default branch, as on the server.
 *     Private and loopback addresses don't need to be.
 *   - Collections outside Git (the person's own): anything not blocked.
 *   - narado's own connections (its server, Git hosts): only the blocked addresses.
 *
 * The server's policy (NARADO_DESKTOP_SEND, from the desktop session) can narrow this:
 *   any            as above (the default)
 *   private-only   only private and loopback addresses, from any collection
 *   allowlist-only every send must match its repo's allowlist; nothing outside a repo
 *
 * Whether an address is public is known only after the name resolves, so for names the
 * rule is checked when connecting. For an HTTP request whose path isn't on the allowlist,
 * the host may then only be private: either already known from this process's lookups,
 * or required of the coming connection (the send's context remembers it).
 */
const net = require('node:net');
const { RequestGuard, RequestRefused } = require('./guard');
const { normalise, listOf } = require('./blocklist');

const BLOCKED = [
  ['0.0.0.0', 8, 'ipv4', 'unspecified'],
  ['169.254.0.0', 16, 'ipv4', 'link-local (cloud metadata)'],
  ['224.0.0.0', 4, 'ipv4', 'multicast'],
  ['255.255.255.255', 32, 'ipv4', 'broadcast'],
  ['::', 128, 'ipv6', 'unspecified'],
  ['fe80::', 10, 'ipv6', 'link-local'],
  ['ff00::', 8, 'ipv6', 'multicast'],
  ['fd00:ec2::254', 128, 'ipv6', 'cloud metadata']
].map((r) => ({ list: listOf([r]), reason: r[3] }));

const PRIVATE = listOf([
  ['127.0.0.0', 8, 'ipv4'],
  ['::1', 128, 'ipv6'],
  ['10.0.0.0', 8, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['198.18.0.0', 15, 'ipv4'],
  ['fc00::', 7, 'ipv6']
]);

const POLICIES = ['any', 'private-only', 'allowlist-only'];

/** 'public', 'private', or { blocked: reason }. */
const classify = (address) => {
  const a = normalise(address);
  const type = net.isIPv4(a) ? 'ipv4' : net.isIPv6(a) ? 'ipv6' : null;
  if (!type) return { blocked: 'not an IP address' };
  for (const r of BLOCKED) if (r.list.check(a, type)) return { blocked: `${r.reason} address` };
  return PRIVATE.check(a, type) ? 'private' : 'public';
};

const isLocalName = (host) => /^localhost$/i.test(host) || /\.localhost$/i.test(host);

class DesktopGuard extends RequestGuard {
  /**
   * @param {() => string}   policy  the organisation's NARADO_DESKTOP_SEND, read at each check
   * @param {() => string[]} trusted host names narado itself talks to (its server, Git hosts):
   *                                 checked only against the blocked addresses
   */
  constructor({ policy = () => 'any', trusted = () => [], log = console } = {}) {
    super({ log, outsideRepos: 'allow', env: {} });
    this.trustedNames = () => new Set(trusted().map((h) => String(h).toLowerCase()));
    this.policy = () => {
      const p = policy();
      return POLICIES.includes(p) ? p : 'any';
    };
  }

  runSend({ rules, repo }, fn) {
    return this.als.run({ rules, repo, privateOnly: new Set() }, fn);
  }

  /** Before DNS: nothing to decide yet for names; addresses are checked in checkAddress. */
  checkHost() {}

  /** Addresses this process recently resolved `name` to. */
  addressesFor(name) {
    const n = String(name).toLowerCase();
    const now = Date.now();
    const out = [];
    for (const [address, names] of this.resolved) {
      const until = names.get(n);
      if (until && until >= now) out.push(address);
    }
    return out;
  }

  refuse(text) {
    throw new RequestRefused(text);
  }

  notOnAllowlist(ctx, target) {
    return `${target} is a public address and isn't on the allowlist of ${ctx.rules.repo} (its ${ctx.rules.branch || 'default'} branch). Add it to .narado/allowed-hosts.yml through a merge request; private and local addresses don't need to be.`;
  }

  /** Whether `kind` ('private' or 'public') may be reached in this send, by host name(s). */
  decide(ctx, kind, names, port, target) {
    const policy = this.policy();
    const listed = !!ctx.rules && names.some((n) => ctx.rules.allowsHost(n, port));
    if (policy === 'private-only' && kind === 'public') {
      this.refuse(`${target} is a public address; your organisation lets narado desktop send only to private and local networks.`);
    }
    if (policy === 'allowlist-only' && !listed) {
      this.refuse(
        ctx.rules
          ? `${target} isn't on the allowlist of ${ctx.rules.repo}; your organisation lets narado desktop send only to hosts on a repository's allowlist.`
          : `Your organisation lets narado desktop send only from collections in a Git repository, to hosts on its allowlist (${target}).`
      );
    }
    if (kind === 'public' && ctx.rules) {
      if (!listed) this.refuse(this.notOnAllowlist(ctx, target));
      if (names.some((n) => ctx.privateOnly.has(n.toLowerCase()))) {
        this.refuse(`${target} is a public address and this request's path isn't on the allowlist of ${ctx.rules.repo}.`);
      }
    }
  }

  checkAddress(address, host, port) {
    const kind = classify(address);
    const shown = host && host !== address ? `${host} (${address})` : address;
    if (kind.blocked) this.refuse(`${shown} is a ${kind.blocked}; narado never sends requests there`);
    const ctx = this.current();
    if (!ctx || this.trustedNames().has(String(host || '').toLowerCase())) return;
    const names = net.isIP(host || address) ? [address, ...this.namesFor(address)] : [host, address];
    this.decide(ctx, kind, names, port, `${shown}${port ? `:${port}` : ''}`);
  }

  checkRequest(ctx, args, secure) {
    const t = RequestGuard.target(args, secure);
    const target = `${t.host}:${t.port}`;
    if (this.trustedNames().has(t.host.toLowerCase())) return;
    // On the allowlist, path included: fine (connections are still checked for blocked addresses).
    if (ctx.rules && ctx.rules.allowsRequest(t.host, t.port, t.path)) return;
    const addresses = net.isIP(t.host) ? [t.host] : isLocalName(t.host) ? ['127.0.0.1'] : this.addressesFor(t.host);
    if (addresses.length) {
      for (const a of addresses) {
        const kind = classify(a);
        if (kind.blocked) this.refuse(`${t.host} is a ${kind.blocked}; narado never sends requests there`);
        if (kind === 'public' && ctx.rules) {
          this.log.log(`[narado] refused ${t.method} ${target} in ${this.describeRepo(ctx)}: not on the allowlist`);
          this.refuse(`${target}${t.path} is a public address and isn't on the allowlist of ${ctx.rules.repo} (its ${ctx.rules.branch || 'default'} branch). Add it to .narado/allowed-hosts.yml through a merge request.`);
        }
        this.decide(ctx, kind, [t.host, a], t.port, target);
      }
      return;
    }
    // Not resolved yet: the connection that follows must turn out private.
    if (ctx.rules) ctx.privateOnly.add(t.host.toLowerCase());
  }

  who() {
    return 'this computer';
  }
}

module.exports = { DesktopGuard, classify, POLICIES };
