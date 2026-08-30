# agy-proxy gateway container.
# tini is PID 1 (SIGTERM forwarding + zombie reaping for the short-lived agy
# children spawned per request). The official agy binary is installed at build
# time and version-locked; auto-update is disabled at runtime.
FROM node:24-slim

# tini for proper signal handling and zombie reaping
RUN apt-get update && apt-get install -y --no-install-recommends tini ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# Install the official agy CLI at build time (pinned via build arg).
# Verify the pin resolves: the install script fetches the latest manifest and
# honors AGY_CLI_VERSION for a pinned install.
ARG AGY_CLI_VERSION=latest
RUN curl -fsSL https://antigravity.google/cli/install.sh \
    | AGY_CLI_VERSION=${AGY_CLI_VERSION} bash \
    && /root/.local/bin/agy --version

ENV PATH="/root/.local/bin:${PATH}" \
    AGY_CLI_DISABLE_AUTO_UPDATE=true

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY dist/ ./dist/
COPY web/dist/ ./web/dist/

# All mutable state lives under /data (pool, sessions, accounts, media, sqlite).
# Mount a named volume here — account credentials are device-bound and must
# survive container replacement (docs/charter.md §11).
ENV AGY_PROXY_DATA_DIR=/data
VOLUME ["/data"]

EXPOSE 8080
# tini as PID 1
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
