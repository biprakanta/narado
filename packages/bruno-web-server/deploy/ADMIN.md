# Setting up narado on your infrastructure

A guide for whoever runs narado for a team: what it needs, the ways to run it, what to register with your sign-in provider and Git host, and every setting. For day-to-day operation (backups, upgrades, health), see [README.md](README.md).

## What you are running

narado is one container (Node.js 24) with three parts:

- **The front process** serves the web interface and handles sign-in, sessions and MCP tokens. It holds every credential: OpenID Connect, Git apps, secrets stores.
- **One worker per signed-in person** runs Bruno's request engine with that person's files, under Node's permission model: it can read and write only that person's folder (`/data/users/<id>`). Workers stop after 30 idle minutes and start again on the next request.
- **The data volume** (`/data`) holds the database (SQLite), the signing keys and each person's clones and working copies. It is narado's only state.

People reach narado over HTTPS. The browser keeps a WebSocket open to `/ipc`, and AI assistants use `/mcp`.

| Need | Detail |
|---|---|
| Container runtime | Docker 24+ with Compose v2, or any OCI runtime (Kubernetes, ECS, Nomad…) |
| CPU and memory | The server takes about 75 MB. Each person working at the same time has a worker of about 250 MB (measured with a small collection; large collections take more). Budget about 300 MB per concurrent person, plus 2 vCPU to start. `NARADO_MAX_WORKERS` caps the count (default 50, or about 15 GB), so set it to what your memory allows. |
| Disk | A persistent volume for `/data`. Budget for each person's clones: start at 20 GB. |
| Network in | HTTPS on 443, through Caddy (included) or your own load balancer. WebSockets must pass through. |
| Network out | Your OpenID Connect provider, GitHub or GitLab, your secrets stores, and whatever APIs people call. |
| Replicas | **Exactly one.** The database is a local SQLite file and workers live in the server's memory, so narado can't run active-active. Use a restart policy or a single-replica deployment for availability. |

## 1. Register narado with your sign-in provider

Any OpenID Connect provider works: Okta, Entra ID, Google Workspace, Keycloak, Auth0, and others.

- **Application type:** confidential web application (authorisation code flow).
- **Redirect URI:** `https://<narado domain>/auth/callback`
- **Scopes:** `openid profile email` (the default; change it with `NARADO_OIDC_SCOPES`).
- **Keep:** the issuer URL, client ID and client secret.

## 2. Register narado with your Git host

Each person connects their own Git account, and narado acts as them on the host.

**GitHub:** the easiest way is to let narado create its own GitHub App from the setup page (step 4), using GitHub's app-manifest flow. To register it yourself instead:

- Create a GitHub App in your organisation's settings (Developer settings → GitHub Apps).
- **Callback URL:** `https://<narado domain>/auth/github/callback`, wildcard matching off.
- **Expire user authorisation tokens:** on. **Webhook:** off.
- **Repository permissions:** Contents read and write, Pull requests read and write, Metadata read. **Account permissions:** Email addresses read.
- Generate a client secret. No private key is needed.
- Install it on your organisation, or on the repositories narado should see.
- Keep the client ID, the client secret and the app's slug (the name in its URL).

**GitLab** (gitlab.com or self-managed): create a confidential OAuth application with redirect URI `https://<narado domain>/auth/gitlab/callback` and scopes `api` and `read_user`. For self-managed GitLab, also add the host to `narado.json` (see the server README, "Git hosts").

## 3. Choose how to run it

All three ways use the same image, built from the repository root:

```bash
docker build -f packages/bruno-web-server/deploy/Dockerfile -t narado .
```

Push it to your registry if it runs elsewhere. The first build takes several minutes.

### A. One machine with Docker Compose and automatic HTTPS

This is the simplest option for a VM with a public address. Caddy gets the TLS certificate. See [README.md](README.md), "Start":

```bash
cp narado.env.example narado.env
```

```bash
NARADO_DOMAIN=narado.example.com docker compose up -d --build
```

### B. Behind your own load balancer

Use this when TLS ends at an existing load balancer, reverse proxy or ingress (an AWS ALB, nginx, Traefik, Cloudflare Tunnel…). [`compose.proxy.yaml`](compose.proxy.yaml) runs narado without Caddy, listening on `127.0.0.1:4100`:

```bash
cp narado.env.example narado.env
```

```bash
NARADO_DOMAIN=narado.example.com docker compose -f compose.proxy.yaml up -d --build
```

Or with plain Docker:

```bash
docker volume create narado-data
```

```bash
docker run -d --name narado --restart unless-stopped -p 127.0.0.1:4100:4100 -v narado-data:/data --env-file narado.env -e NARADO_PUBLIC_URL=https://narado.example.com -e BRUNO_WEB_ORIGINS=https://narado.example.com narado
```

Your load balancer must:

- forward `https://<domain>/` to port 4100 over HTTP;
- allow WebSocket upgrades (`/ipc`), with a long idle timeout (an hour). Each open tab keeps one socket open; the interface reconnects if it drops, but a short timeout makes it reconnect often;
- keep the `Host` header, and not cache anything;
- if it checks health, use `GET /healthz` (200 when the server is up, setup mode included).

`NARADO_PUBLIC_URL` must be the address people type, starting with `https://`: sign-in redirects are built from it, and session cookies are marked `Secure` only when it is HTTPS. `BRUNO_WEB_ORIGINS` must contain that same address, or the browser's WebSocket is refused.

An nginx example:

```nginx
location / {
    proxy_pass http://127.0.0.1:4100;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 1h;
}
```

### C. Kubernetes or another orchestrator

The same rules apply. In Kubernetes terms:

- **A Deployment with `replicas: 1` and `strategy: Recreate`**, so two copies never share the volume during a rollout. A StatefulSet with one replica also works.
- **A ReadWriteOnce PersistentVolumeClaim** mounted at `/data`, owned by user 1000 (the image's `node` user): `securityContext.fsGroup: 1000`.
- **Secrets** from your secrets manager as environment variables (External Secrets, the CSI driver, or a Secret), never baked into the image.
- **A Service on port 4100 and an Ingress** with WebSocket support and a long read timeout. With ingress-nginx, `nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"` is enough.
- **Probes:** HTTP `GET /healthz` on 4100, with a 60-second start period. It answers before sign-in is set up too, so the setup page stays reachable.
- **Requests and limits** sized from the table above. For example, 2 CPU and 4 Gi requested and an 8 Gi limit, with `NARADO_MAX_WORKERS=25`.
- **Request rules:** set `NARADO_BLOCKED_NETWORKS` to the pod and service networks (for example `10.0.0.0/8`) so people's requests can't reach the cluster's own services. Use `NARADO_ALLOWED_NETWORKS` for internal APIs they may call.

## 4. First start

1. Start narado with the sign-in settings filled in. You can leave them empty to set them up from the browser instead.
2. Look in the log for the one-time setup link:

   ```bash
   docker compose logs narado | grep SETUP
   ```

   (or `kubectl logs deploy/narado | grep SETUP`).
3. Open the link to name the admins, check sign-in and set up the Git apps. Anything set in the environment wins over the setup page and is shown as locked there.
4. Sign in as an admin. The admin console stays at `https://<domain>/admin`.
5. Each person signs in, then connects their Git account from the Git section.

Until sign-in is configured, narado listening on anything other than loopback serves only the setup pages.

## 5. Settings

Put secrets (marked 🔒) in your secrets manager or `narado.env`, which is kept out of Git and out of the image. Everything else can also be set from the admin console.

### Server

| Setting | Default | What it does |
|---|---|---|
| `NARADO_PUBLIC_URL` | `http://localhost:4100` | narado's public address. Required behind a proxy. |
| `BRUNO_WEB_ORIGINS` | localhost only | Browser origins allowed to connect, comma-separated. Include `NARADO_PUBLIC_URL`. |
| `BRUNO_WEB_HOST` / `BRUNO_WEB_PORT` | `0.0.0.0` / `4100` in the image | Where the server listens. |
| `BRUNO_WEB_DATA_DIR` | `/data` in the image | The data folder. |
| `NARADO_MAX_WORKERS` | `50` | People working at the same time; the least recently active idle worker makes room. |
| `NARADO_WORKER_IDLE_MINUTES` | `30` | Stop a person's worker after this long without use. |
| `NARADO_WORKER_SANDBOX` | on | `0` turns off the per-person file sandbox. Don't, except to diagnose. |

### Sign-in

| Setting | What it does |
|---|---|
| `NARADO_OIDC_ISSUER` | The provider's issuer URL. |
| `NARADO_OIDC_CLIENT_ID` / `NARADO_OIDC_CLIENT_SECRET` 🔒 | narado's application at the provider. |
| `NARADO_OIDC_PROVIDER_NAME` | Shown on the sign-in button ("Sign in with Acme SSO"). |
| `NARADO_OIDC_SCOPES` | Default `openid profile email`. |
| `NARADO_OIDC_AUTO_REDIRECT` | `1` sends people straight to the provider, skipping narado's sign-in page. |
| `NARADO_ALLOWED_EMAIL_DOMAINS` | Comma-separated. Only these email domains may sign in. |
| `NARADO_ADMINS` | Comma-separated emails that may use `/admin`. Once set here, the console can't change them. |

### Git

| Setting | What it does |
|---|---|
| `NARADO_GITHUB_APP_CLIENT_ID` / `NARADO_GITHUB_APP_CLIENT_SECRET` 🔒 / `NARADO_GITHUB_APP_SLUG` | The GitHub App. |
| `NARADO_GITLAB_APP_CLIENT_ID` / `NARADO_GITLAB_APP_CLIENT_SECRET` 🔒 | The GitLab OAuth application. Other hosts in `narado.json` use `NARADO_<HOST ID>_APP_…`. |
| `NARADO_GIT_TOKEN_KEY` 🔒 | Encrypts stored Git tokens: `openssl rand -base64 32`. Without it, a key file is kept in `/data`, next to what it protects. |
| `NARADO_GIT_ACCOUNT_MATCH` | `warn` (default), `require` or `off`: whether a connected Git account must have the person's sign-in email. |
| `NARADO_SHARED_GIT_TOKENS` | `1` lets shared tokens (`NARADO_GITHUB_TOKEN`) work with sign-in on, while moving over. Off by default. |
| `NARADO_SPARSE_CLONES` | `0` clones whole repositories instead of only the collection folders. |

### Requests people send

| Setting | What it does |
|---|---|
| `NARADO_ALLOWED_NETWORKS` | Internal networks (CIDRs) requests may reach. Every private address is blocked otherwise. |
| `NARADO_BLOCKED_NETWORKS` | Ranges always blocked, even if allowed above (the cluster network, the metadata service). |
| `NARADO_REQUESTS_OUTSIDE_REPOS` | `allow` (default) or `refuse`: requests from collections that aren't in a Git repository. |
| `NARADO_REQUEST_RULES` | `0` turns the rules off. For local development only. |

### Secrets, MCP and desktop

| Setting | What it does |
|---|---|
| `NARADO_SECRETS_…` 🔒 | Credentials for the secrets stores in `narado.json`, for example `NARADO_SECRETS_VAULT_ROLE_ID`. |
| `NARADO_SECRETS_CACHE_SECONDS` | Default `60`: how long a secret read is reused. |
| `NARADO_SECRETS_REVEAL` | `0` stops people revealing secret values in the interface. |
| `NARADO_MCP_ALLOW_WRITE` | `0` makes every MCP token read-only, whatever its owner chose. |
| `NARADO_DESKTOP_SEND` | `any`, `private-only` or `allowlist-only`: where narado desktop may send requests. |
| `NARADO_DESKTOP_MIN_VERSION` | Oldest narado desktop version allowed to connect, for example `0.4.0`. |

## 6. Checklist before people use it

- [ ] `https://<domain>` loads, and the browser shows a valid certificate.
- [ ] Signing in works, and someone outside `NARADO_ALLOWED_EMAIL_DOMAINS` is refused.
- [ ] An admin can open `/admin`.
- [ ] Connecting a Git account works, and Explore APIs lists repositories.
- [ ] A request to an internal address you didn't allow is blocked.
- [ ] The `/data` volume is backed up (see [README.md](README.md), "What to back up").
- [ ] `NARADO_GIT_TOKEN_KEY` is stored in your secrets manager, not only in the data volume.
- [ ] Logs are collected: they record each sign-in, Git connection, secret read (never the value) and request sent.
