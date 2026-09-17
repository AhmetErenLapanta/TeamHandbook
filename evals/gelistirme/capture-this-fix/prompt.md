---
description: >-
    Routing under a real antecedent. The sentence points at a fix the prior turns
    actually contain, so the run measures whether a "make this stick" request reaches
    the plugin rather than whether the model can resolve a dangling pronoun. Its
    measured competitor is not another handbook command: it is Claude Code's own
    memory, which answers the same request without asking anyone.
expected_outcome: >-
    /handbook:learn. The prior turns hold a concrete fix and the user asks to keep it,
    which is what learn exists for. Writing the rule to memory or to a CLAUDE.md
    instead is the failure this case is built to catch, not an alternative pass.
tags: [nl-gelistirme]
max_turns: 6
timeout_seconds: 180
allowed_tools: [Read, Glob, Grep, Skill]
---

şu az önce bulduğumuz çözümü unutmayalım, kaydet
