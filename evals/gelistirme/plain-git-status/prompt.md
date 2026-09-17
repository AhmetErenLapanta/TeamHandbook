---
description: >-
    False-positive probe, not a routing case. A git question that shares the word "status"
    with /handbook:status and sits close to the trigger "give me the current state".
tags: [fp-gelistirme]
expected_outcome: >-
    No handbook command. The subject is the git working tree, not the plugin's own counters.
max_turns: 6
timeout_seconds: 180
allowed_tools: [Read, Glob, Grep, Skill]
---

what is the status of my branch, is anything still uncommitted
