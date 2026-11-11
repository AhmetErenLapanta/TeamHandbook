## Work

**Work** shows a board the way the team's tracker draws it: the active or a future sprint,
or the board's backlog (`/<organization>/work/backlog`), each issue in the column its status
sits in, with its type, assignee, priority, labels, story points, whether it is blocked, and
the orchestrator tasks started from it, each naming who started its agent. **My work** keeps the
issues assigned to the person or carrying a task they started, and stays in the address.

The page head carries the sprint's dates, the days left and its goal, with **Open in Jira**, then a
line of progress, **Next up** and **Copy the morning summary**. **Next up** names the issue to
start next: one waiting to be done that no agent has touched and nothing blocks, the person's own
first, then by Jira's priority, then in the board's order; pressing it shows the issue in the rail.
**Copy the morning summary** copies plain text for the team's channel: the sprint's counts (done,
points, in progress, to do), then the issues in review, those agents are at work on, the blocked
ones and the next one, one a line. The orchestrator sends it nowhere; the person pastes it, and
where the browser refuses the clipboard the page says to select the board's text instead. Below
it, each card shows its title, parent, key, type, priority, points and assignee, and
the agent's state last. Pressing a card's title shows it in the rail beside the board, whose one
action is **Start an agent**. A board with no sprints (a Kanban board, or a whole project read
through a person's own server) is drawn as the board itself: every issue on it but its epics, which
show as their cards' parent line, and the done ones from the last two weeks. A Scrum board between
sprints keeps its backlog. The board picker names each board's kind: Scrum, Kanban or whole
project. Through a person's own server **My work** is what Jira says is theirs (`assignee =
currentUser()`), even where Jira hides their email; through the organization's token it is matched
by email.

The tab appears once the person has a source to read from:

- **The organization's tracker**, when Integrations has Jira connected with the account's email
  and an API token. It reads as that account, which sees more than any one person should, so its
  boards are shown to owners and admins, and to a team's owners once an owner or an admin maps
  the board to that team (`PUT /api/work/boards/teams`). A board's columns, sprints and story
  points come from Jira's Agile API. The same rule holds for a single issue: the task form's
  preview (`GET /api/issues/preview`) and a task's start read an issue with the organization's
  token only for an owner or an admin, or when the issue's project is on a board mapped to a
  team the person owns. Anyone else gets the issue through an MCP server of their own that
  reads it, or the link alone, and the preview says why.
- **Linear**, when it is the connected tracker, read with the workspace's API key over its GraphQL
  API, queries alone and never a change: a team is a board (Scrum with cycles on, Kanban with them
  off), its active and upcoming cycles are sprints, and its columns are the team's workflow states
  in Linear's order. A card shows the identifier, title, priority, estimate as points, assignee and
  parent, and a `blocked` label marks it blocked; a Kanban team shows its open issues and those done
  in the last two weeks. It moves nothing: the board says "The orchestrator does not move Linear
  issues yet".
- **The person's own Atlassian MCP server**, added under Integrations with a tool that reads
  Jira issues allowed. It reads as that person, through `getAccessibleAtlassianResources`,
  `getVisibleJiraProjects` and `searchJiraIssuesUsingJql`: a project is the board, its sprints
  are found on its issues, and its columns are every status the project's work was in over the
  last three months, done ones too, in Jira's order. **Arrange columns**, folded under the moves
  switch, lets the person name the column each status sits in (statuses given one name share a
  column); it is kept for that person alone, never changes Jira, and the board's counts and moves
  follow it, while a status left out keeps a column of its own and **A column per status** goes
  back. The
  organization's MCP connection for tasks is not a source.
- **GitLab**, through the organization's tracker token when GitLab is the connected tracker, or
  through its GitLab connection (see [Integrations](integrations.md#integrations)): a project is a board, an
  active milestone or a current or upcoming iteration is a sprint, and the columns are Open, the
  project's issue board lists and Closed. An issue sits in the first list one of its labels
  names; a `blocked` label marks it blocked and a `priority::` label names its priority.
- **GitHub**, through the organization's GitHub connection, with a token narrowed to reading
  issues and metadata: a repository the app is installed on is a board, an open milestone is a
  sprint, and an issue is Open or Closed. Pull requests are left out, and GitHub has no story
  points.
- **GitHub on one person's own machine**, through their own gh (`gh api`), signed in to
  github.com: each repository a project's folder names as its origin is a board, read the same
  way. The orchestrator holds no token; a gh that is missing or signed out is named on the page
  with the command that signs it in. A task started from one of these issues gets the issue's
  text and latest comments read with the same gh. When the repository's issues sit on an open
  GitHub Project with a Status field, the board's columns are that field's options in the
  project's order, each issue in its Status there (the first option counts as to do, the last as
  done, and a closed issue as done), read with one GraphQL query and never a change; with no such
  project, or a gh sign-in without the project scope, the board stays Open and Closed.

Boards read with the organization's token or a connection are mapped to teams and shown the
same way. Only Jira boards move issues as the agent works, and only they show the switch for it. A board
or sprint id the page sends back is honoured only when it is one the person is shown, and only
a project key and a sprint id held to their shapes reach a Jira query. The tracker's answers
are kept in the orchestrator process for a minute: a board read again within it is answered from
there, an older answer is shown at once while a new read runs behind it, and **Read the tracker
again** asks the tracker at most every 15 seconds. They are never written to the database, a backup or an export.
A summary, label or name is masked against the credential that read it and withheld when it
reads like a secret. The tasks on each card are read from the orchestrator's own records on every
look, only those the person is allowed to read, and the board reads again every 10 seconds, so a card follows
its agent. A board shows the first 500 issues of a sprint or backlog and says when Jira returned
more. Nothing is set up in the tracker for the
boards: no webhook, and an owner or an admin is never asked to add one.

**Automations** (Integrations, Automations) read their boards the same way: once a minute, each
board an enabled automation watches is read, its active sprints and its backlog, as the owner or
admin who set the automation up, and each issue is compared with the read before. An issue now in
one of the trigger column's statuses, or carrying the trigger label, that was not before is a
change: it drafts a task or starts one, paced and logged as the automation's deliveries. The first
read after the orchestrator starts, or after an automation is made or turned on, is only kept, so a
restart starts nothing for issues already in their column; a change made while the orchestrator is
stopped is not acted on, and an issue outside the active sprints and the backlog is not seen. What
was read is kept in the orchestrator's memory alone. With the organization's automations off, or
none enabled, the boards are not read for them; an automation whose owner or admin no longer is one
reads nothing, and its deliveries say so once.

Nothing in a tracker changes until an owner or an admin turns on "Move Jira issues when a card
moves on Work" on the tracker's card under Integrations; it is off by default, and while it
is off a board reads its tracker and says on its moves switch why it moves nothing.

**Move issues as the agent works.** Each board has the switch, off until turned on, with a
column for each moment guessed from the column names: the agent starting, a request opening,
and the task's requests merged. With it on, a task's issue moves into that column through the
first move its workflow offers, never back, and an issue already in that column or past it
stays. A board counts only when the person who started the task is shown it and the issue is on
it; the organization's board comes first, then the board on the starter's own server. The
organization's board moves issues with its token, which needs Jira's permission to transition
issues, and its switch is changed by an owner or an admin; a board on a person's own server
moves them as that person, through `getTransitionsForJiraIssue` and `transitionJiraIssue`, and
its switch is theirs. Each move is written to the event log before it is sent (`work.moved`,
`work.move-skipped`, `work.move-failed`), so an orchestrator whose log refuses it moves nothing. A
person moves an issue by hand on the board (`POST /api/work/items/<key>/transition`) through
their own server, or with the organization's token when they are an owner or an admin or own
the board's team.

**Start agents.** Pick issues on the board and start one agent per issue together (`POST
/api/tasks/batch`, 1 to 20 items, one agent for all). Each issue becomes its own task with the
issue as its link, either in one repository or, with **Let each agent find the repositories its
issue changes**, over several (`"targets": "orchestrator"`, see [A task over several
repositories](tasks.md#a-task-over-several-repositories)). Each item is started or refused on its own,
in order, and the answer lists the refused ones by their place in the list with the reason; the
started ones wait in the organization's one queue like any other task, and the budget each start
reads counts the ones before it.
