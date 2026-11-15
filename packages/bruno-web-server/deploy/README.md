# Running narado for a team

This folder runs narado on one machine with Docker: the narado server behind [Caddy](https://caddyserver.com), which gets and renews the TLS certificate for your domain.

| File | What it is |
|---|---|
| `Dockerfile` | The narado image: the web interface, the front process and the per-person workers. Runs as the unprivileged `node` user, data in `/data`. |
| `compose.yaml` | narado plus Caddy, with volumes for narado's data and Caddy's certificates. |
| `Caddyfile` | HTTPS in front of narado, WebSockets included. |
| `narado.env.example` | The settings to fill in. |

## Before you start

1. **A domain** pointing at the machine, with ports 80 and 443 open (Caddy needs them for the certificate).
2. **Sign-in:** register narado with your OpenID Connect provider as a confidential web application, redirect URI `https://<domain>/auth/callback`.
3. **GitHub:** register a GitHub App in your organisation (see the server README, "Git accounts"), callback `https://<domain>/auth/github/callback`, and install it on the repositories narado should see. **GitLab:** an OAuth application with redirect URI `https://<domain>/auth/gitlab/callback`.
4. **An encryption key** for stored Git tokens: `openssl rand -base64 32`. Keep it in your secrets manager, not on the same disk as the data.

## Start

From this folder:

```bash
cp narado.env.example narado.env
```

Fill in `narado.env`, then:

```bash
NARADO_DOMAIN=narado.example.com docker compose up -d --build
```

Open `https://narado.example.com`. The first build takes several minutes (it installs and builds the whole monorepo).

Secrets stores, extra Git hosts (self-managed GitLab) and their settings go in `narado.json` in the data volume:

```bash
docker compose cp narado.json narado:/data/narado.json
```

```bash
docker compose restart narado
```

## What to back up

Everything narado keeps is in the `narado-data` volume:

| Path | What | If lost |
|---|---|---|
| `narado.db` | People, sessions, connected Git accounts (tokens encrypted) | Everyone signs in and connects their Git account again |
| `mcp-tokens.json` | MCP token hashes | People create new MCP tokens |
| `narado-identity-key.pem` | narado's signing key for per-person secrets-store sign-in (Vault JWT) | Update the stores' trust in narado's new key (`/auth/jwks.json`) |
| `narado-git-key` | Token encryption key, only when `NARADO_GIT_TOKEN_KEY` isn't set | Stored Git tokens can't be read; people connect again |
| `narado.json` | Hosts and secrets-store configuration | Recreate it |
| `users/` | Each person's clones, working copies and synced copies | Re-opened from Git; unpushed work and synced-copy edits are lost |

A consistent copy of the database while narado runs:

```bash
docker compose exec narado node -e "const {DatabaseSync}=require('node:sqlite'); new DatabaseSync('/data/narado.db').exec(\"VACUUM INTO '/data/narado-backup.db'\")"
```

Then copy `/data/narado-backup.db` and the files above off the machine. `users/` is large and mostly re-creatable; back it up if people keep unpushed work there.

## Upgrades

```bash
git pull
```

```bash
NARADO_DOMAIN=narado.example.com docker compose up -d --build
```

Database changes are applied on start. People's workers restart with the server.

## Isolation

Each person's requests run in their own worker process under Node's permission model (their own folder only, no other people's files), and the request rules block internal addresses. In this setup all workers run as the same `node` user inside one container. For stronger isolation, run narado on a host where each worker can be its own container or OS user; that is not built yet.

## Checking it's healthy

```bash
docker compose ps
```

```bash
docker compose logs -f narado
```

The image has a health check on `/auth/me`. The log shows each sign-in, Git account connection, secret read (never the value) and every request a worker sends (person, host, repository, status).
