---
description: >-
    The same positive control with the surrounding sentence in the user's own language.
    A command named outright must route whatever the sentence around it is written in;
    a failure here is the wiring, or a description that only matches English framing.
expected_outcome: >-
    /handbook:mine, on every run.
tags: [kontrol]
max_turns: 6
timeout_seconds: 180
allowed_tools: [Read, Glob, Grep, Skill]
---

şu /handbook:mine komutunu çalıştırır mısın
