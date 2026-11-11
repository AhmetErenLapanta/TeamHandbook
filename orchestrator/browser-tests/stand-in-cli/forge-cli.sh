#!/bin/sh
# A stand-in for gh and glab on the suite's orchestrator, linked under both names: it acts out a
# browser sign-in from files under the suite's own home, and nothing reaches a forge. The sign-in
# prints a one-time code and the page to enter it on, as the real CLI does with no terminal, then
# waits until the spec writes .stand-in-<tool>-approved (or -denied) in that home.
tool=$(basename "$0")
signed="$HOME/.stand-in-$tool-signed-in"
case "$tool" in gh) page="https://github.com/login/device"; field=login ;; *) page="https://gitlab.com/oauth/device"; field=username ;; esac
case "$1 $2" in
  "--version "*) echo "$tool version 9.9.9 (stand-in)" ;;
  "auth status") [ -f "$signed" ] || { echo "You are not logged into any hosts" >&2; exit 1; } ;;
  "auth git-credential") [ "$3" = "--help" ] || { echo "the stand-in $tool hands git no sign-in" >&2; exit 1; } ;;
  "auth login")
    echo "! First copy your one-time code: ABCD-1234" >&2
    echo "Open this URL to continue in your web browser: $page" >&2
    tries=0
    while [ ! -f "$HOME/.stand-in-$tool-approved" ] && [ ! -f "$HOME/.stand-in-$tool-denied" ]; do
      tries=$((tries + 1)); [ "$tries" -gt 600 ] && exit 1; sleep 0.2
    done
    [ -f "$HOME/.stand-in-$tool-denied" ] && { echo "failed to authenticate via web browser: access_denied" >&2; exit 1; }
    echo ada > "$signed"
    echo "✓ Logged in as ada" >&2 ;;
  "api "*) [ -f "$signed" ] && printf '{"%s":"ada"}\n' "$field" || { echo "HTTP 401: Bad credentials" >&2; exit 1; } ;;
  *) echo "the stand-in $tool runs nothing else" >&2; exit 1 ;;
esac
