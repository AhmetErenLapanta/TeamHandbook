---
description: >-
    Context that the sentence leans on but does not itself supply. The situation is
    established in the prior turns because the harness cannot pre-seed the sandbox's
    product state: it was measured that add_dirs grants reads without putting anything
    in the working directory, and scaffold_script runs outside the sandbox. A
    conversational stand-in, not real state. A hand-written skill on disk, established
    in the prior turns.
expected_outcome: >-
    /handbook:share-skill. The user wrote it by hand, which is the discriminator against
    review, and it is not a session capture.
tags: [nl-tutma]
max_turns: 8
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill]
---

Elimde geçen hafta yazdığım bir tane var, ekibin de kullanması lazım
