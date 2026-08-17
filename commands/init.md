---
description: Set up the team's shared skills repository, one person, once
argument-hint: [optional SSH URL of an empty git repo]
---

You are running TeamHandbook's team setup. ONE person on a team runs this ONCE: it
scaffolds their skills repository — a Claude Code plugin marketplace where approved skills
get merged and distributed — opens a merge request with the scaffold, and records the repo
URL locally. Everyone else runs the join or /plugin commands the output prints; nobody else
runs this command.

Never ask the user for a branch or commit prefix up front. Most repositories need none, and
asking everybody about a rule that affects a minority is how a two-command setup becomes a
form to fill in. Run it plainly, and only if the forge refuses, ask — the refusal says
exactly what the rule is.

1. Determine the target repository:
   - If the user provided a git URL ($ARGUMENTS), use it. It may be empty or already have files in it: the scaffold is added alongside whatever is there, and any file that already has content is left alone.
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
4. **If it fails because the forge refuses the branch NAME**, the error quotes the pattern
   the project requires. Do not hand the user a flag to work out. Read the pattern, propose
   ONE prefix that satisfies it, and ask them to confirm or correct it with a
   multiple-choice question — for a pattern like
   `((^(HSP|HEM|HEA|HEG)-\d+(-[a-z0-9]+)*)|dev|master|prod|hotfix(.*))$` a working prefix is
   `HEM-1-`, and the repo's existing branches or recent commit messages usually show which
   key the team really uses. Then re-run with `--branch-prefix "<their answer>"`.
5. **If it then fails because the forge refuses the commit MESSAGE**, do the same with
   `--commit-prefix "<prefix>"`. Both are remembered, so every skill shared later uses them
   without asking again.
6. **If it fails for any other reason** — credentials, access, a protected branch — relay
   the error as-is and stop. Those need a person, not a retry.
7. Relay the CLI output verbatim — it contains the message to send teammates.
8. Add `--with-ci` only if the user says skills will also be committed to this repository by
   hand. The version bump normally travels inside each skill's own merge request, so the
   scaffold needs no CI, no access token, and no right to push to a protected branch.

Never create or push to a repository the user has not explicitly confirmed.

Note: teammates who only want to USE the team's skills (not capture their own) do not need TeamHandbook at all — they run the two built-in `/plugin` commands the CLI prints, and the team plugin ships a tiny hook that shows them new-skill notices.
