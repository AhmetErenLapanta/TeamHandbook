# TeamHandbook

**Turn your team's real error→fix moments into gated, reviewable, merge-ready skills.**

TeamHandbook is a [Claude Code](https://code.claude.com) plugin. While you work, it
quietly notices when a command failed and a later edit made it pass, decides
whether that lesson is worth keeping, distills the ones that are into a
spec-compliant `SKILL.md` — and opens a pull request to your team's skill repo,
so the next person (and the next Claude session) already knows.

You review a one-line "publish this?" prompt. Everything else is automatic.

---

## Why this exists

Sharing a skill with your team is already a solved problem — it's a `git push`.
A git repo with a marketplace manifest is a Claude Code marketplace; teammates
auto-update from it in the background. Distribution is not the gap.

The gap is **judgment**: of everything that happens in a coding session, *which
moments deserve to become a durable, team-wide instruction* — and are they even
correct? Tools that auto-generate skills from session history exist now, and they
mostly turn everything into a skill. An unverified, auto-written instruction is
worse than none: it applies on every session, for the whole team, silently.

TeamHandbook is the layer that makes captured lessons trustworthy enough to merge:

- a **promotion gate** decides what's worth keeping (rules first, then an LLM),
- **secret redaction** runs before anything is written to disk,
- every skill ships with the **grounded case** that produced it, as a regression anchor,
- and a human approves each one via an ordinary **pull request**.

## What it looks like

You hit a failure and fix it:

```
$ npm test
FAIL src/api.test.ts
  400 Bad Request: unknown field 'user_id' (send camelCase)
# …you change the DTO to camelCase, tests pass, you move on.
```

Next time you open Claude Code, if that class of failure has recurred, you see:

```
handbook: 1 candidate ready to publish — /handbook:review
```

`/handbook:review` shows the distilled skill and its grounded case; you approve,
and TeamHandbook opens a PR to your team's skill repo (with your own git identity).
Merge it, and every teammate's Claude has it the next day.

## Install

**Requires** Claude Code and Node.js ≥ 18.

```
/plugin marketplace add <your-username>/TeamHandbook
/plugin install handbook@teamhandbook
```

That's the whole install. It works **solo immediately** — captured skills are
written to the project you're in, no team setup required.

### See it work in 2 minutes

The detector deliberately waits for a lesson to *recur* before proposing a skill,
so a fresh install is quiet. To watch the whole loop right now, stage a recurring
error→fix on purpose — in a Claude Code session, ask Claude to:

1. Run a command that fails with a distinctive error (e.g. a script that rejects a
   config), fix it by editing a file, and re-run the same command until it passes.
2. Do the same fail→fix once more (a new session works too).
3. Run `/handbook:status` — watch `failures captured` and `pairs resolved` count up.
4. Within a minute the gate scores the recurring pair; `/handbook:review` shows
   the distilled skill with its grounded case. Approve it and find it in the
   project's `.claude/skills/`.

Or skip the theater: finish any real task and run `/handbook:learn` — it captures
the procedure immediately, no recurrence needed.

To share with a team, one person runs `/handbook:init` once; it scaffolds the
team skill repo (a marketplace with version-bump CI) and prints the single
command teammates run to connect. See [team setup](#team-setup).

## How it works

```
PostToolUse hook          gate                       route + review
────────────────          ────                       ──────────────
Bash exits ≠ 0     ─┐     rule sieves (cheap):        approved candidate →
edit attached       ├──▶  · has a file change?    ──▶ solo: project/.claude/skills
same command        │     · no secret (veto)          team: PR to the skills repo
  later exits 0   ──┘     · seen ≥ N times            ─────────────────────────────
(a resolved pair)         · size                       nothing leaves the machine
                          then LLM (your own claude):  without your approval
                          score 5 criteria, ≥7/10
                          distill → SKILL.md + case
```

- **Capture is a hook, not a tool call.** The model won't remember to save a
  lesson at the worst moment (a failing build, a frustrated developer); a hook is
  deterministic and fires every time. Retrieval is model-invoked; capture is not.
- **The gate is rules-first, LLM-second, and the rules win.** Cheap deterministic
  checks run before any model call; a secret detection vetoes a candidate no
  matter what the model thinks.
- **Five gate criteria** (0–2 each, promote at ≥7/10): recurrence, unfindability
  (can't be derived from code/tests/README), generality, durability, cost of error.
- **Scope.** A general procedure is `scope: team` and travels to everyone; a
  project-specific fact is scoped to that repo's git remote and only surfaces there.
- **Grounded case.** Each skill carries the exact case that produced it and the
  behavior that proves the fix — so when the skill is later edited, there's a
  regression anchor, not just prose.

Output is a **spec-compliant [Agent Skill](https://agentskills.io)**, so it isn't
Claude-only — the corpus is portable across the ~40 tools that read `SKILL.md`.

## Knowing it's working

TeamHandbook stays out of your way, but never leaves you wondering whether it's alive:

- **First session after install**, it introduces itself once:
  `TeamHandbook is active — watching this machine for error→fix moments worth keeping…`
- **When it captured something** since your last session, a one-line heartbeat:
  `handbook: since your last session — 3 failures watched, 1 error→fix pair captured.`
- **When a candidate is ready**, the review prompt:
  `handbook: 1 candidate skill is awaiting your review — run /handbook:review…`
- Nothing happened → it says nothing. Disable entirely with
  `~/.teamhandbook/config.json` → `{"notify": {"sessionStart": false}}` (or just the
  heartbeat via `{"notify": {"heartbeat": false}}`).

`/handbook:status` shows the full picture anytime: detector counters, ledger,
queue, and the last gate run.

## Commands

| Command | What it does |
|---|---|
| `/handbook:review` | List, show, approve, or reject pending candidates. **Nothing is published without this.** |
| `/handbook:learn` | Manually capture an error→fix moment OR a completed task's procedure as a candidate (still passes the gate). |
| `/handbook:status` | Ledger, queue, redaction count, and detector health counters. |
| `/handbook:init` | Scaffold a team skill repo and print the command teammates run. |
| `/handbook:join <url>` | Point the engine at an existing team skill repo. |

## Privacy & security

This plugin's hooks read your session, so this matters and is worth stating plainly:

- **Nothing leaves your machine without your explicit approval.** Candidates sit
  in a local queue; only `/handbook:review` → approve opens a PR, using your own
  git credentials.
- **Secret redaction runs before anything is written.** A signal whose command,
  error, or edits contain a secret is dropped entirely and reduced to a
  content-free fingerprint; only a counter is kept. Patterns cover private keys,
  AWS/GitHub/GitLab/Slack/Stripe/OpenAI/Google/npm tokens, JWTs, Basic-auth
  headers, and `KEY=value` assignments ([`src/lib/secrets.ts`](src/lib/secrets.ts)).
- **The gate's scoring uses *your* Claude** (`claude -p`), not a bundled key —
  no third-party model, no extra credentials.
- **No telemetry.** State lives under `~/.teamhandbook/`.
- Raw hook payloads are **never** written to disk unless you opt in with
  `TEAMHANDBOOK_DEBUG=1` (for schema diagnosis), because payloads can contain secrets.

## Honest limitations

- Promotion requires **recurrence** (a one-off error→fix won't become a skill);
  this is deliberate — precision over recall for v1. It also means capture is
  conservative: TeamHandbook learns the mistakes your team makes *more than once*.
- Automatic capture is **error-shaped** (a failing command, an edit, a passing
  re-run). Successful work is learned through two other paths: `/handbook:learn`
  captures a completed task's procedure (goal, ordered steps, verification) with
  the full session context; Claude itself offers to capture a genuinely teachable
  task the first time it happens (a plugin skill guides it — at most one offer per
  session, never for trivia); and TeamHandbook tracks each session's **work shape**,
  nudging once when the same kind of work recurs (default: 2nd time, configurable
  via `notify.workNudgeThreshold`). Generation is never automatic for procedures:
  you ask — and because you asked, a manual capture is ALWAYS distilled and
  queued: a low gate score travels with it as advice, and the publish decision
  stays yours at review. (The gate's hard veto applies only to the automatic
  path, plus secrets everywhere.)
- v1 produces **skills only**. Routing lessons to tests/lint rules/`AGENTS.md`
  lines is future work.
- `/handbook:status` shows `tool calls seen / failures captured / pairs resolved`
  counters so you can confirm capture is working at a glance.

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
/plugin install <team-plugin>@<team-marketplace>
```

If your team deletes TeamHandbook tomorrow, the skill repo and its distribution keep
working — there's no lock-in.

## Development

```
npm install
npm run build       # bundle the hooks into dist/
npm test            # vitest
npm run typecheck
```

`dist/` is committed on purpose: the plugin is installed by git clone, so the
built hooks must be present.

## License

[Apache-2.0](LICENSE).
