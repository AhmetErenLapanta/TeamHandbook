#!/bin/sh
# A stand-in for the Claude Code CLI, for the readiness screen only: it answers the version and
# sign-in questions the way an old CLI with no sign-in would, and runs nothing else.
case "$1" in
  --version) echo "2.0.0 (Claude Code)" ;;
  auth) echo '{"loggedIn":false,"authMethod":"none"}' ;;
  *) echo "the stand-in Claude Code runs no task" >&2; exit 1 ;;
esac
