#!/bin/sh
# A stand-in for the Claude Code CLI, for the readiness screen only: it answers the version and
# sign-in questions the way an old CLI with no sign-in would (current and signed in when the home holds .stand-in-signed-in, for a README picture), and runs nothing else.
case "$1" in
  --version) if [ -e "$HOME/.stand-in-signed-in" ]; then echo "2.1.322 (Claude Code)"; else echo "2.0.0 (Claude Code)"; fi ;;
  auth) if [ -e "$HOME/.stand-in-signed-in" ]; then echo '{"loggedIn":true,"authMethod":"claude.ai"}'; else echo '{"loggedIn":false,"authMethod":"none"}'; fi ;;
  *) echo "the stand-in Claude Code runs no task" >&2; exit 1 ;;
esac
