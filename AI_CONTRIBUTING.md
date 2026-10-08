# Contributing here with an agent

This is the entry point for a coding agent that has been asked to contribute to this
repository, often on behalf of someone who will not read the code. It says what to read and
in which order, what you may touch at each level of experience with this codebase, and how
to tell that the work is done.

It does not restate the repository's rules. Each rule lives in one file, and this guide links
to that file. If this guide and the file it links to disagree, the linked file wins and this
guide is the bug: say so in your pull request.

## 1. Read these first, in this order

1. [CLAUDE.md](CLAUDE.md), all of it. The layout, the conventions and the invariants a
   reviewer holds every change to are there or linked from there.
2. [CONTRIBUTING.md](CONTRIBUTING.md#development-setup), "Development setup" and "Pull
   requests". The setup commands, why the dependency versions are exact, and the commit
   message format live there.
3. [SECURITY.md](SECURITY.md), only the sections your change comes near. It is the promise
   the product makes to the people who install it, section by section.

   | If your change touches | Read |
   |---|---|
   | a hook, or what is captured from a session | [What it reads](SECURITY.md#what-it-reads) |
   | any file the plugin writes | [What it writes, and where](SECURITY.md#what-it-writes-and-where) |
   | the harvest, a model call, a push or a merge request | [What leaves your machine](SECURITY.md#what-leaves-your-machine) |
   | `/handbook:mine` or the drafts it writes | [What `/handbook:mine` reads and sends](SECURITY.md#what-handbookmine-reads-and-sends) |
   | how the `claude -p` child is started | [The model call](SECURITY.md#the-model-call) |
   | `/handbook:join`, or anything read from a team repository | [A team repository you joined](SECURITY.md#a-team-repository-you-joined) |
   | how a session is recognized as repeated work | [Recognizing a workflow in a session](SECURITY.md#recognizing-a-workflow-in-a-session) |
   | the skill health report or the share screen's overlap warning | [Skill health](SECURITY.md#skill-health) |
   | a new file or directory the plugin keeps | [Removing your data](SECURITY.md#removing-your-data) |

4. [evals/README.md](evals/README.md#two-halves-and-why), "Two halves, and why", but only if
   you will touch `evals/`, a `commands/*.md` frontmatter or a `skills/*/SKILL.md`
   frontmatter. It explains why one half of the suite must stay unread.
5. Section 4 of this file, to pick the step your task belongs to before you change anything.

## 2. Architecture in one screen

[CLAUDE.md, Layout](CLAUDE.md#layout) says what each directory holds. What it does not draw
is how data moves between them:

```
session  hooks/hooks.json -> dist/<hook>.js -> src/hooks/*
           post-tool-use, user-prompt-submit -> lib/capture -> session state (local)
           stop -> lib/signals -> signals.jsonl (local)
           session-end -> lib/pipeline queues a job, spawns dist/run-pipeline.js detached
             -> lib/harvest: lib/transcript slice, redacted line by line
             -> one `claude -p` through lib/score -> parse, sieve -> lib/queue (pending)
history  /handbook:mine -> lib/mine (git log) -> lib/draft -> lib/queue (pending)
review   /handbook:review -> lib/deliver -> a personal or project skills directory,
           or for the team: lib/publish -> lib/branch (git push) -> lib/forge (merge request)
share    /handbook:share -> lib/share (the pick is the approval) -> lib/publish
           -> lib/branch -> lib/forge
```

Every arrow that ends outside `~/.teamhandbook/` passes one of the modules below. They are
the main trust boundaries, and the promise each one keeps lives in the file on the right.
The table explains them; the complete list, which the ladder uses, is computed by a
command in Step 2, so it stays right as modules are added.

| Module (`src/lib/`) | What it guards | The promise lives in |
|---|---|---|
| `secrets.ts`, `secret-corpus.ts` | secret detection, used at every place something is persisted, and the lines it is measured against | [CLAUDE.md, invariants](CLAUDE.md#non-negotiable-invariants-dont-regress-these) |
| `identity.ts` | finding and masking this machine's user name and home path in text that leaves | [What leaves your machine](SECURITY.md#what-leaves-your-machine) |
| `config.ts` | reading the switches that keep sending off; a config file that cannot be parsed counts as off | [What leaves your machine](SECURITY.md#what-leaves-your-machine) |
| `capture.ts`, `signals.ts` | what the hooks persist; a secret-bearing occurrence is dropped, signals are sanitized before `signals.jsonl` | [What it reads](SECURITY.md#what-it-reads), [What it writes](SECURITY.md#what-it-writes-and-where) |
| `transcript.ts` | the session slice, redacted line by line before it enters the harvest prompt | [CLAUDE.md, invariants](CLAUDE.md#non-negotiable-invariants-dont-regress-these) |
| `queue.ts` | the secret and identity audit of a skill directory | [What it writes](SECURITY.md#what-it-writes-and-where) |
| `prompt-safety.ts` | `fenceUntrusted`, the fence around untrusted session text in every prompt | [CLAUDE.md, invariants](CLAUDE.md#non-negotiable-invariants-dont-regress-these) |
| `score.ts` | the isolated `claude -p` child: its flags and its environment allow-list | [The model call](SECURITY.md#the-model-call) |
| `harvest.ts` | the harvest prompt, and dropping a reply it cannot parse | [CLAUDE.md, conventions](CLAUDE.md#conventions) |
| `deliver.ts`, `publish.ts`, `branch.ts`, `forge.ts`, `init.ts` | approval before delivery, every push, every merge request | [What leaves your machine](SECURITY.md#what-leaves-your-machine) |
| `share.ts` | the pick screen, which is the act of consent for sharing | [CLAUDE.md, invariants](CLAUDE.md#non-negotiable-invariants-dont-regress-these) |
| `mcp.ts`, `commands.ts` | refusing an MCP server or a slash command that carries a credential before it is shared | [What leaves your machine](SECURITY.md#what-leaves-your-machine) |
| `mine.ts`, `mine-command.ts` | what `/handbook:mine` reads from git history and puts in its model call | [What `/handbook:mine` reads and sends](SECURITY.md#what-handbookmine-reads-and-sends) |
| `session-workflow.ts` | what is recorded when a session looks like repeated work | [Recognizing a workflow in a session](SECURITY.md#recognizing-a-workflow-in-a-session) |
| `join.ts` | the values read out of a team repository someone else controls | [A team repository you joined](SECURITY.md#a-team-repository-you-joined) |
| `gate.ts` | the legacy recurrence threshold no automatic path reaches | [CLAUDE.md, invariants](CLAUDE.md#non-negotiable-invariants-dont-regress-these) |
| `corrections.ts`, `teachings.ts` | non-English phrases kept as detector data | [CLAUDE.md, conventions](CLAUDE.md#conventions) |

Why `dist/` is committed is in [CLAUDE.md, Layout](CLAUDE.md#layout), and when to rebuild
it in [CLAUDE.md, Conventions](CLAUDE.md#conventions). One consequence is not written down
elsewhere: some tests run the built bundles rather than the source. `src/lib/branch.test.ts`
runs `dist/share.js` and `src/lib/mine.test.ts` runs `dist/mine.js`, so build before you
test, or those tests exercise the old code.

## 3. Setup and the commands that prove it

You need Node 22 or newer ([package.json](package.json) `engines`; CI runs 22) and a git
identity (below). Then run the commands from
[CONTRIBUTING.md, Development setup](CONTRIBUTING.md#development-setup), in that order.

Measured on a fresh `git clone` on one 14-core arm64 machine with Node 26 and npm 11, while
unrelated work held the load average between 11 and 18. Your times will differ; the last
lines should not.

| Command | Took | What to look for |
|---|---|---|
| `npm install` | 8 s, empty npm cache | `added 55 packages, and audited 56 packages in 8s`, then an audit summary (`4 vulnerabilities (2 moderate, 2 critical)`) that you leave alone, see section 7 |
| `npm run build` | under 1 s | `built 16 hook bundle(s) to dist/`; afterwards `git status --porcelain` prints nothing |
| `npm run typecheck` | 2 s | only the `> tsc --noEmit` header, exit code 0 |
| `npm test` | about 110 s | `Test Files  54 passed (54)` and `Tests  2484 passed (2484)`. Both counts grow with every pull request, so read them as about 54 and about 2,500 |

npm 11 also warns that `esbuild` has an install script not covered by `allowScripts`. The
build above ran with that warning in place, so there is nothing to approve.

**Git identity.** `git config user.name` and `git config user.email` must both print
something. Several tests drive a real git remote, and the code under test refuses to commit
without an author, which is why CI sets one
([ci.yml](.github/workflows/ci.yml), "Give git an identity for the tests"). Measured with
no identity configured:

```
 Test Files  6 failed | 48 passed (54)
      Tests  102 failed | 2382 passed (2484)
```

The failures are in `branch.test.ts`, `deliver.test.ts`, `init.test.ts`, `join.test.ts`,
`publish.test.ts` and `share.test.ts`, and each one carries
`git user.name/user.email is not set`.

## 4. The contribution ladder

Pick the lowest step your task fits. If the task needs a file from a higher step, it is a
higher-step task: say so to your human before you start, not in the pull request.

An issue labelled `good first agent task` names its step, and the maintainer chose that
step with the diff in view, sometimes below what the file rules here would say (an opening
paragraph of a command's instructions, one regular expression in a boundary module). Take
the issue's step over your own reading of this section. If the work grows past what the
issue describes, stop and tell your human before you continue.

Every tracked file sits in exactly one of Step 1, Step 2, Step 3 or "Outside the ladder":
the lowest step allowed to change it. A higher step may change it too, and Step 2 names the
parts of a file that need Step 3. The rules in section 8 apply at every step.

### Step 1: documentation and new eval cases

- **Work:** prose fixes, clearer explanations, a new routing case for the open half of the
  eval suite, an issue template.
- **Safe zone:**
  - `README.md`, `CONTRIBUTING.md`, `AI_CONTRIBUTING.md`
  - `SECURITY.md`, wording only: what it promises does not change at this step
  - `docs/examples/README.md`
  - `.github/ISSUE_TEMPLATE/*.md`
  - `evals/gelistirme/<new-case>/`, a new directory only. Changing an existing case is
    Step 2.
- **Do not touch:** `src/`, `dist/`, `commands/*.md` (the frontmatter is routing text and
  the body is the instructions the command runs, see Step 2 and 3), `skills/`, every other
  directory under `evals/`.
- **Verify:**
  - `npm test` still passes. It is not a formality here: `src/lib/plugin-manifest.test.ts`
    reads `README.md`, and fails if its command table stops listing exactly the commands
    the plugin ships or a diagram's description stops matching the diagram.
  - For a new eval case, two checks that cost nothing. Its frontmatter carries exactly the
    keys every case in `evals/gelistirme/` carries, `allowed_tools description
    expected_outcome max_turns tags timeout_seconds`:

    ```
    awk '/^---$/{n++; next} n==1 && /^[a-z_]+:/{sub(/:.*/,""); print}' \
      evals/gelistirme/<new-case>/prompt.md | sort | tr '\n' ' '
    ```

    and its grader pattern matches the command it expects and not a neighbour:

    ```
    python3 - evals/gelistirme/<new-case>/graders/<grader>.md <<'PY'
    import re, sys
    pattern = re.search(r"^input_match: '(.*)'$", open(sys.argv[1]).read(), re.M).group(1)
    print(bool(re.search(pattern, '{"skill": "handbook:leave"}')),
          bool(re.search(pattern, '{"skill": "handbook:share"}')))
    PY
    ```

    That prints `True False` for a case that expects `/handbook:leave`; put your own
    command in the first string and a neighbour in the second. Tag the case `nl-gelistirme`
    (must route) or `fp-gelistirme` (must fire nothing), never a tag of the held-out half.
  - Then, if your human agrees to spend well under a dollar, run the one case once. It needs
    the `claude` CLI signed in, and `--trust-plugin` answers the first-run prompt that would
    otherwise wait forever in a non-interactive shell. Run it from a fresh clone of your
    committed branch, not from the checkout you work in (section 7 says why), and come back
    to your own checkout when it finishes: the clone has no `master`, so the checks in
    section 6 do not work there.

    ```
    git clone <your checkout> <empty directory> && cd <empty directory>
    evals/run-suite.sh nl-gelistirme --case <new-case> --runs 1 \
      --model claude-sonnet-5 --max-cost-usd 1 --trust-plugin
    ```

    Two runs of this command on an existing case cost $0.08 in 15 s and $0.31 in 118 s;
    `--max-cost-usd 1` stops it at a dollar. The first ended in

    ```
      score (valid runs only) : 1.0000
      valid runs              : 1/1
      invalid runs            : 0/1 = 0.0%
      cost / duration         : $0.08 / 15s

      valid: the invalid-run rate is within the limit.
    ```

    One run is not a measurement of the case, only proof that it loads and is graded.
    [evals/README.md](evals/README.md) says how a number is read.
- **In the pull request:** what was unclear before; for an eval case, the sentence's
  intent, the two check outputs and the run output if you ran it.

### Step 2: a small change outside the trust boundaries

- **Work:** a bug fix or a small behaviour change in a module or entrypoint that is not a
  trust boundary, with its test, or in a command's instructions.
- **Safe zone:**
  - a `src/lib/*.ts` module or `src/cli/*.ts` entrypoint the command below does not list,
    and the `*.test.ts` beside it
  - `dist/`, only as `npm run build` writes it
  - `commands/*.md` and `skills/*/SKILL.md` below the frontmatter, except
    `commands/review.md` and `commands/share.md`
  - an existing case under `evals/gelistirme/`
- **Do not touch:** the files the command below lists, `src/hooks/`, the frontmatter of
  any `commands/*.md` or `skills/*/SKILL.md`, `commands/review.md` and
  `commands/share.md`, and anything else under `src/` that is neither a module, an
  entrypoint nor the test beside one. Each of those is Step 3. The command lists the
  boundaries: nine modules by name, every `src/lib/` module that imports one of them, and
  every `src/cli/` entrypoint that imports any of those:

  ```
  named='secrets|identity|prompt-safety|branch|forge|publish|config|teachings|secret-corpus'
  lib=$(git grep -lE "from \"\./($named)\.js\"" -- 'src/lib/*.ts' ':!*.test.ts' | sed 's#src/lib/##; s#\.ts$##' | paste -sd'|' -)
  echo "$named|$lib" | tr '|' '\n' | sed 's#.*#src/lib/&.ts#' | sort -u
  git grep -lE "from \"\.\./lib/($named|$lib)\.js\"" -- 'src/cli/*.ts'
  ```

  Three of the nine import none of the others and still guard something: `config.ts` reads
  the switches that keep sending off, `teachings.ts` holds detector phrases as data, and
  `secret-corpus.ts` is what the secret detector is measured against. The command looks one
  import deep, so a file outside its list is still Step 3 if your change would break a
  promise in SECURITY.md; [CLAUDE.md](CLAUDE.md#where-to-look-before-you-change-something)
  says what that change then owes.
- **Verify:** for a module or an entrypoint, the test you wrote first fails before your
  change and passes after it, and the rebuild rule in
  [CLAUDE.md, Conventions](CLAUDE.md#conventions) holds, `src/lib/` included. For a change
  only to a markdown body or an existing eval case, Step 1's verification instead. Then the
  definition of done in section 6.
- **In the pull request:** the behaviour before and after, and for code the test that pins
  it.

### Step 3: a feature, or anything at a trust boundary

- **Work:** a new command or flag; any change to a file Step 2's command lists, to
  `src/hooks/`, to a command's or skill's frontmatter, or to `commands/review.md` and
  `commands/share.md`, whose bodies carry the approval dialog.
- **Before you start:** open an issue or link one, and wait for the maintainer to agree to
  the shape. The [feature request template](.github/ISSUE_TEMPLATE/feature_request.md) asks
  what the change has to handle.
- **What comes with it:**
  - SECURITY.md, under the rule in
    [CLAUDE.md, Where to look](CLAUDE.md#where-to-look-before-you-change-something):
    "A change that breaks one edits it too."
  - A new command needs a `commands/<name>.md` for its `src/cli/<name>.ts` and a row in the
    README's command table; `src/lib/plugin-manifest.test.ts` fails without either.
  - A changed `description:` line: "the number is stale until it is rerun"
    ([CLAUDE.md, Where to look](CLAUDE.md#where-to-look-before-you-change-something)). You
    do not run the held-out suite, and cannot without reading it. Say in the pull request
    that the routing suite needs a rerun, and the maintainer runs it.
- **Verify:** the rebuild rule in [CLAUDE.md, Conventions](CLAUDE.md#conventions);
  everything in section 6, plus the boundary module's own tests.
- **In the pull request:** for a capture, gate or secret change, the failure case it
  prevents, as the [pull request template](.github/pull_request_template.md) asks.

### Outside the ladder

Every tracked file the three steps do not name is changed only by the maintainer. That
includes `CLAUDE.md`, `AGENTS.md`, `CODE_OF_CONDUCT.md`, `.gitignore`,
`.github/pull_request_template.md`, `.github/workflows/`, `hooks/hooks.json`,
`.claude-plugin/`, `package.json` (the pins and the version), `scripts/build.mjs`,
`vitest.config.ts`, `tsconfig.json`, `CHANGELOG.md` (its newest entry is a released version,
not an Unreleased section), `LICENSE`, `NOTICE`, `demo/`, `docs/examples/*/SKILL.md`,
`docs/*.svg`, `evals/README.md`, `evals/run-suite.sh`, `evals/kontrol/`, `evals/hasat/`,
`evals/enjeksiyon/`, and `evals/tutma/`, which nobody else opens either.

## 5. The flow

1. Branch off `master` ([CONTRIBUTING.md](CONTRIBUTING.md#pull-requests)).
2. Step 2 and 3: write or extend the test first, in the style
   [CONTRIBUTING.md, Ground rules](CONTRIBUTING.md#ground-rules) asks for, and watch it
   fail.
3. Make the change.
4. If anything under `src/` changed: the rebuild rule in
   [CLAUDE.md, Conventions](CLAUDE.md#conventions).
5. `npm test`, then `npm run typecheck`.
6. Commit. The format is in [CONTRIBUTING.md](CONTRIBUTING.md#pull-requests). An example
   from this repository's history: `Nothing proved that a path into someone's home
   directory keeps a recognized session off disk`.
7. Pushing to your fork and opening the pull request are your human's decisions: ask before
   either. Fill in the [template](.github/pull_request_template.md), including its optional
   block at the end if you can.
8. Merging is the maintainer's. Until a contributor has a commit merged here, CI on their
   pull requests from a fork waits for a maintainer to approve each run (the repository's
   Actions policy is `first_time_contributors`), so no checks at first is expected, not a
   failure.

## 6. Definition of done

Run these from your own checkout, not from the clone Step 1 uses for the eval run.

- [ ] `npm run build`, then `git status --porcelain -- dist/` prints nothing.
- [ ] `npm test` ends with `Test Files  N passed (N)` and `Tests  N passed (N)`, with no
      `failed` anywhere in the summary. A non-zero exit whose only errors are
      `Timeout calling "onTaskUpdate"` means re-run (section 7); any other unhandled error
      is a failure.
- [ ] `npm run typecheck` exits 0.
- [ ] `git diff --stat master...HEAD` lists only files your step allows.
- [ ] `git diff --name-only master...HEAD -- evals/tutma` prints nothing.
- [ ] `git diff master...HEAD | grep -E '^\+.*(/Users|/home)/'` prints nothing, and no
      added line carries what [CLAUDE.md, Conventions](CLAUDE.md#conventions) keeps out of
      a commit, or what section 8 adds to that list.
- [ ] The commit message follows [CONTRIBUTING.md](CONTRIBUTING.md#pull-requests).
- [ ] The SECURITY.md rule in
      [CLAUDE.md, Where to look](CLAUDE.md#where-to-look-before-you-change-something)
      holds for your diff.
- [ ] If a `description:` line changed, the pull request says the routing suite needs a
      rerun.

## 7. Common mistakes

The first seven were reproduced on a fresh clone before they were written down. The last
group is the opposite case: nothing turns red, and that is the trap.

**Every test passed and `npm test` still exited 1.**
- Symptom: `Errors  5 errors`, each `Error: [vitest-worker]: Timeout calling "onTaskUpdate"`,
  under a summary in which every test passed.
- Cause: vitest's own worker messages timing out while the machine is busy. It is not a
  test. It appeared in two of four full runs at a load average between 11 and 18.
- Do: run `npm test` again when the machine is quieter. Fewer workers,
  `npx vitest run --maxWorkers=4`, cleared it in one of two busy runs and not in the other.

**`--maxWorkers` fails before a single test runs.**
- Symptom: `RangeError: options.minThreads and options.maxThreads must not conflict`.
- Cause: `node_modules` holds a vitest other than the version `package.json` pins.
  Reproduced with 2.1.9 against the 3.2.7 pin, under which a plain `npm test` still passed,
  so a green run does not prove the install is current.
- Do: compare `npx vitest --version` with `package.json`, then `npm install`. No lockfile
  is committed ([CONTRIBUTING.md](CONTRIBUTING.md#development-setup)), and that one command
  replaced 2.1.9 with 3.2.7.

**102 tests fail in six files at once.**
- Symptom: `Tests  102 failed | 2382 passed`, each failure carrying
  `git user.name/user.email is not set`.
- Cause: no git identity (section 3).
- Do: `git config --global user.name "Your Name"` and
  `git config --global user.email you@example.com`, which is what CI does.

**CI fails on "dist/ matches src/".**
- Symptom: `dist/ is out of date with src/:` followed by the bundles that differ.
- Cause: something under `src/` changed and the rebuilt bundles were not committed. A
  change only under `src/lib/` counts: a one-line edit to `src/lib/status.ts` changed
  `dist/doctor.js` and `dist/status.js`.
- Do: run `npm run build` after every `src/` edit and let `git status --porcelain -- dist/`
  decide rather than a guess: a comment-only edit to the same file left `dist/` unchanged.
  Commit whatever it lists, as the rebuild rule in
  [CLAUDE.md, Conventions](CLAUDE.md#conventions) says.

**`npm install` suggests `npm audit fix --force`.**
- Symptom: `4 vulnerabilities (2 moderate, 2 critical)` and the suggestion to run it.
- Cause: the advisories are in the development toolchain, and the fix is a major-version
  jump. Run in a throwaway clone, it rewrote `"vitest": "3.2.7"` to `"^5.0.3"` and
  `"esbuild": "0.23.1"` to `"^0.28.2"`, and the next build rewrote almost every bundle in
  `dist/` (14 of 16).
- Do: leave it. Why the pins are exact and how one is bumped deliberately is in
  [CONTRIBUTING.md](CONTRIBUTING.md#development-setup).

**The test file count doubled.**
- Symptom: vitest collects twice as many test files as `git ls-files '*.test.ts'` lists
  (108 instead of 54), and `git status` shows an untracked `.claude/`.
- Cause: a Claude Code worktree under `.claude/worktrees/` inside the repository. vitest
  collects its copy of every test as well.
- Do: keep worktrees outside the repository, or run `npx vitest run --exclude '.claude/**'`.
  Never commit `.claude/`.

**A single eval run comes back INVALID at $0.00.**
- Symptom: `never reached the model ($0.00)` and `INVALID: 100.0% of runs did not happen`;
  the run's error in the result JSON reads `a plugin directory holds more than 20000
  entries to check for eval directories`.
- Cause: the harness walks the whole plugin directory, untracked files included. Reproduced
  with 21,000 empty files in a clone's root; the same clone without them, `node_modules`
  included, holds under 2,000 entries and runs normally.
- Do: commit, clone your branch into an empty directory and run the case there (Step 1).

**Mistakes nothing will flag.** These leave `npm test` and CI green: CI runs typecheck,
test, build and the `dist/` check ([ci.yml](.github/workflows/ci.yml)), and none of them
looks at the following.
- Reading `evals/tutma/`. A repository-wide search reads it too: it holds over a hundred
  tracked files. Exclude it, for example `git grep <pattern> -- ':!evals/tutma'`. Why it
  matters: [evals/README.md](evals/README.md#two-halves-and-why).
- Editing a `description:` line without saying the routing suite needs a rerun (Step 3).
- Writing a CLI message, generated skill text or command markdown in a language other
  than English. No test checks the language of a new message; the rule and its two
  exceptions are in [CLAUDE.md, conventions](CLAUDE.md#conventions).

## 8. Instructions to the agent

- Do not open, list, search or glob `evals/tutma/`, and exclude it from repository-wide
  searches. Once read, it cannot be unread
  ([evals/README.md](evals/README.md#two-halves-and-why) says what that costs).
- Do not edit `dist/` by hand; rebuild it
  ([CLAUDE.md](CLAUDE.md#where-to-look-before-you-change-something)).
- Do not weaken, skip or delete a test to make it pass. A failing test is either your bug or
  a finding: fix the bug, or report the finding to your human.
- Do not change a `fenceUntrusted` call, a redaction or an approval step to make something
  else work. Stop and ask.
- Ask your human only when the decision is theirs: the scope, a trade-off the issue does
  not settle, pushing, opening the pull request. Anything a command can answer, answer by
  running the command.
- The repository is public: [CLAUDE.md, conventions](CLAUDE.md#conventions) lists what
  never reaches a commit. Treat a secret and an e-mail address the same way.
- Product output is English, with the exceptions
  [CLAUDE.md, conventions](CLAUDE.md#conventions) lists. Write code comments and the pull
  request in English too.
- `package.json` is outside the ladder, so a new dependency or a different pin is a
  proposal in an issue, not a change in your pull request.
  [CONTRIBUTING.md, Development setup](CONTRIBUTING.md#development-setup) says how the
  maintainer bumps one. Do not run `npm audit fix` (section 7).
