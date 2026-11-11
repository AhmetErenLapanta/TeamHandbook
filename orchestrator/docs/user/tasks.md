## Tasks

The Tasks screen hands a piece of work to an agent CLI: a title, a description, a project and
an agent. In a project that is a Git repository the orchestrator checks it out of its mirror,
installs the
team's own skills and MCP servers for the agent, runs it, runs the team's tests, and opens
what the agent changed as a request on a branch named by the team's rule (below). The task
then waits in `needs-review`;
merging stays a person's decision, as for every other orchestrator change. Once the request is
merged or closed, the task shows that decision instead: read from the request's own record,
so a merge on the orchestrator shows at once and one on GitLab or GitHub after Refresh, on the
repository's screen or the task's. Starting or cancelling
a task takes the admin role or ownership of the repository's team; everyone signed in sees
the list and the log. A repository the configuration no longer lists is not offered, and a
start on it, Run again included, is refused: its last synced copy is old, and a task would
open a request on it.

A task can start from a template, picked under *Kind of task*: **Write a new skill** (named
in the form; refused if the repository has it) or **Improve a skill** (one the repository
has). The title can be left empty (`Write the skill on-call`). The prompt tells the agent what
the plugin reads in a skill and that the change stays in `skills/<name>/`; a result that
reaches outside that folder, a new skill without its `SKILL.md`, or an improved skill whose
`SKILL.md` was deleted is refused. Run again starts from the same template.

Two kinds of task run no agent; the orchestrator does them itself in the task's checkout, and they
pass the same tests, checks and request as any other:

- **Refresh the TeamHandbook scaffold** writes what `/handbook:init --upgrade` writes today:
  the manifests, the README between its markers, `hooks/` and the CI files, never `skills/`,
  `commands/`, `agents/` or `.mcp.json`. The scaffold names the address teammates add the
  repository by, so the repository needs `memberUrl` in `orchestrator.json`; without it the
  refresh is refused rather than written for the fetch address, which can carry a token. It
  records this orchestrator's release as `scaffoldVersion`, raises the plugin's version as every
  orchestrator request does, and is refused when the scaffold is already current or was written
  by a newer TeamHandbook. A file the plugin cannot regenerate here, and a README replaced
  whole, are named under "Look at these before merging".
- **Switch the plugin to versioning by commit** is the same refresh with the version line
  taken out of `.claude-plugin/plugin.json`. It is refused while the repository runs the
  version-bump job (`scripts/bump-version.mjs`) or has no version to take out. The request
  names the open requests that claim a version, and says what the orchestrator cannot check:
  everyone who shares to the repository has to run TeamHandbook 0.31.0 or later first, or
  their next share puts the line back.

What a run does, in order:

1. **Checkout.** A checkout of the mirror's head is written through a git directory kept
   outside the task's directory, not inside the checkout. The agent's changes are read back
   through that directory, so nothing the agent writes into the checkout (a `.git`, a hook, a
   filter) runs when the orchestrator reads them.
2. **Skills and MCP servers.** The team's skills go into the agent's own config directory,
   under the task's HOME. A team MCP server is placed only if the plugin's share rule lets it
   travel and the repository's `mcpTools` names one of its tools. The agent can call only the
   tools named there. A server's tools are not known until it runs, so a whole server or a
   pattern is not accepted: a server that can comment on an issue or change its status is
   never handed over by accident. Without `mcpTools` the agent gets no MCP server, and the
   log names the servers left out.
3. **The agent runs** in the task's directory with a stripped environment: `PATH`, the locale,
   a HOME and temp directory of the task's own, the agent's model credential, and any
   variable named in `ORCHESTRATOR_TASK_ENV_PASS`. Nothing else the orchestrator's process holds
   crosses.
4. **The checks.** The repository's `testCommand`, or without one the checks its files name
   (package scripts, a Makefile, a build wrapper) once approved, runs in the checkout before the
   agent and after it, without the agent's credential. The task box, and the task form while
   something waits on approval, says "Checked with" and the commands, and **Start** approves them
   (only an owner or an admin approves, and anyone else is told so while a task there runs no
   check; a folder on a person's machine is theirs alone, and to anyone else, an admin included,
   its project is not found); **Change** picks others, each marked when it reaches the
   network or takes long, with the setup it installs with first. When what an approved check runs
   changes, by a teammate or by the agent, none runs until it is approved again where the
   project's tasks start, and the log says so. When it passed before and fails on the agent's
   change, the agent gets up to two repair rounds with the failing output; a check that still
   fails opens its request marked broken ("Tests: broken"), and one that failed before the agent
   too gets no repair round. Each run's exit code and last lines are on the task's page and in the
   request. On a person's own orchestrator, a task started in a folder with no project there
   (one box, no project picked) approves what the folder's files name at **Start**, leaving out
   the checks marked as taking long, or taking the first of them when every check is, and its first line says "Checked
   with ...", with ", set up first with ..." when a setup goes first. A folder holding several
   repositories runs with no check at all, the checks being per project, and its log says so on
   its first lines. Without a check, the log says why.
5. **Checking the result.** Before any request, the changed files are checked:
   - only regular text files (a symbolic link or a binary file is refused);
   - at most 200 files of 1 MiB each;
   - none that looks like it holds a secret, or holds a credential the orchestrator passed to
     the agent;
   - the plugin's own rules, the ones the editor applies: a `skills/<name>/SKILL.md` has
     frontmatter with a name and a description, the name is its folder's, and the folder is
     a name the plugin reads; a server added to or changed in `.mcp.json` passes the share
     rule (a server already there is not judged again).

   A change to `hooks/`, `.claude-plugin/`, `.teamhandbook.json` or a CI file, a server that
   starts a command, and a removed server are named under "Look at these before merging" at
   the top of the request and in the log. The count and the sizes are checked before git reads any file, so a 1 GB file or
   thousands of files are turned away without being copied into the task's git directory.
6. **The request.** The request body quotes the task and the agent's own report inside a
   fence that no line of the report can close, marked as data. Closing words and
   smart-commit commands are made inert: `Fixes #1` becomes `[Fixes] #1`, `#done` becomes
   `# done`. The commit carries only its subject and one line the orchestrator writes, never the
   agent's words, because a commit message is what a tracker integration reads for commands.
   The branch, title and test outcome come from the task and the orchestrator's checks, never
   from the agent's text. The branch follows the team's rule, as every orchestrator branch does:
   the issue's key when the task has an issue link, then a ticket key in the commit prefix,
   then the shape of `branchExample`; with no rule it is `task/<id>`. When the example starts
   with a ticket (`PAY-12-fix-login`) and the task has no issue link, there is no name the
   rule accepts: the form asks for the link, and a start without one is refused before it
   waits in line, templates and the scaffold refresh included. A name that carries a trace of
   a machine or a credential, or that git refuses, falls back to `task/<id>` before the agent
   starts, and the log says why without repeating it. An agent that changes the commit prefix
   in `.teamhandbook.json` is refused when the plugin does not accept the new one, or when the
   repository runs the version-bump job, which commits with it. When the plugin's manifest carries a version, the request raises it past
   every unmerged branch that already claims a higher one, as every orchestrator request does,
   and says so: Claude Code fetches a plugin again only when that number moves. A manifest
   the agent changed keeps the line the agent wrote, and the request warns when that number
   reaches nobody.

The log is redacted line by line before it is stored: the plugin's secret patterns, private
key blocks, and the literal value of every credential handed to the agent. Each stream of a
process's output passes one redactor in order, the lines the log leaves out as well, so a
private key block is masked wherever in the output it starts or ends, and the "Last line" of
a failure is taken from the redacted text. A control character in a process's output (a NUL,
a terminal escape), and in the agent's report the request quotes, is stored as a
replacement mark; a title or description holding one is refused. The task's
directory is deleted when the run ends. Cost is what the agent reports: Claude Code's
`total_cost_usd` and token counts, or the sum of OpenCode's step costs. An agent that
reports none shows `unknown`. A task left queued or running when the orchestrator stops is marked
failed at the next start. When the store refuses a task's outcome, as it does on a disk the
agent filled, the outcome is written again once the task's directories are deleted.

Tasks start in the order they were asked for, `ORCHESTRATOR_TASK_CONCURRENCY` at a time; a waiting
task shows its place in line. Cancelling a waiting task takes it out of the line before it
starts; cancelling a running one ends its agent's whole process group and deletes its
directories, and no branch is left: the branch only reaches the team repository with its
request, after the agent and the tests. A cancel that arrives while that request is being
opened lets it open, and the task waits for review. A failed or cancelled task has **Run again**, which
starts a new task with the same title, description, issue, repository and agent and leaves
the old one as it is. The log keeps the first 4000 and the last 1000 lines of the agent's
output and of the tests' output, each on its own, and every line the orchestrator writes; the
last ones arrive when the process ends, and a line between the two says how many were left
out. A failed agent or failed tests put their last line in the task's error.

### A task in a folder without Git

On your own machine a project can be any folder, a Git repository or not (named when you start a task, or added under Settings > **Where your code lives** with **Add a folder**; see
[Run it on your machine](../../README.md#run-it-on-your-machine)). In a folder that is not a Git
repository the task works in the folder itself, not in a checkout: the agent edits the files
there, and there is no branch and no request. It runs only as you ([Run as me](#run-as-me))
under process isolation, takes no template, other projects or delegation, and one task works in
a folder at a time: another started meanwhile fails, saying which, and is started again once the
first ends. Before and after the run the orchestrator records the folder in a shadow Git in its
own data, never in the folder ([SECURITY.md](../../../SECURITY.md), "A folder without Git"), and
a folder past its limits does not start. The folder's own MCP servers stay off, and the team's
policy holds as in a checkout: an edit it refuses is taken back.

The task ends in `needs-review` with **Changes** on its page: each file the agent
changed and its diff. The person who started it answers once: **Keep these changes** leaves the
files as the agent left them, and **Undo these changes…** asks first, then puts each one back as
it was before the task; a file you edited since stays as you left it and is named, and a file
kept only by its digest (one named like a key or a password file) cannot be put back. The answer
goes to the task's log and the audit log, and the task then reads **changes kept** or **changes
undone** (see [The screens](screens.md#the-screens)). **Make this a Git repository**, on the project's **Settings** tab, starts
Git in the folder without adding or committing a file; the task's review then offers **Commit
these changes**, and later tasks run as in any Git repository. What tasks changed in your folders, and every request, waits
under **Your turn** on Tasks.

### A follow-up

The person who started a task writes to its agent from the task's page, from their own signed-in
browser. While the agent works, **Tell the agent while it works** (**Send**) reaches it at once and
**Message for the agent** (**Queue message**) waits for its current step to end. When the task is
in review and its request is still open, **Continue with a follow-up** (**Start the next run**)
sends it back to work: a new run on the request's branch, from where the branch is now, held to the
same rights and policies as a start, and its new push goes onto the same request, checked again
before it merges. A merged or closed request takes no more. Lines selected in the request's
changes go with the follow-up as quotes.

A teammate who reviews a task's request writes **Suggest a follow-up to <starter>** instead
(**Suggest**). It waits under **Suggested follow-ups** on the task's page and puts the task in its
starter's turn on Tasks; only the starter sends it on, with **Continue with it**, which starts the
next run with it fenced as data like their own words, or drops it with **Dismiss**. It lapses once
the request is merged or closed, the writer reads how it stands, and the log names both people.

On a finished task's open request, each changed file's row offers **Take out of the request…** to
whoever started the task, an admin or the team's owner. After **Take it out**, one commit on the
request's branch puts the file back as it was before the task, or deletes it when the task added
it, and the request is checked again. A path the request does not change, a branch that moved
since, or a path outside the repository is refused with the reason.

### What a task leaves: Learned

The task page's rail closes with **Learned**: one sentence naming the skills the task started with
and the lessons its review left. On your own orchestrator, once a task ends, what you said about it
(a follow-up while it ran, with the lines it quoted, a tool call you denied with a note, and the one
line you give when you undo a change in a folder without Git) goes to
the task's agent as one question with no tool, and the answer is no lesson or a draft skill. Each is fenced as data, and words
that match a secret drop the lesson. A draft waits in your own review queue and reaches nobody.
Each pending lesson opens in its own fold with what it would teach, what you said and the skill's
text: **Keep** copies it into your own skills folder, **Reject** turns it down and **Never suggest
it again** mutes it; sharing a kept skill with the team stays in `/handbook:review`. On a team's
orchestrator the lesson is made and decided on your connected machine.

### A task that works on an issue

The form takes an optional issue link. The orchestrator reads only the address:

- Jira (`https://<site>/browse/PAY-142`) gives the key `PAY-142`;
- GitHub (`/<owner>/<repo>/issues/12`) and GitLab (`/<group>/<project>/-/issues/7`) give a
  key like `acme/payments#12`;
- any other https address is kept without a key.

An address that is not https, carries a user name or password, or looks like it holds a
secret is refused, because it is written into the prompt, the log and the request.

With a key:

- the title can be left empty (`Work on PAY-142`);
- the branch leads with the key under the team's example prefix (`feature/PAY-142-...`);
- the request title carries the key after the team's commit prefix (`PAY PAY-142 ...`); a
  commit prefix that is itself a ticket key gives way to the issue's;
- the request body links the issue.

The orchestrator never fetches the issue: no request goes from the orchestrator to a tracker, and it
holds no tracker token. The agent reads the issue through one of the team's MCP servers, if
one can, and the prompt quotes the link as data and tells the agent that the issue's text
describes the work rather than instructing it. For that:

- the team's `.mcp.json` declares the tracker's server with its credential as a reference.
  The plugin's share rule takes a value that is a reference as a whole and nothing around
  it, so the header is `"Authorization": "${TRACKER_AUTHORIZATION}"`; `"Bearer
  ${TRACKER_TOKEN}"` is refused as a literal value;
- the orchestrator's environment holds the whole value (`TRACKER_AUTHORIZATION="Bearer ..."`)
  and names it in `ORCHESTRATOR_TASK_ENV_PASS`;
- the repository's `mcpTools` names the server's read tools, for example
  `"mcpTools": ["tracker/getIssue"]`.

A server that signs in through a browser (OAuth with a login page) does not work in a task:
nobody is there to sign in. It needs a token-based configuration.

Nothing is written to the issue:

- the prompt tells the agent not to comment, change a status or edit a field;
- the agent can call only the tools `mcpTools` names, so leave every write tool out of it;
- nothing the agent writes reaches a commit or a closing word.

What a forge does by itself still happens: GitHub and GitLab note on an issue that a commit
or request mentions it, which is what the key in the title is for. A comment on the issue
that links the request is designed as the repository setting `tracker.writeBack` but not
built, so the orchestrator starts only with it absent or `false`.

### Tasks on a cloud orchestrator

With `ORCHESTRATOR_MODE=cloud`, an orchestrator's own container runner calls a model only with the
key its operator gives it, and hands that key to no task.
- **The key.** The operator sets `ANTHROPIC_API_KEY` on the runner. No organization enters one, and no page or endpoint takes one.
- **Without one.** A task on an agent that calls a model is refused with "No runner for this task", a skill suggestion answers none and says why, and a review writes its check as not read. A task already waiting fails before any agent runs. The stand-in agent calls no model and runs either way.
- **The proxy.** No credential of the orchestrator's own reaches a task. The agent holds a stand-in key, and its model's address is `http://model.orchestrator.invalid`. The orchestrator's proxy puts the runner's key on those requests on the way to `api.anthropic.com`, and only on `POST /v1/messages` and `/v1/messages/count_tokens`, so the key never enters the agent's environment, its files or its output.
- **The network.** The proxy is the only way out for every cloud task: its setup, its agent and its tests. It lets through the repository's `allowedDomains` and the hosts of the MCP servers placed for the task. The forge stays closed, because the orchestrator opens the request, not the agent. Everything else is refused and said in the log.
- **The data directory.** The proxy listens on a socket in the task's directory, whose path has a limit of 103 characters. A `ORCHESTRATOR_DATA_DIR` too long for it fails each task saying so.

### A task over several repositories

One issue often changes more than one code repository: an endpoint is a service, the layer in
front of it and the gateway. A start that sends `targets` runs one task over several:

- `"targets": "orchestrator"` lets a planning step choose. The orchestrator lists the candidates itself:
  code repositories in the configuration, read at least once, on a team the person can start
  tasks for and open to them under the orchestrator's policies, at most 8. The planning step is an
  agent with no skill, MCP server, secret or checkout. It reads the issue and, for each
  candidate, the first 4,000 characters of its `README.md` and its top-level entries. It also
  reads the team's skills from each candidate's `skillsFrom` repository: their names,
  descriptions and a `## Which repositories` section when a skill has one, up to 1,500
  characters each and 30,000 in all. A skill such as `add-endpoint` says which repositories one
  kind of change goes through. All of it is quoted as data. The step answers
  `TARGET: <id>: <reason> (skill: <name>)` lines. A repository that is not a candidate is
  dropped, a skill the team does not have is left out of the reason, and an answer that names
  no repository fails the task.
- `"targets": ["orders-service", "orders-bff"]` names them, in order, with no planning step.
  Each is checked as the start's own repository is, branch rule included, before the task is
  queued.

A task over several repositories needs an issue link, which every request carries: each
repository's branch and request title lead with the same key. The repositories run one at a
time, at most 5, the one others depend on first. Each gets its own checkout, team setup, task
secrets, environment, tests and request, and its agent sees only its own checkout. The policies
and the budget are read again before each one. A later repository's agent is told the plan and
what the earlier ones' agents reported and changed, up to 50,000 characters, quoted as data and
masked with every secret the task has read so far. Each request says which part of the plan it
is.

The first repository that fails stops the task. The ones after it are skipped, and the requests
already opened stay open for a person to merge or close. A cancel does the same. The task's
cost adds up the planning step and every repository. When one of them reported no cost, the
task says its cost is partial.

### The mode a task runs in

A start can name `mode`: `approval-required`, `auto-accept-edits`, `auto` or `full-access`, from
the least the agent does on its own to the most. A start that names none runs in `auto`, and the
task keeps the mode it runs in. A mode the agent does not run in is refused with the code
`mode-not-offered`; `GET /api/tasks/options` lists each agent's `modes`. A policy's mode ceiling
on the repository holds too: a task above it is refused, the policy named.

### Child tasks

With `ORCHESTRATOR_PUBLIC_URL` set and process isolation, a task's agent is given the orchestrator's
own MCP server (`th-orchestrator`), reached with a token of the task's own, and its tools by name:
`delegate_task` starts a child task on another repository the starter can start tasks on,
`task_status`, `task_cancel` and `request_status` follow it, and `suggest_skill` finds a team
skill. A child task runs as the starter, through the same checks as any start, in a mode no
higher than its parent's, with the parent's denied tools kept, and with the parent agent's words
quoted as data. It starts beside its parent rather than waiting for a place, so a parent can wait
on it. A task delegates at most 3 tasks, a child delegates none, and a parent that is cancelled
or fails cancels its children; one that finishes leaves them to finish. Run as me, container
isolation and a cloud orchestrator give no agent this server yet.

### Picking the team skills a task uses first

A start can name up to 5 of the team's skills in `skills`. A task on a skills repository draws
them from that repository, a code repository's from its `skillsFrom`, and a task over several
repositories from each one's. A name the team does not have is refused. The agent's prompt names
the picked skills, with their descriptions quoted as data, to use before the others. A repository
whose setup lacks one, because a policy holds it back or it is not that repository's, leaves it
out and says so in the log.

`POST /api/tasks/skill-suggestions` asks which skills fit:
`{ agent, repoId, issueUrl?, description?, targets? }`, or `{ agent, items: [...] }` for up to 20
at once. It answers each with `suggestions` (`{ skill, reason }`, at most 5) and every team
`skill` there is to choose from. The suggestion is an agent run like the planning step's:
- no tool, skill, MCP server, secret or checkout;
- the issue and the skills' names, descriptions and *Which repositories* sections are quoted as data;
- 60 seconds at most.

A skill the team does not have is dropped from the answer. Each call is written to the event log
with what the agent reported spending, and that spend counts in the month's task budgets as the
person's. One person asks for 20 suggestions a minute, each item of a batch counting as one, and
the organization's people run 3 at once between them; the rest wait their turn.

### OpenCode and MCP

Holding OpenCode to named MCP tools rests on how it behaves, as read in its source at version
1.18.31:

- it registers a server's tool as `sanitize(server)_sanitize(tool)`;
- every MCP call asks permission under that name;
- the last matching permission rule decides;
- the default agent applies the user config after its own defaults;
- `opencode run` rejects whatever would ask.

The hold rests on every one of these, and none is a promise OpenCode makes. So MCP for OpenCode stays off
until an operator who runs a version that behaves this way sets `ORCHESTRATOR_OPENCODE_MCP=1`.
Without it an OpenCode task gets no MCP server and cannot read an issue.

With it, a server is still left out, and the log says why, when:

- its name has an underscore (`a_b` + `c` and `a` + `b_c` would both register as `a_b_c`);
- its definition holds `{env:...}` or `{file:...}`, which OpenCode fills in from the host when
  it reads its config.

Remote servers are written with OAuth off.

### Team policies

A policy takes something away: a skill, an MCP server or one of its tools, or a Claude Code
tool pattern such as `Bash: git push *`. Saved in the orchestrator, a policy that reaches
teammates' sessions opens a request on each affected team's repository; once merged, the
TeamHandbook plugin's hook denies a matching call in every teammate's session and the same
rules narrow what a task's agent gets. The orchestrator's own rules (repository access, a monthly
task budget) apply at once.

A monthly task budget counts what agents reported this calendar month (UTC). A task still
waiting or running has reported nothing yet, so it holds part of the budget: the largest cost a
task under the same budget reported in the last 90 days. Until a task under the budget has
reported a cost, a waiting or running task holds all that is left, so the budget runs one task
at a time. A start the held share would take past the budget is refused and says how much is
held. Starts in one organization read the budget and queue their task one at a time, so a batch
or two people starting at once cannot each spend the same budget.

For an organization that enforces settings through MDM or its own delivery, an owner or an
admin exports the policies as Claude Code managed settings: `GET /api/policies/export`
(the workspace's policies) or `?repo=<id>` (that repository's), with `&download=1` for the
`managed-settings.json` file itself. The answer lists each path rule as approximate, since
Claude Code's paths read `*` within one directory, and each rule Claude Code cannot say, with
the reason. The orchestrator hands the file over and delivers it nowhere. A Claude Code install
whose managed settings set `allowManagedHooksOnly` without force-enabling the TeamHandbook plugin
in managed `enabledPlugins`, or whose settings set `disableAllHooks`, runs no TeamHandbook hook, so the rules that reach
teammates' sessions through the TeamHandbook hook (skills, MCP servers and tool patterns) are
not enforced there; for such an organization this export is the way to enforce them, while
repository access and the task budget, which the orchestrator applies itself, hold either way.
Team > **Policies** and the policy preview say so, with the export a click away for an owner or an admin.

### Code repositories

A task can change a repository that is not a skills repository: a service, a library. List it
in `orchestrator.json` with `"kind": "code"`:

```json
{ "id": "billing-service", "team": "Payments", "name": "billing-service", "url": "...",
  "kind": "code", "skillsFrom": "payments-skills", "testCommand": "npm test",
  "naming": { "commitPrefix": "PAY", "branchExample": "PAY-12-fix-rounding" } }
```

- `skillsFrom` names the team skills repository whose skills, MCP servers and policies the
  task's agent gets; without it the agent gets none.
- The repository's own `.teamhandbook.json` names its branches and commits when it has one;
  `naming` stands in when it does not, held to the plugin's rules for a prefix and an example.
- No plugin version moves with its requests, and the skill templates and the scaffold refresh
  are refused for it. `GET /api/repos` marks it `"kind": "code"`, so the repository page can
  leave out the skills inventory and the setup panel.

### Run as me

On an orchestrator only you use (`ORCHESTRATOR_MODE=local`, with process isolation), tasks run as you
unless `ORCHESTRATOR_TASK_PROFILE=isolated` says otherwise; elsewhere `ORCHESTRATOR_TASK_PROFILE=personal`
turns it on. Run as me runs your own Claude Code: your settings, memory, CLAUDE.md, skills,
plugins, hooks and MCP servers load as in your own sessions, plus the team's skills for the task.
A folder's own project and local settings load only in a folder without Git you opened yourself,
and only once you trust it, asked once per project and off until then, since a folder's settings
can run programs and send the model and your sign-in elsewhere (`apiKeyHelper`, `env`). The task's
page asks in its rail, under **This folder's settings**, only the person who opened the folder and
only until they answer: **Use them** loads them for the next tasks there, **Keep them off** keeps
them off; the task that asks runs without them. A copy the orchestrator cloned loads your user
settings alone either way. In a Git repository the task gets its own
checkout and ends in a request nobody merges for you; in a folder without Git it works in the
folder (see [A task in a folder without Git](#a-task-in-a-folder-without-git)). The orchestrator
writes nothing into your profile, names the mode on every start, and runs Full access as Auto, so
your MCP servers' tools do not all run without a question. A team policy can keep your own setup
out of a project's tasks; the task then runs with your sign-in alone.

The orchestrator adds a guard of its own, a settings layer from the task's folder and never your
profile, which your own hooks cannot lift. It denies an MCP tool that writes to a tracker (a Jira,
Confluence or other issue tool that does not read) ahead of everything else, with "This
organization keeps tasks from writing to its tracker", then every other MCP tool whose name does
not start with a reading verb (`get`, `list`, `search`, `read`, `view`, `fetch`, `query` and the
like) apart from the orchestrator's own tools the task was given. It keeps the agent's writes
inside the folder the task works in, never through a link out of it, a `..` or into a `.git`,
its reads out of `~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.config/glab-cli`, `~/.netrc` and your
Claude Code settings, and carries the team's path rules. The folder's own `.mcp.json` servers stay
off. If your organization's managed Claude Code settings, or the folder's own, switch hooks off,
the task does not start and says why.

It is refused, and tasks do not run, unless the orchestrator listens on this machine alone
(`ORCHESTRATOR_HOST` loopback) and has one account, across every organization it serves, and no
service account; the readiness check
says which condition failed. It needs `ORCHESTRATOR_TASK_ISOLATION=process`, since no container has
your sign-in. OpenCode runs this way too, as a session of its own `opencode serve` on 127.0.0.1
behind a password made for the task, with your OpenCode sign-in; its rules go with the session,
so no setting of yours outranks them, and they deny the shell and the web, anything outside the
task's folder and every tool named for a tracker or a forge, and ask you before any other tool. The task form and the readiness check say
"Runs as you: your own Claude Code, with your skills, plugins, MCP servers and memory, plus the team's skills."

### A repository's task environment

A repository can describe how its tasks run in `.teamhandbook/environment.json`, a file the
team reviews and changes by request like any other:

```json
{ "setup": { "command": "npm ci", "network": true },
  "agent": { "allowedDomains": ["registry.npmjs.org", "*.example.com"] } }
```

- `setup.command` runs in the task's checkout before the agent, with none of the orchestrator's
  credentials and, unless `network` is `false`, with the network the orchestrator allows
  (`ORCHESTRATOR_TASK_NETWORK=none` still holds). A setup that fails, runs past the tests' time
  limit, or changes a file the repository tracks stops the task before any agent runs. What
  it creates (dependencies, a build) stays out of the agent's request.
- `agent.allowedDomains` is the only network the agent and the team's tests can reach, besides
  the agent's own model API and the remote MCP servers placed for the task. Under container
  isolation they run with no network at all; a shim from the task's directory, started as the
  container's entrypoint (so the task image needs `node`), hands their traffic to the orchestrator's
  proxy over a socket, and the proxy opens only the listed names on ports 80 and 443, never a
  bare address. The request names each host the proxy refused. Process isolation cannot hold a
  list, so a repository that names one has its tasks refused there.
- A key the orchestrator does not read, a domain written as an address, or a credential in the
  setup command refuses the task with the reason. Without the file, tasks run as before.

### Task secrets

The team's and the repository's task secrets, kept in the orchestrator's vault, reach a task's
setup, agent and tests as environment variables, a repository's value replacing the team's of
the same name. They are read when the task starts. Each value is masked in the task's log, in
every process's output and in the request; a change that writes one into a file opens no
request. The task log and the audit log record which names a task ran with, never a value. A
name the orchestrator also hands tasks (through `ORCHESTRATOR_TASK_ENV_PASS`, or an agent's own
credential) stops the task with the variable named, since one of the two settings has to go.

A secret can name a 1Password item instead of holding a value: under **Value**, **Read from
1Password** takes `op://vault/item/field`, in a vault the orchestrator's operator lists in
`ORCHESTRATOR_1PASSWORD_VAULTS`; the choice shows only where they list one. The orchestrator keeps
the reference and reads the value each time a task starts, with the service account token in
`OP_SERVICE_ACCOUNT_TOKEN`, so a value rotated in 1Password reaches the next task. A reference that
reads no value stops the task with the secret and the item named.

### Scheduled and triggered jobs

A repository can keep jobs ready in `orchestrator.json`: named tasks that run on a schedule, or
when a teammate asks for one in a comment on the team's forge.

```json
"jobs": [{ "id": "format-check", "title": "Check the skills' format", "agent": "claude-code",
           "description": "Fix any skill whose frontmatter the plugin refuses.", "schedule": "0 6 * * 1" }],
"triggerSecretEnv": "TH_TRIGGER_PAYMENTS"
```

- `schedule` is five cron fields, read in UTC. A due job starts once that minute, as the
  orchestrator for the repository's team, under every rule a start from the orchestrator meets.
- A comment `/handbook run format-check` reaches `POST /api/hooks/forge/<repository id>`. Point
  the forge's webhook there (GitHub: issue comments, secret = the value of the named variable;
  GitLab: comments, secret token = the same). The orchestrator checks GitHub's signature or GitLab's
  token, takes the comment's author only if their forge login belongs to an orchestrator user who can
  change that team, and runs the job as them. A comment already handled starts nothing, even
  sent again under a new delivery id or after a restart.
- The comment reaches the agent quoted as data. It is not an instruction and it approves
  nothing: every job ends in a request a person reviews, and the orchestrator writes nothing back
  to the forge.
- A `triggerSecretEnv` whose variable is unset, or holds fewer than 16 characters, stops the
  orchestrator at start.

### Review rules as a check on requests

A team can keep review rules in `.teamhandbook/review-rules.md` and have the orchestrator apply them
to every request to that repository, as a check the forge shows beside the request and can
require before a merge. It is off until a team owner or an admin turns it on for the
repository (`PUT /api/repos/<id>/review-check` with `{ "agent": "claude-code" }`), which the
audit log records, and it needs the repository's GitHub or GitLab access and a
`triggerSecretEnv`: point the forge's webhook for pull requests (GitHub) or merge requests
(GitLab) at the same `POST /api/hooks/forge/<id>` the jobs use.

- Only requests into the repository's default branch are reviewed, by the rules on that
  branch, never the request's own. A check lives on a commit, and the same commit can head a
  request into another branch, whose rules would otherwise overwrite the outcome.
- A review runs under the orchestrator's own rules for the person who turned the check on: a
  repository they cannot start tasks on, or a monthly task budget already spent, makes the
  check an error saying it was not reviewed. A review's own cost is not counted against the
  budget yet. It never runs with anyone's own profile, even on an orchestrator set to Run as me.
- The agent reads the change as data and changes nothing: no file edits, skill, MCP server,
  shell or web.
- The outcome is written on the request's head commit as the check `teamhandbook/review-rules`
  (a commit status on GitHub, a pipeline status on GitLab): pending while it runs, then passed,
  failed with the rule it breaks, or an error. Anything short of a clear PASS or FAIL (no rules,
  a change over 200,000 characters, an agent that fails) is an error, which a required check
  holds the merge on. The orchestrator never comments on a request.
- Each commit of a request is reviewed once, and a head that moved since the forge announced
  it is left to the announcement of the new one.

### Guardrails on an agent's work

- **The agent never merges.** A task gets the model's credential and nothing that reaches the
  forge: `ORCHESTRATOR_TASK_ENV_PASS` naming a forge token (`GH_TOKEN`, `GITLAB_TOKEN` and the like)
  stops the orchestrator at start. The orchestrator opens the request itself, and a service account
  that started a task cannot merge that task's request; a person reviews and merges it.
- **The request says what the agent was refused.** Under *What the agent was refused* it
  names the network the run had and each tool call the agent reported as refused (Claude
  Code's `permission_denials`), quoted as data. With `ORCHESTRATOR_TASK_NETWORK=open` the orchestrator
  sees no connection the agent made; only `none` keeps it off the network.
- **CI on a task's branch waits for a person.** The orchestrator does not change forge settings;
  each forge decides whether a pipeline on the agent's branch runs with the team's secrets:
  - GitHub: put jobs that use secrets behind an environment with required reviewers, and
    require a review before merging on the default branch (branch protection or a ruleset).
  - GitLab: put jobs that use secrets behind a protected environment with deployment
    approvals or `when: manual`, protect the default branch, and require an approval on
    merge requests.
