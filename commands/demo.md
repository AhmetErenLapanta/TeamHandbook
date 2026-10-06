---
description: Watch TeamHandbook learn something from a real session end to end, in about five minutes: it prepares a piece of real work, harvests a skill out of it, and hands you the approval step. Use when someone wants to see the product actually work before trusting it or rolling it out to a team. Triggers: "show me how this works", "give me a demo", "walk me through it", "let me see it in action", "what does this thing actually do", "I want to try it before I hand it to the team".
---

You are running TeamHandbook's guided demo. It shows the product's main path on a scratch
repository: the work a history repeats, listed; one of those drafted as a skill; the draft
on the review screen. Nothing here reads the user's own repositories, and nothing calls a
model unless the user picks a live draft.

## First, build the scratch repository and list it

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/demo.js" start
```

This builds an invented shop API under the system's temporary directory, its history
written to order, and lists the work that history repeats exactly as `/handbook:mine` lists
a real repository. It makes no model call and sends nothing. Relay the list as it is
printed: the counts beside each workflow are how a reader recognises their own work, and
the file map under it is the measured part. Keep the repository path it printed; every step
below needs it.

## Then, ask how the draft should be written

One AskUserQuestion, two options, the first marked as recommended:

- **Recorded draft** - a draft written earlier from this same history, put through the
  format check and screen a fresh one has to pass. No model call, nothing sent.
- **Live draft** - a fresh one from the user's own `claude` CLI. One model call: the
  screened evidence for the scratch repository's first workflow is sent, and nothing else.

Run only what they picked, with the repository path from the first step:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/demo.js" recorded "<repository path>"
node "${CLAUDE_PLUGIN_ROOT}/dist/demo.js" live "<repository path>"
```

Never run `live` without that answer, and never as a fallback when something else fails:
the answer is what makes the model call theirs. If a live draft comes back with nothing
kept, relay the reason as printed - a reply that fails the format check or the screen is
dropped, not repaired - and offer the recorded one.

## Last, the review screen

The draft now waits in the user's review queue like any draft from `/handbook:mine`. Show
it with the slug the previous step printed:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/review.js" show <slug>
```

Present it as `/handbook:review` would: what it is (a draft from repository history), its
file map, and the questions it lists under what the history could not show. Those questions
are the part a person fills in; do not call the draft a finished skill.

Then one AskUserQuestion, two options:

- **Add it to the scratch repository** - run
  `node "${CLAUDE_PLUGIN_ROOT}/dist/review.js" approve <slug> --to project`. The first run
  commits nothing: it comes back with `commit message required` and the message it
  proposes. Show the user that sentence, let them approve or edit it, and run the same
  command again with `--message "<their wording>"`. The commit lands in the scratch
  repository and nowhere else; show it with `git -C "<repository path>" log -1 --stat`.
- **Reject it** - run `node "${CLAUDE_PLUGIN_ROOT}/dist/review.js" reject <slug>`.

Offer nothing else. Keeping it for themselves or sharing it with the team would carry a
skill about an invented API out of the scratch repository, and leaving it pending lets it
outlive that repository: approved later from a real project, it would land there instead.

## Afterwards

The scratch repository stays until it is deleted. When the user asks, remove the directory
the repository sits in (the `handbook-demo-*` one), once the draft has been added or rejected:
a draft still waiting after that can only be rejected. To do the same on real work, run
`/handbook:mine` in a real repository.
