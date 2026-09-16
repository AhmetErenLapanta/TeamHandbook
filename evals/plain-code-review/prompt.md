---
description: >-
    False-positive probe, not a routing case. Ordinary code review, which shares the word
    "review" with /handbook:review and with the trigger "approve or throw these out". If a
    description reaches this sentence it is too broad.
expected_outcome: >-
    No handbook command. The object under review is a function in the user's code, not a
    captured skill waiting for a verdict.
tags: [fp]
max_turns: 6
timeout_seconds: 180
allowed_tools: [Read, Glob, Grep, Skill]
---

review this function and tell me whether the error handling is right
