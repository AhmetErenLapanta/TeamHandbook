# Security

TeamHandbook runs as a Claude Code plugin whose hooks observe your coding session.
This document states exactly what it reads, what it writes, and where data goes.

## What it reads

- **`PostToolUse` hook input:** the tool name, the command or file path, and the
  command result (exit code / output). This is how it detects an error followed by a
  fix. The transcript path Claude Code supplies is recorded for later.
- **`UserPromptSubmit` input:** the prompt you just typed. Any prompt long enough to
  carry a lesson and short enough not to be a task brief (12–600 characters, and not a
  slash command or a notice the harness injected) is stored in the session's local
  state, so the harvest cannot miss a rule you stated mid-session. It used to store
  only prompts matching a list of English phrases; that list is gone, because deciding
  which sentence states a rule is something the model does in any language and a phrase
  list only ever did it in one. **The practical effect is that more of your prompts are
  written to local state than before** — bounded to the 40 most recent per session, and
  a prompt containing a secret is still dropped and never stored. Nothing is sent
  anywhere by this hook.
- **`SessionEnd`: the session id, the working directory, and the path to Claude
  Code's transcript file for that session.** If the session did real work, that path
  and the captured evidence are queued as a harvest job; the background runner then
  reads the transcript — the conversation, your prompts included — slices it to at
  most 40 000 characters and redacts it before anything is sent.
- **`SessionStart`: the same, for sessions that ended without `SessionEnd` firing**
  (crash, terminal kill, power loss). A session file untouched for 3 hours is
  salvaged at the start of a later session, so a crashed session's transcript can be
  read and harvested after the fact. Each session is salvaged at most once.
- Your local git config and credentials — only when *you* approve a candidate and it
  opens a pull request, using your own identity.

## What it writes, and where

All state lives under `~/.teamhandbook/` (override with `TEAMHANDBOOK_HOME`):

- `sessions/` — per-session working state: the failing command and its fix, the
  transcript path, and any flagged teachings. Kept until the session ends or is
  salvaged.
- `signals.jsonl` — the evidence ledger of captured error→fix pairs.
- `pending/` — harvest jobs waiting for the background runner: one file per session
  holding its id, cwd, the **path** to its transcript, and the captured evidence.
  The runner claims a job by rename and deletes it before calling `claude`.
- `candidates/` — the review queue: each pending lesson's `SKILL.md`, its grounded
  case, and its metadata.
- `counters.json`, `pipeline.log` — activity counters and one line per harvest run
  (what was produced, sieved, or errored). `pipeline.log` is rotated, never deleted.
- `teachings.json` — what you have already said, so a rule you give twice is
  recognized as a repeat instead of scored as a guess. Holds the content words of each
  recorded prompt, a count, and a 160-character sample of your own sentence — the same
  text the session files already keep, behind the same secret scan, capped at the 2000
  most recent — about three months. Since prompts are no longer pre-filtered by an
  English phrase list, this file now holds ordinary prompts alongside rules; nothing is
  ever read out of it except by matching against a lesson the model has already
  proposed, so what it remembers only surfaces when it is the thing you taught. Local
  only.
- `skill-usage.json` — how many times each skill has fired, and when. Claude Code
  reports a skill invocation to the same hook TeamHandbook already listens on, so this
  is a name and a count: no arguments, no file contents, no prompt. The hook sees
  **every** skill you invoke, including ones from other plugins, and the file records
  them all; what `/handbook:status` reports on is deliberately narrower — only the
  skills TeamHandbook itself delivered or pulled from your team repo, because counting
  the others would credit TeamHandbook with work it did not do. Either way it never
  leaves your machine.
- `config.json` — your settings. `muted.json` — fingerprints silenced by
  `reject --never`. Notice state (`welcomed`, `notified-counters.json`,
  `nudged-team`, `last-digest`, `seen-skills.json`) — what has
  already been shown to you, so a notice never repeats.
- `debug/` — raw hook payloads, written only when you set `TEAMHANDBOOK_DEBUG=1`.
- `abandoned.jsonl` — a harvest job that failed to reach `claude` three times is
  parked here rather than dropped silently, so the session's evidence stays
  recoverable. It persists until you delete it; `/handbook:status` reports the count.

Approved skills are written **outside** `~/.teamhandbook/`, where Claude Code loads
them: `~/.claude/skills/<slug>/` (personal), the repo's `.claude/skills/<slug>/`
(project), or the team repo via a pull request.

- **Secrets are redacted before anything is written — the session files included.**
  A captured command, error, or edit that matches a secret pattern is dropped
  entirely and reduced to a content-free fingerprint (only a redaction counter is
  kept). For transcript slices the mechanism differs by necessity: a matching line is
  replaced in place with `[redacted:<type>]` rather than dropping the whole slice, and
  a multi-line secret whose value spans following lines — a PEM private-key block — is
  consumed as a whole unit (if its END marker is missing, the rest of the slice is
  dropped rather than risk leaking the key). The number of redacted lines is recorded
  in `pipeline.log`. Either way the raw text reaches neither disk nor the model. Detection is best-effort pattern matching
  (see `src/lib/secrets.ts`); a secret in an unrecognized format can slip through, so
  review a candidate before approving it.
- **Raw hook payloads are never written unless you opt in** with `TEAMHANDBOOK_DEBUG=1`
  (a diagnostics aid for confirming the payload schema). Raw payloads can contain
  secrets, so this is off by default.

## What leaves your machine

Two things, and only these:

1. **Automatically, before you review:** at the end of a substantive session,
   TeamHandbook calls `claude -p` (your own Claude CLI) **once**, with a redacted slice
   of that session's conversation — up to 40 000 characters, 60% of that budget
   reserved for your own messages — plus the captured error→fix pairs and the
   session's work shape. This reaches Anthropic exactly as any Claude Code prompt
   does. Disable it with `{"harvest": {"enabled": false}}`, or disable every
   automatic model call with `{"gate": {"auto": false}}`, in
   `~/.teamhandbook/config.json`; both are checked before a session is queued, so the
   transcript is never read and nothing is sent. `/handbook:learn` still works and
   sends only what you asked it to capture.
   - Precisely: those switches stop the SENDING, not the local capture. The
     `PostToolUse` and `UserPromptSubmit` hooks keep writing evidence into
     `~/.teamhandbook/` (secret-redacted, as above) so the history is there if you turn
     harvesting back on. If you want no local capture either, uninstall the plugin.
   - If `config.json` exists but cannot be parsed, both switches fail **closed** —
     a trailing comma in a hand-edited file must never silently re-enable sending —
     and the next session-start notice tells you.
   - A session with no substance (no error→fix pair, no teaching, no real work) is
     never harvested and costs no model call at all.
2. **On your approval:** `/handbook:review` → approve installs the skill locally or
   opens a PR to the team repo you configured (your git credentials, your chosen
   repo). Nothing is shared with your team before this.

## Removing your data

```
rm -rf ~/.teamhandbook
```

That deletes every byte TeamHandbook itself stores — ledger, queue, per-session state,
counters, `pipeline.log`, any `abandoned.jsonl`, and notice state. There is no other
storage location and no remote copy.

Skills you already approved are ordinary files and are **not** removed by that
command: delete `~/.claude/skills/<slug>/` (personal) or the repo's
`.claude/skills/<slug>/` (project) yourself, and remove merged skills from the team
repo like any other commit.

## Trust model

Plugin hooks execute with your user privileges and run automatically once installed.
Everything captured from a session — stderr, commands, and the transcript slice — is
fenced as untrusted data inside every model prompt, so text that looks like an
instruction can never steer the harvest. Review the source before installing, as you
would any plugin. TeamHandbook is open source (Apache-2.0) specifically so this is
auditable.

## Reporting a vulnerability

Please open a GitHub issue for non-sensitive reports, or use GitHub's private
vulnerability reporting for anything that should not be public. Include the version
(`.claude-plugin/plugin.json`) and steps to reproduce.
