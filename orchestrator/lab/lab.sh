#!/bin/sh
# A running lab by hand: `lab/lab.sh status`, or `lab/lab.sh dev <org> <developer> <action>`
# for one teammate's machine (doctor, update, session, use <plugin:skill>, agree, decline).
set -eu
cd "$(dirname "$0")/.."
. lab/dir.sh
dir=$(lab_dir)
if [ ! -f "$dir/lab.mjs" ]; then
  echo "lab: no lab at $dir; start one with npm run lab" >&2
  exit 1
fi
LAB_DIR="$dir" LAB_ORCHESTRATOR_DIR="$(pwd)" node "$dir/lab.mjs" "$@"
