#!/bin/sh
# One lab scenario against the running lab, with an evidence directory of its own:
#
#   sh lab/verify.sh <spec>               the scenario; exits as it did
#   sh lab/verify.sh <spec> --fail-gate   the scenario with the fault it names left in; exits
#                                         0 only when it failed and its decision says so, which
#                                         shows its checks catch that fault
#
# Each scenario's directory under the printed path holds the store, the tasks, the orchestrator's
# log and decision.json, redacted. Every agent CLI the run reaches by name lands on a trap first,
# written down and refused, so no real one starts; a run that reached one fails, whatever its
# scenarios say.
set -eu
cd "$(dirname "$0")/.."
. lab/dir.sh
spec=${1:?usage: sh lab/verify.sh <spec> [--fail-gate]}
gate=${2:-}
case "$gate" in "" | --fail-gate) ;; *) echo "verify: unknown option $gate" >&2; exit 2 ;; esac
evidence="$(lab_dir)/evidence/$(date +%Y%m%dT%H%M%S)-$$"
mkdir -p "$evidence"
[ -n "$gate" ] && fail_gate=1 || fail_gate=0
trapped="$evidence/trap"
mkdir -p "$trapped"
for cli in claude opencode codex cursor-agent gemini; do
  cat > "$trapped/$cli" <<EOF
#!/bin/sh
printf '%s %s\n' '$cli' "\$*" >> '$trapped/calls.log'
echo "the lab's trap: $cli is never a real CLI in a lab run" >&2
exit 97
EOF
  chmod +x "$trapped/$cli"
done
PATH="$trapped:$PATH"
export PATH

status=0
LAB_EVIDENCE_DIR="$evidence" LAB_FAIL_GATE="$fail_gate" npx playwright test -c lab/playwright.config.ts "$spec" --workers=1 --retries=0 --reporter=line || status=$?
echo "verify: evidence in $evidence"
if [ -s "$trapped/calls.log" ]; then
  echo "verify: the run reached an agent CLI by name, which the trap refused:" >&2
  cat "$trapped/calls.log" >&2
  exit 1
fi
if [ -z "$gate" ]; then exit "$status"; fi

decided=$(find "$evidence" -name decision.json | wc -l | tr -d ' ')
missed=$(find "$evidence" -name decision.json -exec grep -l '"passed": true' {} + | wc -l | tr -d ' ')
if [ "$status" -ne 0 ] && [ "$decided" -gt 0 ] && [ "$missed" -eq 0 ]; then
  echo "verify: the fault was caught by every scenario that decided ($decided)"
  exit 0
fi
echo "verify: the fault was not caught (playwright exit $status, $decided decided, $missed passed with the fault in)" >&2
exit 1
