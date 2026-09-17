---
description: >-
    The joiner side of the same pair. The user has been handed a URL and wants to be
    wired up, which is exactly join, but the sentence never says "join".
expected_outcome: >-
    /handbook:join. A run that picks init has inverted the two roles, which would be
    the worse of the two possible misses: init opens a merge request.
tags: [nl]
max_turns: 6
timeout_seconds: 180
allowed_tools: [Read, Glob, Grep, Skill]
---

bir ekip arkadaşım depo adresini paylaştı, beni de oraya bağla
