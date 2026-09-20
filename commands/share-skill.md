---
description: Put a skill that already exists on disk, one you wrote by hand rather than one TeamHandbook harvested, into the review queue so it can reach the team. One skill per run, through the same review as everything else. Use only when the skill is already written; to capture something out of the current session, use /handbook:learn instead, and to pick several skills, MCP servers, and commands from a list of everything installed here, use /handbook:migrate. Triggers: "one of my own skills should go to the team", "add a skill I already have to the queue", "this skill of mine belongs in the team handbook", "queue an existing skill".
---

The user wants to take a skill that already exists on disk - one they wrote themselves, not
one TeamHandbook harvested - and put it in the review queue. Until now the only route into
that queue was to re-live the lesson and hope the harvest caught it.

One skill per run. If the user names several, or does not yet know which ones, /handbook:migrate
lists everything installed on this machine and takes as many as they pick in one go.

1. Work out which skill they mean. Skills live in `~/.claude/skills/<name>` (personal, loads
   everywhere) and `.claude/skills/<name>` in the current project. If they named one, use it.
   If they did not, list what is there and ask which one - do not guess, and do not take the
   whole directory in.
2. Run: `node "${CLAUDE_PLUGIN_ROOT}/dist/share-skill.js" <path to the skill directory>`
3. On success, relay the message and tell them two things: the queue got a COPY, so the skill
   they already use is untouched and keeps working; and the next step is /handbook:review,
   where they choose between keeping it, adding it to this project, and opening a pull request
   to the team handbook. Nothing has left the machine yet.
4. On a refusal, relay the reason as-is; each one names what to fix:
   - a secret in one of the skill's files. The skill is NOT queued, and this is deliberate:
     it would otherwise be reviewed and pushed to a shared repository as it stands. Tell them
     which file, and that taking the credential out (an environment variable, a local config
     file the skill reads) and running the command again is the fix. Do not offer to redact
     it for them - a skill with a blanked-out script installs and then fails.
   - already waiting in the review queue, or already approved or rejected there. Either way
     the queued copy is left exactly as it is. A waiting one is decided in /handbook:review;
     a decided one has already been through it.
   - no SKILL.md, or a SKILL.md with no name and description frontmatter. It is not a skill
     Claude Code would load either; offer to write the frontmatter.

The skill directory itself is never modified, moved, or deleted.
