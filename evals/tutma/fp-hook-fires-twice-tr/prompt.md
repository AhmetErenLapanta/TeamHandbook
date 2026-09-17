---
description: >-
    A probe for the notice, not for the description. The plugin's SessionStart notice prints
    doctor's name into every run, and this case measures how hard that pulls on the false-
    positive side. Read a low score as the notice pulling, not as a bad description.
expected_outcome: >-
    No handbook command. What is asked for is debugging code in this repository, not
    diagnosing an installation.
tags: [fp-tutma, zor]
max_turns: 8
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill]
---

Şu session-start hook'u her açılışta iki kere koşuyor gibi, bir bakar mısın?
