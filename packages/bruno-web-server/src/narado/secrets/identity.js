/**
 * narado's own signing key, for stores that read secrets as the signed-in person (Vault's
 * JWT auth method). The front signs a short-lived token naming the person; the store checks
 * it with the public key published at /auth/jwks.json. The private key never leaves the front.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

class Identity {
  constructor({ dataDir, issuer }) {
    this.issuer = issuer;
    const file = path.join(dataDir, 'narado-identity-key.pem');
    if (!fs.existsSync(file)) {
      const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
    }
    this.privateKey = crypto.createPrivateKey(fs.readFileSync(file));
    this.publicKey = crypto.createPublicKey(this.privateKey);
    const jwk = this.publicKey.export({ format: 'jwk' });
    // RFC 7638 thumbprint as the key id.
    this.kid = crypto.createHash('sha256').update(JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n })).digest('base64url');
    this.jwk = { ...jwk, kid: this.kid, alg: 'RS256', use: 'sig' };
  }

  jwks() {
    return { keys: [this.jwk] };
  }

  publicPem() {
    return this.publicKey.export({ type: 'spki', format: 'pem' });
  }

  sign(user, { audience, ttlSeconds = 120 }) {
    const now = Math.floor(Date.now() / 1000);
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const head = enc({ alg: 'RS256', typ: 'JWT', kid: this.kid });
    const body = enc({
      iss: this.issuer,
      sub: user.id,
      aud: audience,
      iat: now,
      nbf: now - 5,
      exp: now + ttlSeconds,
      jti: crypto.randomUUID(),
      ...(user.email ? { email: user.email } : {}),
      ...(user.name ? { name: user.name } : {})
    });
    const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), this.privateKey).toString('base64url');
    return `${head}.${body}.${sig}`;
  }
}

module.exports = { Identity };
