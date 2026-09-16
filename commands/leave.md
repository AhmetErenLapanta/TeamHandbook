---
description: Leave the current team skill base and return to solo mode, or clear the binding so you can join a different team. It removes only the local link: no skills are deleted, and Claude Code's marketplace subscription is a separate command you run yourself. Triggers: "disconnect me from this team", "I am not working with them anymore", "unlink the team repo", "switch me to a different team handbook", "go back to just my own skills".
---

You are running TeamHandbook's team leave flow. This clears the local team binding so the user
can return to solo mode or join a different team. It does NOT delete any skills, and it does
not touch Claude Code's marketplace subscription.

1. Run: `node "${CLAUDE_PLUGIN_ROOT}/dist/leave.js"`
2. Relay the CLI output verbatim. It notes that removing the Claude Code marketplace
   subscription is a separate built-in command (`/plugin marketplace remove <name>`) the
   user runs themselves if they also want to stop *receiving* that team's skills.
3. To switch teams, follow up with `/handbook:join <new-url>`.
