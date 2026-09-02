# agy-proxy gateway container.
# tini is PID 1 (SIGTERM forwarding + zombie reaping for the short-lived agy
# children spawned per request). The official agy binary is installed at build
# time and version-locked; auto-update is disabled at runtime.

# ---- stage 0: build the gateway bundle (self-contained: no prebuilt dist/) ----
FROM node:24-slim AS build
# better-sqlite3 has no prebuilt for every node24/glibc target — when the
# prebuild download misses, node-gyp needs the full native toolchain.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsdown.config.ts ./
COPY src/ ./src/
# tsdown only (host bundle); the WebUI builds in the web stage below.
# Prune dev deps so the runtime stage reuses this node_modules verbatim.
RUN npx tsdown && npm prune --omit=dev

# ---- stage 1: build the WebUI (web/dist for the static hosting in dist/) ----
FROM node:24-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---- stage 2: gateway + WebUI assets ----
FROM node:24-slim

# tini for proper signal handling and zombie reaping
RUN apt-get update && apt-get install -y --no-install-recommends tini ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# Install the official agy CLI at build time (version-locked: m1.md verified
# the real binary as 1.1.22; charter L148 requires the pin, no floating tags).
ARG AGY_CLI_VERSION=1.1.22
RUN curl -fsSL https://antigravity.google/cli/install.sh \
    | AGY_CLI_VERSION=${AGY_CLI_VERSION} bash \
    && /root/.local/bin/agy --version

ENV PATH="/root/.local/bin:${PATH}" \
    AGY_CLI_DISABLE_AUTO_UPDATE=true

WORKDIR /app
COPY package.json ./
# prod node_modules come verbatim from the build stage (dev deps pruned there)
COPY --from=build /app/node_modules ./node_modules

COPY --from=build dist/ ./dist/
COPY --from=web /web/dist/ ./web/dist/

# All mutable state lives under /data (pool, sessions, accounts, media, sqlite).
# Mount a named volume here — account credentials are device-bound and must
# survive container replacement (docs/charter.md §11).
ENV AGY_PROXY_DATA_DIR=/data
VOLUME ["/data"]

EXPOSE 8080
# tini as PID 1
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
