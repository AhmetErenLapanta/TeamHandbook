#!/bin/sh
# The orchestrator lab in one command: four stand-in organizations, each with its own orchestrator, team
# repositories on a local forge, a stand-in GitLab or a stand-in GitHub, one of them on a shared
# Postgres in docker, and teammates' machines that run the plugin's real hooks and commands.
# LAB_EXTRA_ORGS names a file that adds organizations of your own; see docs/internals/tests-and-lab.md, "The lab".
set -eu
cd "$(dirname "$0")/.."
. lab/dir.sh
dir=$(lab_dir)
if [ -e "$dir/lab.json" ]; then
  echo "lab: a lab is already up at $dir; stop it with npm run lab:down" >&2
  exit 1
fi
# The marker without lab.json is what an earlier lab left: a start that stopped before it began
# anything (a port in use, docker not answering), and the results of a test run on top of it.
if [ -f "$dir/.teamhandbook-orchestrator-lab" ]; then
  echo "lab: $dir holds what an earlier lab left (a start that stopped, or a test run's results); clear it with npm run lab:down, then start again" >&2
  exit 1
fi
if [ -d "$dir" ] && [ -n "$(ls -A "$dir")" ]; then
  echo "lab: $dir is not empty; set LAB_DIR to an empty or missing directory" >&2
  exit 1
fi
# Built every time: a lab started on an older build would test code the tree no longer holds.
npm run build
mkdir -p "$dir"
# Written first, so lab:down can clear a start that stops before it begins anything.
echo "made by the TeamHandbook orchestrator lab; lab/down.sh deletes this directory" > "$dir/.teamhandbook-orchestrator-lab"
# Bundled into the lab directory rather than dist/: the image never carries the lab.
npx esbuild lab/lab.ts --bundle --platform=node --format=esm --target=node22 --log-level=warning \
  --banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" \
  --outfile="$dir/lab.mjs"
LAB_DIR="$dir" LAB_ORCHESTRATOR_DIR="$(pwd)" node "$dir/lab.mjs" up
