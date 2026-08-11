# TeamHandbook

**The things you tell Claude twice should only be said once.**

You correct Claude mid-session — *"we never mock the DB in integration tests."*
TeamHandbook harvests that session when it ends and, at your next session, opens with
your own sentence and one question: keep it for yourself, put it in this repo, or
send it to your team as a pull request. Every skill ships with the receipt it came
from.

```
TeamHandbook learned from your last session: "no-db-mocks-in-integration-tests"
(correction, 8/10) — keep it for yourself, share it with the team, or skip:
run /handbook:review
```

And then you choose:

```
/handbook:review approve <slug> --to personal   # ~/.claude/skills — every project, just you
/handbook:review approve <slug> --to project    # this repo's .claude/skills — travels with the code
/handbook:review approve <slug> --to team       # a PR to your team's skill repo
```

Nothing installs itself. Nothing reaches your team without that choice.

## Install

**Requires** Claude Code ≥ 2.1 and Node.js ≥ 18.

```
/plugin marketplace add <your-username>/TeamHandbook
/plugin install handbook@teamhandbook
```

> Replace `<your-username>` with the GitHub owner this repo is hosted under.

From a local clone (before it is published, or offline):

```
git clone <this-repo-url> TeamHandbook
```

then in Claude Code:

```
/plugin marketplace add ./TeamHandbook
/plugin install handbook@teamhandbook
```

That's the whole install. It works **solo immediately** — no team setup required.

## What it looks like

You are pairing with Claude on a payment service. It writes a test that mocks the
database; you push back in one line:

```
you: we never mock the DB in integration tests here — use the testcontainer fixture
```

Later the same session, a command fails and you fix it:

```
$ ./validate.sh
ERROR 400: field 'user_id' unknown — the gateway only accepts camelCase
# …you rename the field, re-run, it passes.
```

The session ends. TeamHandbook makes **one** `claude -p` call — your own CLI — over a
redacted slice of that conversation plus the error→fix pair it captured
deterministically. Next session:

```
TeamHandbook learned from your last session: "no-db-mocks-in-integration-tests"
(correction, 8/10) (+1 more) — keep it for yourself, share it with the team, or
skip: run /handbook:review
```

`/handbook:review` shows each lesson with the evidence that produced it:

```
candidate: no-db-mocks-in-integration-tests  [correction]  [scope: team]  [status: pending]
score:     8/10  (recurrence 1, unfindability 2, generality 2, durability 2, costOfError 1)
suggested: keep for yourself (~/.claude/skills)

── grounded case ──
you said:  "we never mock the DB in integration tests here — use the testcontainer fixture"
expect:    Integration tests start a testcontainer instead of a mock.
```

Keep it, and every future session in every project already knows. Send it to the
team, and it arrives as an ordinary pull request — reviewed like code, merged like
code, distributed by Claude Code's own marketplace.

## Why this exists

Auto-generated skills are a liability; reviewed ones compound. Tools that turn
session history into skills mostly turn *everything* into a skill, and an
unverified instruction is worse than none — it fires on every session, for
everyone, silently.

TeamHandbook's answer is that judgment belongs at **activation**, not production:

- it reads a finished session **once** and proposes **at most three** lessons,
- each one arrives with its **receipt** — your quoted words, the failing command,
  the steps you took — so you can judge it in seconds,
- hard vetoes are only the ones a human shouldn't have to make (a secret, an
  oversized body, a duplicate, something you already muted),
- and **you** decide where each lesson lives: your machine, this repo, or a PR.

The output is a spec-compliant [Agent Skill](https://agentskills.io), so the corpus
is portable across the ~40 tools that read `SKILL.md` — and if you delete TeamHandbook
tomorrow, the skills and their distribution keep working.

## How it works

<img src="docs/handbook-loop.svg" alt="The TeamHandbook loop: a coding session produces evidence and a redacted transcript slice; one harvest call through your own claude CLI proposes up to three lessons scored on five criteria, with anything under 4/10 dropped before you see it; the next session asks whether to keep each one for yourself, put it in this repo, or share it with the team." width="880">

- **Capture is a hook, not a tool call.** The model won't remember to save a lesson
  at the worst moment (a failing build, a frustrated developer); hooks fire every
  time. Your teachings are flagged the instant you type them, so a correction in the
  middle of a long session can't be lost.
- **A free check decides whether the model runs at all.** A trivial session — a
  question, a couple of `ls` calls — is never harvested and costs nothing.
- **Five criteria** (0–2 each): recurrence, unfindability, generality, durability,
  cost of error. A lesson needs **≥4/10** to reach your queue, and at most the top 3
  per session do. The score decides what's worth *asking about*, not what ships.
- **Scope.** A general lesson is `scope: team`; a repo-specific one is scoped to
  that repo's git remote and says so in its own text.
- **Grounded case.** Every skill carries the case that produced it and the behavior
  that proves it — a regression anchor, not just prose.

## Knowing it's working

- **First session after install**, it introduces itself once and tells you exactly
  what it reads.
- **When it learned something**, the line above: what it learned, how it scored,
  and the keep/share/skip question.
- **When new skills arrived** (your approvals or teammates' merges):
  `handbook: 2 new skills available since your last session here: …`
- **Once a week**, what the week produced:
  `TeamHandbook — your week: 2 skills kept, 1 shared with the team, 1 waiting for your call.`
- Nothing happened → it says nothing. Silence it with `~/.teamhandbook/config.json` →
  `{"notify": {"sessionStart": false}}`.

`/handbook:status` shows the full picture anytime; `/handbook:doctor` diagnoses a
gate that can't reach your `claude` CLI.

## Commands

| Command | What it does |
|---|---|
| `/handbook:review` | Review each lesson: keep it for yourself, put it in this repo, share it with the team, edit it first, or reject. **Nothing is installed or shared without this.** |
| `/handbook:learn` | Capture something on demand — an error→fix moment or a completed task's procedure — without waiting for the session harvest. |
| `/handbook:status` | Ledger, queue, detector counters, harvest config, and a since-install recap. |
| `/handbook:doctor` | One-command diagnosis: node, claude CLI (probed with every model you configured), hooks firing, config, team repo, forge CLI. |
| `/handbook:init` | Scaffold a team skill repo and print the command teammates run. |
| `/handbook:join <url>` | Point the engine at an existing team skill repo. |
| `/handbook:leave` | Clear the team binding (back to solo, or switch teams). Deletes no skills. |

## Privacy & security

This plugin's hooks read your session, so this matters and is worth stating plainly.

- **The harvest reads your conversation, and sends a slice of it to your own
  `claude` CLI.** This is the one thing to understand before installing. At the end
  of a substantive session, TeamHandbook reads Claude Code's transcript for that
  session and sends up to 40 000 characters of it — **including your own prompts,
  which get 60% of that budget on purpose, because your corrections are the most
  valuable lessons** — together with the error→fix evidence it captured. This
  reaches Anthropic exactly as any Claude Code prompt does, and it happens *before*
  you review anything. Tool calls, tool results, and subagent traffic are not
  included; only conversational prose.
  - **Turn it off** with `~/.teamhandbook/config.json` → `{"harvest": {"enabled": false}}`,
    or disable every automatic model call with `{"gate": {"auto": false}}`. Either
    switch is checked before a session is queued, so the transcript is never read
    and nothing is sent; candidates then come only from an explicit
    `/handbook:learn`. To be precise about what they do *not* stop: the local
    hooks keep capturing evidence to `~/.teamhandbook/` (the failing command, the fix,
    and teaching-shaped prompts), because that costs nothing and leaves your
    machine only through a harvest you have re-enabled or a `/handbook:learn` you
    ran. If the config file cannot be parsed, both switches fail **closed** and the
    session-start notice says so.
  - A trivial session is never harvested and costs no model call at all.
- **Nothing is installed or shared without your explicit approval.** Candidates sit
  in a local queue; only `/handbook:review` → approve installs a skill or opens a PR
  (with your own git credentials).
- **Secret redaction runs before anything is written or sent.** A captured command,
  error, or edit that matches a known secret pattern is dropped and reduced to a
  content-free fingerprint; a transcript line that matches is replaced in place with
  `[redacted:<type>]` before the slice leaves the process. Patterns cover private
  keys, AWS/GitHub/GitLab/Slack/Stripe/OpenAI/Google/npm tokens, JWTs, Basic-auth
  headers, and `KEY=value` assignments ([`src/lib/secrets.ts`](src/lib/secrets.ts)).
  Detection is **best-effort pattern matching**: a secret in an unrecognized format
  can slip through, so still eyeball a candidate before you approve it.
- **It uses *your* Claude** (`claude -p`), not a bundled key — no third-party model,
  no extra credentials, no telemetry. State lives under `~/.teamhandbook/`.
- Raw hook payloads are **never** written to disk unless you opt in with
  `TEAMHANDBOOK_DEBUG=1` (for schema diagnosis), because payloads can contain secrets.

See [SECURITY.md](SECURITY.md) for the full data map, including the crash-salvage
path and every file TeamHandbook writes.

## Configuration

Everything is optional; defaults are shown.

```jsonc
// ~/.teamhandbook/config.json
{
  "harvest": {
    "enabled": true,            // false → no session is ever read or sent
    "model": "haiku",           // model for the single per-session call
    "maxPerSession": 3,         // hard cap on lessons proposed per session
    "minScore": 4,              // 0-10 floor; below this an item is dropped
    "transcriptCharCap": 40000, // max characters of conversation sent
    "timeoutMs": 120000
  },
  "gate":   { "auto": true },   // false → no automatic model calls at all
  "notify": { "sessionStart": true, "heartbeat": true }
}
```

## Honest limitations

- **The harvest is one model call.** A lesson buried in a very long session can be
  missed, and the model can propose something plausible but wrong. That's exactly
  why nothing installs itself: the floor is 4/10 because *your* decision at review
  is the real gate, not the score.
- **Only conversational prose is read.** A lesson that lives purely in tool output —
  a log line you never discussed — reaches the harvest only through the
  deterministic error→fix pairs the hooks captured.
- **A "correction" needs you to have said it.** If you fixed Claude's approach by
  editing the file yourself instead of telling it the rule, there's nothing to quote.
- **Recurrence counts are per-machine.** The same trap hit on two machines scores
  lower on recurrence than it deserves. It still gets harvested — recurrence is one
  of five criteria, not a gate.
- **v2 produces skills only.** Routing lessons to tests, lint rules, or `AGENTS.md`
  lines is future work.
- A harvest that can't reach `claude` retries up to 3 times, then parks the whole
  session in `~/.teamhandbook/abandoned.jsonl` rather than dropping it silently;
  `/handbook:status` reports the count.

## Team setup

One person, once:

```
/handbook:init                      # creates the repo + CI, prints the join command
```

Teammates who want to *produce* skills:

```
/handbook:join <team-repo-url>
```

Teammates who only want to *consume* them don't need TeamHandbook at all — the team
repo is an ordinary Claude Code marketplace:

```
/plugin marketplace add <team-repo-url>
/plugin install <team-plugin-name>
```

If your team deletes TeamHandbook tomorrow, the skill repo and its distribution keep
working — there's no lock-in.

## One developer, several machines

All state lives under `~/.teamhandbook` on **each machine separately** — there is no
sync. Practically:

- **Personal approvals** land in `~/.claude/skills` on that machine only.
- **Project approvals** land in the repo's `.claude/skills/` — **commit that
  directory** and they travel with the repo to your other machines and teammates.
- **Team approvals** reach every machine through the merged PR. That's the fix for
  everything else: recurrence counts, mutes, and nudges are all per-machine.
- Point several machines at one state dir with `TEAMHANDBOOK_HOME` if you really want
  shared local state (advanced; no locking guarantees across machines).

## Uninstall

```
/plugin uninstall TeamHandbook
rm -rf ~/.teamhandbook                  # all TeamHandbook state
```

Skills you approved are ordinary files and stay where you put them:
`~/.claude/skills/<slug>/` for personal, the repo's `.claude/skills/` for project,
the team repo for shared. Delete those yourself if you want them gone too.

## Development

```
npm install
npm run build       # bundle the hooks into dist/
npm test            # vitest
npm run typecheck
```

`dist/` is committed on purpose: the plugin is installed by git clone, so the built
hooks must be present.

## License

[Apache-2.0](LICENSE).
