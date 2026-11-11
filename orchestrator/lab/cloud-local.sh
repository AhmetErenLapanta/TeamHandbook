#!/usr/bin/env bash
# A cloud orchestrator on this machine for a person to sign up to: the orchestrator's own image on
# Postgres, ORCHESTRATOR_MODE=cloud, every task in a container of its own, and the lab's stand-in
# Google, GitHub and Microsoft. Plain http on CLOUD_LOCAL_HTTP_PORT sends the browser to the
# orchestrator's https address one port above it, served with a certificate made here, which a
# browser warns about once. Nothing leaves this machine.
#
#   CLOUD_LOCAL_DIR=<dir> sh lab/cloud-local.sh up      build what is missing and start it
#   CLOUD_LOCAL_DIR=<dir> sh lab/cloud-local.sh down    stop it; the database and the secrets stay
#   CLOUD_LOCAL_DIR=<dir> sh lab/cloud-local.sh reset   stop it and delete its database and state
#
# CLOUD_LOCAL_PRIVACY_URL and CLOUD_LOCAL_TERMS_URL are the pages a person accepts at sign-up,
# the English pages of the landing preview on this machine unless given, such as
# http://127.0.0.1:3050/en/teamhandbook/orchestrator/privacy. CLOUD_LOCAL_HELP_URL is where
# sign-up's "Stuck? Get help" leads, the preview's help section unless given.
set -euo pipefail

orchestrator_dir=$(cd "$(dirname "$0")/.." && pwd)
repo_root=$(cd "$orchestrator_dir/.." && pwd)
dir=${CLOUD_LOCAL_DIR:?set CLOUD_LOCAL_DIR to the directory that keeps its state}
dir=${dir%/}
http_port=${CLOUD_LOCAL_HTTP_PORT:-18340}
https_port=$((http_port + 1))
providers_port=$((http_port + 3))
name=th-cloud-local
containers="$name-front $name-providers $name-orchestrator $name-postgres"

say() { printf 'cloud-local: %s\n' "$*"; }
die() { printf 'cloud-local: %s\n' "$*" >&2; exit 1; }

stop() {
  for c in $containers; do
    docker rm -f "$c" >/dev/null 2>&1 || true
  done
}

case "${1:-}" in
  down)
    stop
    say "stopped; the database and $dir stay, and up starts it again"
    exit 0
    ;;
  reset)
    stop
    docker volume rm "$name-pg" "$name-orchestrator-data" >/dev/null 2>&1 || true
    docker network rm "$name" >/dev/null 2>&1 || true
    rm -rf "$dir/run" "$dir/secrets" "$dir/orchestrator.env"
    say "stopped; its database, its tasks and its state are gone"
    exit 0
    ;;
  up) ;;
  *) die "usage: sh lab/cloud-local.sh up | down | reset" ;;
esac

if docker ps --format '{{.Names}}' | grep -qx "$name-orchestrator"; then
  die "it is running already; down stops it"
fi
for port in "$http_port" "$https_port" "$providers_port"; do
  if nc -z 127.0.0.1 "$port" 2>/dev/null; then die "port $port is taken; set CLOUD_LOCAL_HTTP_PORT"; fi
done
mkdir -p "$dir"

# One image per state of what goes into it, built only when missing: the lab is no part of the
# image, so a change there reuses it, and uncommitted changes get an image of their own.
built=(orchestrator src/lib package.json)
commit=$(git -C "$repo_root" ls-tree -r HEAD -- "${built[@]}" | grep -v $'\torchestrator/lab/' | shasum | cut -c1-12)
changed=$(git -C "$repo_root" diff HEAD -- "${built[@]}" ':(exclude)orchestrator/lab')
if [ -n "$changed" ]; then
  commit="$commit-dirty-$(printf '%s' "$changed" | shasum | cut -c1-8)"
fi
image="teamhandbook-orchestrator:cloud-local-$commit"
if ! docker image inspect "$image" >/dev/null 2>&1; then
  say "building $image"
  docker build --target container-tasks -t "$image" -f "$orchestrator_dir/Dockerfile" "$repo_root"
fi

say "bundling the lab's stand-ins"
(cd "$orchestrator_dir" && npx esbuild lab/lab.ts --bundle --platform=node --format=esm --target=node22 --log-level=warning \
  --banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" \
  --outfile="$dir/run/lab.mjs")
node "$dir/run/lab.mjs" cloud-local-config "$dir" "$http_port" "$name-postgres" \
  "${CLOUD_LOCAL_PRIVACY_URL:-http://127.0.0.1:3050/en/teamhandbook/orchestrator/privacy}" "${CLOUD_LOCAL_TERMS_URL:-http://127.0.0.1:3050/en/teamhandbook/orchestrator/terms}" \
  "${CLOUD_LOCAL_HELP_URL:-http://127.0.0.1:3050/en/teamhandbook/orchestrator#yardim}"
if [ ! -f "$dir/run/cert.pem" ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 365 -subj "/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
    -keyout "$dir/run/key.pem" -out "$dir/run/cert.pem" 2>/dev/null
  chmod 644 "$dir/run/key.pem"
fi

docker network inspect "$name" >/dev/null 2>&1 || docker network create "$name" >/dev/null
gid=$(docker run --rm --entrypoint stat -v /var/run/docker.sock:/var/run/docker.sock "$image" -c %g /var/run/docker.sock | tr -d '[:space:]')
[ -n "$gid" ] || die "the group of Docker's socket is unknown"

say "starting Postgres"
docker run -d --name "$name-postgres" --network "$name" --restart unless-stopped \
  -e POSTGRES_USER=orchestrator -e POSTGRES_DB=orchestrator -e POSTGRES_PASSWORD_FILE=/run/secrets/pg_password \
  -v "$dir/secrets:/run/secrets:ro" -v "$name-pg:/var/lib/postgresql/data" postgres:16.10-alpine >/dev/null
for _ in $(seq 1 60); do
  docker exec "$name-postgres" pg_isready -U orchestrator -d orchestrator >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$name-postgres" pg_isready -U orchestrator -d orchestrator >/dev/null 2>&1 || die "Postgres did not start"

orchestrator_env=(--env-file "$dir/orchestrator.env" -e "ORCHESTRATOR_TASK_IMAGE=$image" -e "ORCHESTRATOR_TASK_VOLUME=$name-orchestrator-data" -e "ORCHESTRATOR_IMAGE_TAG=cloud-local-$commit")
mounts=(-v "$dir/secrets:/run/secrets:ro" -v "$name-orchestrator-data:/data" -v /var/run/docker.sock:/var/run/docker.sock --group-add "$gid")

say "moving the database to this image's schema"
docker run --rm --network "$name" "${orchestrator_env[@]}" "${mounts[@]}" "$image" migrate

say "starting the orchestrator"
# The stand-ins and the front share the orchestrator's network, so the browser and the orchestrator reach
# the providers at the same 127.0.0.1 address; the ports are published from here.
docker run -d --name "$name-orchestrator" --network "$name" --restart unless-stopped \
  -p "127.0.0.1:$http_port:$http_port" -p "127.0.0.1:$https_port:$https_port" -p "127.0.0.1:$providers_port:$providers_port" \
  "${orchestrator_env[@]}" "${mounts[@]}" "$image" >/dev/null
beside() { docker run -d --name "$1" --network "container:$name-orchestrator" --restart unless-stopped -v "$dir/run:/lab" --entrypoint node "$image" /lab/lab.mjs "$2" "/lab/$2.json" >/dev/null; }
beside "$name-providers" sign-in
beside "$name-front" front

for _ in $(seq 1 90); do
  curl -fsk "https://localhost:$https_port/api/health/ready" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsk "https://localhost:$https_port/api/health/ready" >/dev/null 2>&1 || die "the orchestrator did not answer; docker logs $name-orchestrator says why"
curl -fs "http://127.0.0.1:$providers_port/google/.well-known/openid-configuration" >/dev/null || die "the stand-in providers did not answer; see $dir/run/sign-in.log"
say "up: http://127.0.0.1:$http_port/signup sends the browser to https://localhost:$https_port/signup"
say "the certificate is made here, so the browser warns once; the stand-in providers list their people at http://127.0.0.1:$providers_port"
