#!/bin/sh
# The whole demo in one command. It builds and starts the orchestrator with its stand-in team
# repositories, local forge and example task, then has the Payments team ask to see skill use
# and reports three uses the way a teammate's TeamHandbook would, so each of the four layers
# has something on screen. Platform is left alone, so the screen also shows a team that never
# asked. It ends by printing the command that stops it.
set -eu
cd "$(dirname "$0")"
# ORCHESTRATOR_HOST_PORT moves the demo off 8080 when something else already listens there.
URL="http://127.0.0.1:${ORCHESTRATOR_HOST_PORT:-8080}"

ORCHESTRATOR_PUBLIC_URL="$URL" docker compose up --build -d
tries=0
until curl -sf "$URL/api/me" >/dev/null; do
  tries=$((tries + 1))
  if [ "$tries" -ge 120 ]; then
    echo "The orchestrator did not answer on $URL; see: docker compose logs orchestrator" >&2
    exit 1
  fi
  sleep 1
done

# POSIX sh has no pipefail, so a value read through a pipe is checked by hand: an empty one
# would otherwise carry on into calls that fail with nothing on screen.
need() {
  if [ -z "$2" ]; then
    echo "demo: could not read $1; see: docker compose logs orchestrator" >&2
    exit 1
  fi
}
endpoint() {
  docker compose exec -T orchestrator git -C /data/demo/repos/payments-skills.git show main:.teamhandbook.json |
    sed -n 's/.*"endpoint": *"\([^"]*\)".*/\1/p'
}

# A second run on the same volume finds the request already merged and only reports more use.
endpoint=$(endpoint)
if [ -z "$endpoint" ]; then
  # The request goes through the same steps as the screen: read the proposed message and branch,
  # confirm them against the head the page showed, then merge. JSON is read with the image's own
  # node rather than sed, since the branch and message are free text.
  number=$(docker compose exec -T orchestrator node -e '
    const url = "http://127.0.0.1:8080";
    const call = async (path, csrf, body) => {
      const res = await fetch(url + path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const json = await res.json();
      if (!res.ok) throw new Error(path + ": " + (json.error ?? res.status));
      return json;
    };
    (async () => {
      const { csrf } = await call("/api/me");
      const { repos } = await call("/api/repos");
      const head = repos.find((r) => r.id === "payments-skills")?.head;
      const { proposal, branch } = await call("/api/repos/payments-skills/usage/proposal", csrf, {});
      const { request } = await call("/api/repos/payments-skills/usage/propose", csrf, { baseSha: head, message: proposal, branch });
      await call("/api/repos/payments-skills/requests/" + request.number + "/merge", csrf, {});
      console.log(request.number);
    })().catch((err) => { console.error("demo: " + err.message); process.exit(1); });
  ')
  need "the usage request's number" "$number"
  endpoint=$(endpoint)
  need "the usage address in payments-skills" "$endpoint"
fi

hour=$(date -u +%Y-%m-%dT%H)
curl -fsS -X POST -H 'content-type: application/json' \
  --data "{\"events\":[{\"skill\":\"release-checklist\",\"hour\":\"$hour\"},{\"skill\":\"release-checklist\",\"hour\":\"$hour\"},{\"skill\":\"add-ledger-migration\",\"hour\":\"$hour\"}]}" \
  "$endpoint" >/dev/null

cat <<EOF

The orchestrator is up at $URL, signed in as the built-in admin.

1. Inventory: open payments-skills or platform-skills for each team's skills, MCP servers,
   commands, request settings and history.
2. Editing: Edit a skill, review the commit message, open the request, then Merge it. Add a
   server whose environment holds a literal token: the share rule refuses it.
3. Skill use: payments-skills asked to see skill use and shows the uses just reported;
   platform-skills never asked and shows none.
4. Tasks: start one with the stand-in agent; it ends waiting for review with a request, and
   nothing merges until a person does.

EOF

# The stop command names this directory quoted and the compose project this run used, so it
# is right when pasted from anywhere, for a run started as COMPOSE_PROJECT_NAME=x ./demo.sh too.
quoted_dir=$(pwd | sed "s/'/'\\\\''/g")
printf "Stop it with: cd '%s' && %sdocker compose down -v\n" "$quoted_dir" "${COMPOSE_PROJECT_NAME:+COMPOSE_PROJECT_NAME='$COMPOSE_PROJECT_NAME' }"
