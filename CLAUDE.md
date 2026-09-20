# CLAUDE.md — working in this repo

TeamHandbook is a Claude Code plugin (TypeScript/Node) that harvests durable lessons from
real coding sessions — the corrections you gave, the procedures you completed, the traps
you hit — and offers each one as a personal, project, or team skill. See
[README.md](README.md) for the product story.

## Layout

- `src/hooks/` — hook entrypoints (`post-tool-use`, `user-prompt-submit`, `stop`,
  `session-end`, `session-start`). Thin; they read stdin, call a lib function, exit 0.
- `src/cli/` — command entrypoints backing `commands/*.md`.
- `src/lib/` — the engine: `capture`/`corrections`/`session-state`/`signals`
  (deterministic evidence), `transcript`/`harvest` (the session harvest: slice, redact,
  ONE `claude -p`, sieve), `secrets`/`prompt-safety` (trust boundaries),
  `gate`/`score`/`distill` (the `/handbook:learn` path only),
  `queue`/`deliver`/`publish`/`init`/`join` (review + routing), plus small utilities.
- `hooks/hooks.json`, `commands/*.md`, `.claude-plugin/` — the plugin manifest and
  wiring, discovered by Claude Code by convention.
- `dist/` — esbuild bundles, committed (the plugin is installed by git clone).
- `evals/` - the natural-language routing suite: does a plain sentence reach the right
  command? Cases sit under `tutma/` (the held-out set the headline number comes from),
  `gelistirme/` (iteration) and `kontrol/` (must score 1.00). Run one with
  `evals/run-suite.sh <suite>`; `evals/README.md` lists the suites and the flags each needs.

## Conventions

- After editing anything under `src/hooks/` or `src/cli/`, run `npm run build` —
  the plugin runs `dist/`, not `src/`.
- Tests are vitest, colocated as `*.test.ts`. Cover `lib/` services; the thin
  hook/CLI entrypoints are exercised by the lib tests they call.
- A function that reads or writes under the handbook home takes its root as a defaulted
  parameter (`home: string = handbookHome()`), so a test hands it an `mkdtemp` directory
  instead of a real `~/.teamhandbook`. A few call sites still reach `homedir()` directly
  (`deliver.ts`, `init.ts`, `skill-index.ts`); don't add more.
- Comments carry the reason rather than a restatement: the measurement behind a
  default, the failure a guard prevents. Don't drop them to tidy a diff.
- The repo is public. No real machine path, OS account name or session id reaches a
  commit; a fixture that needs a home path uses an obvious stand-in name.
- All product output is English: CLI messages, generated skills, command markdown.
  Deliberate exceptions: `evals/*/prompt.md` keeps the user's own language, and the
  correction detectors (`corrections.ts`, `teachings.ts`) and the fixtures feeding them
  carry non-English phrases as data. Translating either deletes what it measures.
- Fail closed at trust boundaries: an unparseable model reply or a possible secret
  drops the candidate rather than promoting it.
- `~/.teamhandbook/` (or `TEAMHANDBOOK_HOME`) holds all runtime state.

## Where to look before you change something

- Setup commands, the commit message format and what a pull request needs:
  [CONTRIBUTING.md](CONTRIBUTING.md). Not repeated here.
- Anything that reads a session, writes to disk, or sends bytes off the machine
  (`capture`, `harvest`, `secrets`, `publish`): [SECURITY.md](SECURITY.md) is the promise
  the product makes about each. A change that breaks one edits it too.
- A description under `commands/*.md`: that string is what the routing suite measures, so
  the number is stale until it is rerun, and `evals/tutma/` stays unread while you write one.
- `dist/` is esbuild output (`scripts/build.mjs`). Edit `src/` and rebuild; an edit made
  directly in `dist/` is overwritten by the next build.

## Non-negotiable invariants (don't regress these)

- Nothing is delivered without explicit user approval via `/handbook:review`.
- Secrets are redacted at the persistence boundary — no captured secret reaches
  `signals.jsonl`, the pending queue, a candidate, or a PR.
- Untrusted session text — stderr, commands, and the transcript slice (the
  conversation itself) — is fenced as data, never instructions, in every model prompt.
- The transcript slice is redacted line-by-line before it enters the harvest prompt.
- `gate.ts`'s recurrence threshold is legacy: no automatic path reaches it. Don't
  reintroduce a recurrence precondition without a deliberate decision.
