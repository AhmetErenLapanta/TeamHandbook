#!/bin/sh
# An old orchestrator's Postgres database for the release gate (lab/fixture-dump.ts):
#
#   sh lab/fixture-dump.sh <ref>    builds the orchestrator at <ref>, fills it on the lab's Postgres
#                                   and writes lab/fixtures/postgres/schema-<N>.sql
#
# It needs the lab up (npm run lab) for its Postgres, and pg_dump on the PATH.
set -eu
lab=$(cd "$(dirname "$0")" && pwd)
. "$lab/dir.sh"
out="$(lab_dir)/tools/fixture-dump.mjs"
mkdir -p "$(dirname "$out")"
"$lab/../node_modules/.bin/esbuild" "$lab/fixture-dump.ts" --bundle --platform=node --format=esm --target=node22 --log-level=warning \
  --banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" --outfile="$out"
exec node "$out" "$@"
