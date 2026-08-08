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

- All state lives under `~/.teamhandbook/` (override with `TEAMHANDBOOK_HOME`): a signal
  ledger, a candidate queue, and counters. No telemetry, no network calls except
  the gate's `claude -p` and the PR you approve.
- **Secrets are redacted before anything is written.** A captured signal whose
  command, error, or edits match a secret pattern is dropped entirely and reduced
  to a content-free fingerprint; only a redaction counter is kept. See
  `src/lib/secrets.ts` for the pattern list.
- **Raw hook payloads are never written unless you opt in** with `TEAMHANDBOOK_DEBUG=1`
  (a diagnostics aid for confirming the payload schema). Raw payloads can contain
  secrets, so this is off by default.

## What leaves your machine

Nothing, until you approve a candidate in `/handbook:review`. Approval opens a
pull request to the team skill repo you configured — with your git credentials,
to a repo you chose. The gate's scoring calls `claude -p` (your own Claude), which
sends the candidate's redacted content to Anthropic exactly as any Claude Code
prompt does.

## Trust model

Plugin hooks execute with your user privileges and run automatically once
installed. Review the source before installing, as you would any plugin. TeamHandbook
is open source (Apache-2.0) specifically so this is auditable.

## Reporting a vulnerability

Please open a GitHub issue for non-sensitive reports, or use GitHub's private
vulnerability reporting for anything that should not be public. Include the
version (`.claude-plugin/plugin.json`) and steps to reproduce.
