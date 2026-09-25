---
description: Join a team skills repository someone else already created with /handbook:init: points this machine at that repo and prints the commands to subscribe Claude Code to its plugin marketplace, so skills merged there arrive automatically once you run them. Use when the repo already exists and you are not the person who made it. Triggers: "connect me to my team's skill base", "my team already has one, add me", "point me at the repo they set up", "someone gave me the address, wire me in", "hook this machine up to the team handbook".
argument-hint: <git URL shared by your team's champion>
---

You are running TeamHandbook's team join flow. Joining points the local TeamHandbook engine
at the team's skills repository (where approved skills will be proposed). It does not connect
Claude Code to anything by itself: it prints two built-in commands, and the user runs them to
subscribe to that repository's plugin marketplace so merged skills reach this machine.

1. The team repo URL is required ($ARGUMENTS). If missing, ask the user for the URL their
   team champion shared and stop until they provide it.
2. Run: `node "${CLAUDE_PLUGIN_ROOT}/dist/join.js" <url>`
   This clones the repo shallowly to validate it, reads the marketplace name and the
   commit-message prefix the repository records, and writes the team target to the local
   TeamHandbook config.
3. Relay the CLI output verbatim. It ends with two built-in commands
   (`/plugin marketplace add <url>` and `/plugin install <name>@<name>`); tell the user to run
   those two commands themselves to finish the marketplace connection.
4. If the output says the repository records no commit-message prefix, relay that
   paragraph too rather than trimming it as noise. It is the one warning the user gets
   before their FIRST share is refused by a rule this machine could not satisfy, and the
   fix belongs to whoever ran `/handbook:init` - it is not something to work around here.
   Do not offer to set a prefix yourself: guessing one produces commits the forge refuses
   for a second reason.
5. If the clone fails, show the error as-is; the most common causes are a typo in the URL
   or missing SSH access to the repository.

Note: teammates who only want to USE the team's skills (not capture their own) do not need TeamHandbook at all - they run the two built-in `/plugin` commands the CLI prints, and the team plugin ships a tiny hook that shows them new-skill notices.
