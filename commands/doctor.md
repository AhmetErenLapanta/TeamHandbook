---
description: Diagnose the TeamHandbook installation: node, the claude CLI it shells out to, the hooks, the config, and the team repo, with a fix for every failure it finds. Use when TeamHandbook itself looks inert or misconfigured, and before editing any Claude Code settings by hand. Triggers: "is TeamHandbook set up right", "nothing is being captured", "check my install", "why is it not picking anything up", "it stopped working", "verify the plugin is healthy".
---

The user wants to check whether TeamHandbook is healthy. Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/doctor.js"
```

Relay the full output verbatim. Then, for every ✘ problem (and ⚠ warning worth acting
on), add one short sentence on how to fix it, based on the check's own detail text.
If everything is healthy, say so in one line - no elaboration needed.
