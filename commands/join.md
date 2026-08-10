---
description: Join your team's shared skills repository set up by a champion via /handbook:init
argument-hint: <git URL shared by your team's champion>
---

You are running TeamHandbook's team join flow. Joining does two things: it points the local
TeamHandbook engine at the team's skills repository (where approved skills will be proposed),
and it connects Claude Code to that repository's plugin marketplace so merged skills reach
this machine automatically.

1. The team repo URL is required ($ARGUMENTS). If missing, ask the user for the URL their
   team champion shared and stop until they provide it.
2. Run: `node "${CLAUDE_PLUGIN_ROOT}/dist/join.js" <url>`
   This clones the repo shallowly to validate it, reads the marketplace name, and records
   the team target in the local TeamHandbook config.
3. Relay the CLI output verbatim. It ends with two built-in commands
   (`/plugin marketplace add <url>` and `/plugin install <name>`) — tell the user to run
   those two commands themselves to finish the marketplace connection.
4. If the clone fails, show the error as-is; the most common causes are a typo in the URL
   or missing SSH access to the repository.

Note: teammates who only want to USE the team's skills (not capture their own) do not need TeamHandbook at all — they run the two built-in `/plugin` commands the CLI prints, and the team plugin ships a tiny hook that shows them new-skill notices.
