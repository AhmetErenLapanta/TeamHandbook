---
description: >-
    The old sentence said "on this machine", and the model read that as the real
    machine and inspected the filesystem, which is a fair reading. The subject now
    names the plugin, so what is left to measure is routing rather than whether the
    model guesses which subject was meant. No antecedent is needed, so this case
    carries no history.
expected_outcome: >-
    /handbook:status. The question asks for the current state of the plugin's own
    side: counters, queue, ledger.
tags: [nl-gelistirme]
max_turns: 6
timeout_seconds: 180
allowed_tools: [Read, Glob, Grep, Skill]
---

TeamHandbook tarafında her şey ne durumda, kısa bir özet çıkar
