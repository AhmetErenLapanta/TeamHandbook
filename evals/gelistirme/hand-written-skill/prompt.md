---
description: >-
    The discriminator case for share-with-team. Here the user says outright that the
    skill already exists and they wrote it, so it goes out through share rather than
    through the queue. The word "skill" is unavoidable: it is the product noun, not a
    command name.
expected_outcome: >-
    /handbook:share. If this misses to review while share-with-team also misses, the
    two commands are indistinguishable on their descriptions.
tags: [nl-gelistirme]
max_turns: 6
timeout_seconds: 180
allowed_tools: [Read, Glob, Grep, Skill]
---

I wrote a skill myself and I want my team to have it
