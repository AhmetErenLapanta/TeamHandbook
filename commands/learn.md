---
description: Turn one specific thing from THIS session into a skill candidate: either an error that got fixed, or the procedure of a task that was just completed. Use only when the user points at something concrete they want preserved; it queues a candidate for review and installs nothing. Triggers: "capture this as a skill", "turn what we just did into a skill", "this is worth teaching the rest of the team", "record how we got past that", "write this procedure down for next time", "keep this for future sessions".
argument-hint: [optional hint about which moment or task to capture]
---

The user wants to capture something from this session on demand, without waiting for the
end-of-session harvest. If the user typed `/handbook:learn` themselves, the candidate is
ALWAYS distilled and queued - the gate scores it, but its verdict travels as advice for
the review, not as a veto. This command has no `disable-model-invocation` guard, though,
so it can also start from a plain-language request with no literal `/handbook:learn` in
the transcript ("capture that as a skill"). In that case there was no explicit ask to
honor, so the gate's rejection is enforced instead: a low-scoring candidate is dropped,
not queued, and the CLI says so. Either way, only the secret scan can drop a candidate
the gate would otherwise have queued.

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

1. Decide the mode. If the user's hint ($ARGUMENTS) names a task ("this task",
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
4. Relay the CLI's verdict to the user verbatim: written (with slug and gate score —
   including the gate's concern when the score is below the threshold), dropped by a
   rule sieve (secret / oversized), or - only possible when you invoked this yourself,
   not the user - not captured because the gate rejected it.

This uses the user's own `claude` CLI and runs two calls back to back — it scores, then
distills — so it may take a couple of minutes. That is normal; do not cancel it. If it
errors, the message ends with a `/handbook:doctor` pointer.
