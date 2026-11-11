# Repositories and requests

A project is a folder an agent works in; Tasks filters by it with **Repository**. This page is about the
projects that are Git repositories: how they are connected and how their changes become
requests. A task in a folder without Git ends in **Changes** instead; see
[A task in a folder without Git](tasks.md#a-task-in-a-folder-without-git).

## Connect repositories

Repositories are connected from a file, or by an owner or an admin from the screen. For the
file, point `ORCHESTRATOR_CONFIG` at it. The file is re-read at
every start and its entries are upserted, so an install is reproducible from configuration.
Each one it lists is synced once the orchestrator is serving, from the address it gives now, so a
URL changed to rotate or drop a token is the one fetched. A file named and not there stops the
orchestrator at start rather than reading as every repository taken out.

**Add a repository** in the welcome steps, or **Add a folder** under Settings > **Where your code lives** on your own machine (`POST /api/repos`, a signed-in owner or admin, no
API key) takes the forge (GitLab, GitHub, or a path on this machine), the clone address, the project
(taken from the address when left empty, which a forge served under a subpath needs entered), the
team, a name, the kind (`skills`, or `code` with the skills repository its tasks read) and, on a
forge, a token. The address is https (plain http only to this machine) and carries no user,
password, query or option; a GitHub one is on github.com. The orchestrator reads the repository
before it answers: a read that fails leaves no record, token or copy behind and says why. The
token is sealed in the vault twice over, as the repository's forge access (so requests open on
the forge as when set from the GitLab or GitHub card) and as its fetch credential, bound to the
clone address's origin. Each fetch hands it to git as an `Authorization` header for that origin
only, through git's environment, with redirects off: it is in no URL, argument, mirror config or
log. A host that resolves to this machine, a private network or a cloud's metadata service is
refused unless `ORCHESTRATOR_INTERNAL_FORGE_HOSTS` names it, and each fetch is held to the address
judged when it starts. A path is taken by its real path, links followed, and only inside the
folder `ORCHESTRATOR_LOCAL_REPOS_ROOT` names, or your home folder on a local orchestrator that
names none: not that folder itself, not one with a part that starts with a dot, not under its
top `Library`, and not inside the orchestrator's data or holding it. A folder is connected once;
a second time is refused with "that folder is already connected as <id>". On a team's
orchestrator without that variable no path is connected from the screen. The list marks those
connected here with **connected here**; only they offer **Remove**, which asks first (**Remove
project**) and works as Disconnect below, deleting the fetch token too. An id the file lists is refused, and when the file comes to list an id connected here, the
next start takes the file's entry and drops the one connected here with its fetch token. Both
connecting and removing are written to the event log, without the token.

A repository the file no longer lists - taken out, or renamed to another id - is kept, marked
**Not in the configuration** on its page, and is not synced or changed: its URL, and any
token in it, is not used again, the start's check of local requests leaves its repository
alone, while its requests, tasks and history stay readable and its open requests can still be
merged or closed by hand. Without `ORCHESTRATOR_CONFIG` no repository is listed, so a start without
the file fetches nothing; the log names what it kept and did not sync. Putting it back in the file makes it a repository
like any other at the next start. An admin removes it for good with **Disconnect project**
on its page (`DELETE /api/repos/<id>`): the orchestrator's copy, its forge access and sealed token,
and the id its usage endpoint carries are deleted; the team's repository is not touched, and
the orchestrator's records of its requests, tasks and skill use stay. It is refused while the file
still lists the repository, while a request on it is open and while a task runs on it. A team
whose repository is connected again, or under a new id, asks to report skill use again: the old
endpoint's id is gone. The orchestrator's records are kept by id: an id connected again - to the same
repository or to another - shows the requests, tasks and skill-use counts recorded under it
before, and numbers its requests after them, so a different repository takes a new id. Marking rather than removing on its own keeps a repository's request
history from vanishing with a typo in the file.

```json
{
  "tenant": "acme",
  "repos": [
    {
      "id": "payments-skills",
      "team": "Payments",
      "name": "payments-skills",
      "url": "https://git.example.com/acme/payments-skills.git",
      "memberUrl": "https://git.example.com/acme/payments-skills.git",
      "testCommand": "npm test",
      "mcpTools": ["tracker/getIssue"]
    }
  ]
}
```

| Key | Meaning |
|---|---|
| `tenant` | The tenant this orchestrator serves; `default` when left out |
| `orgs` | In place of `tenant` and `repos`: the orgs this orchestrator serves, each `{ "tenant", "repos", "sso" }`; see below |
| `id` | Lower-case letters, digits and dashes; the repository's name in URLs and the store |
| `team` | The team it belongs to; team owners are assigned per team |
| `url` | Where the mirror is cloned from. A `file://` URL uses the local forge. A user and password in it are kept for git and masked in every answer, sync error and screen |
| `memberUrl` | The address teammates add the repository by, shown on its page in the commands they type to join. A user, password or token in it stops the orchestrator at start, since every teammate reads it. Without it the page says to set it; nothing is taken from `url` |
| `testCommand` | The check a task runs in its checkout before its agent and after it; without it the checks the project's files name run once approved, and without those none, which the task's log says |
| `mcpTools` | The only MCP tools a task's agent calls, as `server/tool`, one tool each |
| `tracker` | Only `{ "writeBack": false }` is accepted; see [A task that works on an issue](tasks.md#a-task-that-works-on-an-issue) |

A repository on GitLab or GitHub also needs its forge access set from the screen; see
[Forges and the token vault](#forges-and-the-token-vault).

One orchestrator serves several orgs when the file lists them under `orgs`, each a tenant with
repositories of its own; two orgs can each have a repository of the same id. The first org is
the one the plain `/api/...` paths reach, so a file of one `tenant` opens as one org, as before.
Every org's API is also at `/api/orgs/<tenant>/...`, and an org the file does not list answers
404. `GET /api/orgs` names the orgs this browser is signed in to. Each org signs people in on
its own: an account belongs to one org, and the same address in two orgs is two accounts,
because an admin of one org adds any address they like and an account shared by address would
take them into the other org. Single sign-on reaches only the orgs that set `"sso": true`,
since whoever the provider lets through becomes a member; a file of one `tenant` keeps it. Each
org without an owner prints its own setup code at start. The web app shows an org other than the
first at `/<tenant>/`, so `api`, `ingest`, `mcp`, `integrations` and `assets` are refused as org
names.

```json
{
  "orgs": [
    { "tenant": "acme", "sso": true, "repos": [ { "id": "payments-skills", "team": "Payments", "name": "payments-skills", "url": "https://git.example.com/acme/payments-skills.git" } ] },
    { "tenant": "beta", "repos": [ { "id": "payments-skills", "team": "Payments", "name": "payments-skills", "url": "https://git.example.com/beta/payments-skills.git" } ] }
  ]
}
```

## The setup panel

Each repository's page opens with **Setup**: the team repository as a team lead reads it,
one finding per line, each saying what is so and, when something is to be done, what. It
reads the repository with the plugin's own rules:

- whether teammates can join and install it: the marketplace's name as `/handbook:join`
  judges it, and whether the marketplace lists the plugin;
- whether requests are named the team's way: `commitPrefix` and `branchExample` as the plugin
  reads them, and reviewers or labels its rule leaves off a request;
- how the scaffold compares with the TeamHandbook release this orchestrator carries, and whether
  its README section and `hooks/` are there - an admin or the team's owner refreshes a
  scaffold behind it from the panel, which starts the orchestrator's own refresh task (it needs
  the repository's `memberUrl`, and says so without one), or with `/handbook:init --upgrade`
  from a teammate's machine;
- how the plugin is versioned (by commit, by each request, or by CI), and the agents shared;
  in a repository that was versioned by commit and carries a version again, the commit that
  put it back and its author, since from then on a merge that raises nothing reaches nobody;
- a version-bump job written the old way, with the commit prefix in its shell line: a problem
  when the recorded prefix is one the plugin's rule refuses, since the job runs that line on
  every merge with `TEAMHANDBOOK_CI_TOKEN`, and otherwise a refresh that rewrites it.

**How teammates join** follows it: the commands `/handbook:init` prints, with the repository's
`memberUrl` - `/plugin marketplace add` and `/plugin install <plugin>@<marketplace>` to use the
team's skills, `/handbook:join` to share their own - each with a Copy button. It shows them
only when Setup finds teammates can install the plugin. After a request is merged, a teammate
with auto-update on for the marketplace gets it in their next session; the others run
`claude plugin update <plugin>@<marketplace>` (or `/plugin` > Marketplaces > Update marketplace),
then a new session or `/reload-plugins`.

Below it the page lists what the team ships: skills - each with what the plugin's skill format,
the one `/handbook:learn` drafts to, says it lacks, and the other skills whose descriptions
answer the same requests by the plugin's own measure, worked out once for each commit and in
slices so the orchestrator keeps answering meanwhile (2000 skills: under 20 ms when their words
differ) - MCP servers with the plugin's share rule
applied, and slash commands - every one under `commands/`, a command in a folder under the name
Claude Code types (`git/sync.md` is `/git:sync`). On an orchestrator that runs tasks, each server also
says whether a task gets it and why, by the rule a task's own setup applies: the share rule,
the repository's `mcpTools`, and what each offered agent takes. A remote server that sends no
credential is marked, since one that asks for a sign-in fails in a task with nobody there to
finish it in a browser.

## Editing as requests

An admin or a team's owner adds, edits or removes a skill, an MCP server or a slash command, sets the
reviewers and labels requests carry, and sets how commits and branches are named. Each change is built against the commit the screen
showed. The orchestrator proposes a commit message with the team's prefix and a branch named the
team's way, the person confirms or changes either, and the change opens as a request. Nothing
is written to a default branch; the one exception is the scaffold of a team repository the
orchestrator sets up on the organization's forge (see [Integrations](integrations.md#integrations)).

- The branch is named as the plugin's share names one: a ticket key in the team's
  `commitPrefix` first, then the shape of its `branchExample` (`team/fix-login` gives
  `team/<topic>-<random>`), and `handbook/orchestrator-<topic>-<random>` when the team records
  neither. An example that starts with a ticket (`TEAM-42-fix-login`) leaves `<TICKET>` in the
  proposal for the person to fill in; a request is not opened until they do. A branch name
  carrying a trace of a machine or a credential, or one git refuses, is refused.

- An MCP server passes the plugin's own share rule or does not travel. A value in `env` or
  `headers` that is not a `${VAR}` reference, a token in a URL, a secret pattern or a trace of
  one machine is refused, naming the key and never the value. An edit passes the same rule.
  The edit form starts from the server's definition only when that rule passes it; one it
  refuses is withheld, as in the list, and written again. Removing a server takes out its
  entry alone and keeps the rest of `.mcp.json` as the team wrote it.
- A slash command passes the plugin's own share rule for commands: its name is a path under
  `commands/` (`git:sync` is `commands/git/sync.md`), and a secret or a trace of one machine in
  its text is refused, naming where and never the value. The edit form starts from its text
  only when that rule passes it.
- A skill whose text matches a secret pattern is refused the same way.
- Editing reviewers and labels keeps every other key in `.teamhandbook.json`, and each entry
  passes the plugin's own rule for that file. The same rule filters what a request carries.
- Editing the naming sets `commitPrefix` and `branchExample` in the same file, each passing the
  plugin's own rule; an example left empty is a key removed. A prefix is letters, digits,
  spaces and `. , : / [ ] ( ) _ -`, since the CI job's commits carry it; one a team file
  already records outside that is left unused everywhere the orchestrator reads it, and the setup
  panel says so. The request itself is named the way the team names requests until it is
  merged. A repository whose CI job raises the version (`scripts/bump-version.mjs`) carries
  the prefix in that job's commits, so a new prefix there is refused and
  `/handbook:init --upgrade --commit-prefix "<prefix>"` from a teammate's machine is named: it
  rewrites the team file and the job in one request.
- A repository whose plugin carries a `version` has it raised in the same request, so
  teammates fetch the change once it is merged - every request the orchestrator opens, the one
  asking a team to report skill use included. The raise goes one patch past the default
  branch and past every unmerged branch of the team repository that already claims a higher
  number, as the plugin's own share does: two requests raising to the same number merge as an
  identical line, and the second reaches nobody. The request's description names the branches
  it went past. Requests to one repository take turns from the raise to the opened request, and
  each turn first syncs the orchestrator's copy, so two requests sent at the same moment and a
  teammate's share pushed since the last sync each get a number of their own. Orchestrators of
  several tenants on one Postgres database take that turn together, held under the team
  repository's address. A share pushed between a turn's sync and its request still races it,
  as two teammates' shares race each other.

### Forges and the token vault

Where a request opens depends on the repository:

- **Local forge**, for a repository reached by `file://`. The change is built from git
  objects alone: no file is written to disk, and a symbolic link on a changed path is refused.
  The branch is fetched into the bare repository. An owner or admin merges it from
  **Your turn** on Tasks, and two merges of the same request at once produce one merge commit. On one
  person's own machine, where the repository is their working copy, the merge also moves the
  branch checked out there forward, and its files with it, as `git merge --ff-only` does, with the
  folder's hooks off. When a tracked file holds a change not committed, or the folder's own git
  settings would run a program or reach outside it, **Merge** is refused with the reason and the
  command to merge it there yourself (`git merge <branch>`).
- **GitLab or GitHub.** An admin sets the repository's API address, project and a token under
  **Integrations**. The orchestrator then opens the branch, commit and request through the REST
  API, asks the team's reviewers, applies its labels, and assigns the person who asked when
  their forge login is known. Merging happens on the forge, and **Refresh** reads the state
  back. **Waiting to be merged** on the repository's page lists the open requests there that
  the orchestrator did not open - a teammate's share, one opened by hand - read from the forge
  at most every half minute and again after the orchestrator opens, merges, closes or refreshes a
  request - one the orchestrator merged or closed is never listed, and counts the orchestrator's own toward the list above it; on the
  local forge it lists every branch the default one does not contain. A request the forge refuses to open takes its branch back with it, or names the branch
  left behind.
- **The orchestrator's check on a request a task opened.** Every head such a request moves to is
  checked again against the team's rules once the orchestrator sees it: its watch reads the heads
  every two minutes, and on GitLab or GitHub the forge's signed webhook (`triggerSecretEnv`, see
  [configuration](../operations/configuration.md#configuration)) reports one sooner. On the local
  forge **Merge** checks the head again and refuses a held request. On GitLab or GitHub the result
  is written on the head as the commit status `teamhandbook/pushed-check`, success or failure
  with the reason, and the orchestrator never merges there; to have the forge refuse a head that
  was not checked or did not pass, make `teamhandbook/pushed-check` a required status check of the
  default branch (GitHub: branch protection or a ruleset; GitLab: **Pipelines must succeed** in
  the project's merge request settings). Writing the status takes "Commit statuses: read and
  write" on a GitHub token, `statuses: write` for a GitHub App and the `api` scope on GitLab.

Forge tokens are sealed with AES-256-GCM under `ORCHESTRATOR_SECRET_KEY`, which never enters the
database; without the key no token is stored at all. The same key seals every other secret the
orchestrator keeps: a person's MCP sign-ins and tokens, task secrets, a Slack webhook. An orchestrator only
its one user reaches - it listens on a loopback address, gives no public address elsewhere, names
no `ORCHESTRATOR_TRUSTED_PROXY`, and runs as the built-in admin or holds at most one account - makes a key of its own when none is set,
in `secret.key` in its data directory, readable by its user alone, and says so in its log at
every start. That key sits beside the database it seals, so a copy of the data directory opens
those secrets: set `ORCHESTRATOR_SECRET_KEY` before others reach the orchestrator. While it seals with its
own key it takes no second account, by hand, invitation, single sign-on or SCIM, and says to set
the key first. An orchestrator others reach
makes none and keeps no secrets until the key is set; it names a key it made earlier, which it
uses again only once `ORCHESTRATOR_SECRET_KEY_FILE` points at it. Readiness with the metrics token says
where the key came from (`secrets`: `set`, `generated` or `none`). A token is bound to its tenant, its
repository and the API origin it was entered for. The API answers only whether one is set,
when and by whom. Changing the forge, its address or the project needs a new token: a change
sent without one is refused, and nothing is altered.

### Read before merging

For a request on GitLab or GitHub, `GET /api/repos/<id>/requests/<number>/forge` answers what
the forge says of it, in one shape for both, so a screen or an agent reads one answer:

- **Checks**, folded to one state: `passing`, `failing`, `pending`, `no-ci` or `unknown`, with
  each check listed (failures first, then what is still running) and a rerun of a check counted
  once, as its newest report. On GitLab no check at all means the repository runs no CI; on
  GitHub, where an app can report minutes later, it means `unknown`.
- **Review**: `approved` (with who approved), `changes-requested`, `pending` or `none`. GitLab's
  reviewers approve or say nothing, so `changes-requested` comes only from GitHub.
- **Mergeability**: `mergeable`, `conflict`, `blocked` (with what holds it, in words),
  `checking` or `not-open`.

A read the forge turns down says why in a word a program reads (`unauthenticated`,
`forbidden`, `rate-limited`, `not-found`, `unreachable`) and what to do in words: connect the
forge again, enter a new token, or wait until the time a rate limit gives. A request on the
orchestrator's own copy has no forge to read and is answered 409.
`GET /api/repos/<id>/request-template` returns the team's request template from the places the
forge looks for one (`.gitlab/merge_request_templates/`, `.github/pull_request_template.md` and
the like). The screen does not show either yet.
