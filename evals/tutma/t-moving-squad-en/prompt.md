---
description: >-
    Context that the sentence leans on but does not itself supply. The situation is
    established in the prior turns because the harness cannot pre-seed the sandbox's
    product state: it was measured that add_dirs grants reads without putting anything
    in the working directory, and scaffold_script runs outside the sandbox. A
    conversational stand-in, not real state. That the machine is bound to a team is
    established in the prior turns.
expected_outcome: >-
    /handbook:leave. Unbinding this machine, which is leave rather than a repo
    operation.
tags: [nl-tutma]
max_turns: 8
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill]
---

I'm moving to another squad, unhook me from this one's shared setup
