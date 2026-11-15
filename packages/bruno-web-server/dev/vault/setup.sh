#!/bin/sh
# Local Vault for narado's secrets stores. For local development only: the root token and
# every secret here are fixed test values.
#
# Expects a dev Vault in a container named narado-vault (see README.md). Creates:
#   - test secrets under secret/payments/ and secret/cards/
#   - JWT sign-in that trusts narado's public key, so Vault decides per person:
#       everyone: payments/staging; alice@narado.test also: payments/prod
#   - a service token for a second, rule-limited store, written to $TOKEN_FILE
set -eu
NARADO_JWKS=${NARADO_JWKS:-http://host.docker.internal:4100/auth/jwks.json}
NARADO_ISSUER=${NARADO_ISSUER:-http://localhost:3000}
TOKEN_FILE=${TOKEN_FILE:-./vault-svc-token}

v() { docker exec -i -e VAULT_ADDR=http://127.0.0.1:8200 -e VAULT_TOKEN=narado-dev-root narado-vault vault "$@"; }

v kv put secret/payments/staging api_key=staging-key-1234 client_id=narado-staging >/dev/null
v kv put secret/payments/prod api_key=prod-key-5678 >/dev/null
v kv put secret/cards/issuer token=cards-token-9012 >/dev/null

v auth list -format=json | grep -q '"jwt/"' || v auth enable jwt >/dev/null
v write auth/jwt/config jwks_url="$NARADO_JWKS" bound_issuer="$NARADO_ISSUER" >/dev/null

v policy write narado-everyone - >/dev/null <<'HCL'
path "secret/data/payments/staging" { capabilities = ["read"] }
path "secret/metadata/*" { capabilities = ["list"] }
HCL
v policy write narado-prod - >/dev/null <<'HCL'
path "secret/data/payments/prod" { capabilities = ["read"] }
HCL
v policy write narado-service - >/dev/null <<'HCL'
path "secret/data/*" { capabilities = ["read"] }
path "secret/metadata/*" { capabilities = ["list"] }
HCL

v write auth/jwt/role/narado role_type=jwt user_claim=email bound_audiences=vault \
  token_policies=narado-everyone token_ttl=10m >/dev/null

# alice gets prod through her Vault identity, not through anything in narado.
ACCESSOR=$(v auth list -format=json | sed -n '/"jwt\/"/,/accessor/p' | sed -n 's/.*"accessor": "\(.*\)".*/\1/p' | head -1)
ENTITY=$(v write -field=id identity/entity name=alice policies=narado-prod)
v write identity/entity-alias name=alice@narado.test canonical_id="$ENTITY" mount_accessor="$ACCESSOR" >/dev/null 2>&1 || true

v token create -policy=narado-service -period=24h -field=token > "$TOKEN_FILE"
chmod 600 "$TOKEN_FILE"
echo "Vault is set up. Service token written to $TOKEN_FILE"
