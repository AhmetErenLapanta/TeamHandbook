---
description: >-
    The request arrives as an outcome rather than as a source: the user wants a skill
    and says where it should come from. The competitor is /handbook:share, which also
    produces a skill but out of what is already installed.
expected_outcome: >-
    /handbook:mine. The source named is the history, which is the only command that
    reads it.
tags: [nl-gelistirme]
max_turns: 6
timeout_seconds: 180
allowed_tools: [Read, Glob, Grep, Skill]
---

write me a skill out of what this codebase has already been built doing, not out of this conversation
