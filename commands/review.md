---
description: Review what TeamHandbook learned — keep each skill for yourself, add it to this project, share it with the team, or reject it
---

You are running TeamHandbook's review flow. Pending skill candidates were harvested from real
sessions (the user's own corrections, completed-task procedures, discoveries, and error→fix
skills) or captured manually via /handbook:learn. Nothing leaves this machine without the
user's approval.

Ask for every verdict with the multiple-choice question tool (AskUserQuestion), never as a
sentence the user has to answer in prose. Typing `--to personal` back at you is not a review,
it is a chore, and a queue that feels like a chore is a queue nobody empties. The tool takes
up to four questions in one dialog, so ask about up to four candidates at a time and let the
user clear them in one pass.

1. Run: `node "${CLAUDE_PLUGIN_ROOT}/dist/review.js" list`
2. If there are no pending candidates, tell the user so — but if the CLI notes that sessions
   are still being harvested in the background, relay that they should try again shortly —
   then stop.
3. Show the whole queue first, one line each: name, kind, score, age, and the description's
   first line. The user decides what to spend attention on; drip-feeding them one candidate
   at a time hides how much is waiting.
4. Then take them in batches of up to four. Run `show` and write the summary for every
   candidate in the batch FIRST, and only then open a single dialog carrying one question
   per candidate. One dialog per candidate is the thing this replaces: it is the same
   drip-feed with buttons on it.
   a. Per candidate, run: `node "${CLAUDE_PLUGIN_ROOT}/dist/review.js" show <slug>`
   b. Present a compact summary: name, kind (correction / procedure / discovery / error-fix),
      description, scope, score (and its rationale, especially when low — the score is
      advice the user should see), and the grounded case (for a correction, that is the
      user's own quoted words). Quote the full SKILL.md body only if the user asks.
   c. In the dialog, one question per candidate, with these four options, the suggested
      destination first and marked as recommended:
      - **Keep for yourself** — loads in every project, only for you
      - **Add to this project** — this directory's `.claude/skills`, for anyone who works here
      - **Share with the team** — a pull request to the team handbook
      - **Reject** — not worth keeping
      The question header is a short tag, not a title: it fits about a dozen
      characters, so use "Skill 1" ... "Skill 4" and put the candidate's name in the
      question text itself, where it has room. Editing and skipping go through the tool's
      free-text answer; say so once, before the first dialog, rather than spending an
      option on each. Never-suggest-again is not announced here, because it is asked
      after a Reject, where it is the obvious next question rather than a fifth thing
      to hold in mind.
5. **Edit first**: if the user asks for changes ("step 3 is wrong", "add a warning about X"),
   edit the candidate's `SKILL.md` in place (it lives in the directory shown by `show`;
   keep the frontmatter `name:` unchanged), show the diff, and then ask for their verdict
   again.
6. Map each answer to the CLI:
   - **Keep for yourself** → `node "${CLAUDE_PLUGIN_ROOT}/dist/review.js" approve <slug> --to personal`
     (installs into the user-level `~/.claude/skills` — loads in every project).
   - **Add to this project** → `node "${CLAUDE_PLUGIN_ROOT}/dist/review.js" approve <slug> --to project`
     (installs into this directory's `.claude/skills`; commit it and it travels with the code).
   - **Share with the team** → `node "${CLAUDE_PLUGIN_ROOT}/dist/review.js" approve <slug> --to team`
     (pushes a `handbook/<slug>` branch and opens a PR to the team handbook; needs
     /handbook:init or /handbook:join first — the CLI says so if not).
   - Plain `approve <slug>` (no --to) follows the candidate's suggested target, which is
     the `suggested:` line `show` prints, not its `scope:`; relay
     where the CLI says it landed. If the output shows an "Open the PR here" link
     instead of a PR URL, pass that link on.
   - **Reject** → `node "${CLAUDE_PLUGIN_ROOT}/dist/review.js" reject <slug>`
     — a plain reject does NOT prevent the same skill from being suggested again later.
     Rejecting is the one answer worth a follow-up: ask, once the user has picked it,
     whether to drop it just this time or never suggest it again, and for the latter run
     `node "${CLAUDE_PLUGIN_ROOT}/dist/review.js" reject <slug> --never`. Do not put both
     on the main question; three destinations and a reject is already the most a person
     should have to weigh at once. If several in a batch were rejected, ask their
     follow-ups together, for the same reason the verdicts were asked together.
   - **Skip** → leave it pending and move on.
7. Finish with a one-line tally: how many kept (personal/project), shared, rejected, and
   still pending.

Queue STATE (candidate.json) is only ever written by the review CLI; the only file you may
edit directly is a candidate's SKILL.md, at the user's request, before their verdict.
