---
description: Put a skill you wrote by hand into the review queue, so you can share it with your team
---

The user wants to take a skill that already exists on disk - one they wrote themselves, not
one TeamHandbook harvested - and put it in the review queue. Until now the only route into
that queue was to re-live the lesson and hope the harvest caught it.

One skill per run. If the user names several, do them one at a time and report each result.

1. Work out which skill they mean. Skills live in `~/.claude/skills/<name>` (personal, loads
   everywhere) and `.claude/skills/<name>` in the current project. If they named one, use it.
   If they did not, list what is there and ask which one - do not guess, and do not take the
   whole directory in.
2. Run: `node "${CLAUDE_PLUGIN_ROOT}/dist/share-skill.js" <path to the skill directory>`
3. On success, relay the message and tell them the next step is /handbook:review, where they
   choose between keeping it, adding it to this project, and opening a pull request to the
   team handbook. Nothing has left the machine yet.
4. On a refusal, relay the reason as-is; each one names what to fix:
   - a secret in one of the skill's files. The skill is NOT queued, and this is deliberate:
     it would otherwise be reviewed and pushed to a shared repository as it stands. Tell them
     which file, and that taking the credential out (an environment variable, a local config
     file the skill reads) and running the command again is the fix. Do not offer to redact
     it for them - a skill with a blanked-out script installs and then fails.
   - already in the review queue. The queued copy is left untouched; /handbook:review is
     where it gets decided.
   - no SKILL.md, or a SKILL.md with no name and description frontmatter. It is not a skill
     Claude Code would load either; offer to write the frontmatter.

The skill directory itself is never modified, moved, or deleted. The queue gets a copy.
