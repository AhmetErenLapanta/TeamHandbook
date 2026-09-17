---
description: >-
    How a broken install actually gets reported: by the symptom, not by the name of
    the diagnostic. The word "hooks" appears in the doctor description, so this case
    is expected to be one of the easier ones.
expected_outcome: >-
    /handbook:doctor. If even this one misses, the routing problem is not about
    subtle wording.
tags: [nl]
max_turns: 6
timeout_seconds: 180
allowed_tools: [Read, Glob, Grep, Skill]
---

hooks don't seem to be firing, something's wrong with my setup
