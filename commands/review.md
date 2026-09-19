---
description: Review what TeamHandbook has captured and give each pending skill a verdict: keep it for yourself, add it to this project, share it with the team, or reject it. This is the only route by which anything leaves this machine, and the place to go whenever captured work should reach other people. Triggers: "go through the pending ones", "what has it learned so far", "deal with the queue", "my team should get these", "approve or throw these out", "empty the review queue".
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
   at a time hides how much is waiting. If that list is longer than the user can work
   through in one sitting, offer the sweep at the end of this file before starting the
   batches.
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
      - **Add to <project>** - the `.claude/skills` of the project `show` names on its
        `project:` line (or `suggested:`, when that is what it recommends), for anyone who
        works there. A skill installs into the project it was captured in, not whichever
        project you are reviewing from, so put that project's name in the option itself:
        the user answers from the option text, and the CLI names the project only after
        it has already copied the skill. "Add to this project" is right only when `show`
        says this one.
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
   - **Add to <project>** → `node "${CLAUDE_PLUGIN_ROOT}/dist/review.js" approve <slug> --to project`
     (installs into the `.claude/skills` of the project the skill was captured in, which is
     the one `show` named; commit that repo and the skill travels with the code).
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
7. **If the CLI says the team already has a skill by that name**, nothing was sent and
   nothing in the team repository changed. Treat it as the next question rather than as a
   failure, and ask it the way every other verdict here is asked — one AskUserQuestion,
   three options:
   - **Send it as an update to theirs** → `node "${CLAUDE_PLUGIN_ROOT}/dist/review.js" approve <slug> --to team --update`
     The merge request then replaces the team's copy rather than adding a file, and its
     body says so to whoever reviews it. Say the consequence BEFORE they pick: anything
     the team's copy gained since it landed is gone once that request is merged.
   - **Send it under a different name** → `node "${CLAUDE_PLUGIN_ROOT}/dist/review.js" approve <slug> --to team --as <new-name>`
     Both skills then exist, and the one that goes out carries the new name in its own
     frontmatter.
   - **Leave the team's alone** → keep this one with `--to personal` or `--to project`, or
     reject it.
   Never choose for them and never re-run with `--update` on your own initiative: an
   update overwrites work somebody else may have done to that skill, and the CLI refuses
   to do it without being told twice. `--as` takes one name, so it belongs to one
   candidate; do not put it on a batch.
8. A skill kept for yourself or added to a project behaves the same way, with one
   difference: rather than refusing, it installs under a suffixed name and the CLI says
   which name it used and why. Relay that line as printed — the name it reports is the
   name Claude will load, and it is not always the one in the queue. `--update` and
   `--as` work there too, if the user would rather replace or rename.
9. Finish with a one-line tally: how many kept (personal/project), shared, rejected, and
   still pending.

Queue STATE (candidate.json) is only ever written by the review CLI; the only file you may
edit directly is a candidate's SKILL.md, at the user's request, before their verdict.

## When the queue is too long to review

The backlog predates the bar the harvest holds discoveries to today, and a queue nobody can
finish reading is a queue nobody decides. The sweep puts today's bar to what is already
waiting. Offer it when `list` shows more than one sitting's worth.

1. Show what it would do before it does it:
   `node "${CLAUDE_PLUGIN_ROOT}/dist/review.js" sweep --dry-run`
   It judges the backlog and prints the same report, archiving nothing. Relay that report
   and let the user decide from it.
2. Then, on their word: `node "${CLAUDE_PLUGIN_ROOT}/dist/review.js" sweep`
3. Say what it does not cover, before they expect otherwise: only DISCOVERY candidates are
   re-judged. Corrections, procedures and error-fix candidates stay pending, so a sweep
   shortens the queue rather than emptying it. Both runs spend model calls, and the report
   names how many it took.
4. Archived is not rejected, and the user should hear that too:
   `node "${CLAUDE_PLUGIN_ROOT}/dist/review.js" list --archived` shows what was set aside,
   and `node "${CLAUDE_PLUGIN_ROOT}/dist/review.js" restore` puts the most recent sweep
   back. Pass a manifest path to restore an older one.
