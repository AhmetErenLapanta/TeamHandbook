---
description: >-
    Context that the sentence leans on but does not itself supply. The situation is
    established in the prior turns because the harness cannot pre-seed the sandbox's
    product state: it was measured that add_dirs grants reads without putting anything
    in the working directory, and scaffold_script runs outside the sandbox. A
    conversational stand-in, not real state. "This integration" and "mine" both point at
    the server in the prior turns.
expected_outcome: >-
    /handbook:share. Sharing a locally configured server so nobody repeats the setup.
tags: [nl-tutma]
max_turns: 8
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill]
---

Nobody else should have to wire this integration up by hand, push mine out to them
