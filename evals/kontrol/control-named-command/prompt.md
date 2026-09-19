---
description: >-
    Positive control, not a measurement. The prompt names the command outright, so a
    failure here means the plugin did not load or the Skill wiring is broken rather
    than that natural phrasing missed. Without it a suite-wide zero is
    uninterpretable. Excluded from the headline number via its tag.
expected_outcome: >-
    /handbook:status, on every run. Anything less invalidates the nl run.
tags: [kontrol]
max_turns: 6
timeout_seconds: 180
allowed_tools: [Read, Glob, Grep, Skill]
---

run the /handbook:status command
