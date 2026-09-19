---
description: >-
    CONFOUNDED the same way as see-it-work: the SessionStart notice names
    /handbook:doctor in every run, three times in the trace counted. It also has a
    second, more interesting competitor that is not one of our commands: Claude Code's
    built-in update-config skill, which the measurements picked up twice. Kept because
    that competition is real and worth watching, not because the number is clean.
expected_outcome: >-
    /handbook:doctor. A run that reaches update-config instead is the informative
    outcome here, and it is a miss.
tags: [nl-gelistirme]
max_turns: 6
timeout_seconds: 180
allowed_tools: [Read, Glob, Grep, Skill]
---

hooks don't seem to be firing, something's wrong with my setup
