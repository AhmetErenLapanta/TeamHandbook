---
description: Manually turn an error→fix moment from this session into a skill candidate (T2 trigger)
argument-hint: [optional hint about which moment to capture]
---

The user wants to turn something that happened in this session into a reusable skill
candidate. This is TeamHandbook's manual (T2) trigger: it still passes the promotion gate
(LLM scoring + secret veto), but skips the automatic detector's noise sieves because the
user explicitly asked.

1. Identify the error→fix moment to capture. If the user gave a hint ($ARGUMENTS), use it
   to pick the moment; otherwise use the most recent clear error→fix sequence in this
   session. Collect, strictly from what actually happened — do not invent anything:
   - `command`: the exact command that failed
   - `error`: the error output (verbatim; it will be normalized automatically)
   - `resolvedCommand`: the command that later succeeded, if any
   - `edits`: files that were edited to fix it, if any
2. If the session contains no identifiable error→fix moment matching the request, tell
   the user what you looked for and ask them to describe the case — do not fabricate one.
3. Submit the case by piping a JSON payload to the learn CLI:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/learn.js" <<'EOF'
   {"command": "...", "error": "...", "resolvedCommand": "...", "edits": ["..."]}
   EOF
   ```

   Omit `resolvedCommand` and `edits` if there are none. Never put secrets, tokens, or
   passwords in the payload — the secret scan will veto the whole candidate.
4. Relay the CLI's verdict to the user verbatim: written (with slug and gate score),
   gate-rejected (with score/rationale), or dropped by a rule sieve.

The gate call uses the user's own `claude` CLI and may take up to a minute; that is normal.
