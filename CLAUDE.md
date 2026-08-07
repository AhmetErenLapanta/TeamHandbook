# CLAUDE.md — working in this repo

TeamHandbook is a Claude Code plugin (TypeScript/Node) that captures error→fix pairs
from coding sessions via hooks, gates them, distills `SKILL.md` artifacts, and
opens PRs to a team skill repo. See [README.md](README.md) for the product story.

## Layout

- `src/hooks/` — hook entrypoints (`post-tool-use`, `stop`, `session-end`,
  `session-start`). Thin; they read stdin, call a lib function, exit 0.
- `src/cli/` — command entrypoints backing `commands/*.md`.
- `src/lib/` — the engine: `capture`/`session-state`/`signals` (detector),
  `gate`/`secrets`/`score`/`distill` (promotion + distillation),
  `queue`/`deliver`/`publish`/`init`/`join` (review + team), plus small utilities.
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
- Untrusted session text (stderr, commands) is fenced as data, never instructions,
  in the gate and distill prompts.
