# Tests and the lab

## Tests

```sh
npm test                                                   # server and seed (vitest)
ORCHESTRATOR_TEST_DATABASE_URL=postgres://... npm test          # the store contract and the tenant lock on Postgres too
ORCHESTRATOR_TEST_DOCKER=1 npm test                             # container isolation on a real Docker daemon
npm run e2e                                                # browser (Playwright), against an orchestrator it starts itself
ORCHESTRATOR_E2E_BASE_URL=http://127.0.0.1:8080 npm run e2e     # against a running stack
```

The browser suite signs in for real. It creates the first owner with
`ORCHESTRATOR_E2E_SETUP_TOKEN`, then one account per role, so a stack it runs against has to
start empty, in `local` mode, with the same `ORCHESTRATOR_SETUP_TOKEN`. The GitLab and GitHub
providers are tested only against a fake HTTP server that records every request. The orchestrator
the suite starts offers the stand-in agent and Claude Code, with `ORCHESTRATOR_CLAUDE_BIN` naming
`browser-tests/stand-in-claude.sh`: a script that answers only the readiness questions, as an
old CLI with no sign-in, and runs no task. No real agent CLI is started, and the model
credential variables are emptied for that orchestrator.

Every main screen is checked by axe-core against WCAG 2.1 A and AA and axe's best practices,
in the light and the dark theme, and at 390 pixels wide for a page that scrolls sideways
(`accessibility.spec.ts`). `states.spec.ts` covers the keyboard, refusals tied to their
fields, and what each screen says when there is nothing to show or the orchestrator does not
answer.

| Variable | Default | Meaning |
|---|---|---|
| `ORCHESTRATOR_TEST_DATABASE_URL` | none | A Postgres the contract and tenant lock suites create and drop a database in, per test |
| `ORCHESTRATOR_E2E_BASE_URL` | none | A running orchestrator to test, instead of one the suite starts |
| `ORCHESTRATOR_E2E_PORT` | `18181` | The port of the orchestrator the suite starts |
| `ORCHESTRATOR_E2E_SETUP_TOKEN` | `e2e-setup-code-0001` | The setup code the suite creates its admin with |
| `ORCHESTRATOR_E2E_SCREENSHOTS` | none | `1` writes the README's pictures |
| `ORCHESTRATOR_E2E_LOCAL_HOME` | the suite's scratch home | The home the local-mode suite's orchestrator runs in, for its picture |
| `ORCHESTRATOR_DESIGN_AUDIT` | none | A directory each screen's design audit findings are written to |

`ORCHESTRATOR_E2E_SCRATCH` and `ORCHESTRATOR_E2E_STATE_DIR` are set by the suite itself, so that its
workers share one scratch directory and one set of signed-in browsers.

The README's pictures come from the same suite, run against a fresh demo container, so that
every path on screen is the container's own:

```sh
docker run -d --rm -e ORCHESTRATOR_DEMO=1 -e ORCHESTRATOR_SETUP_TOKEN=e2e-setup-code-0001 \
  -e ORCHESTRATOR_PUBLIC_URL=http://127.0.0.1:18291 -p 127.0.0.1:18291:8080 orchestrator-orchestrator
ORCHESTRATOR_E2E_BASE_URL=http://127.0.0.1:18291 ORCHESTRATOR_E2E_SCREENSHOTS=1 npx playwright test browser-tests/screenshots.spec.ts
```

That step refuses to write a picture that shows the home directory, temp directory or
account name of the machine taking it.

The local-mode picture comes from a suite of its own, which starts an orchestrator with nothing
configured, in a home of its own, and follows the one-time link it opens. The picture is taken in a
stand-in home of made-up folders, outside the temp folder, since the suite's scratch home would show
the temp folder's path and the picture refuses that:

```sh
ORCHESTRATOR_E2E_SCREENSHOTS=1 ORCHESTRATOR_E2E_LOCAL_HOME=<a stand-in home> npm run test:e2e:local
```

The stand-in home has to start empty of orchestrator data each time, as a first start does.

### The design audit

`browser-tests/design-audit.spec.ts` holds the folder picker, a finished task's page and the task
list to the design tokens, in both themes at 1440 and 390 pixels. It reads what the browser drew:
every text's font, size, weight and colour, every background, border colour, radius and shadow,
and the contrast of each text on what is painted behind it (4.5 to 1, large text too). The tokens
are read from the page's own `:root` rules, so a change of scale needs no change to the audit, and a
colour is compared as the pixel it paints, so hex, `rgb()` and `oklch()` tokens meet on the same
terms. A raw value that happens to equal a token's (`8px` for `--radius`) is invisible here; the
static check catches those: `web/src/design/tokens.test.ts` fails on a raw colour, radius, shadow or
font size in any stylesheet but `tokens.css` and in any component's inline `style`, and
`.github/workflows/orchestrator-design-tokens.yml` runs it on every pull request that touches `orchestrator/web/`. Nothing sticking out is checked with the layout
suite's own `overflows()`. One test plants an element off the tokens and requires the audit to name
each of its values. The audit runs with the rest of the suite; `ORCHESTRATOR_DESIGN_AUDIT` also keeps
each screen's findings as a file, for a list to work through:

```sh
ORCHESTRATOR_DESIGN_AUDIT=/tmp/design-audit npx playwright test browser-tests/design-audit.spec.ts
```

### Screen pictures

`browser-tests/design-baseline.spec.ts` holds each screen the design critic has passed in the chosen
direction to a picture of it, in both themes: the task page at 1440 and 390 pixels. A
screen joins once it scores 8 of 8 and draws in one go, so two shots in a row agree. What moves with the
clock or the run is masked: start times, durations and the request number. The pictures are taken on macOS, where the
suite runs. After a deliberate change to a screen:

```sh
npx playwright test browser-tests/design-baseline.spec.ts --update-snapshots
```

and the new pictures are reviewed in the request that changes the screen.

### The old name

The product was renamed with no alias kept, so `server/old-name.test.ts` fails on any tracked path
or line under `orchestrator/` that still carries the old name, other than JavaScript's runtime logging object.
A file or line that names the old word on purpose (a guard that turns an old setting away, a shipped
migration's function) is listed with its reason in `server/old-name.exceptions.json`, and a listed
entry that no longer matches fails too. `.github/workflows/orchestrator-old-name.yml` runs it on
every pull request that touches `orchestrator/`.

### The context budget

`server/tasks/context-budget.test.ts` measures the bytes the orchestrator's own wording puts in
front of an agent: the planning and skill-suggestion prompts with the smallest inputs they take,
and the tool list its MCP server offers. The sizes are kept in `server/tasks/context-budget.json`
and the test fails when the code and the file disagree. After a change to that wording, record
the new sizes with

```sh
UPDATE_CONTEXT_BUDGET=1 npx vitest run server/tasks/context-budget.test.ts
```

and commit the file with the change. On a pull request, `.github/workflows/agent-context-budget.yml`
compares it with the base branch: a size that grew, or a new one, passes only with the
`context-increase` label; one that shrank passes as it is.

### Agent transcripts

`server/tasks/transcripts/` holds runs of the agent CLIs as NDJSON: the CLI version, the flags
and prompt text the run was started with, every line it printed and its exit code.
`transcript.test.ts` plays each one back through the real adapter: `replayProgram` stands in
for the CLI, refuses a start that lacks what the transcript expects, and prints the recorded
lines. A transcript whose CLI version is not the one the adapter was checked against fails,
so an adapter change and its transcripts move together.

The committed transcripts marked `"source":"hand"` are written from the CLIs' documented
output. A recorded one comes from the real CLI, by hand and never in CI, with your own model
credential and the cost of one short task:

```sh
ORCHESTRATOR_RECORD_AGENT=claude-code npx vitest run server/tasks/transcript.record.test.ts
ORCHESTRATOR_RECORD_AGENT=opencode npx vitest run server/tasks/transcript.record.test.ts
```

Besides the lines it prints, a transcript can take steps the replay performs in order: `stdin`,
the client's next line in a two-way run, which has to parse to the recorded value (the replay
fails after `ORCHESTRATOR_REPLAY_TIMEOUT_MS`, 10 seconds by default, when it never comes); `write`
and `remove` a file inside the checkout; `wait` some milliseconds; or `until` a file exists. The stand-in adapter runs `replayProgram` as its script, so a task test describes
its agent as a transcript; one that needs the agent still running holds it with `until` and
releases it by writing the file, rather than waiting on a clock.

A transcript keeps only the fields the adapters read of a line, and is not written when it
still names the home or temp directory, the account name or the credential the run had, or
holds what looks like a secret.

### Evals

`evals/` asks a real model what it makes of the orchestrator's prompts, by hand and never in
CI; `npm run evals` without `EVAL_LIVE=1` only checks the cases. See
[evals/README.md](../../evals/README.md).

## The lab

The lab runs the orchestrator the way a company would: four organizations, each with its own
orchestrator, its teams' repositories on different forges, and teammates' machines running the
plugin. Every name in it is a stand-in, and nothing in it reaches a real forge or a real agent.

```sh
cd orchestrator
npm ci
npm run lab        # builds the orchestrator, then starts everything
npm run lab:test   # the end-to-end suite against it (Playwright)
npm run lab:down   # stops every process, removes the container with its volume, and deletes the lab directory
```

| Organization | Orchestrator | Store | Forge | Team repositories |
|---|---|---|---|---|
| acme | `127.0.0.1:18410` | SQLite | the orchestrator's local forge | payments (versioned 0.1.5, prefix `PAY`), platform (versioned by commit), mobile (branch rule `feature/MOB-123-...`, prefix `MOB`), bulk (2000 skills), billing (versioned 0.4.2, kept for the switch to versioning by commit) |
| globex | `127.0.0.1:18411` | Postgres, shared, in docker | a stand-in GitLab | data (versioned 0.3.0), infra (prefix and branch rule, a reviewer the forge does not know, an MCP server with a referenced credential) |
| initech | `127.0.0.1:18412` | SQLite | a stand-in GitHub | web (versioned by commit, keyed branch rule `WEB-42-...`), support (versioned 2.0.1, no `memberUrl`) |
| vandelay | `127.0.0.1:18413` | SQLite | the stand-in GitLab | the shape of a company's own repository: imports on `master`, versioned 0.1.x, a ticket key (`VAN-7`) as the commit prefix and in the branch example, nine reviewers, two MCP servers that sign in through a browser; exports, versioned by commit; release, with the version-bump CI job |

- **Repositories** are laid out by the plugin's own scaffold, then filled with skills, commands
  and MCP servers one commit each.
- **The stand-in GitLab and GitHub** (`lab/forge.ts`) answer the REST calls the orchestrator's
  providers make, and the merge a person makes on the forge. Each call works on a real bare
  repository through git plumbing. The same server serves those repositories over git's HTTP
  protocol, read-only. The orchestrator's mirror, a teammate's join and doctor, and a teammate's
  marketplace copy all clone that one address.
- **Each organization's people:** an admin, an owner per team and a member. globex also signs
  in through a stand-in OpenID Connect provider (`lab/idp.ts`, on `LAB_PORT_BASE` +4). Its page
  lists the lab's single sign-on people to pick from, each with their groups; one of them has an
  address the provider did not verify, one an address a password account holds. They sign in with
  the password `npm run lab` prints; `lab/lab.sh status` lists them.
- **Each organization has three teammates** with a home of their own. On each one, the
  plugin's `dist/` bundles run under node: join and doctor directly, and the hooks the way
  Claude Code runs a plugin's: every command `hooks/hooks.json` registers for the event and the
  tool, with `CLAUDE_PLUGIN_ROOT` set. Claude Code's
  `/plugin marketplace add` and `update` are the git clone and pull it makes. One teammate
  agrees to report skill use, one declines, and one has not answered.
  `lab/lab.sh dev <org> <teammate> doctor|update|session|use <plugin:skill>|agree|decline`
  drives one machine by hand.

Everything the lab starts gets an environment built from nothing, never a copy of yours:

- **PATH** holds git, node and a stand-in `claude` that answers only its version and logs every
  call. gh, glab and opencode are absent, and `npm run lab` stops if any of them would resolve
  to a real program.
- **Orchestrators** run with `ORCHESTRATOR_AGENTS=fake` and empty model credentials. vandelay's also
  offers `claude-code`, with `ORCHESTRATOR_CLAUDE_BIN` naming the lab's stand-in claude, which
  runs nothing.
- **Teammates' hooks** run with a fake HOME and the harvest off, so your own `~/.claude` and
  `~/.teamhandbook` are never read.

| Variable | Default | Meaning |
|---|---|---|
| `LAB_DIR` | `teamhandbook-orchestrator-lab` under the system's temp directory | Where everything the lab makes lives: repositories, data directories, homes, logs, the suite's report. `npm run lab:down` deletes it, and only when it carries the lab's marker file |
| `LAB_PORT_BASE` | `18400` | GitLab at +1, GitHub at +2, Postgres at +3, orchestrators from +10, and two ports after the last orchestrator for the second tenants the suite starts. A taken port stops the start, and so does a range that reaches 8000-8099, `ORCHESTRATOR_HOST_PORT` or 18181, where the demo and the browser suite listen |
| `LAB_EXTRA_ORGS` | none | A JSON file of further organizations; see below |

**One browser profile holds every organization.** A browser sends a cookie to every port of a
host, so each orchestrator names its session cookie after its tenant: signing in to a second
organization on `127.0.0.1` leaves the first one signed in. Another organization's orchestrator
never accepts that cookie; the suite checks it.

**Adding an organization of your own.** `LAB_EXTRA_ORGS` names a file outside the repository
(`lab/*.local.json` is ignored too):

```json
{ "orgs": [ { "name": "northwind", "store": "postgres", "developers": 2,
    "repos": [ { "id": "team-skills", "team": "Core", "path": "/path/to/a/bare/repository.git",
                 "memberUrl": "https://git.example.com/northwind/team-skills.git",
                 "branchExample": "CORE-12-short-description" } ] } ] }
```

- **Repositories** are copied into the lab with `git clone --bare` and reached through the
  local forge, so a merge in the lab never touches the original.
- **People and teammates:** the organization gets an admin, an owner per team, a member and up
  to three teammates on its first repository.
- **`memberUrl`** (optional) is the address teammates add the repository by. The join commands
  on its page and the README a scaffold refresh writes name it. The lab never fetches it, and
  checks it with the orchestrator's own rule before anything starts. Without it the page asks for
  one; the copy's own path is never offered to teammates.
- **`branchExample`** (optional) is committed into the copy's `.teamhandbook.json`, so the
  orchestrator's requests are named the team's way.
- **What the suite runs** on it:
  - tenant isolation, roles and reading;
  - the join commands;
  - the branch the orchestrator proposes;
  - a scaffold refresh, whose request, if it opens one, writes `memberUrl` and is closed again.
- **Its name** stays out of every test title; the suite calls it "extra organization 1".

**The suite** (`lab/tests/`) covers what a single orchestrator's suite cannot:

- tenant isolation: across orchestrators, and between two tenants of one Postgres database;
- the role matrix for every person and every repository;
- each layer on each forge: inventory; an edit opened, merged and reaching a teammate's copy,
  with doctor's version or commit comparison before and after the update; skill use with the
  team's and the teammate's answer; a task run by the stand-in agent;
- the share rule for a credential in an MCP server;
- task templates: writing a new skill and improving one on each forge, the refusals, and an
  agent that changes a file outside the skill's folder;
- the scaffold refresh with no agent on each repository shape: a teammate's merge leaves an
  old scaffold; after the refresh is merged, the teammate's doctor stops warning and a new
  teammate joins at `memberUrl`. Teammates reach the hosted forges as `localhost` and the
  orchestrator as `127.0.0.1`, so the README the refresh writes is checked for the teammates'
  address. Also covered: the refusals for a current scaffold and for a repository without
  `memberUrl`;
- the switch to versioning by commit: a teammate's doctor follows the commit, later edits
  raise no version, and a repository that runs the version-bump CI job is refused;
- the commit prefix and example branch changed as a request, on each repository shape. Once
  merged, a new teammate's join, the setup panel and the orchestrator's next request use the new
  naming. The change is then put back, a cleared example removing its key. A prefix change
  where the version-bump CI job runs is refused;
- a task's branch: it takes the example's folder (`feature/...`) and, when the task names an
  issue, the issue's key. A task that names no ticket where the example starts with one is
  refused before it runs;
- an MCP server added, edited and removed, each merged and followed onto a teammate's copy with
  the team's other servers kept, on each repository shape; an edit to a literal credential,
  to what is there already, or of a server the team does not have is refused;
- a team's skill-use address given anew and then stopped, on each repository shape. The old
  address is refused as soon as the request opens; once it is merged the teammate is asked
  again; after the stop nothing is sent;
- the panel's Refresh the scaffold, pressed by a team's owner in the browser on each shape.
  It is not offered to a member, and where `memberUrl` is missing the panel says why;
- what waits to be merged, on each shape: a request from the orchestrator and a teammate's share
  from their own machine, listed by who opened them. The stand-in forges take a lab-only
  `x-lab-user` header to name the teammate. A share withdrawn on the forge leaves the list once
  the orchestrator's 30-second read of the forge is renewed;
- a slash command in a folder added, edited and removed, followed onto a teammate's copy. A
  token, one machine's path, an existing or unchanged command, a missing one and a name that
  is no command's are refused;
- the plugin's skill format findings, and the overlaps read apart from the inventory, for a
  well-formed skill, two skills that answer the same requests, and a thin one;
- a version line written back into a repository versioned by commit, named on the panel and
  by the teammate's doctor alike, and never on a numbered repository;
- single sign-on: someone the provider verified arrives as a member and comes back as the same
  account; an unverified address and one a password account holds are refused;
- an orchestrator reading a repository of 2000 skills and their overlaps, and whether it still
  answers who is signed in meanwhile;
- two tenants' orchestrators on one Postgres, connected to the same repository, opening a request at
  the same moment, and whether the two claim different versions;
- the In tasks column. vandelay's orchestrator also offers Claude Code, as the lab's stand-in
  claude (every task the suite starts names the stand-in agent), so a server whose tool the
  repository names is given to a task, and one that sends no credential is marked as signing
  in through a browser;
- a commit prefix that carries a quote, `$()` or a backtick: refused by the orchestrator's naming
  request. A scaffold refresh on a repository with the CI job whose recorded prefix holds one
  writes no CI file carrying it raw. The lab's forges run no CI, so nothing is executed;
- two requests sent to one repository at the same moment, which claim different versions;
- the setup panel on each repository shape (versioned by number, by commit, named by ticket
  key, on master): what it says as the lab sets the repository up, and after a teammate's change
  merged outside the orchestrator - a stale scaffold stamp, a deleted `hooks/hooks.json`, a reviewer
  the plugin's rule drops, a marketplace name join refuses. A new teammate's real join and the
  orchestrator's next request are checked against what the panel says, and the change is then put back.

A known gap is written as an expected failure that says what is missing, and turns red once the
fix lands.
