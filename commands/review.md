---
description: Review pending TeamHandbook candidates — approve, refine, or reject each distilled skill
---

You are running TeamHandbook's review flow. Pending skill candidates were distilled from real
session learnings (error→fix moments and task procedures) and now wait for the user's
verdict. Nothing leaves this machine without their approval.

1. Run: `node "${CLAUDE_PLUGIN_ROOT}/dist/review.js" list`
2. If there are no pending candidates, tell the user so and stop.
3. For each pending candidate, one at a time:
   a. Run: `node "${CLAUDE_PLUGIN_ROOT}/dist/review.js" show <slug>`
   b. Present a compact summary: name, description, scope, gate score (and its rationale,
      especially when the score is below the threshold — the gate's dissent is advice the
      user should see), and the grounded case. Quote the full SKILL.md body only if the
      user asks for it.
   c. Ask the user: **approve, edit first, reject, or skip?**
   d. **Edit first**: if the user wants changes ("adım 3 yanlış", "add a warning about X"),
      edit the candidate's `SKILL.md` in place (it lives in the directory shown by `show`;
      keep the frontmatter `name:` unchanged), show the diff, and then continue to their
      approve/reject decision. This is the expected way to fix a 90%-right skill instead of
      rejecting it.
   e. On approve run: `node "${CLAUDE_PLUGIN_ROOT}/dist/review.js" approve <slug>`
      — with a team repo configured (via /handbook:init or /handbook:join) this pushes a
      `handbook/<slug>` branch and opens a PR to the team skill base; otherwise it installs
      the skill into the originating project's `.claude/skills/` directory (solo mode).
      Relay the PR URL or installed path from the CLI output; if the output shows an
      "Open the PR here" link instead of a PR URL, pass that link on to the user.
      On reject run: `node "${CLAUDE_PLUGIN_ROOT}/dist/review.js" reject <slug>`
      — a plain reject does NOT prevent the same learning from being suggested again later.
      If the user says they never want this suggested again, run:
      `node "${CLAUDE_PLUGIN_ROOT}/dist/review.js" reject <slug> --never`
      On skip, leave it pending and move to the next one.
4. Finish with a one-line tally: how many approved, rejected, and still pending.

Queue STATE (candidate.json) is only ever written by the review CLI; the only file you may
edit directly is a candidate's SKILL.md, at the user's request, before their verdict.
