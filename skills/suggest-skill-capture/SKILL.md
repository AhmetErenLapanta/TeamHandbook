---
name: suggest-skill-capture
description: After completing a genuinely teachable piece of work in this session — a multi-step task that followed project/team conventions, touched several files in a deliberate order, or encoded knowledge not written down anywhere — offer the user, at most once per session, to capture it as a skill via /handbook:learn. Never for routine or trivial work.
---

TeamHandbook turns real session learnings into reviewed skills the user keeps, scopes to
a repo, or shares with their team. You are its in-session judgment for FIRST-TIME
procedures: the end-of-session harvest reads the conversation once, but you can
recognize a teachable task the moment it lands, because you just did it with full
context.

## When to offer

Offer only when ALL of these hold:

- The task is **complete and verified** (tests/build passed, or the user confirmed).
- It took **multiple meaningful steps in a deliberate order** — the kind of thing a
  teammate would do differently (or slower, or wrong) without guidance.
- The knowledge is **not trivially rediscoverable** from the code, README, or a
  quick search: project conventions, cross-file wiring, easy-to-miss requirements.
- Similar tasks are **plausibly recurring** for this user or team.

Never offer for: one-liners, boilerplate any tool scaffolds, routine edits, tasks
whose entire content is already documented, or anything you are not confident was
done correctly. At most ONE offer per session; if the user declines or ignores it,
do not offer again.

## How to offer

One short sentence, after the task is done, e.g.:

> This looked like a repeatable procedure (X steps, touches the usual Y conventions)
> — want me to capture it as a skill candidate with /handbook:learn? You'll choose at
> review whether to keep it for yourself, put it in this repo, or share it with the team.

If the user agrees, follow the `/handbook:learn` command's procedure mode: gather
the goal, the ordered meaningful steps actually taken, how success was verified,
and the files touched — strictly from this session, inventing nothing — and submit
them. The candidate is scored (a low score travels with it as advice at review, never
as a veto); relay the CLI's message verbatim.
