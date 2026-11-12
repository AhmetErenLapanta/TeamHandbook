### The screens

Every page sits inside an organization, at `/<organization>/<section>/...`; one orchestrator serves
one organization, so the picker at the top lists that one. Four tabs sit under it, **Work**, **Tasks**,
**Team** and **Integrations**; **Work** shows once the person reads issues from somewhere (see
[Work](../user/work.md#work)). **Settings**, **What's new** and the theme are in the account menu,
under the person's name; the search is beside it.

- **Work**: the sprint board and the backlog of a Jira board, a GitLab project or a GitHub repository, each issue with the orchestrator
  tasks started from it.
- **Tasks**: a person's work by whose turn it is (below), with a **Repository** filter once more
  than one repository has tasks, and the **New task** form.
- **Team**: **Getting set up** (one guide for the organization: an owner or an admin marks steps
  and hides it for everyone, and each change goes to the audit log), **Lessons to review** (keep
  or discard each), on a team's orchestrator the members and **Tasks by person** for the last 30
  days, **Team handbook** (the team's skills, MCP servers and commands) and **Policies**.
- **Integrations**: each service and each repository's forge access.

On one person's own orchestrator, **Team** and the empty first **Tasks** screen carry one card
while the handbook plugin is missing from their Claude Code: "Add the handbook plugin to your
Claude Code. It turns what your sessions teach into skills you keep or share." **Install the
plugin…** says what pressing it does (add the TeamHandbook marketplace to your Claude Code and
install the plugin, with `claude plugin marketplace add` and `claude plugin install`), then
**Install** does it, in your own Claude Code folder, and the card says "The handbook plugin is
installed; your next Claude Code session has it." Nothing is installed except by that click;
**Not now** hides the card. A refusal shows what Claude Code said, and the two commands can be
typed in Claude Code instead. A team's orchestrator never installs anything: its **Team handbook**
shows the commands to copy, under "To get these in your own Claude Code".

Skill use over time (**Usage**: skill use per day for 7, 30 or 90 days; admins and team owners
also see it by team and by skill and export it as CSV or JSON), **Leaderboard**, **Logs** and **Audit**
(the orchestrator's event log, admins only; each change opens on a page of its own at
`/<organization>/activity/audit/<id>`, with the fields it changed and a link to share) are pages
under `/<organization>/activity/`, found in the search and, for Usage and What's new, in the account
menu. A link to `/activity` or `/repositories` opens Tasks, and
`/controls` opens Team.

**Tasks** groups a person's work by whose turn it is: **Your turn** (a change to review or keep, a
question waiting, a task to continue or retry), **The agents' turn** (running or in line),
**Done this week**, and, where tasks run on people's machines, **Waiting for a computer**. Each row
gives its state, its title with where and by whom, how big its change is, and when it last moved.

A task's page puts its change first: **Changes**, each file with its diff, and under it the log,
folded. A rail beside it holds **The ask** (the description, when there is more than the title),
**Where** (the project, the team on a team's orchestrator, and the issue it works on) and **Run**
(the agent, who started it and when, the tests, how long it ran and what it cost).

On Tasks and a task's page a task reads queued, running, needs review, failed, cancelled or
interrupted, and once a person decides, merged or closed for a request and changes kept or changes
undone for a folder without Git. A card on the Work board is an issue, so it says what each state
belongs to (**Agent working**, **Request closed**, **Changes to review**, **Changes kept**), where
the task screens say the state alone.

On your own machine (`local`, see [the README](../../README.md#run-it-on-your-machine)) the
tabs are Work once it reads issues, Tasks, Team and Integrations, and Settings has Your account,
Agent readiness and Task secrets. There is no sign-in screen and nobody to invite.

On a team's or the cloud's orchestrator whose tasks run on people's own machines, a person's
welcome opens on **Connect this computer**: the command with its code is on the screen as it
opens, renewed when the code runs out, and the first machine of theirs that comes online is taken,
with nothing to press. Settings (account menu) > **Your machines** lists the machines that run your tasks, each with its agent CLIs and whether each is signed in. **Connect a machine** gives a
code and the command to run on that machine:

```sh
handbook-orchestrator runner connect <address> <code>
```

The code works once, for five minutes, and a person holds at most three unused ones. The command
pairs the machine and goes on to run the tasks you start there on it, with your own git and
Claude Code sign-in, until Ctrl-C; a task running then is held for **Continue**. Later,
`handbook-orchestrator runner start` runs them again on a machine already connected, for every
organization it is connected to (`runner start <org>` for one), and `runner service install`
runs them whenever you are logged in, with no terminal open. `runner status` lists the
connections, and `runner disconnect <org>` forgets one; the last disconnect removes that service.
**Remove** on the screen stops the machine's key on the orchestrator. A task started while no
machine of yours is connected or reachable waits for one, and its log says which. The machine
gets the task's work with its lease, pushes the task's branch with your git, and the orchestrator
opens the request once the branch passes its checks. A project opened on a folder without Git of
your machine runs its tasks there, in place: the agent edits the folder's files as you, behind the
same guard, which carries the team's path rules as Claude Code's own deny rules, and the change
is checked against them again when the task ends (a change they refuse is taken back). The orchestrator
records only which files changed and how many lines, so the task's page lists the files but shows
no diff. **Undo these changes…** puts them back through the machine, whose runner has to be
running; while a task works in that folder the machine refuses it with "a task is working in this
folder now; undo once it ends". The tasks a machine is not handed yet are under
[Known limits](../internals/known-limits.md#known-limits).

On a cloud orchestrator (`ORCHESTRATOR_MODE=cloud`) a new organization's owner or admin is walked through
its setup at `/<organization>/welcome`, one step at a time, each one skippable:

1. **Connect GitLab or GitHub**, in one click through the organization's connection (see
   [Integrations](../user/integrations.md#integrations)); the forge returns the browser to the welcome.
2. **Pick your team's skills repository**: connect one the connection lists, put the scaffold in
   an empty one, or create a new one (private by default). A GitHub app installed on a personal
   account cannot create a repository there; the welcome shows the three steps to make one by
   hand instead.
3. **Invite your team**, under Settings, Members.
4. **Start a task or connect Jira**: open Work, or connect Jira under Integrations.

On your own machine the first screen is the **New task** form: describe the change and press
**Start**. When nothing in the task or your history points to a folder, a **Which folder** question
lists folders and takes **A folder's path** (see [the README](../../README.md#run-it-on-your-machine)).
The steps are also the list under **Getting set up** on Team.

A step left for later is left for the whole organization and stays under Team's **Getting
set up**, which also lists proposing and merging the first request. A member sees a pointer to
Team instead, and a self-hosted orchestrator has no welcome page. A person who creates an
organization at sign-up lands here (see [Signing up to a cloud orchestrator](../user/people-and-access.md#signing-up-to-a-cloud-orchestrator)).

The search (`/`, or Cmd or Ctrl and K anywhere) finds pages, tasks, projects and, on one person's
own orchestrator, folders by name; `g` and a tab's letter goes to that tab, and `?` lists the keys.
The account menu picks a light or dark theme for that browser. Links from before the tabs (`/#/repo/<id>`, `/#/tasks/<id>`) open the same
page at its new address.
