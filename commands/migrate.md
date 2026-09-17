---
description: Take the Claude Code setup already on this machine to the team: lists every skill you have installed and every MCP server you have configured in one screen, you pick as many as you want, and the picked ones go out together. Use when more than one thing should travel, or when you want to see everything you could share before deciding. For a single skill use /handbook:share-skill and for a single server /handbook:mcp. Triggers: "share my setup with the team", "move my skills to the team handbook", "which of my skills should the team have", "send several of these at once", "migrate my local setup", "I have a lot of skills, let me pick some".
---

You are running TeamHandbook's migration flow: the manager's own setup, chosen from and
carried to the team. It reads `~/.claude/skills`, this project's `.claude/skills` and
`~/.claude.json`. It writes to none of them, and the copies the user already uses keep
working untouched.

Two different things happen to the two halves, and the user has to know which before they
choose, not after:

- a **skill** is copied into the review queue. Nothing leaves this machine. The verdict is
  still theirs to give in /handbook:review.
- an **MCP server** goes out immediately as a merge request to the team repository. That
  one other people can see.

1. Run it read-only first: `node "${CLAUDE_PLUGIN_ROOT}/dist/migrate.js" list`
   Relay the whole list, both halves, exactly as printed, including the entries it marks
   not shareable and the reason for each. Show everything before asking anything: the
   point of this command is that the user sees how much they have and decides where to
   spend their attention. Nothing is shared by this step.
2. Say the two consequences above in one line, then ask.
3. Ask with the multiple-choice question tool (AskUserQuestion), `multiSelect` enabled,
   the same way /handbook:review asks for verdicts. **Nothing is pre-selected and
   nothing is recommended.** Do not mark an option as recommended, do not pre-tick, and
   never treat "all of them" as the default: the user asked for this command precisely
   because sharing everything is the wrong answer.
   - Put the MCP servers in their own question, since picking them is the half that opens
     a merge request.
   - Put the skills in the questions that remain, four per question, in the order the list
     printed them. A dialog holds four questions, so a long inventory takes more than one
     pass; say how many are left after each.
   - Offer only what the list called shareable. A refusal is the point, not an obstacle.
   - Say once, before the first dialog, that they can answer in free text instead
     ("the three hesap ones", "all of the servers, none of the skills") if they already
     know what they want. Twenty skills is six dialogs, and a person who knows their own
     setup should not have to click through them.
4. Share what they picked, naming each one:
   `node "${CLAUDE_PLUGIN_ROOT}/dist/migrate.js" share --skill <name> --skill <name> --mcp <name>`
   Never add a name the user did not choose. With no flags the command shares nothing,
   which is the correct answer to an empty selection.
5. Relay the output verbatim. It reports the two groups separately, on purpose: the queued
   skills are still here and the shared servers are already out. Then point at
   /handbook:review as the next step for the queued half.
6. **If something is refused, relay the reason as-is and stop there.** Each one names what
   to fix, and none of them is worked around:
   - a secret in one of a skill's files. The skill is NOT queued. Tell them which file,
     and that taking the credential out is the fix. Never offer to redact it: a skill with
     a blanked-out script installs and then fails.
   - a literal in a server's `headers` or `env`, or a credential in its URL. The message
     names the exact key. The fix is to rewrite it as `${VAR}` in their own config, where
     the name travels and the value does not. Never offer to redact it either.
   - already waiting in the review queue, or already decided there. The queued copy is
     left exactly as it is.
   - the team repository already declares a server by that name. Theirs is untouched; the
     rest of the selection still went.
7. **If it fails because the forge refuses the branch NAME**, the error quotes the pattern.
   Handle it exactly as `/handbook:mcp` does: propose one prefix that satisfies the
   pattern, confirm it with the user, and have them set `branchPrefix` under `team` in
   `~/.teamhandbook/config.json`. A prefix discovered by a successful retry is remembered.

The selected MCP servers travel as ONE merge request, with one version bump, rather than
one request each. That is deliberate: two requests opened before either is merged both
claim the same plugin version, and the second one to be merged then reaches nobody.

If no team repository is configured, skills can still be queued; the servers cannot go
anywhere until /handbook:init or /handbook:join has been run. The command says so.
