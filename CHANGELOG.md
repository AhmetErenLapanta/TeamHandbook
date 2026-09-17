# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project uses
[semantic versioning](https://semver.org/).

## [0.5.6] - 2026-09-17

- **A harvest cut off halfway never spent the attempt it was given.** The retry budget was
  only charged when a run recorded its own failure, and a run that is killed outright, by
  the laptop closing or the machine running out of memory, never gets that far. So the job
  stayed in the queue with all three attempts intact, and every session opened after it
  picked the job up, bought another model call, and died in the same place. The work was
  never lost and never finished either. The attempt is now charged when the job is picked
  up rather than when it fails, so a job that keeps killing its runner is abandoned after
  three tries, with its evidence kept. Measured over four session starts on the failing
  path: five model calls before, three and then silence after.

## [0.5.5] - 2026-09-16

- **Asking Claude in plain language for a capture got the same free pass as typing the
  command.** `/handbook:learn` skips the quality gate on purpose: you asked for this
  skill, so the score travels as advice rather than a veto. But nothing stopped Claude
  from reaching for the command itself off an ordinary sentence, and in that moment the
  reason for the exemption is simply not true. The exemption now belongs to the person:
  when you type the command, everything works as it did and the candidate is queued
  whatever the gate thinks; when Claude reaches for it on your behalf, the gate keeps its
  veto. Answering the question the command itself asks you counts as you, which took some
  care to get right: the flag that records your request survives the turns in between
  without ever leaking into a later, unrelated capture.

## [0.5.4] - 2026-09-16

- **The repository can now measure whether a plain sentence reaches the right command.**
  Nothing an installed copy does changes with this release. What changes is that the
  question "does asking in ordinary language actually work" stopped being a matter of
  opinion: there is an eval suite under `evals/`, written in the phrasings a developer
  would really use, English and Turkish both, and running it prints a hit rate. The first
  run scored 0.5556, and of the misses, most were not the wrong command being chosen but
  no command being chosen at all. That number is the baseline the next two changes to the
  command descriptions have to beat, and without it neither of them could honestly claim
  to have improved anything.

## [0.5.3] - 2026-09-16

- **A suggestion that said nothing once the names came out no longer gets through.**
  The harvest already refused items that only state a fact about one system, but the line
  between a fact and a way of working was left to the model to feel out, and plenty of
  single-system notes read like rules. There is a test for it now, and it is the one a
  reader would apply by hand: take the proper names and the machine-specific constraints
  out of the candidate, and see whether a rule that still says what to do survives.
  Measured on three real candidates, two kept their rule and the third collapsed into
  generic advice once its one local constraint was removed. That split is what the test
  catches, and it is not the same thing as the item's kind or its score.

## [0.5.2] - 2026-09-16

- **The queue grew past reading and nothing could be set aside without deciding it.**
  One developer had 157 suggestions waiting, the oldest a month old, and the only two
  things you could do with any of them were approve and reject. So none of them got read,
  and each session added more. Candidates can be set aside now: swept against the quality
  bar, marked archived rather than deleted, and listed in a manifest that puts them back
  exactly as they were, evidence and score intact. `/handbook:status` counts what was set
  aside, because a queue that shrinks without saying so is a queue that lies.

  Measured on that real queue: of 111 discovery candidates, 13 were set aside. That is
  smaller than it sounds like it should be, and the reason is worth knowing: most of what
  the new bar removes, it removes at harvest time, before anything reaches the queue. The
  sweep was not tightened to make the number look better.

## [0.5.1] - 2026-09-16

- **The same session was harvested more than once, and its lessons arrived twice.**
  Thirteen sessions in one developer's history were harvested again after the first run
  finished, each repeat costing another model call and putting the same lesson back in
  the queue under a different name. Most of those repeats were legitimate: continuing a
  session with `--continue` keeps its id and grows the transcript, and the new tail
  deserves a harvest. So a run is now identified by the session and the transcript it
  read, which lets a resumed session through and turns the duplicates away.

- **A harvest killed halfway through no longer locks the session out.** The marker that
  says "this one is done" was written when the work was claimed, so a runner stopped by a
  reboot or an out-of-memory kill left one behind that nothing would clear for thirty
  days, while the queue handed the job back after ten minutes. The job came back and was
  refused, and that session's lessons were lost for as long as the marker stood. Claiming
  and completing are recorded apart now: an unfinished marker does not turn the next run
  away.

## [0.5.0] - 2026-09-16

- **A team's MCP server arrived one teammate at a time, by hand.** The handbook could
  share skills and nothing else, so the tools the team actually works through, a GitLab
  connection say, were set up again on every machine by whoever got round to it. Now
  `/handbook:mcp` takes a server you already run locally and sends it to the team
  repository as a merge request, beside the skills, carrying the version bump that makes
  everyone's copy refresh. Merge it and the next session a teammate opens already has the
  server connected.

- **A server whose address is its password is refused, not published.** Credentials in an
  MCP definition do not only live in headers and environment values: a whole class of
  hosted servers puts an opaque token in the URL itself, and that is the shape
  `claude mcp add` writes. Chasing those by pattern is a race, so the rule is structural
  instead. Anything but a plain `${VAR}` reference in a header or environment value stops
  the share, and so does a URL segment that looks like a secret rather than a path. The
  request that goes out says what was actually checked rather than promising that no
  credential travels, because the developer reviewing it deserves the real scope of the
  guarantee.

## [0.4.0] - 2026-09-16

- **A skill you wrote by hand had no way to reach your team.** The only route into the
  queue was living the lesson again and hoping the harvest caught it: of the skills
  sitting in a developer's own `~/.claude/skills`, all but one had been written by hand
  and none of them could be shared. `/handbook:share-skill` takes one into the review
  queue, where the ordinary approval path already knows how to deliver it. A skill is
  more than its `SKILL.md` too: the scripts, references and helpers beside it now travel
  with it, so what arrives is the skill that worked rather than a pruned copy of it.

- **Nothing reaches the queue on trust.** The harvest sieves for secrets on its way in,
  and a skill taken from disk skips that path entirely, so the check is done at the new
  boundary instead: every file that would travel is scanned, and one that carries a
  credential is refused before anything is copied. Refused, not redacted. A skill with
  `[REDACTED]` where its token was is a skill that fails for whoever installs it, and a
  broken thing shipped quietly is worse than nothing shipped at all.

## [0.3.9] - 2026-09-16

- **The review promised this project and installed the skill elsewhere.** Approving a
  candidate with `--to project` puts it in the project the lesson was captured in, which
  is right: that is where the rule applies. But the option you picked it from said "this
  project", and the review runs wherever you happen to be. Reviewing from one checkout a
  lesson caught in another installed it somewhere you did not choose, and the line naming
  the real destination printed after the decision, not before it. The choice now names
  the project it will install into, and the command, its documentation and the README all
  point at the same place.

## [0.3.8] - 2026-09-15

- **Discovery took most of the queue and nothing ever dropped one.** Discovery was 72% of
  the pending queue, the prompt ranked it last in priority and no line of code read that
  ranking, and the only quality filter was a scoring hint that had never sieved anything
  out: 96 runs, 96 times zero. Its definition invited whatever the session happened to
  turn up, so a fact about one system arrived as a skill. The definition now asks for a
  way of working that recurs, says outright that something a stronger model would get
  right on its own is not a skill, and the sieve enforces one discovery per session
  against the order the model itself proposed, not against the score. Tightened parsing
  closes the cheap way around it: a correction without a quote the developer actually
  wrote, or an error-fix naming a failure that never happened, is dropped rather than
  relabelled.

  **Yield drops on purpose.** Replayed over 17 real sessions, the same evidence through
  the old and new prompts: 45 proposals became 36 (-20%), and the discovery share of the
  queue fell from 48.9% to 36.1%. Every one of those nine losses was a discovery;
  corrections and procedures kept all of theirs. Fewer suggestions is the point, and the
  ones that survive are the ones worth reading.

## [0.3.7] - 2026-09-15

- **Leaving the team promised an install that never happened.** `/handbook:leave` said
  approved skills now install into the current project. Neither half was true. A
  candidate the harvest marked for the team still resolves to the team after the binding
  is cleared, finds no configuration, and returns an error instead of installing
  anything, so every team-scoped candidate in the queue needs an explicit `--to` once you
  have left. And a project skill installs into the project it was captured in, not
  whichever one you happen to be reviewing from. The message says both now, and it lives
  in a function with tests instead of inline in the command.

## [0.3.6] - 2026-08-28

- **Sharing a skill died on a branch name nobody chose.** A group that polices branch
  names refused `handbook/<slug>`, and the push failed with no way forward: the advice
  was to hand-edit `~/.teamhandbook/config.json`, a file a sandboxed session may not be
  allowed to touch. The retry now derives a name from the `commitPrefix` the team already
  agreed with that same server during `/handbook:init`, checks it against the pattern the
  rejection quoted before pushing anything, and remembers what worked so no later skill
  pays the same round trip. When the branch goes out under a different name than the
  default, the approval says so rather than leaving the reader to find it in the forge.
  Push failures also keep the forge's own `remote:` explanation, which a plain tail of
  git's stderr had been cutting away, leaving the verdict without the reason.

## [0.3.5] - 2026-08-18

- **The scaffold stopped shipping a script nothing runs.** `scripts/bump-version.mjs` is
  what the version-bump CI job executes, and 0.3.4 moved the bump into each skill's own
  merge request so that job is no longer needed. The script stayed behind anyway, putting
  a file in every team's repository that nothing would ever run. It ships with
  `--with-ci` now, next to the job that calls it. The default scaffold is six files: the
  two manifests that make the repository a marketplace, the dependency-free notice that
  tells teammates new skills arrived, and a README at each level.

## [0.3.4] - 2026-08-17

Setting up a real team handbook, on a real company GitLab, found four things in a row.
None of them were visible from the test suite.

- **`/handbook:init` adopts a repository that already exists**, on the branch that repo
  actually uses. It used to build a history locally and push it, which requires an empty
  remote and assumed the branch was called `main` — while teams get their repo from
  organisation tooling, which leaves a README in it, and plenty of them still default to
  `master`. A file that already has content is never overwritten, and is named in the
  output so the join instructions are not silently lost.
- **The scaffold arrives as a merge request**, not as a push to the default branch.
  Writing to a protected branch takes a role most members do not have; opening a branch
  is something almost anyone can do, and it is how every skill arrives anyway. An empty
  repository is the one exception, because there is nothing to open a request against.
- **Branch and commit names are configurable, and it asks instead of demanding.** A real
  GitLab group rejected `handbook/scaffold` because branches there must match
  `TEAM-42-something`, and then rejected the commit message for the same kind of reason.
  Every skill shared with the team would have been rejected identically. `init` now runs
  plainly, and only when the forge refuses does it read the pattern out of the refusal,
  propose a prefix, and ask. Both prefixes are remembered.
- **A refused push says which rule refused it** — branch name with the pattern quoted,
  commit message, commit author, protected branch — and when the rule is one nobody
  anticipated, the forge's own words survive instead of being replaced by a guess. The
  first version of this said "that branch is protected, ask for Maintainer" to someone
  whose access was fine.
- **`init` commits as the developer**, not as `TeamHandbook@localhost`, which is an
  author a forge that checks authors will refuse. publish always did this.
- **The version bump travels inside each skill's merge request**, so distribution needs
  no CI, no access token, and no right to push to a protected branch. That job used to
  be the only thing that made teammates' copies refresh, and it needed all three to be
  right with nothing to warn you when they were not. `--with-ci` still scaffolds it for
  repositories where skills also arrive by hand.
- **Sharing a skill says what is now true**: the request to merge, and the version it
  raises the handbook to, which is the part that makes teammates fetch it.

## [0.3.3] - 2026-08-14

Joining a private team handbook, which is what most teams will have, failed twice over
for the first person who tried it.

- **Clones no longer use the system temp directory.** Claude Code can run tools in a
  sandbox that denies it, and join died there before git was ever reached. `join`,
  `init`, `publish` and `doctor` now clone under `~/.teamhandbook/tmp`, which the plugin
  already writes to every session.
- **A failed clone says which failure it was, and what this machine needs next.** No
  credentials, an unregistered SSH key, a repo that is not there, or the network: each
  gets its own answer. For the credentials case it checks whether `gh` is installed and
  signed in, so the advice is one command rather than a menu.
- **`/handbook:init` hands the champion a message to send.** Access to the repository
  and credentials on a teammate's machine are two separate things, both required by a
  private repo, and nothing used to mention either before the teammate hit a raw git
  error. The generated handbook README says the same thing permanently.

## [0.3.2] - 2026-08-13

- **The session-start line always says something.** Every line it could print was
  conditional, and a developer who empties their queue and starts a session meets all of
  those conditions being false at once. Silence reads as "not installed". It now says it
  is on, what it watched since last time, and how many skills you have kept, whenever
  there is nothing more specific to report. `{"notify": {"sessionStart": false}}` still
  turns it off completely.

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
