#!/bin/sh
# The lab's clean machine (lab/clean-machine.ts) for a shell script, so a script outside the lab's
# scenarios keeps their rules rather than a copy of them:
#
#   sh lab/clean-machine.sh make <new dir>     makes the machine there and prints <dir>/run;
#                                              `<dir>/run <command>` runs the command on it, with its
#                                              environment and nothing of the caller's
#   sh lab/clean-machine.sh trapped <dir>      every call its trap refused; exits 1 when there is one
#   sh lab/clean-machine.sh packed <archive>   an npm tarball's or a release archive's name, bins,
#                                              paths that say the old name and the renamed settings it
#                                              lacks; exits 1 on a path or a missing setting
set -eu
lab=$(cd "$(dirname "$0")" && pwd)
. "$lab/dir.sh"
out="$(lab_dir)/tools/clean-machine.mjs"
mkdir -p "$(dirname "$out")"
"$lab/../node_modules/.bin/esbuild" "$lab/clean-machine-cli.ts" --bundle --platform=node --format=esm --target=node22 --log-level=warning --outfile="$out"
exec node "$out" "$@"
