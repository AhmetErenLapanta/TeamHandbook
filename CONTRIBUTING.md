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

**The dev dependency versions are exact on purpose.** With no lockfile, every install and
every CI run resolves them afresh, so a caret range means a version nobody chose can arrive
between one run and the next. Two reasons put the pins there, and they overlap rather than
divide the list:

- *Reproducible committed output.* The bundler writes the `dist/` bundles that are committed
  here and checked for drift on every pull request. A floating version lets two contributors
  emit different bytes from the same source, and that noise surfaces in an unrelated pull
  request rather than in the one that caused it.
- *A CI verdict that reflects the change under review.* All four run in a CI step:
  `typecheck`, `test`, `build`. Under a range, a version published that morning can turn a
  pull request that touched only markdown red, with nothing in its diff to explain why.

The bundler is the one package carrying both reasons, so it stays exact even if the second
reason is ever dropped. Bump a pin deliberately rather than loosening it: edit the version in
`package.json`, run `npm install`, then `npm run build`, `npm test` and `npm run typecheck`,
and commit the rebuilt `dist/` together with the bump, so the upgrade arrives as one
reviewable change instead of a surprise inside someone else's.

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
