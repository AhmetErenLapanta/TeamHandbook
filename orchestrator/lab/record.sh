#!/bin/sh
# A screen recording of the orchestrator's own tab alone (lab/record-tab.ts): a visible window the
# person uses, opened with the one-time sign-in link it is handed; it reads no secret itself.
#
#   sh lab/record.sh --link-file <0600 file holding the link> | --link <link> [--out <dir>] [--minutes 30] [--rehearse]
#
# Close the window, wait for the cap, or press Ctrl-C to end it; recording.webm and recording.json
# are written to --out. Node runs the TypeScript itself, so @playwright/test comes from this
# orchestrator's own node_modules.
set -eu
lab=$(cd "$(dirname "$0")" && pwd)
exec node "$lab/record-tab.ts" "$@"
