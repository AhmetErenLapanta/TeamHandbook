# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project uses
[semantic versioning](https://semver.org/).

## [0.1.0] — unreleased

Initial release.

- **Capture**: `PostToolUse` hook detects error→fix pairs (a failing command
  followed by an edit and a later passing run of the same command family), with
  stderr normalization and stable fingerprinting.
- **Gate**: deterministic rule sieves (file-change requirement, secret veto,
  recurrence threshold, size) run before an LLM scores five criteria; promotes at
  ≥7/10. Uses your own `claude -p`, no bundled key.
- **Distill**: promoted signals become a spec-compliant `SKILL.md` plus a
  `grounded-case.json` regression anchor, scoped to `team` or the project's git
  remote.
- **Review & deliver**: candidates queue locally; `/handbook:review` lists,
  shows, edits-then-approves, rejects, or skips them; solo mode writes to the
  project's `.claude/skills/`, team mode opens a PR. Manual captures are always
  queued — a low gate score rides along as advice, and the publish decision stays
  with the user. A plain reject does not suppress recurrence; `reject --never`
  mutes the fingerprint permanently, and rejected candidates are excluded from
  the gate's dedup.
- **Team setup**: `/handbook:init` scaffolds a marketplace repo with version-bump
  CI; `/handbook:join` connects the engine to it.
- **Privacy**: secret redaction before any write; raw payload dumps are opt-in
  (`TEAMHANDBOOK_DEBUG`); no telemetry.
- **Procedure skills**: `/handbook:learn` also captures a completed task's
  procedure (goal + ordered steps + verification) as a candidate; the gate judges
  it with a manual-trigger calibration, the distiller produces a step-by-step
  skill, and the grounded case records the original task. Repeated-work detection
  records each session's work shape and nudges — once per shape — when similar
  work keeps recurring.
- **Visibility**: a one-time welcome on the first session, a since-last-session
  activity heartbeat (only when something was captured and nothing stronger is
  pending), and detector health counters in `/handbook:status`. All notices are
  single-line and configurable off.

The capture path is verified end-to-end against real Claude Code: failures arrive
as `PostToolUseFailure`, successes as `PostToolUse` with no exit code, and a
fail→edit→pass sequence produces a candidate. See the README's "Honest limitations"
for what capture does and doesn't cover.
