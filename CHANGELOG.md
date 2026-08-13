# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project uses
[semantic versioning](https://semver.org/).

## [0.3.1] - 2026-08-13

- **Review asks with buttons, not with prose.** Every verdict is a multiple-choice
  question now, up to four candidates in one dialog, so clearing the queue is picking
  rather than typing `--to personal` back once per skill. The whole queue is shown before
  the first question, so nobody answers three to find out there were six. Rejecting asks
  one follow-up: just this time, or never again.
- **The session-start line leads with how many are waiting**, and how long the oldest has
  waited once that stops being "just now". One line competes with everything else that
  prints at session start, and a name alone did not say there was a queue behind it.
- **It says "skill" everywhere it used to say "lesson".** The thing being produced is a
  skill; a second word for it was only ever something else to learn.

## [0.3.0] - 2026-08-12

**A rule counts in any language, and the first run tells the truth.** Everything here
came out of installing the published plugin and using it, not out of the test suite.

- **Teaching detection no longer reads English only.** The list of English phrases that
  decided what a teaching was is gone: every prompt that could carry a lesson is
  recorded, and which of them states a rule is the model's call. Matching lost its
  English stemmer's monopoly too, so an agglutinative suffix
  ("mocklama"/"mocklamayız") is one word, and the tokenizer stopped deleting the
  letters it could not fold. Probed against a real session, eighteen Turkish prompts
  used to produce zero flags.
- **Recurrence is measured after the call, not asked for before it.** A lesson whose
  quote echoes an earlier session, or whose pair recurred in the ledger, is scored 2
  because that was measured locally.
- **A lesson learned from an umbrella directory keeps its repository.** Opening Claude
  Code one level above your checkouts left a project-specific rule labelled `team`, and
  shipped without its "only in this repository" guard. Scope now comes from the files
  the session actually edited, and refuses to guess when they span two repos.
- **The harvest stopped reading this plugin's own command text as the developer's
  words.** A slash command expands into the transcript as a user turn; the demo's body
  told the model it was watching a staged exercise, and the model believed it.
- **The demo hands its work to a clean session.** Narrating the harvest inside the
  session it wants harvested produced a lesson in 1 run out of 3; the same work done
  in an ordinary session produces it 3 out of 3.
- **The first `/handbook:doctor` after an install no longer blames your model** for a
  probe that merely timed out on a cold machine, and the README says to restart before
  running it.
- **"Add it to this repo" is now "add it to this project"**, which is what that option
  has always done, and is correct in a directory that is not a repository.
- **Install scope is documented**: user scope, and why project scope installs the
  harvest for everyone who clones the repo.

## [0.2.0]

**Session harvest replaces the recurrence gate.** TeamHandbook stopped being an
error-hunter and became a session-harvesting, personal-first learning layer.

- **Harvest**: after every substantive session, ONE `claude -p` call over a redacted,
  fenced slice of the session transcript (40 000 chars, 60% reserved for the user's own
  messages) plus deterministic evidence extracts up to 3 durable lessons — `correction`
  (an explicit teaching, quoting the user's words as the receipt), `procedure`,
  `discovery`, `error-fix`. Scored 0–2 on five criteria with a 4/10 floor and a
  top-3-per-session cap. A trivial session is never harvested and costs nothing.
- **Teachings are flagged as you type them**: a `UserPromptSubmit` hook classifies
  "we never do X here" / "always run Y first" locally so a mid-session correction can't
  be lost to transcript slicing. Secret-bearing prompts are dropped, never stored.
- **Three delivery targets**: `/handbook:review approve --to personal|project|team` —
  `~/.claude/skills` (every project), the repo's `.claude/skills` (travels with the
  code), or a PR to the team skill repo. The session-start notice asks the question
  directly: keep it, share it, or skip.
- **Judgment moved from production to activation**: automatic vetoes are now only
  secret, oversize, duplicate, and muted. Nothing installs or ships without a human
  choosing where it goes.
- **Weekly digest**: once every 7 days, what the week produced.
- **New privacy surface**: the harvest reads Claude Code's session transcript. Disable
  with `{"harvest": {"enabled": false}}` or `{"gate": {"auto": false}}`. See SECURITY.md.
- **Removed**: recurrence-promotion (K8). Recurrence is now one of five score inputs,
  not a precondition. `/handbook:learn` keeps its 7/10 advisory score.
- **New command**: `/handbook:leave` clears the team binding.

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
