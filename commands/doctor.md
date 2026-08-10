---
description: Diagnose the TeamHandbook installation — checks node, the claude CLI, hooks, config, and the team repo
---

The user wants to check whether TeamHandbook is healthy. Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/doctor.js"
```

Relay the full output verbatim. Then, for every ✘ problem (and ⚠ warning worth acting
on), add one short sentence on how to fix it, based on the check's own detail text.
If everything is healthy, say so in one line — no elaboration needed.
