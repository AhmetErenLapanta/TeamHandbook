#!/usr/bin/env bash
# Run one half of the suite and report a score that excludes runs which never happened.
#
# The harness's own overallScore counts a run that never reached the model as a plain
# zero. That was measured, not assumed: a case with an unresolvable path scored 0.00 at
# $0.00 and 0 seconds, and the suite average moved as if the model had answered and got
# it wrong. Under load that turns a quiet infrastructure failure into a product result,
# so this script recomputes the score over valid runs only and reports the rest.
#
# Usage: evals/run-suite.sh <tag> [extra claude args...]
#   tag: nl-tutma (headline) | nl-gelistirme | fp-tutma | fp-gelistirme | kontrol
set -uo pipefail

TAG="${1:?usage: run-suite.sh <tag> [extra args...]}"; shift
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${TH_EVAL_OUT:-$(mktemp -d -t th-eval)}/result-$TAG.json"
mkdir -p "$(dirname "$OUT")"

# --ablation none is load-bearing, not decoration: under the default with-without arm every
# tool_used grader whose tool is Skill is pulled out of the score and reported as a
# "plugin-fired indicator" instead. Every grader in this suite is exactly that type, so
# without this flag the number silently measures something else.
# --threshold 0 keeps the exit code meaning "the suite ran", so the INVALID stamp below is
# the only thing that can fail it; the default of 1.0 exits 1 whenever any case misses.
claude plugin eval "$ROOT" --tag "$TAG" --ablation none --no-publish \
  --threshold 0 --json "$OUT" "$@" || true

[ -s "$OUT" ] || { echo "no result written; the suite did not run"; exit 2; }

python3 - "$OUT" "$TAG" <<'PY'
import json, sys

result, tag = json.load(open(sys.argv[1])), sys.argv[2]

# A run that reached the model always costs something: the cheapest observed real run was
# $0.024. $0.00 therefore means the run never happened. A timeout means it was cut off
# before it could answer. Neither is evidence about routing, so neither is scored.
# A turn-limit hit is NOT invalid: the model did answer, it just ran long, and that is a
# real behavioural outcome worth keeping in the number.
# A case the harness could not even set up (a bad fixture path, an unplannable case) also
# costs $0.00, and folding it in with genuine infrastructure noise would let a typo in a new
# case be reported as a flaky slot and quietly dropped from the denominator. It is a third
# state: the package is broken and the number is not to be read at all.
# Only strings that cannot appear without a bad case file. "run could not start" is
# deliberately NOT here: the harness prints it for generic launch failures too, which are
# transient, and calling those a broken package would send someone to edit a correct case.
BROKEN = ("escapes the case directory", "resolves (through a link) outside",
          "could not be planned", "could not be resolved")

def classify(run):
    err = (run.get("error") or "").lower()
    if any(b in err for b in BROKEN):
        return "broken", run.get("error") or "setup failed"
    if run.get("costUsd", 0) == 0:
        return "invalid", "never reached the model ($0.00)"
    # A timeout only destroys the evidence if the evidence had not arrived yet. Measured: two
    # runs timed out at 180s having ALREADY fired the right command, so their graders passed.
    # Discarding those would drop a real hit and quietly shrink the denominator for that case
    # in every future comparison. A timeout without a score is the ambiguous one.
    if ("timed out" in err or "timeout" in err) and run.get("score", 0) < 1:
        return "invalid", "timed out before reaching a verdict"
    return "valid", ""

if not result.get("cases"):
    print(f"\n=== {tag} ===\n\n  no cases carry this tag, so nothing was measured.")
    sys.exit(2)

rows, invalid, broken, turn_capped = [], [], [], 0
for case in result.get("cases", []):
    hits = total = 0
    for run in case.get("arms", {}).get("with", []):
        state, why = classify(run)
        if state == "broken":
            broken.append((case["name"], why))
            continue
        if state == "invalid":
            invalid.append((case["name"], why))
            continue
        total += 1
        hits += 1 if run.get("score", 0) >= 1 else 0
        if "maximum number of turns" in (run.get("error") or ""):
            turn_capped += 1
    rows.append((case["name"], hits, total))

scored = [(n, h, t) for n, h, t in rows if t]
score = sum(h / t for _, h, t in scored) / len(scored) if scored else None
runs_total = sum(t for _, _, t in rows) + len(invalid)
rate = len(invalid) / runs_total if runs_total else 0

print(f"\n=== {tag} ===")
if broken:
    print("\n  BROKEN: these cases could not be set up, so the package did not run:")
    for name, why in broken:
        print(f"      {name}: {why}")
    print("\n  Fix the case definitions; there is no number to read here.")
    sys.exit(2)
if result.get("partial"):
    print("\n  BROKEN: the suite stopped early (partial result, most likely a cost ceiling).")
    print("  A score over the cases that did run is not a result for this package.")
    sys.exit(2)
for name, hits, total in sorted(rows):
    print(f"  {hits}/{total}" if total else "  ---", f" {name}"
          + ("   [ALL RUNS INVALID]" if not total else ""))

print(f"\n  score (valid runs only) : {score:.4f}" if score is not None else
      "\n  score                   : none, every run of every case was invalid")
print(f"  valid runs              : {runs_total - len(invalid)}/{runs_total}")
print(f"  invalid runs            : {len(invalid)}/{runs_total} = {rate:.1%}")
for name, why in invalid:
    print(f"      {name}: {why}")
if turn_capped:
    print(f"  turn-limit hits         : {turn_capped} (counted, not invalid)")
print(f"  cost / duration         : ${result.get('costUsd', 0):.2f} / "
      f"{result.get('durationSeconds', 0)}s")

# 10%: one invalid run in a twelve-case package at three runs each is 2.8%, and a single
# accident must not void a package. The band on this suite is +/-0.073 at three runs per
# case, itself a floor; dropping a tenth of the runs shrinks the denominator from 36 to
# about 32 and widens that band by roughly a sixteenth, which stays inside the uncertainty
# already carried. Above a tenth the failures stop looking independent: the one observed
# real instance was a loaded machine returning $0.00 for five cases at once, about 14%.
# So the line sits above a single accident and below the only failure of this kind seen.
LIMIT = 0.10
if rate > LIMIT:
    print(f"\n  INVALID: {rate:.1%} of runs did not happen (limit {LIMIT:.0%}). "
          f"The score above is not a result for this package; re-run it.")
    sys.exit(1)
print("\n  valid: the invalid-run rate is within the limit.")
PY
