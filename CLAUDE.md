# CLAUDE.md — working in this repo

TeamHandbook is a Claude Code plugin (TypeScript/Node) that harvests durable lessons from
real coding sessions — the corrections you gave, the procedures you completed, the traps
you hit — and offers each one as a personal, project, or team skill. See
[README.md](README.md) for the product story and [docs/SPEC-P1-HARVEST.md] for the v2
design decisions (K1–K8).

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

## Conventions

- After editing anything under `src/hooks/` or `src/cli/`, run `npm run build` —
  the plugin runs `dist/`, not `src/`.
- Tests are vitest, colocated as `*.test.ts`. Cover `lib/` services; the thin
  hook/CLI entrypoints are exercised by the lib tests they call.
- All product output is English: CLI messages, generated skills, command markdown.
- Fail closed at trust boundaries: an unparseable model reply or a possible secret
  drops the candidate rather than promoting it.
- `~/.teamhandbook/` (or `TEAMHANDBOOK_HOME`) holds all runtime state.

## Non-negotiable invariants (don't regress these)

- Nothing is delivered without explicit user approval via `/handbook:review`.
- Secrets are redacted at the persistence boundary — no captured secret reaches
  `signals.jsonl`, the pending queue, a candidate, or a PR.
- Untrusted session text — stderr, commands, and the transcript slice (the
  conversation itself) — is fenced as data, never instructions, in every model prompt.
- The transcript slice is redacted line-by-line before it enters the harvest prompt.
- `gate.ts`'s recurrence threshold is legacy: no automatic path reaches it (K8). Don't
  reintroduce a recurrence precondition without a deliberate decision.
