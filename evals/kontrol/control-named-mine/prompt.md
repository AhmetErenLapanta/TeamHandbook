---
description: >-
    Positive control for the mining command, not a measurement. The prompt names the
    command outright, so a failure here means commands/mine.md did not load or its
    Skill wiring is broken rather than that natural phrasing missed. Excluded from the
    headline number via its tag.
expected_outcome: >-
    /handbook:mine, on every run. Anything less invalidates the nl run for this command.
tags: [kontrol]
max_turns: 6
timeout_seconds: 180
allowed_tools: [Read, Glob, Grep, Skill]
---

run the /handbook:mine command
