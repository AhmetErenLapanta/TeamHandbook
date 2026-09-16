---
description: >-
    False-positive probe, not a routing case. Carries "team" and "joins" against
    /handbook:init, /handbook:join and the trigger "I am setting this up for my team". The
    hardest of the three, because the sentence is about a team and about onboarding.
expected_outcome: >-
    No handbook command. The request is to write a document, not to create or join a
    shared skills repository.
tags: [fp]
max_turns: 6
timeout_seconds: 180
allowed_tools: [Read, Glob, Grep, Skill]
---

write a short onboarding doc the team can read when someone new joins the project
