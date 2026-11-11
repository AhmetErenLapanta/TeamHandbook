#!/bin/sh
set -eu
# `docker compose run --rm orchestrator migrate-store ...` runs the move and starts no orchestrator.
# `docker compose run --rm orchestrator migrate` moves a Postgres database to this image's schema the same way.
if [ "${1:-}" = "migrate-store" ] || [ "${1:-}" = "migrate" ] || [ "${1:-}" = "doctor" ]; then
  exec node dist/server.js "$@"
fi
# `docker-proxy` serves the judged Docker socket the orchestrator starts task containers through.
if [ "${1:-}" = "docker-proxy" ]; then
  exec node dist/docker-proxy.js
fi
# ORCHESTRATOR_DEMO=1 seeds two stand-in team repositories inside the volume and connects them,
# so a first `docker compose up` has something to show. A real install sets ORCHESTRATOR_CONFIG
# to its own file instead. The seed runs once per volume: the database keeps the demo's
# requests and tasks across restarts, and seeding again would replace the branches they name.
if [ "${ORCHESTRATOR_DEMO:-0}" = "1" ] && [ -z "${ORCHESTRATOR_CONFIG:-}" ]; then
  if [ ! -f /data/demo/orchestrator.json ]; then
    node dist/seed.js /data/demo
  fi
  export ORCHESTRATOR_CONFIG=/data/demo/orchestrator.json
  # A cloud orchestrator serves only the organizations a file lists under orgs, so there the demo's
  # one organization is listed that way.
  if [ "${ORCHESTRATOR_MODE:-}" = "cloud" ]; then
    node -e 'const fs=require("fs");const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));fs.writeFileSync(process.argv[2],JSON.stringify({orgs:[{tenant:c.tenant,repos:c.repos}]},null,2)+"\n")' /data/demo/orchestrator.json /data/demo/orchestrator.cloud.json
    export ORCHESTRATOR_CONFIG=/data/demo/orchestrator.cloud.json
  fi
fi
exec node dist/server.js
