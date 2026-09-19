---
description: >-
    DEGRADED, kept for continuity only, and its score must not be read as routing.
    Two separate leaks landed on this one case: the sentence contains its own command
    name ("MCP"), built into the case from the start, and a later change then added the
    English translation of this very sentence to the command description as a trigger.
    It now measures string matching. Product writes an equivalent for the held-out
    half, where the sentence has never been seen; this copy stays here so the old
    series remains readable.
expected_outcome: >-
    /handbook:mcp. Expect a ceiling score for reasons that have nothing to do with
    natural-language routing.
tags: [nl-gelistirme]
max_turns: 6
timeout_seconds: 180
allowed_tools: [Read, Glob, Grep, Skill]
---

ekibin MCP ayarlarını güncelle
