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

FROM node:24.22.3-bookworm-slim
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data && chown node:node /data
COPY --from=build --chown=node:node /app /app
USER node
# Sign-in is required to listen beyond loopback; see deploy/README.md for the settings.
ENV NODE_ENV=production \
    BRUNO_WEB_HOST=0.0.0.0 \
    BRUNO_WEB_PORT=4100 \
    BRUNO_WEB_DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 4100
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD node -e "fetch('http://127.0.0.1:4100/auth/me').then((r) => process.exit(r.status < 500 ? 0 : 1)).catch(() => process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "packages/bruno-web-server/src/server.js"]
