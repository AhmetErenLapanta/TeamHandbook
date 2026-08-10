# Security

TeamHandbook runs as a Claude Code plugin whose hooks observe your coding session.
This document states exactly what it reads, what it writes, and where data goes.

## What it reads

- `PostToolUse` hook input: the tool name, the command or file path, and the
  command result (exit code / output). This is how it detects an error followed
  by a fix.
- `Stop` / `SessionEnd` input: the session id, to finalize captured pairs.
- Your local git config and credentials — only when *you* approve a candidate and
  it opens a pull request, using your own identity.

## What it writes, and where

- All state lives under `~/.teamhandbook/` (override with `TEAMHANDBOOK_HOME`): per-session
  working state under `sessions/` (the failing command and its fix, kept until the
  session ends or is salvaged), a signal ledger, a candidate queue, counters, a
  `pipeline.log` of gate-run outcomes, and — when the gate cannot reach `claude` for a
  captured pair after repeated retries — an `abandoned.jsonl` holding that pair so it
  stays recoverable (it persists until you delete it). All of it is secret-redacted
  (below). No telemetry, no network calls except the gate's `claude -p` and the PR you
  approve.
- **Secrets are redacted before anything is written — the session files included.**
  A captured command, error, or edit that matches a secret pattern is reduced to a
  content-free fingerprint (only a redaction counter is kept), so the raw text never
  lands on disk anywhere under `~/.teamhandbook/`. Detection is best-effort pattern
  matching (see `src/lib/secrets.ts`); a secret in an unrecognized format can slip
  through, so review a candidate before approving it.
- **Raw hook payloads are never written unless you opt in** with `TEAMHANDBOOK_DEBUG=1`
  (a diagnostics aid for confirming the payload schema). Raw payloads can contain
  secrets, so this is off by default.

## What leaves your machine

Two things, and only these:

1. **Automatically, before you review:** to score and distill a captured candidate,
   TeamHandbook calls `claude -p` (your own Claude CLI) with the candidate's
   secret-redacted command/error/task text. This reaches Anthropic exactly as any
   Claude Code prompt does. Disable it entirely with
   `{"gate": {"auto": false}}` in `~/.teamhandbook/config.json` — the detector still
   captures locally, but nothing is sent automatically; candidates then come only
   from the explicit `/handbook:learn`.
2. **On your approval:** `/handbook:review` → approve publishes the skill — a PR to
   the team repo you configured (your git credentials, your chosen repo) or a local
   install. Nothing is shared with your team before this.

## Removing your data

`rm -rf ~/.teamhandbook` deletes every byte TeamHandbook has stored — the ledger, candidate
queue, counters, per-session state, `pipeline.log`, any `abandoned.jsonl`, and notice
state. There is no other storage location and no remote copy.

## Trust model

Plugin hooks execute with your user privileges and run automatically once
installed. Review the source before installing, as you would any plugin. TeamHandbook
is open source (Apache-2.0) specifically so this is auditable.

## Reporting a vulnerability

Please open a GitHub issue for non-sensitive reports, or use GitHub's private
vulnerability reporting for anything that should not be public. Include the
version (`.claude-plugin/plugin.json`) and steps to reproduce.
