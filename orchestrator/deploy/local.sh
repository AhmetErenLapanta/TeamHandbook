#!/usr/bin/env bash
# The cloud setup on this machine: the same compose file and the same release steps a staging
# release takes, on https://localhost with Caddy's own CA, Postgres, ORCHESTRATOR_MODE=cloud, task
# containers with no network, the stand-in agent, and the lab's stand-in Google, GitHub and
# Microsoft to sign up with. Nothing leaves this machine.
#
#   npm run deploy:local             set up (secrets made once), release, then the smoke flow
#   npm run deploy:local -- down     stop it and delete its volumes and directory
#
# ORCHESTRATOR_LOCAL_SIGN_UP=closed starts it with sign-up closed and no stand-in providers;
# ORCHESTRATOR_LOCAL_PRIVACY_URL and ORCHESTRATOR_LOCAL_TERMS_URL are the pages sign-up links, and
# ORCHESTRATOR_LOCAL_HELP_URL where its "Stuck? Get help" goes: the English pages of the landing
# preview on this machine unless given, as lab/cloud-local.sh uses.
#
# ORCHESTRATOR_LOCAL_FROM_DUMP=<file.sql> loads a dump of an earlier schema (lab/fixtures/postgres,
# made by lab/fixture-dump.sh) into a fresh setup's Postgres before the first release, so the
# release moves real data across every migration since; afterwards the schema, each table's rows
# against the dump's header, the dump's task and the event log's guard are checked.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
from_dump=${ORCHESTRATOR_LOCAL_FROM_DUMP:-}
[ -z "$from_dump" ] || from_dump=$(cd "$(dirname "$from_dump")" && pwd)/$(basename "$from_dump")
dir=${ORCHESTRATOR_LOCAL_DIR:-${TMPDIR:-/tmp}/teamhandbook-orchestrator-local}
dir=${dir%/}
target=$dir/target
env_file=$dir/env
project=${ORCHESTRATOR_LOCAL_PROJECT:-teamhandbook-orchestrator-local}
https_port=${ORCHESTRATOR_LOCAL_HTTPS_PORT:-18743}
http_port=${ORCHESTRATOR_LOCAL_HTTP_PORT:-18780}
stand_ins_port=${ORCHESTRATOR_LOCAL_STAND_INS_PORT:-18745}
sign_up=${ORCHESTRATOR_LOCAL_SIGN_UP:-open}
case "$sign_up" in open | closed) ;; *) die "ORCHESTRATOR_LOCAL_SIGN_UP is open or closed" ;; esac

say() { printf 'deploy:local: %s\n' "$*"; }
die() { printf 'deploy:local: %s\n' "$*" >&2; exit 1; }

if [ "${1:-}" = down ]; then
  if [ -f "$target/docker-compose.cloud.yml" ]; then
    (cd "$target" && ORCHESTRATOR_IMAGE_TAG=unused ORCHESTRATOR_DOCKER_GID=0 docker compose --env-file .env -f docker-compose.cloud.yml -f docker-compose.observability.yml -f docker-compose.stand-ins.yml down -v --remove-orphans)
  fi
  rm -rf "$dir"
  say "stopped; its volumes and $dir are gone"
  exit 0
fi
[ $# -eq 0 ] || die "usage: npm run deploy:local [-- down]"

if [ ! -f "$target/docker-compose.cloud.yml" ]; then
  for port in "$https_port" "$http_port" "$stand_ins_port" "${ORCHESTRATOR_LOCAL_PROMETHEUS_PORT:-18790}" "${ORCHESTRATOR_LOCAL_VECTOR_PORT:-18724}"; do
    if nc -z 127.0.0.1 "$port" 2>/dev/null; then die "port $port is taken; set ORCHESTRATOR_LOCAL_HTTPS_PORT and ORCHESTRATOR_LOCAL_HTTP_PORT"; fi
  done
fi

mkdir -p "$target"
if [ ! -f "$env_file" ]; then
  cat >"$env_file" <<EOF
ORCHESTRATOR_TARGET=local
ORCHESTRATOR_TARGET_DIR=$target
COMPOSE_PROJECT_NAME=$project
ORCHESTRATOR_DOMAIN=localhost
ORCHESTRATOR_PUBLIC_PORT=:$https_port
ORCHESTRATOR_BIND=127.0.0.1
ORCHESTRATOR_HTTPS_PORT=$https_port
ORCHESTRATOR_HTTP_PORT=$http_port
ORCHESTRATOR_SECRETS_DIR=./secrets
ORCHESTRATOR_AGENTS=fake
ORCHESTRATOR_DEMO=1
ORCHESTRATOR_OBSERVABILITY=${ORCHESTRATOR_LOCAL_OBSERVABILITY:-1}
ORCHESTRATOR_PROMETHEUS_PORT=${ORCHESTRATOR_LOCAL_PROMETHEUS_PORT:-18790}
ORCHESTRATOR_VECTOR_PORT=${ORCHESTRATOR_LOCAL_VECTOR_PORT:-18724}
ORCHESTRATOR_QUOTA_MEMBERS=unlimited
ORCHESTRATOR_QUOTA_TASKS_PER_MONTH=unlimited
ORCHESTRATOR_QUOTA_CONCURRENT_TASKS=2
ORCHESTRATOR_EDGE_SUBNET=${ORCHESTRATOR_LOCAL_EDGE_SUBNET:-172.31.251.0/29}
ORCHESTRATOR_PROXY_IP=${ORCHESTRATOR_LOCAL_PROXY_IP:-172.31.251.2}
EOF
fi

# The lab's stand-in providers, with clients registered for this orchestrator's address: their ids
# and addresses go in the env file, their secrets in secrets/sign-in, and their own settings in
# stand-ins/, which the stand-ins' container reads.
# The demo task runs on this orchestrator, in a task container: no person's machine is connected here.
# Appended, so an env file an earlier run wrote gets it too.
grep -q '^ORCHESTRATOR_SERVER_TASKS=' "$env_file" || echo ORCHESTRATOR_SERVER_TASKS=1 >>"$env_file"

if [ "$sign_up" = closed ]; then
  grep -q '^ORCHESTRATOR_SIGN_UP=' "$env_file" || echo ORCHESTRATOR_SIGN_UP=closed >>"$env_file"
elif [ ! -d "$target/stand-ins" ]; then
  say "the lab's stand-in sign-in providers on 127.0.0.1:$stand_ins_port"
  lab=$(mktemp -d)
  (cd "$here/.." && npx esbuild lab/lab.ts --bundle --platform=node --format=esm --target=node22 --log-level=warning \
    --banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" \
    --outfile="$lab/lab.mjs")
  # The lab writes the stand-ins for an orchestrator one port above the one it is given, and serves them three above that.
  [ "$stand_ins_port" -eq $((https_port + 2)) ] || die "ORCHESTRATOR_LOCAL_STAND_INS_PORT is two above ORCHESTRATOR_LOCAL_HTTPS_PORT"
  node "$lab/lab.mjs" cloud-local-config "$lab/out" $((https_port - 1)) postgres \
    "${ORCHESTRATOR_LOCAL_PRIVACY_URL:-http://127.0.0.1:3050/en/teamhandbook/orchestrator/privacy}" \
    "${ORCHESTRATOR_LOCAL_TERMS_URL:-http://127.0.0.1:3050/en/teamhandbook/orchestrator/terms}" \
    "${ORCHESTRATOR_LOCAL_HELP_URL:-http://127.0.0.1:3050/en/teamhandbook/orchestrator#yardim}"
  mkdir -p "$target/stand-ins"
  cp "$lab/lab.mjs" "$lab/out/run/sign-in.json" "$target/stand-ins/"
  {
    grep -E '^ORCHESTRATOR_(PRIVACY_URL|TERMS_URL|HELP_URL|SIGN_IN_[A-Z]+_(CLIENT_ID|ISSUER|URL|API_URL))=' "$lab/out/orchestrator.env"
    echo "ORCHESTRATOR_STAND_INS_PORT=$stand_ins_port"
    echo "ORCHESTRATOR_EXTRA_COMPOSE=docker-compose.stand-ins.yml"
    echo "ORCHESTRATOR_BESIDE_ORCHESTRATOR=sign-in"
  } >>"$env_file"
  mkdir -p -m 700 "$target/secrets"
  mkdir -p -m 700 "$target/secrets/sign-in"
  for provider in google github microsoft; do cp "$lab/out/secrets/${provider}_client_secret" "$target/secrets/sign-in/"; done
  chmod 644 "$target/secrets/sign-in"/*
  rm -rf "$lab"
fi

# Made once, readable inside the containers, in a directory only this user opens.
secrets=$target/secrets
if [ ! -f "$secrets/secret_key" ]; then
  mkdir -p -m 700 "$secrets"
  pg_password=$(openssl rand -hex 24)
  printf '%s' "$pg_password" >"$secrets/pg_password"
  printf 'postgres://orchestrator:%s@postgres:5432/orchestrator' "$pg_password" >"$secrets/database_url"
  openssl rand -base64 32 | tr -d '\n' >"$secrets/secret_key"
  openssl rand -hex 32 | tr -d '\n' >"$secrets/metrics_token"
  find "$secrets" -maxdepth 1 -type f -exec chmod 644 {} +
fi

release_flags=(--yes)
cloud_compose() { (cd "$target" && ORCHESTRATOR_IMAGE_TAG=${1:-unused} ORCHESTRATOR_DOCKER_GID=0 docker compose --env-file .env -f docker-compose.cloud.yml "${@:2}"); }
if [ -n "$from_dump" ]; then
  [ -f "$from_dump" ] || die "ORCHESTRATOR_LOCAL_FROM_DUMP names $from_dump, which does not exist"
  [ ! -f "$target/state/current" ] || die "a dump loads into a fresh setup; npm run deploy:local -- down first"
  say "the dump: $(sed -n '1s/^-- //p' "$from_dump" | cut -c1-160)"
  # The release copies these too; the database comes up first so the dump is in it before any migration.
  cp "$here"/docker-compose.*.yml "$here/Caddyfile" "$here/backup.sh" "$target/"
  cp -R "$here/observability" "$target/"
  cp "$env_file" "$target/.env"
  cloud_compose unused up -d --wait postgres >/dev/null
  cloud_compose unused exec -T postgres psql -q -v ON_ERROR_STOP=1 -U orchestrator -d orchestrator <"$from_dump" >/dev/null
  say "  loaded into the setup's Postgres; the release moves it"
  # A dump of an old schema can be behind a contract step; this setup is a test of exactly that move.
  release_flags+=(--contract)
fi
"$here/deploy.sh" release "$env_file" "${release_flags[@]}"

if [ -n "$from_dump" ]; then
  say "the dump's data after the release"
  # exec reads stdin, which in the loop below is the dump's table list: it is closed for it.
  sql() { cloud_compose unused exec -T postgres psql -U orchestrator -d orchestrator -tAc "$1" </dev/null 2>&1 | tr -d '[:space:]'; }
  plan=$(cloud_compose "$(awk '{print $1}' "$target/state/current")" exec -T orchestrator node dist/server.js migrate --check </dev/null 2>&1 | grep -o 'schema: .*' || true)
  case "$plan" in *"moves nothing"*) say "  $plan" ;; *) die "after the release migrate --check says: ${plan:-nothing}" ;; esac
  tables=0
  while read -r table rows; do
    [ "$(sql "SELECT to_regclass('public.$table') IS NOT NULL")" = t ] || { say "  $table, in the dump, is gone after the release (a contract step dropped it)"; continue; }
    now=$(sql "SELECT count(*) FROM \"$table\"")
    [ "$now" -ge "$rows" ] || die "$table held $rows rows in the dump and holds $now after the release"
    tables=$((tables + 1))
  done < <(sed -n 's/^--   \([a-z_]*\): \([0-9]*\)$/\1 \2/p' "$from_dump")
  say "  each of $tables tables holds at least the rows it held in the dump"
  [ "$(sql "SELECT status FROM tasks ORDER BY created_at LIMIT 1")" = needs-review ] || die "the dump's task is not in review after the release"
  say "  the dump's task is still in review"
  # Both are meant to fail; the guard's own words are what is checked.
  changed=$(sql "UPDATE events SET kind = kind WHERE ctid = (SELECT ctid FROM events LIMIT 1)" || true)
  removed=$(sql "DELETE FROM events WHERE ctid = (SELECT ctid FROM events ORDER BY at DESC LIMIT 1)" || true)
  case "$changed$removed" in *append-only*kept*) say "  the event log still refuses a changed and a removed row" ;; *) die "the event log took a change to the dump's rows: $changed $removed" ;; esac
fi

moved=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "http://127.0.0.1:$http_port/signup?from=landing")
[ "$moved" = "302 https://localhost:$https_port/signup?from=landing" ] || die "plain http does not send the browser to the orchestrator's https address ($moved)"
say "plain http on $http_port sends the browser to https://localhost:$https_port, path and query kept"

say "the smoke flow, through Caddy over TLS"
NODE_EXTRA_CA_CERTS="$target/state/caddy-root.crt" node "$here/smoke.mjs" "https://localhost:$https_port" "$sign_up"

say "the demo task, run by the stand-in agent in a container of its own"
status=""
for _ in $(seq 1 60); do
  status=$(cd "$target" && ORCHESTRATOR_IMAGE_TAG=unused ORCHESTRATOR_DOCKER_GID=0 docker compose --env-file .env -f docker-compose.cloud.yml exec -T postgres psql -U orchestrator -d orchestrator -tAc "SELECT status FROM tasks ORDER BY created_at DESC LIMIT 1" 2>/dev/null | tr -d '[:space:]')
  case "$status" in needs-review | failed | cancelled) break ;; esac
  sleep 3
done
[ "$status" = needs-review ] || die "the demo task ended as ${status:-nothing}, not needs-review"
say "  the demo task reached its request (needs-review)"

say "the orchestrator's Docker: only the docker-proxy service's socket"
in_orchestrator() { (cd "$target" && ORCHESTRATOR_IMAGE_TAG=$(awk '{print $1}' state/current) docker compose --env-file .env -f docker-compose.cloud.yml exec -T orchestrator sh -c "$1" 2>&1) || true; }
[ "$(in_orchestrator 'test -e /var/run/docker.sock && echo there')" != there ] || die "the orchestrator holds Docker's own socket"
say "  Docker's own socket is not in the orchestrator's container"
for attempt in "docker run --rm --privileged --name teamhandbook-task-local-check alpine true" "docker run --rm --network host --name teamhandbook-task-local-check teamhandbook-orchestrator:$(awk '{print $1}' "$target/state/current") true" "docker ps" "docker exec teamhandbook-orchestrator-postgres-1 true" "docker volume ls"; do
  said=$(in_orchestrator "$attempt")
  case "$said" in *"refused by the orchestrator's Docker proxy"*) say "  refused: $attempt" ;; *) die "the proxy let through: $attempt ($said)" ;; esac
done

say "a task container's reach, with the flags the orchestrator starts one with"
image=$(awk '{print $1}' "$target/state/current")
probe() {
  docker run --rm --network "$1" --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 --entrypoint node "teamhandbook-orchestrator:$image" -e "
    const net = require('node:net');
    const s = net.connect({ host: process.argv[1], port: Number(process.argv[2]), timeout: 3000 });
    s.on('connect', () => { console.log('reached'); process.exit(0); });
    s.on('error', () => { console.log('unreachable'); process.exit(0); });
    s.on('timeout', () => { console.log('unreachable'); process.exit(0); });" "$2" "$3" 2>/dev/null || echo unreachable
}
[ "$(probe "${project}_internal" postgres 5432)" = reached ] || die "the probe does not reach Postgres even on the internal network, so it proves nothing"
for to in "postgres 5432" "169.254.169.254 80" "host.docker.internal $https_port" "1.1.1.1 443"; do
  # shellcheck disable=SC2086
  [ "$(probe none $to)" = unreachable ] || die "a task container reaches $to"
  say "  unreachable from a task container: $to"
done
if grep -q '^ORCHESTRATOR_OBSERVABILITY=1' "$env_file"; then
  say "observability: Prometheus scrapes the orchestrator, Vector keeps its log lines"
  scraped=""
  for _ in $(seq 1 30); do
    scraped=$(curl -fsS "http://127.0.0.1:${ORCHESTRATOR_LOCAL_PROMETHEUS_PORT:-18790}/api/v1/query?query=up%7Bjob%3D%22teamhandbook-orchestrator%22%7D" 2>/dev/null | grep -o '"value":\[[^]]*"1"\]' || true)
    [ -n "$scraped" ] && break
    sleep 3
  done
  [ -n "$scraped" ] || die "Prometheus does not scrape the orchestrator"
  say "  Prometheus scrapes /metrics with the metrics token (up = 1)"
  logged=$(cd "$target" && ORCHESTRATOR_IMAGE_TAG=unused ORCHESTRATOR_DOCKER_GID=0 docker compose --env-file .env -f docker-compose.cloud.yml -f docker-compose.observability.yml exec -T vector sh -c 'cat /var/log/orchestrator/*.log' 2>/dev/null | grep -c '"msg":"request"' || true)
  [ "${logged:-0}" -gt 0 ] || die "Vector keeps none of the orchestrator's request lines"
  say "  Vector kept $logged of the orchestrator's request lines in the orchestrator-logs volume"
  others=$(cd "$target" && ORCHESTRATOR_IMAGE_TAG=unused ORCHESTRATOR_DOCKER_GID=0 docker compose --env-file .env -f docker-compose.cloud.yml -f docker-compose.observability.yml exec -T vector sh -c 'cat /var/log/orchestrator/*.log' 2>/dev/null | grep -o '"service":"[^"]*"' | sort -u | grep -v -E '"service":"'"$project"'-(caddy|orchestrator|postgres|backup)-([0-9]+|run-[0-9a-f]+)"' || true)
  [ -z "$others" ] || die "Vector keeps lines of containers other than the services: $others"
  say "  and no line of any other container, a task's included"
fi
say "up at https://localhost:$https_port (Caddy's root: $target/state/caddy-root.crt); stop it with npm run deploy:local -- down"
