# TeamHandbook

**The team handbook that writes itself.**

Everyone on your team teaches Claude the same rules. Separately. Every session.

```
you: we never mock the DB in integration tests here — use the testcontainer fixture
```

You just wrote a line of your team's handbook. It died in the scrollback.

TeamHandbook catches it when the session ends, shows you the receipt, and — only if you
approve — keeps it for you, drops it in this repo, or opens a pull request so the next
person never learns it the hard way.

## Install

**Requires** Claude Code ≥ 2.1 and Node.js ≥ 18.

```
/plugin marketplace add AhmetErenLapanta/TeamHandbook
/plugin install handbook@teamhandbook
```

That's the whole install. It works **solo immediately** — no team setup required.

## What you'll see

Your next session opens with your own sentence:

```
handbook learned from your last session: "no-db-mocks-in-integration-tests"
(correction, 8/10) — run /handbook:review
```

`/handbook:review` shows each lesson with the evidence that produced it:

```
candidate: no-db-mocks-in-integration-tests  [correction]  [scope: team]  [pending]
score:     8/10  (recurrence 1, unfindability 2, generality 2, durability 2, costOfError 1)

── grounded case ──
you said:  "we never mock the DB in integration tests here — use the testcontainer fixture"
expect:    Integration tests start a testcontainer instead of a mock.
```

Then you choose where it lives:

```
/handbook:review approve <slug> --to personal   # ~/.claude/skills — every project, just you
/handbook:review approve <slug> --to project    # this repo's .claude/skills — travels with the code
/handbook:review approve <slug> --to team       # a pull request to your team's handbook
```

**Nothing installs itself. Nothing reaches your team without that choice.**

## Commands

| Command | What it does |
|---|---|
| `/handbook:review` | Keep, scope, share, edit, or reject each lesson. **The only way anything ships.** |
| `/handbook:demo` | Walk the whole loop in two minutes on a scratch project. |
| `/handbook:learn` | Capture something on demand instead of waiting for the session to end. |
| `/handbook:status` | Queue, ledger, how often your skills actually fired, config. |
| `/handbook:doctor` | Diagnose node, the `claude` CLI, hooks, config, team repo. |
| `/handbook:init` | Scaffold the team handbook repo and print the join command. |
| `/handbook:join <url>` | Point at an existing team handbook. |
| `/handbook:leave` | Back to solo. Deletes no skills. |

## How it works

<img src="docs/handbook-loop.svg" alt="A coding session produces evidence and a redacted transcript slice; one harvest call through your own claude CLI proposes up to three lessons scored on five criteria, with anything under 4/10 dropped before you see it; the next session asks whether to keep each one, put it in the repo, or share it with the team." width="880">

- **Capture is a hook, not a tool call.** The model won't remember to save a lesson at
  the worst moment — a failing build, a frustrated developer. Hooks fire every time.
- **A free check decides whether the model runs at all.** A trivial session — a
  question, a couple of `ls` calls — is never harvested and costs nothing.
- **Five criteria**, 0–2 each: recurrence, unfindability, generality, durability, cost
  of error. A lesson needs **≥4/10** to reach your queue, and at most the top three per
  session do. The score decides what is worth *asking about*, not what ships.
- **Every skill carries its receipt** — your quoted words, the failing command, the fix
  — so you can judge it in seconds instead of trusting it.

The output is a spec-compliant [Agent Skill](https://agentskills.io). Delete
TeamHandbook tomorrow and your skills keep working, in any tool that reads `SKILL.md`.

## Read this before you install

This plugin's hooks read your session, so it is worth stating plainly.

**The harvest sends a slice of your conversation to your own `claude` CLI.** At the end
of a substantive session it reads Claude Code's transcript and sends up to 40 000
characters — **including your own prompts, which get 60% of that budget on purpose,
because your corrections are the most valuable lessons** — plus the error→fix evidence
the hooks captured. This reaches Anthropic exactly as any Claude Code prompt does, and
it happens *before* you review anything. Tool calls, tool results and subagent traffic
are never included.

Turn it off in `~/.teamhandbook/config.json`:

```jsonc
{ "harvest": { "enabled": false } }   // no session is ever read or sent
{ "gate":    { "auto": false } }      // no automatic model calls at all
```

Both are checked before a session is queued, and both fail **closed** if the file
cannot be parsed. Neither stops the local hooks from capturing evidence into
`~/.teamhandbook/` — that costs nothing and leaves your machine only through a harvest
you re-enabled or a `/handbook:learn` you ran yourself.

**Secrets are redacted before anything is written or sent** — private keys, cloud and
vendor tokens, JWTs, auth headers, `KEY=value` assignments
([`src/lib/secrets.ts`](src/lib/secrets.ts)). Detection is pattern matching: a secret in
an unrecognized shape can slip through, so still eyeball a candidate before approving.

It uses **your** Claude — no bundled key, no third-party model, no telemetry. The full
data map is in [SECURITY.md](SECURITY.md).

## Sharing it with your team

One person, once:

```
/handbook:init                 # creates the repo + CI, prints the join command
/handbook:join <repo-url>      # everyone else who wants to contribute lessons
```

Teammates who only want to *read* the handbook don't need this plugin at all — the repo
is an ordinary Claude Code marketplace:

```
/plugin marketplace add <team-repo-url>
/plugin install <team-plugin-name>
```

If your team drops TeamHandbook tomorrow, the handbook repo and its distribution keep
working. There is no lock-in.

## Honest limitations

- **The harvest is one model call, and the model matters.** On an identical prompt from
  a real session the default (`sonnet`) proposed the developer's stated rule 3 times out
  of 3; `haiku` managed 1 in 3. A lesson buried in a very long session can still be
  missed, and the model can propose something plausible but wrong — which is exactly why
  nothing installs itself.
- **A correction needs you to have said it.** Fix Claude's approach by editing the file
  yourself and there is nothing to quote.
- **Only conversational prose is read.** A lesson living purely in tool output reaches
  the harvest only through the deterministic error→fix pairs the hooks captured.
- **Repeat matching is word overlap, not understanding.** Two phrasings of one rule
  match when they share most of their content words, and a word wearing a different
  suffix still counts as the same word — so it works whatever language you teach in,
  including one where every ending changes. A rule restated in completely different
  words reads as new. The bias is deliberate: a missed repeat, never a false one.
- **State is per-machine.** `~/.teamhandbook/` does not sync; team approvals travel
  through the merged pull request.

## Development

```
npm install
npm run build       # bundle the hooks into dist/
npm test
npm run typecheck
```

`dist/` is committed on purpose: the plugin is installed by git clone, so the built
hooks must be present.

## License

[Apache-2.0](LICENSE).
