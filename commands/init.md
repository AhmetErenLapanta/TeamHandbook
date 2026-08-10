---
description: Set up the team's shared skills repository (marketplace skeleton + version-bump CI)
argument-hint: [optional SSH URL of an empty git repo]
---

You are running TeamHandbook's team setup. This scaffolds the team's skills repository — a
Claude Code plugin marketplace where approved skills get merged and distributed — pushes
the skeleton with version-bump CI, and records the repo URL in the local TeamHandbook config.

1. Determine the target repository:
   - If the user provided a git URL ($ARGUMENTS), use it. It must be an EMPTY repository.
   - Otherwise ask the user whether they already created an empty repo (ask for its SSH
     URL) or want one created now. For creation, check `which gh` and `which glab`; ask
     which namespace/group and repo name to use and confirm visibility (default private),
     then create it, e.g. `gh repo create <ns>/<name> --private` or
     `glab repo create <ns>/<name> --private`, and use the new repo's SSH URL. If neither
     CLI is installed, ask the user to create an empty repo in their forge's web UI and
     paste its SSH URL.
2. Confirm the final target URL with the user before touching it.
3. Run: `node "${CLAUDE_PLUGIN_ROOT}/dist/init.js" <url>`
   (add `--name <n>` only if the user wants the marketplace named differently than the repo).
4. Relay the CLI output verbatim — it contains the join command for teammates.
5. If the push fails, show the error as-is; the most common causes are a non-empty target
   repo or missing SSH access.

Never create or push to a repository the user has not explicitly confirmed.

Note: teammates who only want to USE the team's skills (not capture their own) do not need TeamHandbook at all — they run the two built-in `/plugin` commands the CLI prints, and the team plugin ships a tiny hook that shows them new-skill notices.
