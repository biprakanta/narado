# narado server: the web interface, the front process and the per-person Bruno workers.
# Build from the repository root:
#   docker build -f packages/bruno-web-server/deploy/Dockerfile -t narado .

FROM node:24.22.3-bookworm-slim AS build
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    PUPPETEER_SKIP_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    CI=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends git python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY . .
# Installs dependencies and builds the shared packages, then the web interface.
RUN node scripts/setup.js && npm run build:web
# Keep only what the server runs: its own package, Bruno's desktop code (run by the workers)
# and the shared packages they use, with production dependencies only. The interface is
# served from its build (dist), so its own libraries and all build tools go. Everything is
# already built, so no install scripts run. Links to the workspaces left behind are removed.
ENV NARADO_RUNTIME_WORKSPACES="bruno-web-server bruno-electron bruno-common bruno-converters bruno-schema bruno-filestore bruno-lang bruno-js bruno-query bruno-requests bruno-sqlite"
RUN node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json'));p.workspaces=process.env.NARADO_RUNTIME_WORKSPACES.split(' ').map((w)=>'packages/'+w);fs.writeFileSync('package.json',JSON.stringify(p,null,2))" \
 && npm prune --omit=dev --ignore-scripts --legacy-peer-deps --no-audit --no-fund \
 && mkdir -p /runtime/packages/bruno-app \
 && cp -a package.json node_modules /runtime/ \
 && for w in $NARADO_RUNTIME_WORKSPACES; do cp -a packages/$w /runtime/packages/; done \
 && mkdir -p /runtime/packages/bruno-app/public \
 && cp -a packages/bruno-app/dist /runtime/packages/bruno-app/ \
 && cp -a packages/bruno-app/public/narado /runtime/packages/bruno-app/public/ \
 && rm -rf /runtime/packages/*/test /runtime/packages/*/tests \
 && find -L /runtime/node_modules -maxdepth 2 -type l -delete

FROM node:24.22.3-bookworm-slim
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data && chown node:node /data
COPY --from=build --chown=node:node /runtime /app
USER node
# Sign-in is required to listen beyond loopback; see deploy/README.md for the settings.
ENV NODE_ENV=production \
    BRUNO_WEB_HOST=0.0.0.0 \
    BRUNO_WEB_PORT=4100 \
    BRUNO_WEB_DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 4100
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD node -e "fetch('http://127.0.0.1:4100/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "packages/bruno-web-server/src/server.js"]
