# Local Keycloak for narado sign-in

**For local development only.** This realm holds fixed test users and a fixed client secret, so never use it, or anything copied from it, outside your own machine.

Start Keycloak with the `narado` realm imported:

```bash
docker run -d --name narado-keycloak -p 127.0.0.1:8180:8080 \
  -e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin-dev-password \
  -v "$PWD/packages/bruno-web-server/dev/keycloak:/opt/keycloak/data/import:ro" \
  quay.io/keycloak/keycloak:26.0.7 start-dev --import-realm
```

Then start narado with sign-in turned on:

```bash
NARADO_OIDC_ISSUER=http://localhost:8180/realms/narado \
NARADO_OIDC_CLIENT_ID=narado-web \
NARADO_OIDC_CLIENT_SECRET=narado-dev-client-secret \
NARADO_PUBLIC_URL=http://localhost:3000 \
node packages/bruno-web-server/src/server.js
```

Test users (see `narado-realm.json`): `alice` and `bob`.
