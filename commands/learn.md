---
description: Turn something from this session — an error→fix moment OR a completed task's procedure — into a skill candidate (T2 trigger)
argument-hint: [optional hint about which moment or task to capture]
---

The user wants to turn something that happened in this session into a reusable skill
candidate. This is TeamHandbook's manual (T2) trigger: it still passes the promotion gate
(LLM scoring + secret veto), but skips the automatic detector's noise sieves because the
user explicitly asked.

There are TWO capture modes. Pick the one that matches what happened:

**A. Error→fix moment** — something failed and was fixed. Collect, strictly from what
actually happened (never invent):
- `command`: the exact command that failed
- `error`: the error output (verbatim; it will be normalized automatically)
- `resolvedCommand`: the command that later succeeded, if any
- `edits`: files that were edited to fix it, if any

**B. Task procedure** — a piece of work was completed whose HOW is worth teaching
(similar tasks will come again). Collect from this session:
- `goal`: one line — what the task achieved
- `steps`: the ordered list of meaningful steps actually taken (2–10 items; skip noise
  like `ls`; each step one sentence, concrete: what was created/edited/run and why)
- `verification`: how success was confirmed (test run, build, manual check)
- `edits`: the files created or edited, if any

Procedure:

1. Decide the mode. If the user's hint ($ARGUMENTS) names a task ("bu task'ı",
   "how we added X"), use mode B; if it names an error, use mode A; with no hint,
   prefer the most recent clear error→fix sequence, else the session's main completed
   task.
2. If the session contains nothing matching the request, tell the user what you looked
   for and ask them to describe the case — do not fabricate one.
3. Submit by piping JSON to the learn CLI. Mode A:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/learn.js" <<'EOF'
   {"command": "...", "error": "...", "resolvedCommand": "...", "edits": ["..."]}
   EOF
   ```

   Mode B:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/learn.js" <<'EOF'
   {"goal": "...", "steps": ["...", "..."], "verification": "...", "edits": ["..."]}
   EOF
   ```

   Never put secrets, tokens, or passwords in the payload — the secret scan will veto
   the whole candidate.
4. Relay the CLI's verdict to the user verbatim: written (with slug and gate score),
   gate-rejected (with score/rationale), or dropped by a rule sieve.

The gate call uses the user's own `claude` CLI and may take up to a minute; that is normal.
