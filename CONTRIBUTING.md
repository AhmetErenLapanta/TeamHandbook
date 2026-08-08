# Contributing to TeamHandbook

Thanks for your interest. TeamHandbook is a small, focused codebase; contributions
that keep it that way are very welcome.

## Development setup

```
npm install
npm run build       # bundle the hooks into dist/
npm test            # vitest
npm run typecheck   # tsc --noEmit
```

The plugin runs `dist/`, not `src/` — **after editing anything under `src/hooks/`
or `src/cli/`, run `npm run build`** and commit the updated bundles. `dist/` is
committed on purpose (the plugin is installed by git clone).

## Ground rules

- **Fail closed at trust boundaries.** An unparseable model reply, or any chance
  of a secret, must drop a candidate rather than promote or write it. Never weaken
  the secret redaction (`src/lib/secrets.ts`) or the "nothing is delivered without
  `/handbook:review` approval" invariant.
- **Untrusted session text is data, never instructions.** Anything captured from a
  session (stderr, commands) that flows into a model prompt must stay inside the
  `fenceUntrusted` block.
- **Tests for services.** Cover `src/lib/` changes with a `*.test.ts` beside the
  file, using given/when/then structure. The thin hook/CLI entrypoints are
  exercised through the lib functions they call.
- **English** for all product-facing output: CLI messages, generated skills,
  command markdown.
- Keep changes minimal and match the surrounding style. No new abstraction layers
  or dependencies without a clear reason.

## Pull requests

- Branch off `main`, keep the diff focused, and make sure `npm run build`,
  `npm test`, and `npm run typecheck` all pass.
- Use [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`).
- Describe the behavior change and, for anything touching capture/gate/secrets,
  the failure case your change prevents.

By contributing you agree that your contributions are licensed under the project's
[Apache-2.0](LICENSE) license.
