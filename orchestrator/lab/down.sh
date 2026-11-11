#!/bin/sh
# Stops everything the lab started - its orchestrators, its stand-in forges, its Postgres container -
# and deletes the lab directory with every teammate's home in it. A directory without the lab's
# marker is left alone, and a process is stopped only when its command line names the lab
# directory, so nothing else on the machine is touched.
set -eu
cd "$(dirname "$0")/.."
. lab/dir.sh
dir=$(lab_dir)
if [ ! -e "$dir" ]; then
  echo "lab: nothing at $dir"
  exit 0
fi
if [ ! -f "$dir/.teamhandbook-orchestrator-lab" ]; then
  echo "lab: $dir was not made by the lab; nothing was stopped or deleted" >&2
  exit 1
fi
ours() {
  ps -o command= -p "$1" 2>/dev/null | grep -qF -- "$dir"
}
if [ -f "$dir/lab.json" ]; then
  pids=$(node -e 'for (const p of require(process.argv[1]).processes) console.log(p.pid)' "$dir/lab.json")
  container=$(node -e 'const s = require(process.argv[1]); console.log(s.postgres ? s.postgres.container : "")' "$dir/lab.json")
  for pid in $pids; do
    if ours "$pid"; then kill "$pid" 2>/dev/null || true; fi
  done
  # An orchestrator waits up to 8 seconds for the work under way; after 10 it is stopped outright.
  for pid in $pids; do
    tries=0
    while ours "$pid" && [ "$tries" -lt 40 ]; do
      sleep 0.25
      tries=$((tries + 1))
    done
    if ours "$pid"; then kill -9 "$pid" 2>/dev/null || true; fi
  done
  if [ -n "$container" ]; then
    # -v takes the anonymous volume the postgres image declares for its data with it.
    docker rm -f -v "$container" >/dev/null 2>&1 || true
  fi
fi
rm -rf "$dir"
echo "lab: stopped and removed $dir"
