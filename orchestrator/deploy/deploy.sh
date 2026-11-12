#!/usr/bin/env bash
# Releases the orchestrator to the target an env file names, and rolls it back.
#
#   deploy.sh release <staging|prod|path/to/env> [--yes] [--dry-run] [--contract]
#   deploy.sh rollback <staging|prod|path/to/env> [--yes] [--dry-run] [--docker-socket]
#   deploy.sh status <staging|prod|path/to/env>
#
# A release: plan, image, a pg_dump and the orchestrator's own copy, migrate, the orchestrator, the
# health gate, and the tag recorded. The orchestrator is stopped before the new one starts (two
# orchestrators of one organization never run on one database), and Caddy holds the requests that
# arrive in between, so they wait a few seconds rather than fail; that is a short gap held at
# the proxy, not a release without one. Nothing is printed of a secret but its name.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
orchestrator_dir=$(dirname "$here")
repo_root=$(dirname "$orchestrator_dir")
SECRETS="database_url secret_key metrics_token pg_password"
GATE_TIMEOUT=${ORCHESTRATOR_GATE_TIMEOUT:-120}
# The release being undone served a moment ago, so its own gate waits the full time whatever the new one was given.
ROLLBACK_GATE_TIMEOUT=${ORCHESTRATOR_ROLLBACK_GATE_TIMEOUT:-120}
GATE_STEADY=${ORCHESTRATOR_GATE_STEADY:-10}

say() { printf 'deploy: %s\n' "$*"; }
die() { printf 'deploy: %s\n' "$*" >&2; exit 1; }

usage() { sed -n '4,6p' "$0" | sed 's/^# *//' >&2; exit 2; }

[ $# -ge 2 ] || usage
command=$1
target_name=$2
shift 2
yes=0 dry=0 contract=0 docker_socket=0
for arg in "$@"; do
  case "$arg" in
    --yes) yes=1 ;;
    --dry-run) dry=1 ;;
    --contract) contract=1 ;;
    --docker-socket) docker_socket=1 ;;
    *) usage ;;
  esac
done

case "$target_name" in
  staging | prod) env_file="$here/.env.$target_name" ;;
  *) env_file=$target_name ;;
esac
[ -f "$env_file" ] || die "no env file at $env_file; copy $here/.env.${target_name}.example to it and fill it in"

old_names=$(sed -n 's/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}\(CONSOLE_[A-Za-z0-9_]*\)=.*/\2/p' "$env_file")
[ -z "$old_names" ] || die "$env_file names settings by their old CONSOLE_ prefix, which is not read: $(for n in $old_names; do printf '%s is now ORCHESTRATOR_%s; ' "$n" "${n#CONSOLE_}"; done)rename them and run this again"

set -a
# shellcheck disable=SC1090
. "$env_file"
set +a
for name in ORCHESTRATOR_TARGET ORCHESTRATOR_TARGET_DIR COMPOSE_PROJECT_NAME ORCHESTRATOR_DOMAIN; do
  [ -n "${!name:-}" ] || die "$env_file does not set $name"
done
# A cloud orchestrator nobody can sign up to is a release that looks done and is not.
providers=""
for provider in GOOGLE GITHUB MICROSOFT; do
  id_name="ORCHESTRATOR_SIGN_IN_${provider}_CLIENT_ID"
  [ -z "${!id_name:-}" ] || providers="$providers $(printf '%s' "$provider" | tr '[:upper:]' '[:lower:]')"
done
# One-click GitLab and GitHub: the application's id here, its secrets as files under secrets/forge.
forge_files=""
[ -z "${ORCHESTRATOR_FORGE_GITLAB_CLIENT_ID:-}" ] || forge_files="$forge_files gitlab_client_secret"
if [ -n "${ORCHESTRATOR_FORGE_GITHUB_APP_ID:-}" ]; then
  for name in ORCHESTRATOR_FORGE_GITHUB_APP_SLUG ORCHESTRATOR_FORGE_GITHUB_CLIENT_ID; do
    [ -n "${!name:-}" ] || die "$env_file sets ORCHESTRATOR_FORGE_GITHUB_APP_ID but not $name; the GitHub App's settings are all set or none"
  done
  forge_files="$forge_files github_client_secret github_private_key github_webhook_secret"
fi
# The orchestrator opens sign-up from the two addresses alone, so a closed one is one without them.
if [ "${ORCHESTRATOR_SIGN_UP:-open}" = closed ] && { [ -n "${ORCHESTRATOR_PRIVACY_URL:-}" ] || [ -n "${ORCHESTRATOR_TERMS_URL:-}" ]; }; then
  die "$env_file says ORCHESTRATOR_SIGN_UP=closed and sets ORCHESTRATOR_PRIVACY_URL or ORCHESTRATOR_TERMS_URL, which open sign-up; leave both empty to keep it closed"
fi
if [ "${ORCHESTRATOR_SIGN_UP:-open}" != closed ]; then
  [ -n "${ORCHESTRATOR_PRIVACY_URL:-}" ] && [ -n "${ORCHESTRATOR_TERMS_URL:-}" ] || die "$env_file sets no ORCHESTRATOR_PRIVACY_URL or ORCHESTRATOR_TERMS_URL, so nobody signs up; set both, or ORCHESTRATOR_SIGN_UP=closed on purpose"
  [ -n "$providers" ] || die "$env_file sets no ORCHESTRATOR_SIGN_IN_<GOOGLE|GITHUB|MICROSOFT>_CLIENT_ID, so nobody signs in; set one, or ORCHESTRATOR_SIGN_UP=closed on purpose"
fi
image=${ORCHESTRATOR_IMAGE:-teamhandbook-orchestrator}
https_port=${ORCHESTRATOR_HTTPS_PORT:-443}
public_url="https://${ORCHESTRATOR_DOMAIN}${ORCHESTRATOR_PUBLIC_PORT:-}"

case "$ORCHESTRATOR_TARGET" in
  local) transport=local ;;
  ssh://*) transport=ssh; ssh_dest=${ORCHESTRATOR_TARGET#ssh://} ;;
  *) die "ORCHESTRATOR_TARGET is local or ssh://user@host[:port]" ;;
esac
# ORCHESTRATOR_SSH_OPTS: more ssh options, a key or a known_hosts file of the target's own, split on spaces.
read -r -a ssh_extra <<<"${ORCHESTRATOR_SSH_OPTS:-}"
ssh_args=(-o BatchMode=yes ${ssh_extra[@]+"${ssh_extra[@]}"})
if [ "$transport" = ssh ] && [[ "$ssh_dest" == *:* ]]; then
  ssh_args+=(-p "${ssh_dest##*:}")
  ssh_dest=${ssh_dest%:*}
fi

# One shell command run in the target directory, on this machine or over ssh. In a dry run it is
# printed and nothing runs.
on_target() {
  if [ "$dry" = 1 ]; then
    printf '  would run on %s: %s\n' "$ORCHESTRATOR_TARGET" "$1"
    return 0
  fi
  if [ "$transport" = local ]; then
    (cd "$ORCHESTRATOR_TARGET_DIR" && sh -c "$1")
  else
    ssh "${ssh_args[@]}" "$ssh_dest" "cd '$ORCHESTRATOR_TARGET_DIR' && $1"
  fi
}

# Reads from the target even in a dry run of a local target, which changes nothing; an ssh
# target is not contacted in a dry run.
read_target() {
  if [ "$transport" = local ]; then
    (cd "$ORCHESTRATOR_TARGET_DIR" 2>/dev/null && sh -c "$1") 2>/dev/null || true
  elif [ "$dry" = 0 ]; then
    ssh "${ssh_args[@]}" "$ssh_dest" "cd '$ORCHESTRATOR_TARGET_DIR' 2>/dev/null && $1" 2>/dev/null || true
  fi
}

compose_files="-f docker-compose.cloud.yml"
infra="postgres backup caddy"
if [ "${ORCHESTRATOR_OBSERVABILITY:-0}" = 1 ]; then
  compose_files="$compose_files -f docker-compose.observability.yml"
  infra="$infra prometheus vector"
fi
# More compose files of the deploy directory, and the services among them that share the
# orchestrator's network and so start again with every orchestrator that takes its place.
for extra in ${ORCHESTRATOR_EXTRA_COMPOSE:-}; do
  case "$extra" in docker-compose.*.yml) compose_files="$compose_files -f $extra" ;; *) die "ORCHESTRATOR_EXTRA_COMPOSE names compose files of deploy/, docker-compose.<name>.yml" ;; esac
done
beside=${ORCHESTRATOR_BESIDE_ORCHESTRATOR:-}
# The stand-in providers sign anyone in as anyone; they run on this machine's own Docker alone.
case " ${ORCHESTRATOR_EXTRA_COMPOSE:-} " in
  *" docker-compose.stand-ins.yml "*) [ "$ORCHESTRATOR_TARGET" = local ] || die "docker-compose.stand-ins.yml runs the lab's stand-in sign-in providers, which let anyone in as anyone; it is for ORCHESTRATOR_TARGET=local only" ;;
esac
# Each file is named only where the target holds it, so the files a rollback brings back are read as they are.
compose_present=$(printf '%s' "$compose_files" | sed 's/-f //g')
present='$(for f in '"$compose_present"'; do [ -f "$f" ] && printf -- "-f %s " "$f"; done)'
compose() { printf 'ORCHESTRATOR_IMAGE_TAG=%s docker compose --env-file .env %s %s' "$1" "$present" "$2"; }

current_tag() { read_target "cat state/current 2>/dev/null" | awk '{print $1}'; }
previous_tag() { read_target "cat state/previous 2>/dev/null" | awk '{print $1}'; }

release_tag() {
  if [ -n "${ORCHESTRATOR_RELEASE_TAG:-}" ]; then
    printf '%s' "$ORCHESTRATOR_RELEASE_TAG"
    return
  fi
  local sha
  sha=$(git -C "$repo_root" rev-parse --short=12 HEAD)
  if [ -n "$(git -C "$repo_root" status --porcelain -- orchestrator src package.json)" ]; then
    sha="$sha-dirty-$( { git -C "$repo_root" diff HEAD -- orchestrator src package.json; git -C "$repo_root" ls-files --others --exclude-standard -- orchestrator src | xargs -I{} cat "$repo_root/{}" 2>/dev/null; } | git hash-object --stdin | cut -c1-8)"
  fi
  printf '%s' "$sha"
}

confirm() {
  if [ "$yes" = 1 ] || [ "$dry" = 1 ]; then return 0; fi
  [ -r /dev/tty ] || die "no terminal to confirm on; pass --yes"
  printf 'deploy: type yes to go on: ' >/dev/tty
  local answer
  read -r answer </dev/tty
  [ "$answer" = yes ] || die "stopped; nothing was changed"
}

ship_files() {
  say "copying the compose files, Caddyfile, backup job and env file to $ORCHESTRATOR_TARGET_DIR"
  if [ "$dry" = 1 ]; then
    printf '  would copy the compose files, observability/, Caddyfile, backup.sh and %s as .env\n' "$env_file"
    return 0
  fi
  local stage
  stage=$(mktemp -d)
  cp -R "$here"/docker-compose.*.yml "$here/observability" "$here/Caddyfile" "$here/backup.sh" "$stage/"
  cp "$env_file" "$stage/.env"
  if [ "$transport" = local ]; then
    mkdir -p "$ORCHESTRATOR_TARGET_DIR/state"
    cp -R "$stage/." "$ORCHESTRATOR_TARGET_DIR/"
  else
    rm -f "$stage/docker-compose.stand-ins.yml"
    # macOS tar adds extended attributes and ._ files a Linux tar would write out beside the real ones.
    COPYFILE_DISABLE=1 tar --no-xattrs -C "$stage" -cf - . | ssh "${ssh_args[@]}" "$ssh_dest" "mkdir -p '$ORCHESTRATOR_TARGET_DIR/state' && tar -C '$ORCHESTRATOR_TARGET_DIR' -xf -"
  fi
  rm -rf "$stage"
}

check_secrets() {
  local dir=${ORCHESTRATOR_SECRETS_DIR:-./secrets} missing
  missing=$(read_target "for n in $SECRETS; do [ -s '$dir'/\$n ] || echo \$n; done; [ -d '$dir' ] || echo dir")
  if [ "$dry" = 1 ] && [ "$transport" = ssh ]; then
    printf '  would check that %s holds %s, sign-in/<provider>_client_secret for:%s, and forge/<file> for:%s\n' "$dir" "$SECRETS" "${providers:- none}" "${forge_files:- none}"
    return 0
  fi
  [ -z "$missing" ] || die "the target's $dir lacks: $(echo $missing); write each as a file (docs/operations/run-as-a-service.md)"
  # The files are read inside the containers by their own users (the orchestrator's, Postgres's), so
  # each is readable; the directory is what keeps every other account on the host out of them.
  local provider sign_in_missing=""
  for provider in $providers; do
    sign_in_missing="$sign_in_missing$(read_target "[ -s '$dir'/sign-in/${provider}_client_secret ] || echo ' sign-in/${provider}_client_secret'")"
  done
  [ -z "$sign_in_missing" ] || die "the target's $dir lacks:$sign_in_missing"
  local forge_missing="" file
  for file in $forge_files; do
    forge_missing="$forge_missing$(read_target "[ -s '$dir'/forge/$file ] || echo ' forge/$file'")"
  done
  [ -z "$forge_missing" ] || die "the target's $dir lacks:$forge_missing (write each as a file there; the env example names them)"
  on_target "mkdir -p -m 700 '$dir'/sign-in '$dir'/forge"
  local loose
  # Octal modes, which GNU, BSD and busybox find all read; a find that fails says so rather than passing.
  loose=$(read_target "find '$dir' -maxdepth 0 ! -perm 700 && find '$dir' -mindepth 1 -perm -002 && find '$dir' -mindepth 1 -perm -020 || echo 'find failed'")
  [ -z "$loose" ] || die "the target's $dir is open to others: make it mode 700, and no file in it group- or world-writable"
}

build_image() {
  local tag=$1
  if docker image inspect "$image:$tag" >/dev/null 2>&1; then
    say "image $image:$tag is built already"
    return 0
  fi
  say "building $image:$tag"
  [ "$dry" = 1 ] && { printf '  would run: docker build --target container-tasks -t %s:%s -f orchestrator/Dockerfile .\n' "$image" "$tag"; return 0; }
  docker build --target container-tasks --label "org.teamhandbook.orchestrator.tag=$tag" -t "$image:$tag" -f "$orchestrator_dir/Dockerfile" "$repo_root"
}

ship_image() {
  local tag=$1
  [ "$transport" = local ] && return 0
  say "sending $image:$tag to the target"
  [ "$dry" = 1 ] && { printf '  would run: docker save %s:%s | ssh %s docker load\n' "$image" "$tag" "$ssh_dest"; return 0; }
  docker save "$image:$tag" | ssh "${ssh_args[@]}" "$ssh_dest" docker load
}

docker_gid() {
  read_target "docker run --rm --entrypoint stat -v /var/run/docker.sock:/var/run/docker.sock $image:$1 -c %g /var/run/docker.sock"
}

# The orchestrator's readiness from inside its container, with the metrics token, so the version,
# schema and every org's state come back; one line of JSON, or nothing.
# Kept in single quotes on its own: bash 3.2 expands the braces of a script quoted inside $( ).
READY_JS='const t=require("fs").readFileSync("/run/secrets/metrics_token","utf8").trim();fetch("http://127.0.0.1:8080/api/health/ready",{headers:{authorization:"Bearer "+t}}).then(r=>r.json()).then(j=>console.log(JSON.stringify({ready:j.ready,schema:j.schema,tag:process.env.ORCHESTRATOR_IMAGE_TAG})),()=>{})'
readiness() {
  local command
  command=$(compose "$1" "exec -T orchestrator node -e '$READY_JS'")
  read_target "$command"
}

# What the orchestrator starts tasks with answers: the docker-proxy's socket, or Docker's in a release
# from before it. Ready does not touch Docker, so an orchestrator that cannot start a task is ready.
DOCKER_CHECK='docker version --format {{.Server.Version}}'
docker_reached() {
  local command
  command=$(compose "$1" "exec -T orchestrator $DOCKER_CHECK")
  read_target "$command" | grep -E '^[0-9]+\.' || true
}

# Passes when the orchestrator answers ready, runs the tag being released, reaches Docker, and stays so for
# GATE_STEADY seconds; fails after GATE_TIMEOUT.
health_gate() {
  local tag=$1 timeout=${2:-$GATE_TIMEOUT} started steady_since="" answer
  [ "$dry" = 1 ] && { say "health gate: would wait for ready on $tag for ${GATE_STEADY}s, at most ${timeout}s"; return 0; }
  started=$(date +%s)
  while :; do
    answer=$(readiness "$tag")
    if printf '%s' "$answer" | grep -q '"ready":true' && printf '%s' "$answer" | grep -q "\"tag\":\"$tag\"" && [ -n "$(docker_reached "$tag")" ]; then
      [ -n "$steady_since" ] || steady_since=$(date +%s)
      if [ $(($(date +%s) - steady_since)) -ge "$GATE_STEADY" ]; then
        gate_schema=$(printf '%s' "$answer" | sed -n 's/.*"schema":\([0-9]*\).*/\1/p')
        say "health gate: ready on $tag at schema $gate_schema for ${GATE_STEADY}s"
        return 0
      fi
    else
      steady_since=""
    fi
    [ $(($(date +%s) - started)) -lt "$timeout" ] || { say "health gate: not ready on $tag after ${timeout}s"; return 1; }
    sleep 2
  done
}

# Through Caddy over TLS from this machine: the address people open answers ready.
verify_public() {
  [ "$dry" = 1 ] && { say "would check $public_url/api/health/ready over TLS"; return 0; }
  local ca_args=()
  if [ "$ORCHESTRATOR_DOMAIN" = localhost ]; then
    # Kept beside the target's state on this machine, where deploy:local reads it; a copy of its own for a remote target.
    local root_file="$ORCHESTRATOR_TARGET_DIR/state/caddy-root.crt"
    [ "$transport" = local ] || root_file=$(mktemp)
    read_target "$(compose "$1" "exec -T caddy cat /data/caddy/pki/authorities/local/root.crt")" >"$root_file"
    ca_args=(--cacert "$root_file")
  fi
  local i
  for i in $(seq 1 30); do
    if curl -fsS "${ca_args[@]}" "$public_url/api/health/ready" 2>/dev/null | grep -q '"ready":true'; then
      say "verified: $public_url answers ready over TLS"
      return 0
    fi
    sleep 2
  done
  say "$public_url did not answer ready over TLS"
  return 1
}

schema_now() { read_target "$(compose "$1" "exec -T postgres psql -U orchestrator -d orchestrator -tAc 'SELECT MAX(version) FROM schema_version'")" | tr -d '[:space:]'; }

# The deploy files a release ran with, kept by tag on the target: a rollback starts the release
# before with its own compose file, Caddyfile and settings, not the newer ones.
keep_release_files() {
  on_target "rm -rf 'releases/$1' && mkdir -p 'releases/$1' && cp -R .env Caddyfile backup.sh observability docker-compose.*.yml 'releases/$1/' && ls -1t releases | tail -n +11 | while read -r old; do rm -rf \"releases/\$old\"; done"
}

restore_release_files() {
  if [ "$dry" = 0 ] && [ -z "$(read_target "[ -d 'releases/$1' ] && echo kept")" ]; then
    say "no copy of $1's deploy files is kept; it starts with the files there now"
    return 0
  fi
  say "deploy files: back to $1's"
  on_target "rm -f docker-compose.*.yml && cp -R 'releases/$1/.' ./"
  reload_caddy "$1"
}

# Caddy reads its Caddyfile at start; a release that changes it has it read again, without a restart.
# A Caddy from a release without its admin endpoint is restarted instead, a gap of about a second.
reload_caddy() {
  on_target "$(compose "$1" "exec -T caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile")" >/dev/null 2>&1 || die "Caddy refuses this Caddyfile; it goes on serving with the one it had"
  on_target "$(compose "$1" "exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile")" >/dev/null 2>&1 \
    || on_target "$(compose "$1" "restart caddy")"
}

record() {
  local tag=$1 schema=$2 current=$3
  on_target "mkdir -p state && { [ -z '$current' ] || cp state/current state/previous; } && echo '$tag $schema' > state/current && echo '$(date -u +%Y-%m-%dT%H:%M:%SZ) $tag $schema' >> state/history"
}

# The orchestrator with what it depends on in this release's files (the docker-proxy where it has one);
# a service those files no longer name goes.
start_orchestrator() {
  on_target "$(compose "$1" "up -d --remove-orphans orchestrator")"
  [ -z "$beside" ] || on_target "$(compose "$1" "up -d --no-deps --force-recreate $beside")"
}

# The copy before the release: a pg_dump named with the tag, then the orchestrator's own copy of the
# repositories it reaches by path. Either one failing stops the release with nothing changed.
backup_before() {
  local tag=$1 current=$2
  say "backup: pg_dump before-$tag"
  on_target "$(compose "${current:-$tag}" "run --rm -T backup once before-$tag")" || die "the pg_dump before the release was not written; nothing was changed"
  [ -n "$current" ] || return 0
  say "backup: the orchestrator's own copy (SIGUSR2)"
  [ "$dry" = 1 ] && return 0
  local since
  since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  on_target "$(compose "$current" "kill -s SIGUSR2 orchestrator")"
  local i line
  for i in $(seq 1 30); do
    line=$(read_target "$(compose "$current" "logs --since $since --no-log-prefix orchestrator")" | grep -E 'backup: (asked copy written|the asked copy was not written)' | tail -1)
    case "$line" in
      *"asked copy written"*) say "backup: the orchestrator wrote its copy"; return 0 ;;
      *"not written"*) die "the orchestrator's copy was not written; nothing was changed" ;;
    esac
    sleep 2
  done
  die "the orchestrator did not say its copy was written within a minute; nothing was changed"
}

do_release() {
  local tag current schema plan
  tag=$(release_tag)
  current=$(current_tag)
  schema=$(schema_now "${current:-$tag}")
  say "plan for $target_name"
  say "  target:   $ORCHESTRATOR_TARGET ($ORCHESTRATOR_TARGET_DIR), project $COMPOSE_PROJECT_NAME"
  say "  address:  $public_url"
  say "  release:  $image:$tag (now: ${current:-none})"
  say "  database: schema ${schema:-not read}"
  if [ "${ORCHESTRATOR_SIGN_UP:-open}" = closed ]; then say "  sign-up:  closed (ORCHESTRATOR_SIGN_UP=closed)"; else say "  sign-up:  open, with${providers}"; fi
  say "  help:     ${ORCHESTRATOR_HELP_URL:-none (the sign-up page shows no help link)}"
  confirm
  build_image "$tag"
  ship_image "$tag"
  ship_files
  check_secrets
  if [ "$dry" = 0 ]; then
    ORCHESTRATOR_DOCKER_GID=$(docker_gid "$tag" | tr -d '[:space:]')
    [ -n "$ORCHESTRATOR_DOCKER_GID" ] || die "could not read the group of the target's Docker socket"
    on_target "grep -v '^ORCHESTRATOR_DOCKER_GID=' .env > .env.next; echo ORCHESTRATOR_DOCKER_GID=$ORCHESTRATOR_DOCKER_GID >> .env.next; mv .env.next .env"
  fi
  keep_release_files "$tag"
  say "starting $infra"
  on_target "$(compose "${current:-$tag}" "up -d --wait $infra")"
  reload_caddy "${current:-$tag}"
  backup_before "$tag" "$current"
  local flag=""
  [ "$contract" = 1 ] && flag=--contract
  plan=$(on_target "$(compose "$tag" "run --rm -T --no-deps orchestrator migrate --check $flag")") || { printf '%s\n' "$plan"; die "migrate refuses this release's schema change; nothing was changed but the copies"; }
  printf '%s\n' "$plan" | grep -v ExperimentalWarning | grep -v trace-warnings | sed 's/^/  /'
  say "migrate"
  on_target "$(compose "$tag" "run --rm -T --no-deps orchestrator migrate $flag")" || die "migrate failed; the release before still serves"
  say "orchestrator: $tag in place of ${current:-none}"
  start_orchestrator "$tag"
  if ! health_gate "$tag" || ! verify_public "$tag"; then
    if [ -n "$current" ]; then
      say "rolling back to $current"
      restore_release_files "$current"
      start_orchestrator "$current"
      health_gate "$current" "$ROLLBACK_GATE_TIMEOUT" || die "the release failed its gate, and $current did not come back either; the copy is backups/orchestrator-*-before-$tag.dump in the pg-backups volume"
      die "the release failed its gate; $current serves again"
    fi
    die "the release failed its gate and there is no release before it"
  fi
  record "$tag" "${gate_schema:-?}" "$current"
  if [ "$dry" = 1 ]; then say "dry run: nothing was changed"; else say "released $tag"; fi
}

do_rollback() {
  local current previous previous_schema schema
  current=$(current_tag)
  previous=$(previous_tag)
  previous_schema=$(read_target "cat state/previous 2>/dev/null" | awk '{print $2}')
  [ -n "$previous" ] || [ "$dry" = 1 ] || die "the target records no release before ${current:-this one}"
  schema=$(schema_now "${current:-$previous}")
  say "rollback on $target_name: ${current:-?} -> ${previous:-?} (the database at schema ${schema:-?}, ${previous:-?} wrote ${previous_schema:-?})"
  # A release from before the docker-proxy hands the orchestrator Docker's own socket, root on the host.
  if [ -n "$(read_target "[ -f 'releases/$previous/docker-compose.cloud.yml' ] && ! grep -q '^  docker-proxy:' 'releases/$previous/docker-compose.cloud.yml' && echo socket")" ]; then
    say "  ${previous} mounts Docker's own socket into the orchestrator: it is from before the docker-proxy"
    [ "$docker_socket" = 1 ] || die "a rollback to $previous gives the internet-facing orchestrator Docker's socket; pass --docker-socket to do it anyway"
  fi
  confirm
  # An image from before the database moved starts on it only when every step since only added;
  # the old image says so itself, and a refusal here leaves the current release serving.
  if [ "$dry" = 0 ] && [ -n "$schema" ] && [ -n "$previous_schema" ] && [ "$schema" -gt "$previous_schema" ]; then
    on_target "$(compose "$previous" "run --rm -T --no-deps orchestrator migrate --check")" >/dev/null \
      || die "$previous does not read the database at schema $schema; restore the dump taken before $current (docs/operations/run-as-a-service.md, \"Restoring a dump\")"
  fi
  restore_release_files "$previous"
  start_orchestrator "$previous"
  health_gate "$previous" "$ROLLBACK_GATE_TIMEOUT" || { restore_release_files "$current"; start_orchestrator "$current"; die "$previous failed its gate; $current serves again"; }
  # The release undone becomes the one before, so status names it and a second rollback brings it back.
  on_target "cp state/current state/previous.next && echo '$previous $previous_schema' > state/current && mv state/previous.next state/previous && echo '$(date -u +%Y-%m-%dT%H:%M:%SZ) rollback $previous' >> state/history"
  say "rolled back to $previous"
}

do_status() {
  say "target $ORCHESTRATOR_TARGET ($ORCHESTRATOR_TARGET_DIR)"
  say "current: $(read_target 'cat state/current 2>/dev/null' || true)"
  say "previous: $(read_target 'cat state/previous 2>/dev/null' || true)"
  read_target "$(compose "$(current_tag)" "ps --format '{{.Service}} {{.Status}}'")"
  [ "${ORCHESTRATOR_OBSERVABILITY:-0}" = 1 ] && observability_status "$(current_tag)"
  return 0
}

# The observability example, probed where it runs: Prometheus's own answer for the orchestrator's
# scrape, and Vector's check of its configuration and the newest file it wrote. The orchestrator
# itself dials no telemetry endpoint; a sink of the operator's own is checked by Vector.
PROMETHEUS_UP='wget -qO- http://127.0.0.1:9090/api/v1/query?query=up%7Bjob%3D%22teamhandbook-orchestrator%22%7D'
VECTOR_FILES='vector validate --no-environment /etc/vector/vector.yaml >/dev/null 2>&1 && echo valid; ls -1t /var/log/orchestrator 2>/dev/null | head -1'
observability_status() {
  local command up vector
  command=$(compose "$1" "exec -T prometheus $PROMETHEUS_UP")
  up=$(read_target "$command" | grep -o '"value":\[[^]]*\]' | grep -o '"[01]"' | tr -d '"')
  case "$up" in
    1) say "prometheus: scrapes the orchestrator (up = 1)" ;;
    0) say "prometheus: the orchestrator's scrape fails (up = 0); check ORCHESTRATOR_METRICS_TOKEN and the orchestrator" ;;
    *) say "prometheus: no answer for the orchestrator's scrape" ;;
  esac
  command=$(compose "$1" "exec -T vector sh -c '$VECTOR_FILES'")
  vector=$(read_target "$command" | tr '\n' ' ')
  case "$vector" in
    "valid "?*) say "vector: its configuration holds; newest file ${vector#valid }" ;;
    "valid "*) say "vector: its configuration holds; no file written yet" ;;
    *) say "vector: its configuration does not hold, or it is not running" ;;
  esac
}

case "$command" in
  release) do_release ;;
  rollback) do_rollback ;;
  status) do_status ;;
  *) usage ;;
esac
