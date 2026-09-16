---
description: >-
    The plain "where do things stand" request. Competes with doctor, which also
    answers a question about the state of the installation, but from the health
    angle rather than the counters angle.
expected_outcome: >-
    /handbook:status. The sentence asks for a summary, not for a diagnosis of
    something broken. A run that picks doctor is a near miss.
tags: [nl]
max_turns: 6
timeout_seconds: 180
allowed_tools: [Read, Glob, Grep, Skill]
---

bu makinede her şey ne durumda, kısa bir özet çıkar
