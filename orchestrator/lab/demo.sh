#!/bin/sh
# The three-minute demo and its gate (DEMO-sozlesme F9): the orchestrator cloned onto a clean
# machine, the parcel-pricer repository's failing test made to pass by the agent, a line of its
# change quoted in a follow-up, and the request kept. One line a step in demo.ndjson.
#
#   sh lab/demo.sh [--agent stand-in] [--ref <sha>] [--out <dir>] [--record]
#
# --record makes the screen recording instead: the orchestrator's own tab alone, a person giving the
# task in a folder with no Git, the agent's live run, the test from failing to passing, review and
# Keep, as demo-recording.webm with recording.json (its path and length).
#
# The stand-in claude is the gate's agent, the same each run. The real Claude Code and OpenCode
# run the same demo by hand, with the person's own sign-in, and are not wired here yet. Exits 0
# only when every step passed; a step the screen does not offer yet is written down as skipped.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
. "$here/dir.sh"
agent=stand-in
ref=HEAD
out=""
spec=lab/tests/demo.spec.ts
while [ $# -gt 0 ]; do
  case "$1" in
    --agent) agent=$2; shift 2 ;;
    --ref) ref=$2; shift 2 ;;
    --out) out=$2; shift 2 ;;
    --record) spec=lab/tests/demo-recording.spec.ts; shift ;;
    *) echo "usage: sh lab/demo.sh [--agent stand-in] [--ref <sha>] [--out <dir>] [--record]" >&2; exit 2 ;;
  esac
done
case "$agent" in
  stand-in) ;;
  claude | opencode) echo "demo: the real $agent is run by hand with its owner's sign-in; the gate runs --agent stand-in" >&2; exit 2 ;;
  *) echo "demo: the agent is stand-in, claude or opencode" >&2; exit 2 ;;
esac
sha=$(git -C "$here" rev-parse --verify "$ref^{commit}")
out=${out:-$(lab_dir)/demo/$(printf '%s' "$sha" | cut -c1-12)-$(date +%Y%m%dT%H%M%S)}
mkdir -p "$out"
cd "$here/.."
status=0
LAB_DEMO_REF="$sha" LAB_DEMO_OUT="$out" npx playwright test -c lab/playwright.config.ts "$spec" --workers=1 --retries=0 --reporter=line || status=$?
[ -f "$out/demo.txt" ] && cat "$out/demo.txt"
[ -f "$out/recording.txt" ] && cat "$out/recording.txt"
echo "demo: $out"
exit "$status"
