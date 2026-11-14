<p align="center">
  <img src="branding/icons/narado-illustration-256.png" width="160" alt="narado: the sage Narada with his veena">
</p>

<h1 align="center">narado</h1>

<p align="center"><strong>API collections in Git, for your whole team.</strong><br>
A self-hosted, browser-based API client built on <a href="https://github.com/usebruno/bruno">Bruno</a>.</p>

---

narado is named after Narada, the travelling sage who carries word between worlds. It carries requests between your team and your APIs.

Your collections live in your own GitHub or GitLab repositories, stored as OpenAPI specs. Everyone works in the browser against one narado server. Changes go through branches and merge requests, the same way code does.

![narado](branding/screenshot-narado-dark.jpg)

## What it does

- **Bruno in the browser.** Bruno's interface for building and sending requests, with environments, scripts and tests, running on a server you control. HTTP requests are tested in narado; Bruno's other request types have not been checked yet.
- **Git is the storage.** Open a repository from GitHub or GitLab and narado clones it on the server. Edits stay local until you save them.
- **Changes through review.** Saving on the default branch asks for a new branch, or a fork when you can only read the repo, and opens a pull or merge request. You can update from main and resolve conflicts in the interface.
- **OpenAPI as the source of truth.** Requests are stored in the repo's `openapi.yaml`, with client-only data (examples, scripts, environments) in `.client/`. Edits in the interface go back into the spec, keeping its formatting.
- **Company sign-in.** Any OpenID Connect provider: Okta, Microsoft Entra ID, Google Workspace, Keycloak and others. You can restrict sign-in to your email domains.
- **MCP server for AI assistants.** Assistants such as Claude Code can list, read and send requests and propose changes through `/mcp`, using personal tokens that act as the person who made them. Sends only reach hosts the workspace names, and secrets are masked.

## Quick start (development)

Requires Node.js 24 (see `.nvmrc`), Git, and the repo's dependencies (`npm run setup` from the root).

```bash
NARADO_GITHUB_TOKEN=$(gh auth token) node packages/bruno-web-server/src/server.js
```

```bash
npm run dev:web
```

Open http://localhost:3000. Without sign-in configured, narado is a single-user tool and only listens on `127.0.0.1`. To try sign-in locally, start the Keycloak realm in [`packages/bruno-web-server/dev/keycloak`](packages/bruno-web-server/dev/keycloak) and follow its README.

Configuration, Git hosts, sign-in, the MCP server and known limits are documented in [`packages/bruno-web-server/README.md`](packages/bruno-web-server/README.md).

## How it fits together

| Part | Where |
|---|---|
| Server: a front process for sign-in and routing, and one sandboxed Bruno process per person whose IPC is relayed to the browser over a WebSocket | [`packages/bruno-web-server`](packages/bruno-web-server) |
| Git workspaces, GitHub and GitLab, OpenAPI storage, MCP, sign-in | [`packages/bruno-web-server/src/narado`](packages/bruno-web-server/src/narado) |
| Browser bridge and narado's interface additions | [`packages/bruno-app/src/web-bridge.js`](packages/bruno-app/src/web-bridge.js), [`packages/bruno-app/src/components/Narado`](packages/bruno-app/src/components/Narado) |
| Logo, colours, icons and themes | [`branding`](branding) |

The Electron desktop app in this repository is unchanged and is still Bruno.

## Status

narado is in active development and not production-ready yet.

| | |
|---|---|
| Done | Bruno in the browser · Git workspaces on GitHub and GitLab · branches, forks and merge requests · OpenAPI storage · MCP server · OpenID Connect sign-in · a separate, sandboxed Bruno process per person · branding |
| Next | Per-person Git accounts through a GitHub App and GitLab OAuth (4c); until then everyone uses the server's Git token. Then a pluggable secrets store with Vault and cloud secret managers (4e), and request-safety rules for every send (4a) |

GitLab support has been tested against unit-test fakes only so far, not a real GitLab instance.

## Built on Bruno

narado is a fork of [Bruno](https://github.com/usebruno/bruno), the open-source, Git-friendly API client by Anoop M D, Anusree P S and contributors. Bruno does the hard part; narado adds the server, Git hosting, sign-in and MCP around it. Bruno's own readme is kept in [README.bruno.md](README.bruno.md).

## License

MIT, as Bruno is. See [license.md](license.md), which keeps Bruno's copyright notice.
