---
description: Review pending TeamHandbook candidates — approve or reject each distilled skill
---

You are running TeamHandbook's review flow. Pending skill candidates were distilled from real
error→fix moments in past sessions and now wait for the user's verdict. Nothing leaves this
machine without their approval.

1. Run: `node "${CLAUDE_PLUGIN_ROOT}/dist/review.js" list`
2. If there are no pending candidates, tell the user so and stop.
3. For each pending candidate, one at a time:
   a. Run: `node "${CLAUDE_PLUGIN_ROOT}/dist/review.js" show <slug>`
   b. Present a compact summary: name, description, scope, gate score, and the grounded
      case (failed command → error → fix). Quote the full SKILL.md body only if the user
      asks for it.
   c. Ask the user: approve, reject, or skip?
   d. On approve run: `node "${CLAUDE_PLUGIN_ROOT}/dist/review.js" approve <slug>`
      — with a team repo configured (via /handbook:init or /handbook:join) this pushes a
      `handbook/<slug>` branch and opens a PR to the team skill base; otherwise it installs
      the skill into the originating project's `.claude/skills/` directory (solo mode).
      Relay the PR URL or installed path from the CLI output; if the output shows an
      "Open the PR here" link instead of a PR URL, pass that link on to the user.
      On reject run: `node "${CLAUDE_PLUGIN_ROOT}/dist/review.js" reject <slug>`
      On skip, leave it pending and move to the next one.
4. Finish with a one-line tally: how many approved, rejected, and still pending.

Do not edit candidate files yourself; the review CLI is the only writer of queue state.
