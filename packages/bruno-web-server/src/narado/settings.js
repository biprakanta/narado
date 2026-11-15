/**
 * Server settings made in the admin pages (narado/admin.js), kept in narado.db.
 *
 * Settings use the same names as the environment variables narado already reads
 * (NARADO_OIDC_ISSUER, NARADO_GITHUB_APP_CLIENT_ID, NARADO_ADMINS, ...), and effectiveEnv()
 * lays them under the real environment: a variable set in the environment always wins, and
 * the admin pages show it as set there. Secret values (client secrets, private keys) are
 * encrypted with narado's token key (NARADO_GIT_TOKEN_KEY or the key file).
 *
 * The setup link: until admins are named, narado prints a one-time link in its log; whoever
 * opens it can set up sign-in, the admins and Git.
 */
const crypto = require('node:crypto');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { TokenBox } = require('./git-accounts');

// Encrypted: secrets and keys, and every secrets-store credential (NARADO_SECRETS_<ID>_*).
const SECRET = /(SECRET|PRIVATE_KEY|_PEM)$|^NARADO_SECRETS_/;
const NAME = /^NARADO_[A-Z0-9_]+$/;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

class SettingsStore {
  constructor({ dataDir, env = process.env }) {
    this.db = new DatabaseSync(path.join(dataDir, 'narado.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        name TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        updated_by TEXT
      );
    `);
    this.box = new TokenBox({ dataDir, env });
  }

  get(name) {
    const row = this.db.prepare('SELECT value FROM settings WHERE name = ?').get(name);
    if (!row) return undefined;
    return SECRET.test(name) ? this.box.open(row.value, `setting:${name}`) : row.value;
  }

  /** Set (or with null/'' remove) settings; `by` is who, for the record. */
  set(values, by = null, now = Date.now()) {
    for (const [name, value] of Object.entries(values)) {
      if (!NAME.test(name)) throw new Error(`Not a narado setting: ${name}`);
      if (value == null || value === '') {
        this.db.prepare('DELETE FROM settings WHERE name = ?').run(name);
        continue;
      }
      const stored = SECRET.test(name) ? this.box.seal(String(value), `setting:${name}`) : String(value);
      this.db
        .prepare('INSERT INTO settings (name, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by')
        .run(name, stored, now, by);
    }
  }

  names() {
    return this.db
      .prepare('SELECT name FROM settings')
      .all()
      .map((r) => r.name)
      .filter((n) => !n.startsWith('_'));
  }

  /** The environment narado runs with: these settings, under the real environment. */
  effectiveEnv(env = process.env) {
    const out = {};
    for (const name of this.names()) {
      try {
        out[name] = this.get(name);
      } catch {
        // A secret sealed with another key: leave it unset rather than fail to start.
      }
    }
    return { ...out, ...env };
  }

  /** Where a setting's value comes from: 'env', 'settings' or null. */
  source(name, env = process.env) {
    if (env[name] !== undefined && env[name] !== '') return 'env';
    return this.get(name) !== undefined ? 'settings' : null;
  }

  /* ------------------------------------------------------------- setup link */

  /** A new one-time setup token (its hash is kept); replaces any earlier one. */
  newSetupToken() {
    const token = crypto.randomBytes(24).toString('base64url');
    this.db.prepare('INSERT INTO settings (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run('_SETUP_TOKEN', sha256(token), Date.now());
    return token;
  }

  checkSetupToken(token) {
    const row = this.db.prepare('SELECT value FROM settings WHERE name = ?').get('_SETUP_TOKEN');
    if (!row || typeof token !== 'string' || !token) return false;
    const a = Buffer.from(row.value);
    const b = Buffer.from(sha256(token));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  endSetup() {
    this.db.prepare('DELETE FROM settings WHERE name = ?').run('_SETUP_TOKEN');
  }
}

/** Admin emails from NARADO_ADMINS (comma-separated), lower-cased. */
const adminsFrom = (env) =>
  String(env.NARADO_ADMINS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

module.exports = { SettingsStore, adminsFrom, SECRET };
