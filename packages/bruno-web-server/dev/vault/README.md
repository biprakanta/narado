# Local Vault for narado's secrets stores

**For local development only.** The root token and every secret here are fixed test values.

1. Start narado first (Vault checks narado's public key at `/auth/jwks.json` when it is set up).
2. Start a dev Vault:

   ```bash
   docker run -d --name narado-vault --cap-add=IPC_LOCK -p 127.0.0.1:8200:8200 \
     -e VAULT_DEV_ROOT_TOKEN_ID=narado-dev-root -e VAULT_DEV_LISTEN_ADDRESS=0.0.0.0:8200 \
     hashicorp/vault:1.17.6
   ```

3. Set it up:

   ```bash
   TOKEN_FILE=~/.narado-vault-svc-token packages/bruno-web-server/dev/vault/setup.sh
   ```

   - Test secrets under `secret/payments/` and `secret/cards/`.
   - JWT sign-in trusting narado, so Vault decides per person: everyone may read `payments/staging`; `alice@narado.test` (from the Keycloak dev realm) may also read `payments/prod`.
   - A service token for a second, rule-limited store, written to `$TOKEN_FILE`.

4. Add the stores to `<data dir>/narado.json`:

   ```json
   {
     "secrets": {
       "stores": [
         { "id": "vault", "type": "vault", "url": "http://127.0.0.1:8200", "auth": { "method": "jwt", "role": "narado" } },
         { "id": "vault-svc", "type": "vault", "url": "http://127.0.0.1:8200", "auth": { "method": "token" } }
       ],
       "access": [
         { "store": "vault-svc", "paths": ["payments/staging"], "repos": ["github:<owner>/<repo>"] },
         { "store": "vault-svc", "paths": ["cards/*"], "people": ["bob@narado.test"] }
       ]
     }
   }
   ```

5. Restart narado with `NARADO_SECRETS_VAULT_SVC_TOKEN="$(cat ~/.narado-vault-svc-token)"`.

Then use `secret://vault/payments/staging#api_key` as an environment variable's value.
