---
description: Show where TeamHandbook stands on this machine: version, what the detectors have counted, the ledger, how many candidates are waiting, harvest state, a recap since install, and the active config. Read-only, and the right answer to any question about where things currently stand with the plugin. Triggers: "where do things stand", "how much has it picked up", "show me the counters", "is anything waiting for me", "give me the current state", "how is it doing".
---

Show the user the current state of TeamHandbook.

1. Run: `node "${CLAUDE_PLUGIN_ROOT}/dist/status.js"`
2. Present the output as-is in a code block. Do not editorialize beyond one short sentence;
   if there are pending candidates, remind the user that /handbook:review handles them.
