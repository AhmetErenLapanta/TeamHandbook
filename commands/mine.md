---
description: Find the work this repository keeps repeating - the same files changed the same way, job after job - and turn one of those into a draft skill. Reads git history only and sends nothing anywhere until you ask for a draft; the draft goes to /handbook:review, never straight into the repository. Use when somebody wants to know what their codebase already does over and over, or wants a skill written out of work that has already happened rather than out of the session they are in. Triggers: "what does this repo do over and over", "find the repeating work in our history", "we keep doing this same task, write it down", "turn our git history into a skill", "mine the repository", "what workflows does this codebase have", "is there a pattern in how we add things here", "write a skill from what we have already built", "look at what the team keeps changing together".
argument-hint: [--repo <path>] [--limit <n>] | draft <n|id> [--repo <path>]
---

The user wants to see the work that repeats in a repository's history, and possibly to
turn one of those into a draft skill.

This command runs in two steps, and the first one spends nothing.

**Step 1 - list.** If the user's arguments begin with `draft`, they have already picked
one: go to step 2. Otherwise run it with whatever the user passed:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/mine.js" list $ARGUMENTS
```

Listing never drafts. Handed a draft request, it refuses with a usage error rather than
spending anything.

This reads the git history of the current repository (plus any `--repo <path>` the user
named, plus any configured in `mine.repos`) and prints the work that repeats, most
established first. It makes no model call and touches the network not at all. Relay its
output to the user as it is printed - the numbers beside each workflow are what lets them
recognise their own work, and the file map under it is the measured part.

If it finds nothing, say so plainly. A young repository, or one whose commits each touch
something different, genuinely has no repeating work to find; that is an answer.

**Step 2 - draft, only if the user picks one.** Picking is the consent for the model call:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/mine.js" draft <n> <the --repo arguments the listing was made with>
```

If the user typed `draft <n>` themselves, that is the pick: run
`node "${CLAUDE_PLUGIN_ROOT}/dist/mine.js" $ARGUMENTS` as it is.

Pass the SAME `--repo` arguments the listing was made with. A number means
nothing on its own: `#1` of two repositories and `#1` of one repository are different
workflows, so dropping a `--repo` here would send the model a workflow the user never picked.
The list prints the exact command to use; prefer copying that line.

Before running it, make sure the user knows what it does: it sends the screened evidence
for that one workflow to the model, costs roughly ten cents, and takes about a minute.
Do not run it for a workflow the user has not chosen, and do not run it for several
workflows because the list was long.

The draft is queued for `/handbook:review` and nothing else. It is NOT installed, NOT
written into `.claude/skills`, and NOT committed. Say this when you relay the result.

What the draft is, and what to tell the user it is not: it carries the file map the
history measured and a skeleton of the steps, and it is missing many of the steps a
hand-written skill would have, because much of the work never reaches git at all.
The draft lists what the history could not show rather than guessing it. The user fills
that part in at review. Do not describe it as a finished skill.

If the user then approves it into the project, that writes the skill into the repository
and commits it, so TeamHandbook will ask for the commit message first - give the user the
sentence it proposes and let them approve or edit it before you pass it back.
