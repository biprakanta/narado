/**
 * Personal MCP tokens.
 *
 * A person generates a token in narado; it then acts as that person. Each token records
 * its owner (the person's account on every connected Git host, read from the host when
 * the token is made) and a scope: 'read', or 'write' (edit requests, commit, push, open
 * merge requests). Only a SHA-256 hash is stored; the token itself is shown once.
 *
 * Phase 4 replaces the owner's host accounts with a narado user (SSO) whose linked Git
 * accounts are used for every call; the token format and checks stay the same.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PREFIX = 'narado_';
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

class TokenStore {
  constructor({ dataDir }) {
    this.file = path.join(dataDir, 'mcp-tokens.json');
  }

  load() {
    if (!fs.existsSync(this.file)) return [];
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8')).tokens || [];
    } catch {
      return [];
    }
  }

  save(tokens) {
    fs.writeFileSync(this.file, JSON.stringify({ tokens }, null, 2) + '\n', { mode: 0o600 });
  }

  /** Tokens without their hashes, for listing. */
  list() {
    return this.load().map(({ hash, ...rest }) => rest);
  }

  /**
   * @param {object} args
   * @param {string} args.name   what the token is for, for example "Claude Code on my laptop"
   * @param {'read'|'write'} args.scope
   * @param {object} args.owner  { name, hosts: { [hostId]: login } }
   * @returns {{ token: string, record: object }} the token is only ever returned here
   */
  create({ name, scope, owner }) {
    if (!name || !String(name).trim()) throw new Error('Give the token a name, for example the tool or machine that will use it');
    if (!['read', 'write'].includes(scope)) throw new Error('scope must be "read" or "write"');
    if (!owner || !owner.hosts || !Object.keys(owner.hosts).length) throw new Error('Connect a Git host before creating MCP tokens');
    const token = PREFIX + crypto.randomBytes(24).toString('hex');
    const record = {
      id: crypto.randomUUID(),
      name: String(name).trim().slice(0, 100),
      scope,
      owner,
      hint: `${token.slice(0, PREFIX.length + 4)}…${token.slice(-4)}`,
      createdAt: new Date().toISOString(),
      lastUsedAt: null
    };
    const tokens = this.load();
    tokens.push({ ...record, hash: sha256(token) });
    this.save(tokens);
    return { token, record };
  }

  revoke(id) {
    const tokens = this.load();
    const next = tokens.filter((t) => t.id !== id);
    if (next.length === tokens.length) throw new Error('No such token');
    this.save(next);
  }

  /** The token's record, or null. Compares hashes in constant time. */
  verify(token) {
    if (typeof token !== 'string' || !token.startsWith(PREFIX)) return null;
    const h = Buffer.from(sha256(token), 'hex');
    for (const t of this.load()) {
      const stored = Buffer.from(t.hash, 'hex');
      if (stored.length === h.length && crypto.timingSafeEqual(stored, h)) {
        const { hash, ...record } = t;
        return record;
      }
    }
    return null;
  }

  touch(id) {
    const tokens = this.load();
    const t = tokens.find((x) => x.id === id);
    if (!t) return;
    const now = Date.now();
    // Write at most once a minute.
    if (!t.lastUsedAt || now - Date.parse(t.lastUsedAt) > 60 * 1000) {
      t.lastUsedAt = new Date(now).toISOString();
      this.save(tokens);
    }
  }
}

module.exports = { TokenStore, PREFIX };
