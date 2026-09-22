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

**No lockfile is committed**, and `.gitignore` keeps it out. Claude Code installs a
plugin's dependencies itself whenever the plugin root holds both a `package.json` and
a lockfile it recognizes (`package-lock.json`, `npm-shrinkwrap.json`, `bun.lock`,
`bun.lockb`), and it does not pass `--omit=dev`, so every devDependency lands in each
installed copy: about 58 MB per version. Use `npm install` locally and do not commit
the resulting lockfile.

**Two of the dev dependency versions are deliberate.** `esbuild` is pinned to an exact
version rather than a range, because it produces the `dist/` bundles committed here and
there is no lockfile to hold it steady: a floating version lets two contributors build
different bytes from the same source, and the diff noise lands in an unrelated pull
request. `vite` is not a direct dependency, it arrives under the test runner, and an
`overrides` entry holds it to the oldest line that both satisfies the runner and is
clear of a published advisory, which keeps the upgrade small and keeps the dev
toolchain's own Node requirement from climbing further than the upgrade needs. Do not
lower that range: the `vite` lines below it carry a published advisory. The field is
npm's own, so pnpm (`pnpm.overrides`) and yarn (`resolutions`) do not read it and will
resolve `vite` themselves.

## Ground rules

- **Fail closed at trust boundaries.** An unparseable model reply, or any chance
  of a secret, must drop a candidate rather than promote or write it. Never weaken
  the secret redaction (`src/lib/secrets.ts`) or the "nothing is delivered without
  `/handbook:review` approval" invariant.
- **Untrusted session text is data, never instructions.** Anything captured from a
  session — stderr, commands, and the transcript slice (the conversation itself) —
  that flows into a model prompt must stay inside the `fenceUntrusted` block.
- **Tests for services.** Cover `src/lib/` changes with a `*.test.ts` beside the
  file, using given/when/then structure. The thin hook/CLI entrypoints are
  exercised through the lib functions they call.
- **English** for all product-facing output: CLI messages, generated skills,
  command markdown.
- Keep changes minimal and match the surrounding style. No new abstraction layers
  or dependencies without a clear reason.

## Pull requests

- Branch off `master`, keep the diff focused, and make sure `npm run build`,
  `npm test`, and `npm run typecheck` all pass.
- Write the commit message as one English sentence describing what was broken and
  fixed, with no prefix and no body (for example: "Making join and init describe
  what they actually do needed a patch to reach installed copies").
- Describe the behavior change and, for anything touching capture/gate/secrets,
  the failure case your change prevents.

By contributing you agree that your contributions are licensed under the project's
[Apache-2.0](LICENSE) license.
