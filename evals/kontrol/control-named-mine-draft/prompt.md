---
description: >-
    Positive control for the mining command's second step. The draft argument is the
    half that spends a model call, and it is reached through the same command, so a
    failure here separates "the command did not load" from "the argument was not
    carried through". Written as a sentence AROUND the command rather than as a bare
    slash line: measured, a prompt that is nothing but `/handbook:mine --draft 2` is
    expanded without the Skill tool ever being called, so a tool_used grader sees
    nothing and scores a working command zero.
expected_outcome: >-
    /handbook:mine, on every run, with the user's argument carried through.
tags: [kontrol]
max_turns: 6
timeout_seconds: 180
allowed_tools: [Read, Glob, Grep, Skill]
---

use the /handbook:mine command to draft the second workflow in the list
