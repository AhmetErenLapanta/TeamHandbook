# Built from the repository root (docker-compose.yml sets the context), because the orchestrator
# bundles the plugin's own src/lib rules rather than copying them.
FROM node:22.22.0-bookworm-slim AS build
WORKDIR /repo/orchestrator
COPY orchestrator/package.json orchestrator/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY src/lib /repo/src/lib
# The demo stamps its team repositories with the plugin's release, read from its package.json.
COPY package.json /repo/package.json
COPY orchestrator/ ./
RUN npm run build

FROM node:22.22.0-bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /repo/orchestrator/dist ./dist
COPY orchestrator/docker-entrypoint.sh ./
# /run/docker-proxy holds the judged Docker socket a cloud orchestrator starts task containers through.
RUN mkdir -p /data /run/docker-proxy && chown node:node /data /run/docker-proxy
USER node
ENV ORCHESTRATOR_DATA_DIR=/data ORCHESTRATOR_HOST=0.0.0.0 ORCHESTRATOR_PORT=8080 ORCHESTRATOR_WEB_ROOT=dist/web NODE_ENV=production
EXPOSE 8080
VOLUME ["/data"]
ENTRYPOINT ["./docker-entrypoint.sh"]

# Container isolation for tasks (docker-compose.container-tasks.yml): the same orchestrator with a
# Docker CLI, which starts each agent in a container of its own through the host's socket.
FROM runtime AS container-tasks
COPY --from=docker:28.5.1-cli /usr/local/bin/docker /usr/local/bin/docker

# The default image has no Docker CLI and reaches no Docker socket.
FROM runtime
