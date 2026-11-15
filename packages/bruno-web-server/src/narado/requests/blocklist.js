/**
 * The platform block list (Phase 4a): addresses a worker may never connect to, whatever a
 * repo allows. Checked on the addresses a name resolves to, so a public name pointing at a
 * blocked address is refused too.
 *
 *   - Always blocked: loopback, link-local (cloud metadata such as 169.254.169.254),
 *     unspecified, multicast and broadcast.
 *   - Blocked unless an admin opens a range with NARADO_ALLOWED_NETWORKS: private and
 *     shared ranges (10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7) and other
 *     special-purpose ranges, where the server's own cluster network usually lives.
 *   - NARADO_BLOCKED_NETWORKS adds ranges (the cluster network, say); it wins over
 *     NARADO_ALLOWED_NETWORKS.
 */
const net = require('node:net');

const ALWAYS = [
  ['0.0.0.0', 8, 'ipv4', 'unspecified'],
  ['127.0.0.0', 8, 'ipv4', 'loopback'],
  ['169.254.0.0', 16, 'ipv4', 'link-local (cloud metadata)'],
  ['224.0.0.0', 4, 'ipv4', 'multicast'],
  ['255.255.255.255', 32, 'ipv4', 'broadcast'],
  ['::', 128, 'ipv6', 'unspecified'],
  ['::1', 128, 'ipv6', 'loopback'],
  ['fe80::', 10, 'ipv6', 'link-local'],
  ['ff00::', 8, 'ipv6', 'multicast'],
  ['fd00:ec2::254', 128, 'ipv6', 'cloud metadata']
];

const PRIVATE = [
  ['10.0.0.0', 8, 'ipv4', 'private'],
  ['100.64.0.0', 10, 'ipv4', 'shared (carrier-grade NAT)'],
  ['172.16.0.0', 12, 'ipv4', 'private'],
  ['192.0.0.0', 24, 'ipv4', 'special-purpose'],
  ['192.0.2.0', 24, 'ipv4', 'documentation'],
  ['192.168.0.0', 16, 'ipv4', 'private'],
  ['198.18.0.0', 15, 'ipv4', 'benchmarking'],
  ['198.51.100.0', 24, 'ipv4', 'documentation'],
  ['203.0.113.0', 24, 'ipv4', 'documentation'],
  ['240.0.0.0', 4, 'ipv4', 'reserved'],
  ['fc00::', 7, 'ipv6', 'private (unique local)'],
  ['64:ff9b::', 96, 'ipv6', 'NAT64'],
  ['64:ff9b:1::', 48, 'ipv6', 'NAT64'],
  ['100::', 64, 'ipv6', 'discard'],
  ['2001:db8::', 32, 'ipv6', 'documentation'],
  ['2002::', 16, 'ipv6', '6to4']
];

/** "10.0.0.0/8, fd00::/8, 192.168.1.10" -> [[addr, prefix, type]] */
const parseNetworks = (text, label) =>
  String(text || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [addr, bits] = s.split('/');
      const type = net.isIPv4(addr) ? 'ipv4' : net.isIPv6(addr) ? 'ipv6' : null;
      const prefix = bits === undefined ? (type === 'ipv4' ? 32 : 128) : Number(bits);
      if (!type || !Number.isInteger(prefix) || prefix < 0 || prefix > (type === 'ipv4' ? 32 : 128)) throw new Error(`${label}: "${s}" is not an address or CIDR range`);
      return [addr, prefix, type, label];
    });

const listOf = (ranges) => {
  const list = new net.BlockList();
  for (const [addr, prefix, type] of ranges) list.addSubnet(addr, prefix, type);
  return list;
};

/** An IPv4-mapped or -compatible IPv6 address as plain IPv4. */
const normalise = (address) => {
  const a = String(address).replace(/^\[|\]$/g, '').replace(/%.*$/, '').toLowerCase();
  const mapped = /^::ffff:(?:0:)?(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) return mapped[1];
  const hex = /^::ffff:(?:0:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
  if (hex) {
    const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16);
    return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
  }
  return a;
};

class AddressPolicy {
  constructor({ env = process.env } = {}) {
    this.always = ALWAYS.map((r) => ({ list: listOf([r]), reason: r[3] }));
    this.private = PRIVATE.map((r) => ({ list: listOf([r]), reason: r[3] }));
    this.allowed = listOf(parseNetworks(env.NARADO_ALLOWED_NETWORKS, 'NARADO_ALLOWED_NETWORKS'));
    this.blocked = listOf(parseNetworks(env.NARADO_BLOCKED_NETWORKS, 'NARADO_BLOCKED_NETWORKS'));
  }

  /**
   * Why `address` may not be reached, or null if it may.
   * @param {object} [o]
   * @param {boolean} [o.trusted] a configured Git host: private ranges are allowed
   */
  check(address, { trusted = false } = {}) {
    const a = normalise(address);
    const type = net.isIPv4(a) ? 'ipv4' : net.isIPv6(a) ? 'ipv6' : null;
    if (!type) return 'not an IP address';
    for (const r of this.always) if (r.list.check(a, type)) return `${r.reason} address`;
    if (this.blocked.check(a, type)) return 'a network blocked on this server (NARADO_BLOCKED_NETWORKS)';
    if (trusted || this.allowed.check(a, type)) return null;
    for (const r of this.private) if (r.list.check(a, type)) return `${r.reason} address`;
    return null;
  }
}

module.exports = { AddressPolicy, normalise, parseNetworks };
