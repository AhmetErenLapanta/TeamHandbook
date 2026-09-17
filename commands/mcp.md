---
description: Share one of the MCP servers already configured on this machine with the team, as a merge request to the team's plugin repository: this is how the team's shared MCP setup gets updated, so nobody has to install or configure a server by hand. It only reads your own local MCP config; it never modifies your machine's copy. Triggers: "share this MCP server with everyone", "the team should have this server too", "push my MCP config to the team", "set this server up for the whole team", "distribute an MCP server", "update the team's MCP settings".
argument-hint: [optional name of the server to share]
---

You are running TeamHandbook's MCP sharing flow. It reads the MCP servers Claude Code already
has configured on this machine and offers to write one into the team's plugin repository as a
merge request. Once that request is merged, every teammate has the server connected at their
next session: they install nothing and configure nothing.

This command only ever reads `~/.claude.json`. It never writes to it, so the user's own local
copy of the server stays exactly where it is.

1. Run it with no arguments first: `node "${CLAUDE_PLUGIN_ROOT}/dist/mcp.js"`
   It prints every server it can see, which scope it came from, and for anything it refuses,
   the reason. Nothing is shared by this step. Relay the list verbatim.
2. Ask the user which server to share. Do not pick for them, and do not offer to share one
   the list marked as not shareable: that refusal is the point, not an obstacle.
3. Share it: `node "${CLAUDE_PLUGIN_ROOT}/dist/mcp.js" <name>`
4. **If it refuses because a header or environment value is a literal**, the message names
   the exact key. Do not try to work around it, and never offer to redact the value: a
   server carried over with a blanked-out credential fails to connect for every teammate.
   Tell the user to rewrite that value as `${VAR}` in their own config (the variable name
   travels, the value does not), then run step 3 again.
5. **If it fails because the forge refuses the branch NAME**, the error quotes the pattern.
   Handle it exactly as `/handbook:init` does: propose one prefix that satisfies the pattern,
   confirm it with the user, and have them set `branchPrefix` under `team` in
   `~/.teamhandbook/config.json`. A prefix discovered by a successful retry is remembered.
6. Relay the CLI output verbatim. It says which environment variables each teammate must set,
   whether the server starts a process on their machine, and that the user's local copy is
   still there to remove themselves.

Never share a server the user has not explicitly named.
