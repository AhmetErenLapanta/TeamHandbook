---
description: >-
    The multi-repository case, which is where this command earns its keep: the work that
    is worth writing down is disproportionately the work that crosses repositories, and
    a per-repository read cannot see it. The sentence names several repositories without
    naming the command.
expected_outcome: >-
    /handbook:mine, which takes sibling repositories with --repo.
tags: [nl-gelistirme]
max_turns: 6
timeout_seconds: 180
allowed_tools: [Read, Glob, Grep, Skill]
---

our tickets usually touch the backend repo and the web repo together - is there a pattern in how we do that, going by the commits?
