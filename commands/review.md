---
description: Review what TeamHandbook learned — keep each lesson for yourself, share it with the team, or reject it
---

You are running TeamHandbook's review flow. Pending skill candidates were harvested from real
sessions (the user's own corrections, completed-task procedures, discoveries, and error→fix
lessons) or captured manually via /handbook:learn. Nothing leaves this machine without the
user's approval.

1. Run: `node "${CLAUDE_PLUGIN_ROOT}/dist/review.js" list`
2. If there are no pending candidates, tell the user so — but if the CLI notes that sessions
   are still being harvested in the background, relay that they should try again shortly —
   then stop.
3. For each pending candidate, one at a time:
   a. Run: `node "${CLAUDE_PLUGIN_ROOT}/dist/review.js" show <slug>`
   b. Present a compact summary: name, kind (correction / procedure / discovery / error-fix),
      description, scope, score (and its rationale, especially when low — the score is
      advice the user should see), and the grounded case (for a correction, that is the
      user's own quoted words). Quote the full SKILL.md body only if the user asks.
   c. Ask the user the three-way question: **keep it for yourself, share it with the team,
      or reject?** (Editing first and skipping are also fine.)
   d. **Edit first**: if the user wants changes ("step 3 is wrong", "add a warning about X"),
      edit the candidate's `SKILL.md` in place (it lives in the directory shown by `show`;
      keep the frontmatter `name:` unchanged), show the diff, and then continue to their
      decision. This is the expected way to fix a 90%-right skill instead of rejecting it.
   e. Map the decision to the CLI:
      - **Keep for yourself** → `node "${CLAUDE_PLUGIN_ROOT}/dist/review.js" approve <slug> --to personal`
        (installs into the user-level `~/.claude/skills` — loads in every project).
        If the lesson is clearly project-specific, prefer `--to project` (installs into that
        project's `.claude/skills` and travels with the repo).
      - **Share with the team** → `node "${CLAUDE_PLUGIN_ROOT}/dist/review.js" approve <slug> --to team`
        (pushes a `handbook/<slug>` branch and opens a PR to the team skill base; needs
        /handbook:init or /handbook:join first — the CLI says so if not).
      - Plain `approve <slug>` (no --to) follows the candidate's suggested target; relay
        where the CLI says it landed. If the output shows an "Open the PR here" link
        instead of a PR URL, pass that link on.
      - **Reject** → `node "${CLAUDE_PLUGIN_ROOT}/dist/review.js" reject <slug>`
        — a plain reject does NOT prevent the same lesson from being suggested again later.
        If the user never wants it suggested again:
        `node "${CLAUDE_PLUGIN_ROOT}/dist/review.js" reject <slug> --never`
      - **Skip** → leave it pending and move to the next one.
4. Finish with a one-line tally: how many kept (personal/project), shared, rejected, and
   still pending.

Queue STATE (candidate.json) is only ever written by the review CLI; the only file you may
edit directly is a candidate's SKILL.md, at the user's request, before their verdict.
