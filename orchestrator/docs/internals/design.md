# The orchestrator's design

The one design document: the decisions every screen is built from, and the tokens and classes
that carry them out. A change to the web app reads it first; a change that breaks a rule here
changes the rule here, with its reason, in the same change.

## Who, what, how it should feel

- **Who.** A developer, or someone who works beside developers, who hands work to coding agents:
  one person on their own machine, or a team on a shared orchestrator. They know their folders and
  their tools; they do not want to learn ours.
- **The job.** Hand a repository (or a folder) and a sentence to an agent, then review what it
  changed and keep it or undo it. Everything else (the repositories, requests, the team and its
  policies, settings) serves that review.
- **The feel.** A work tool that is quiet until something needs a person: dense enough to read the
  changes and the log on one screen, calm enough that the one thing waiting is what the eye finds.
  It reads like a well-kept terminal and code review, not like a product page.

## The product's own words

Said one way in screen text; `web/src/words.ts` holds the nouns and their sentences. The words in
the last column are not used in what a person reads on screen; this document and the code use them
where they are the precise term.

| Word | Means | Not on screen |
|---|---|---|
| Repository | Where a task's agent works: a team's repository, or a folder on one person's own orchestrator, called Folder there | project, workspace; repository, to someone without Git |
| Task | One piece of work an agent does in a repository or folder | job, run, ticket |
| Changes | What a task did to the files, waiting for review | diff, output |
| Keep / Undo | The two answers to a task's changes | accept, reject, apply, revert |
| Merge request, pull request | A task's change on its forge, named only in its link: "Merge request !12 on GitLab", "Pull request #12 on GitHub"; on the person's own machine there is none, only the task | request, PR, MR |
| To review | Everything that waits for the person | inbox, notifications |
| Agent | Claude Code, OpenCode or the stand-in that does a task | AI, bot, assistant |

## One thing: the task

A person sees one thing, the task; the change it proposes is a stage of it, never a second row,
page or state. Every list (Tasks, a Work card, the task history) has one row a task, the
repositories it changed and their forge links inside it. No screen shows an internal name (a
repository's id, a request's number on the orchestrator's own copy) or a placeholder address; a
repository is called by its folder's name, and on a Personal orchestrator its person is "you".

A task's state is one sequence, the same word in every list, head and card, as a dot in its tone
and the word:

| State | Word | Tone |
|---|---|---|
| In line | waiting its turn | neutral |
| Running | working | working |
| Held | at the usage limit, waiting for your machine | waiting |
| Wants its person | needs you (a question, or a change to review) | waiting |
| Kept locally | kept on this machine | ok |
| On its forge | in review on GitLab, in review on GitHub | working |
| Done | merged | ok |
| Taken back | undone | neutral |
| Ended badly | failed | danger |
| Ended by a person or a limit | stopped | neutral |

The history of tasks opens from "All tasks" under Tasks' sections: the same rows, filtered by
state and by folder, with no filter by kind.

## Three defaults we refuse

Each is what an unconsidered interface does by itself; each has its replacement.

1. **The stack of cards.** Every section in the same bordered, rounded, shadowed box, so nothing
   leads. Instead: a page is one surface; its sections are a heading, the content and a single
   hairline between them. A box is drawn only around a thing acted on as one: a field, a menu, a
   dialog, the list of changed files, a question waiting for an answer. Nothing else gets one.
2. **The dashboard costume.** Letter-spaced capital eyebrows, a row of big numbers with small labels
   under them, a pill badge on every state, metadata strung with middle dots. Instead: headings in
   sentence case, facts as one plain sentence, a state as a word with a small coloured mark.
3. **The untouched system stack.** The browser's default sans for everything, headings that differ
   from body text by a pixel, the product name half in link blue. Instead: one shipped family with
   its own mono, a short scale where each step is visibly a step, and a wordmark in one colour.

## Rules taken from the references

Learned from reading Linear, GitHub Primer, VS Code and Zed, rewritten as our own; nothing is copied.

**A dense tool with almost no colour**
1. The interface is grey; colour is information. A coloured pixel says a state or an action.
2. One accent, used only on what can be clicked or has focus.
3. Both themes come from the same few variables; a theme is a different lightness, not a different design.
4. Density is a feature: rows of 32 to 36 px, text at 13 to 14 px, nothing padded to look roomy.
5. Hierarchy from the weight and greyness of text, not from boxes.

**Code review**
1. Changes are read in mono on a quiet ground; added and removed lines are tinted, never boxed.
2. A file's row carries its path in mono, its change as a word and its counts in green and red.
3. Mono is for what a machine reads or prints: paths, SHAs, commands, logs, patches. Never for labels.
4. Counts sit beside what they count, in tabular figures.
5. States are words first; colour confirms, it does not replace the word.
6. A dense type scale: 12, 13, 14, 16, 20; body is 14, secondary 13, smallest 12.

**Panes and keys**
1. Regions are separated by a line and a change of surface, not by margins and shadows.
2. The top bar is one row: where you are on the left, what you reach on the right.
3. Lists are rows moved through with the arrow keys; Enter acts on the row.
4. A secondary area (the log) folds away and remembers that it was folded; opening it holds for that task alone, so one task's open log never opens the next one's.
5. A state is a small mark and a word in a fixed place, not a banner.

## Tokens

All in `web/src/design/tokens.css`. Outside it no stylesheet and no inline style names a raw
colour, radius, shadow or font size; `web/src/design/tokens.test.ts` fails on one.

- **Type.** `--text-xs` 12, `--text-sm` 13, `--text-base` 14, `--text-md` 16, `--text-lg` 20;
  weights 400, 500, 600; line heights on a 4 px grid (`--leading-xs` 16 to `--leading-lg` 28).
  Figures are tabular wherever numbers line up: counts, durations, costs, times.
- **Space.** 4 px steps, `--space-1` 4 to `--space-12` 48.
- **Radius.** `--radius-sm` 4 (key, inline code), `--radius` 6 (control), `--radius-lg` 8 (layer,
  the changed files' box). `--radius-full` only for round marks (the avatar, a state's dot).
- **Depth.** One strategy: a 1 px border. A shadow only under a layer that floats: menu
  (`--shadow-layer`), dialog (`--shadow-dialog`), a switch's knob.
- **Colour.** One neutral hue and chroma (`--neutral-h`, `--neutral-c`); a theme sets only the
  lightness of each step: `--canvas`, `--surface`, `--surface-sunken`, `--surface-hover`, `--border`,
  `--border-strong`, `--border-field` (3:1 on the surface, as a control's edge must be), `--text`,
  `--text-muted`. One interaction accent, `--accent`. States, each with a `-soft` tint: `--ok` (ended
  as wanted, added lines), `--danger` (failed, removed lines), `--warn` (waits on a person),
  `--working` (an agent at work, a teal, never the accent). `--hunk` for a patch's hunk
  headers, a quiet grey.
- **Motion.** Transform and opacity only, `--duration-fast` 120 to `--duration-slow` 190 ms, none
  when reduced motion is asked for.

`web/src/design/tone.ts` names the one tone of every state: amber waits on a person, teal is an
agent at work, green ended as wanted, red failed, grey waits on nothing or was set aside.

## The type

Shipped with the app from `web/public/fonts/`, each family with its OFL licence beside it; there is
no CDN, so a local orchestrator works offline and asks nothing of the network.

**IBM Plex Sans and IBM Plex Mono**, chosen over two other pairs drawn on the task page:

- *Source Sans 3 with Source Code Pro*: very legible, but its small x-height read a size smaller at
  13 and 14 px, and its figures set looser in a line of facts.
- *Public Sans with JetBrains Mono*: a clean pair, and the most common mono in tools built this year,
  the look this design refuses.
- *Plex*: one family, so a path in a sentence and the sentence agree; open shapes that stay readable
  at 12 and 13 px; true tabular figures; a mono drawn for terminals. Titles at 20 px sit at
  `--tracking-tight`.

## The layout

A page runs the full width of the window under the one-row top bar; nothing sits in a narrow
centred column with empty margins. Four shared parts build every screen:

- **The page head.** The title at 20px semibold, under it one sentence that says where the page
  stands ("Nine this week across five folders. Three wait on you."), and the page's actions at the
  right of the title. On a page about one thing (a task, a member) the head stays in view while the
  page scrolls, so its main action never leaves the screen. `PageHead` in `web/src/design/`.
- **Whose turn.** A list of things that wait on people and agents is cut into sections by whose
  move it is, not by a status filter: on Tasks, Your turn, The agents' turn, Done this week and
  Waiting for a computer. Each section has its name, its count and one sentence on the left, its
  rows on the right. A section with nothing in it stays, with the sentence that says what would
  land there, as long as something could land there: one that cannot fill where it is drawn (Waiting
  for a computer on one person's own orchestrator) is not drawn. `TurnSection`; the rows of Tasks
  are `table.row-cards.turn-rows`, its columns fixed so every section lines up.
- **The change weight.** Five squares that show how big a change is and how much of it is added
  against removed: green for added, red for removed, empty for the rest. The same squares on a task's
  row and on each file of its changes, so a reader weighs a change the same way in both places.
  `ChangeWeight`.
- **The right rail.** A page about one thing keeps its main surface wide on the left (the diff, the
  log, the folder list) and a 320px rail on the right for what is read beside it: what was asked,
  what the agent says, where it ran and the folded log. On a phone the rail drops below the main
  surface. `.with-rail` and `aside.rail`.

One search: the top bar holds a Search button and no field. Cmd/Ctrl+K opens the command palette
from anywhere, and jumps to a page, a repository or a task, and on one person's own orchestrator
to a folder, which it opens. Search and `/` open the same palette,
except on a page that has a search of its own (the folder picker, the log): there they put the
cursor in that page's field, so a page never shows two.

- **A list is rows, not a box.** Rows are parted by hairlines; no outer frame, rounded or not, holds
  a list. Column names, where a list has them, sit once above it in the muted colour (Tasks:
  Changes, Ran, Cost, When), not repeated in each section.
- **A path is one piece.** A path is written once, whole, in mono (`~/code/on-call-notes`); the
  machine it is on is a plain label beside it ("On ada-laptop"), never a breadcrumb of spaced
  slashes.

## Personal and Team

Two experiences, one layout. Personal is the orchestrator on one person's own computer: no
sign-in, their Claude Code, their folders, their gh and glab. Team is a shared server, run by the
team or by us; the two are the same code and the same screens. Product text never says local,
self-hosted or cloud; where the difference has to be named it is Personal or Team, and a Team
server run by the team reads exactly as one run by us.

- **Every screen is laid out the same in both**: the same pages, the same sections in the same
  order, the same default page in Settings, the same words. A page that opens in one and is not
  found in the other, or opens with other sections, other order or other words, is a bug.
- **A difference is allowed only where one experience physically lacks the thing**, for one of six
  reasons, and each allowed difference is a row of `browser-tests/experience-differences.ts`
  (screen, which experience has it, the item, why). The structure test opens every main screen in
  both and fails on any difference that is not a row there.
  1. *Signing in and the organization*, Team only: sign-in and joining, the organization picker,
     the role line, Settings' Members, Service accounts, API keys, Access, Security and
     Organization.
  2. *Other people*, Team only: People, invitations, tasks by person, the leaderboard and the
     audit, a board's teams, a task's team, the team picker for a task secret.
  3. *Other computers*, Team only: Your machines, waiting for a computer, a task waiting for its
     person's machine.
  4. *This computer*, Personal only: Updates, what the person's Claude Code loads, the count of
     their MCP servers, the agent's sign-in line in the task form, adding a skill source from the
     form, and the steps of Getting set up (the section is in both; its steps differ).
  5. *Where a change goes*: Personal keeps or discards a change and opens a merge request itself;
     Team's change reaches its forge as a request.
  6. *Nouns that say whose or where*: Folder and Repository, "your" and "the team's", Skills and
     Team skills; the sentence around them is the same.

## The first screen

The orchestrator opens on Tasks and asks no folder: a task picks where it works from what it is
asked (Where your code lives, below). Tasks' empty state is the first screen: the one page whose
title is the product's promise rather than the page's name, then one box, "What needs doing?",
and Start; work started from an issue arrives in it with the issue filled in. No folder line, no
picker and no second question come before Start. While the field is empty, "Or start with"
offers up to three tasks found in the folders tasks work in (a TODO, a failing test) as rows
parted by hairlines, the task above and where it was found under it in mono; a row fills the
field with the whole ask and never starts it, so Start stays the person's.

## Where your code lives

Never asked. The folders a task can work in come from the person's own Claude Code: the names of
its project folders (nothing in them is read) and the folders that hold a CLAUDE.md, the most
recently used first; home, SDK and archive folders and the orchestrator's own never count. Each
task's folder is picked by the orchestrator from what the task asks, by the folders' names and the
first heading of each CLAUDE.md, and said in the run's first line; when nothing points to one, the
folder the person ran the most Claude Code sessions in, and the run's second line says what it loaded
there (skills, CLAUDE.md, memory); with no session known, the person is asked which folder, in one
line. A folder is one repository or one that holds many, as a terminal's working
folder is, and the agent decides which repositories in it to touch. On a team's orchestrator in
the cloud the answer is the organization's connected repositories instead, and nothing is asked.

- **The person's own checkouts are never touched.** Every repository the agent changes gets a
  copy on the task's own branch; the review is grouped by repository, each group with its own
  Keep and, where the repository has a forge, its own request. Nothing on screen names the copy.
- **Settings > Where your code lives** is one page on the person's own orchestrator, its sections
  parted by hairlines: Folders tasks work in, a row each with its name, its path in mono and when
  a task last worked there, most recent first, with "Add a folder" under them for one Claude Code
  has not opened, which brings the folder picker; Skills and MCP servers for tasks (by name in
  mono, each with where it comes from; turning one off is that row's one control). No team
  section: the orchestrator is one person's. Nothing is set per folder or repository, so a row is
  not a link. On a Team server the same page holds the same two sections: Repositories tasks work
  in, a row each with its name and its team (none connected: one sentence pointing to
  Integrations), then Skills and MCP servers for tasks, the ones the team's repositories declare,
  each with its repository, read only, under one sentence: "They change through a request to the
  repository that declares them."
- **A task in the folder runs with the person's own Claude Code settings**, so neither its page
  nor its rail asks about the folder's settings or how far its agent acts without asking.
- **GitHub and GitLab** are only where requests open: connecting one adds no repository, lists
  none and asks for none.

## Tasks

The home page: the wordmark opens it, and so does the orchestrator. "What needs doing?" and Start
sit at its top every time, then one sentence that is the day at a glance ("2 wait on you, 1 is
working; 3 kept this week for $4.10"), then one list in its whose-turn sections (Your turn for
what waits on the person, The agents' turn for what runs, Done this week for what was kept,
undone or failed), with no rail beside it. Its column names sit once above it, and a section with
nothing in it is not drawn.

- **Narrowing** to a repository is one control in the list's head, the shared `Select` with "All
  repositories" first, then the repositories tasks have changed; it is a filter, never a step.
- **New task asks for no repository.** What to do and the agent are the form's two choices; the
  task runs where the code lives. Code tasks ask for no repository; a skill task names the skills
  repository it lands in, shown only when the team has more than one.
- **What a task changed** says it in the review, not before: the head's sentence names the
  repositories ("Changed payments-api and payments-worker"), and the changes are grouped under
  each repository's name in mono, with that group's Keep and request.
- **Each repository's group** says where its work lands, as one muted line in its request card or
  above its Keep: on a team's orchestrator, a repository with a forge, "Its work reaches
  payments-api only as a request, which a person merges."; on a person's own orchestrator, a
  repository whose remote is on GitLab or GitHub, "Your checkout changes only when you keep this,
  and nothing reaches GitLab until you open a merge request there."; a repository without a
  remote, "Your checkout changes only when you keep this."; a folder without Git, "The agent
  changed these files in place; keep or undo each change."
- **Nothing reaches a forge on its own.** On a person's own orchestrator the group of a repository
  whose remote is on GitLab or GitHub has, beside its Keep, a secondary named for what it does:
  "Open a merge request" (GitHub: "Open a pull request"). It pushes the task's branch with the
  person's own CLI and opens the request there; once it is open, the group's line says "Merge
  request !12 is open on GitLab." with the number as its link, and the button is gone.
- **One filled Keep at most.** A group's "Keep these changes" is filled only when it is the one
  group still waiting for an answer; while several wait, each group's Keep is a secondary beside its
  Discard. The head offers no Keep for every repository at once: each is read and answered on its
  own.
- **A repository with no remote, on a person's computer,** keeps its change on the task's branch
  there, so the orchestrator shows no diff for it. Its group says so in that same line, "With no
  remote to push to, its change stays on the branch task/add-retry in this repository on
  ada-laptop.", with the command that opens it under the line as `CopyText` ("git switch
  task/add-retry"). The head has no main action for it, and when every change stays that way its
  sentence says where: "The agent finished in 1s, changing delivery-service; the change stays on
  its branch on ada-laptop." The other causes keep the same shape, the cause first: "Nothing is
  pushed to its remote yet, so its change stays on the branch …", with "Open a merge request"
  under it once that action exists; "Its remote is not one of this
  organization's connected repositories, so its change stays on the branch …".
- **Requests** the orchestrator opened that wait to be merged are rows of Your turn, with the task
  they came from; there is no page of requests.
- **A task waiting for a computer** links to Your machines in Settings, and the palette reaches it
  by name.

## The repository panel

In a folder nothing is set per repository: the folder's page in Settings holds what its tasks
get. On a team's orchestrator in the cloud, a connected repository's settings open as a panel from
the right edge, 480px wide, from its row in Settings > Where your code lives; Esc or Close shuts it
and what was under it stays where it was. It is one dialog, not a page, and holds four sections in
this order, each a heading and its rows, parted by hairlines:

- **Checks**: the commands its tasks are checked with, as the first task box shows them, and
  Change.
- **Trust**: how far its agents act without asking, as one choice with a sentence for each.
- **Skills and MCP servers**: those on in this repository, by name in mono, each with where it
  comes from; turning one off is that row's one control.
- **Team**: the team it belongs to, and who may start tasks in it.

On a phone the panel takes the whole screen. `dialog.side-panel`.

## Team

The page what TeamHandbook adds lives on, in plain words and by name, never as counts of things
shared. Its head says where the team stands in one sentence ("5 people; 12 skills and 3 MCP
servers shared; 1 lesson waits for review"), with Invite members as its action.

- **A setup problem**, only when there is one, sits first under the head as one sentence in the
  waiting tone and one action that fixes it ("2 teammates have not joined the team's skills
  repository: Copy the join command"). No sentence when nothing is wrong, and never a vague one.
- **Lessons to review**: each lesson a row (its name in mono, the task it came from, what the
  person said that it comes from); the picked one opens in the right rail with its skill's text,
  Keep filled and Discard beside it, "Never suggest it again" as a checkbox.
- **People**: a person a row, with their role (the row's one control), and over the last 30 days
  the tasks they kept, undid and merged and what their tasks cost. Pending invitations follow
  them, picked to Resend or Revoke once.
- **Team handbook**: one section, three tabs as a `.segmented` choice, Skills, MCP servers and
  Commands, each a list of rows: the name in mono, one sentence of what it does, the team's
  repository it comes from, and the tasks started with it this month. A picked row opens in the
  right rail with its text (a skill's SKILL.md, a server's settings with their values sealed, a
  command's text) and two actions, "Update…", which turns the text into a field and sends the
  change, and "Remove…", asked first. Over the list, "Add from your Claude Code" opens the
  person's own skills, MCP servers and commands as rows with a checkbox, the same list
  /handbook:share shows, and "Propose 3 to the team" sends what is ticked. Every add, update and
  remove is one request to the team's repository that the person's click opens and a person
  merges; until it is merged its row says so ("Proposed in !12, lands once merged"). A lesson
  kept from Lessons to review lands here as a proposed skill.
  The tabs sit inside the section's `TurnSection`, over its rows; a row's source follows its
  sentence, muted, "from payments-skills"; with more than one team repository a `Select` over the
  tabs picks which. "Add from your Claude Code" turns the list itself into the picking list, ticks
  kept across the three tabs, "Propose 3 to the team" filled and Cancel under it; the rail stays
  for a picked row.
- **Policies**, for an owner or an admin alone: the task templates, the MCP servers retired from
  teammates' sessions, Bash kept read-only, the monthly budget; each policy a row with its state in
  words, picked to change it in the right rail. A member does not see the section.
- **Getting set up**: a team with nothing set up yet sees the setup steps as the page's empty state
  (connect the team's repository, invite teammates, send them the join command, hand a task to an
  agent), each with its one action, the next one first. Once a step is done it leaves; a step
  that later breaks comes back only as the setup problem line above.
- **On one person's own orchestrator** Team has no people; it holds the lessons to review and the
  Team handbook in the same place. With no team repository yet, the Team handbook is the person's
  own setup: one sentence first, "Your Claude Code loads 134 skills, 11 MCP servers, a CLAUDE.md
  and its memory; tasks here use them.", then the tabs folded under "Show them", each row "from
  your Claude Code", read only, and one action, "Share with a team", which offers "Start a team
  handbook" or "Join a team handbook". The top bar keeps its four sections either way.
- **The handbook plugin, on one person's own orchestrator**, which reads this computer's Claude
  Code: when the plugin is not in it, one card sits right under Team's head, before any section,
  with no heading and no box, a hairline under it like a row. A sentence, its first part in the
  strong weight ("Add the handbook plugin to your Claude Code. It turns what your sessions teach
  into skills you keep or share."), then "Install the plugin…" filled and "Not now" beside it.
  Pressed, it says first what it does, in one muted sentence naming the two commands in mono
  (`claude plugin marketplace add`, `claude plugin install`) and "Nothing else changes", with
  Install filled and Cancel beside it; nothing runs before that press. While it runs Install reads
  "Installing…" and waits; a refusal is the CLI's own reason in the danger tone with "Install the
  plugin…" again; done, the card is one sentence, "The handbook plugin is installed; your next
  Claude Code session has it." "Not now" puts it away for good; the plugin already there draws
  nothing.
- **On a team's orchestrator** there is no card: it runs on the team's server, which neither sees
  a person's computer nor installs anything on it. The Team handbook section carries one muted line
  under its tabs instead, "To get these in your own Claude Code:" with the join command as
  `CopyText`, the same command the setup line hands to teammates who have not joined.
- **An empty section is not drawn**, in either experience: no "Lessons to review 0", no "Getting
  set up" once nothing is left; the page holds what has something in it. A page with nothing at
  all in it shows its empty state, one sentence and one action.

Each section is a `TurnSection` (name, count, sentence on the left, rows on the right), the picked
row's actions in the right rail. Usage over time and the old Activity's news are one link each
in the account menu, not sections.

## Integrations

One card a service, one question asked once. Not connected, the card's one button is Connect (or
"Sign in with …"); connected, it has no main action, only its state and the account ("Connected as
ada-dev"), with Disconnect under Other ways to connect. Nothing asks for a repository: connecting a
forge is the whole step. A service already answered elsewhere on the page is not asked again (with
Jira connected, no "Issue tracker: Not set up" row). The page is the same in every mode: Start
here (the trackers), Code hosting, Notifications, each card's words the same. A person's own
orchestrator lists nothing found on the machine; tasks already use that person's MCP servers, and
one line under the page's sentence says so: "Your tasks use the 11 MCP servers in your Claude Code."

## The Work board

- **Page head:** the sprint's name as the title; the sentence says its dates, how many days are
  left, and how many of its issues agents worked on and for what cost. Under it one thin line of
  progress (points done, in review or QA, in progress, to do), each with its words beside it, no
  big numbers. Open in Jira as the secondary action. Under the line, "Copy the morning summary"
  copies the sprint's state as text to paste where the team talks; nothing is posted anywhere.
- **Columns** are the team's own statuses as Jira names them, each with its count and points.
- **A card** reads like Jira's: the title, the parent issue under it, then the key, the type, the
  priority, the points and the assignee. A flagged card has the waiting tone and says why. When an
  agent has touched the issue the card's last line is the agent's state (at work, asks you, changes
  to review, request open) as a dot and its words.
- **The right rail** shows the picked card: the key, the title, its facts, what the issue says, and
  what agents did on it. Its one action is Start an agent; the card itself carries none.
- **On a phone** the columns become one switch and the picked column's cards stack under it.

## The new task form

It opens under the Tasks page head in place of the list's first section, with its own right rail beside it.
The field for what to do comes first and takes an issue link as well as words; the agent sits
under it, and nothing asks where the task works; the skills the agent loads are rows with a checkbox, the skill's name in mono,
one sentence of what it does and where it comes from (yours, the team's, this repository's);
model, budget and tools fold under More options. A task on a team's skills repository is any
change at first, so its Kind of task (Any change, Write a new skill, Improve a skill) folds under
More options too; picking another kind keeps the fold open with the skill's name or the skill
under it. Start task is the
one filled action, Cancel beside it. The rail says before it starts where the agent works, whether
Undo or a request takes the change back, and the limits a task stops at (on a team's orchestrator
also the team's commands and network); on a person's own orchestrator where it works is said once
it starts, in its run's first line. An MCP server the task will load that needs a sign-in is said
before Start, under the field: "2 MCP servers need sign-in: GitLab, Notion" with Sign in beside
each, since a task cannot sign in once it runs. The limits link to Settings > Task limits, so the settings a
task runs under are one step from the place that starts it.

**Settings > Task limits**, on a person's own orchestrator: two fields, "Most a task spends" in
dollars and "Longest a task runs" in minutes (10 and 60 at first), each with a "No limit"
checkbox beside it, and Save. One sentence over them: "A task stops at whichever comes first;
the task form says both before Start."

## Rows and actions

- **A row is the target.** No row carries its own action buttons, and no action appears only on
  hover. An action on one row shows once, in the page's action line once the row is selected, or on
  the row's own page. The one exception is a row's editable value, such as a member's role: that
  single control stays in the row.
- **An add form waits behind its button.** A list shows its rows, or its one empty line, and under
  them one secondary named for what it adds ("Add an MCP server"); the form opens in place from
  it, its own button adds, and Cancel folds it back. A picked row's action shows once a row is
  picked, never as a disabled button beside the heading.
- **The folder picker.** One search, the page's own. A row of the list goes into that folder; a
  suggestion is a folder to open. "Open <name>" shows once, in a line at the foot of the list
  that stays in view, for the folder the list is in or the row picked; Up one folder (or Backspace)
  and the path climb out. By keyboard: type to search, Enter opens, Right arrow looks inside,
  Backspace goes up, a pasted path goes straight there; Cmd/Ctrl+K reaches the same folders from
  any page. It has no rail: the keys work without a legend. Each row says Git or No Git, and the
  foot says where a change lands for the folder it opens (in place, or on a branch ending in a
  request), only when one of the listed folders has Git; to
  someone none of whose folders has Git the picker says "in place" alone and never names Git,
  a branch or a request.
- **One main action a state.** Each state has one filled action, with its counterpart beside it as
  a secondary where there is one. A task waiting for review in a folder without Git: "Keep these
  changes" filled, "Undo these changes…" beside it (never "Undo all"). With Git on a person's own
  orchestrator, "Keep these changes" filled brings the task's branch into the checkout's, and
  "Discard these changes…" beside it, asked first, drops the branch and leaves the checkout as it
  is; no line or link names the request behind them, and a merge refused where the branch is
  checked out says so with the command to run there as `CopyText`. On a team's orchestrator, its
  request. Both sit in the page's header line, which stays in view while the page scrolls. A task
  that is queued, running or waiting: "Stop…", a danger action, outlined, in the foot row of the
  live run (below), not the head. The accent never fills a destructive action.
- **One file of a change.** A file's own action sits at the foot of its open patch, small and
  secondary, never on its row: "Undo this file…" where the change is in place, "Take out of the
  request…" where it is a request on a team's orchestrator, and "Discard this file's change…" where
  it waits on the task's branch on a person's own orchestrator, which names no request. It asks first, in place, what happens to that file and that the
  rest stay ("README.md goes back to how it was before the task; the other files stay as they
  are."; for a file the task added, "README.md is deleted; …"), then "Undo this file" and "Keep
  it". An undone file keeps its place in the list with "undone" as its change, and no counts and
  no action; Keep and Undo in the head act on the files left, and the task reads undone once none
  is left.
- **Why, in one line.** Undoing, one file or all of them, asks inside its question for one line on
  why: an `input` labelled "Why", "Goes in the task's log" under it, never required. The line then
  follows who undid it: "Undone by Ada at 14:02: the title was right as it was."

## The task page

- **Page head**, staying in view: the title, the task's state (dot and word), the main action and
  its counterpart; under it the facts as one plain sentence (the repository, the agent, who started
  it, how long it took). A fact with no value (unknown, not run) is left out, not said.
- **Main surface**, wide on the left: waiting for review, the changes, each file a row with its
  path, its change and its change weight, its patch under it with the line numbers before and
  after; running, the live run (below), with the agent's question or request for permission in it.
- **Right rail**: You asked (the description as plain text, no box), what the agent says, Where
  (the folder, and whether Undo or a request takes the change back), Run (agent, machine, started,
  ran, cost, and Loaded: what the agent loaded, the same list the task form shows) and the log, folded once the task ended.
  What a run cost reads beside what made it large: Cost ("$0.41"), then Context ("48k tokens at
  its start"), then Loaded, three rows of facts with no sentence joining them, since the
  orchestrator measures each but not how much one caused the other. Ran is the agent's own time:
  the minutes a card stood waiting for its person are not in it, and read on their own row once
  they pass a minute ("Waited 7m for you"). An ended run whose agent reported no cost reads "Cost
  Not reported" in the rail, since that is a fact about the run; a list's cost column says nothing.
  While it runs, the head's sentence counts on its own, a second at a time, the time and the
  running total: "The agent has worked 3m 12s; $0.41 so far." A value not known is left out.
- **Notices, asked where they mean something.** On a working task its person started, one muted
  line under the head, until the browser has been asked: "Away from this page when it needs you?"
  with "Get a notification" and "Not now" as links beside it, spaced, with no dot between. The
  account menu keeps the standing switch.
- **On a phone** the rail follows the changes, and a patch scrolls sideways with a visible edge
  saying there is more.
- **Going on from a review**, the same section in both experiences: under the changes of a task
  waiting for its starter's review, "Continue with a follow-up", one field, the quoted lines as
  chips over it, and "Start the next run". Its note says where the next run starts, in the words
  of where the change is now: with a request open, "A new run starts on the request's branch with
  your words, and the request gets its new changes."; with none yet, "A new run starts where this
  one left off, with your words, and its changes join this review." A team's orchestrator offers
  it as a person's own does.
- **Sharing to read.** "Share…" in the head, a secondary, opens one field in the rail's Shared
  with section, "A teammate's email", with Share and Cancel. The people it is shared with are rows
  there, picked to remove ("Remove…" shows once one is picked). They read the page without its
  answers; an address outside the organization is refused in one line, with Invite them on Members
  for someone who manages it.
- **Answering with its own lines.** Lines picked in a patch offer one small button under them,
  "Quote lines 38-40 in a follow-up"; nothing is quoted until it is pressed. Quotes gather as
  chips above the follow-up's field, each with its own remove, and Start the next run sends them
  with the words to a new run on the same branch.
- **Standing still.** A task that waits says why in one `div.waiting` line, with its one action
  beside it. A usage limit says what is reached and what happens next: "Your plan's usage limit
  is reached; the task goes on by itself at 14:00." (or "at 14:00 tomorrow"); past a day, "Your
  plan's usage limit is reached until Nov 7 at 14:00; continue the task then."; with no reset
  time, "Your plan's usage limit is reached; continue the task once it resets." Its row in Tasks
  and its head's state say "at the usage limit" in the waiting tone, as a task kept for a machine
  says "waiting for your machine"; neither reads as "queued", since neither waits its turn. While
  it waits the head's sentence counts no time, since the agent is not working: "The agent has spent
  $0.41 so far."

## Facts a task gains

A new fact about a task lands in a place the task page or the task form already has: a sentence,
a line of the rail's facts, or a fold. None of them adds a box, a tab or a menu item, and each says
its detail behind a fold rather than on the page.

- **Its checks.** The commands a repository's work is checked with are found once and confirmed in the
  first task box. Start confirms only what is in view, so everything it confirms is shown open,
  never behind Change or a fold: one line a command, the setup first ("npm ci"), each with what it
  runs in mono beside it ("npm test" runs "node --test"), wrapped rather than cut however long,
  and "reaches the network" in the waiting tone beside a command that does. Change, after the
  list, is where the list is edited; it hides nothing Start confirms. `ul.task-checks`.
  On the task page the rail's first section is Checks: a command a line, in mono, with its state
  words before and after the agent's work ("passed before, passed after"). Repair rounds are part
  of the line ("passed after 1 repair round"). A change whose checks still fail keeps the task's
  own state in the head and says so in the head's sentence ("Its tests still fail after 2 repair
  rounds."), with the failing line in the danger tone; no badge, no banner.
- **What the agent loaded.** Under the task form's agent field, one muted sentence ("Claude Code
  loads 12 skills or commands, 3 MCP servers and CLAUDE.md"; its list holds skills and slash
  commands together, so the sentence names both), the list behind a fold. On the task page the same
  sentence is a line of the rail's Run section.
- **What it taught.** The rail's last section, Learned, holds one sentence of what is known: the
  skills the task started with ("Started with 3 team skills; 1 lesson waits for your review"), not
  ones it is said to have used until that is recorded. The lesson is decided in the sentence's own
  fold: what it would teach, what the person said that it comes from ("You said: …"), the skill's
  text, then Keep, filled, and Reject beside it with "Never suggest it again" as a checkbox. A kept
  lesson's line reads "kept as your skill". Nothing learned, no section.

## The live task

While a task runs, its page's main surface is the run itself, drawn from the agent's events. It is
never a mirror of a terminal: each event is drawn as what it is, so nothing the agent's tools print
reaches the page except as a fold the person opens. It is the task page in another state, not a
screen or a menu of its own.

- **Page head**, staying in view: the title, "working" as a dot and its words, and the time it
  has run and what it has cost so far, counting as they change.
- **The plan.** When the agent keeps a to-do list, it sits under the head and stays in view with it:
  one line an item, an empty ring for one not started, the working tone for the one in progress, a
  check and muted words for one done. Items change in place; nothing moves but the mark. Past five
  items it shows the one in progress and "4 more", which opens the rest. No list, no plan.
- **Where it works** is the stream's first line on a person's own orchestrator, said from facts
  about the folder, never from the model's own words for why: "Working in ~/code/payments-api,
  which its CLAUDE.md calls Payments API" when the folder's CLAUDE.md has a heading, "Working in
  ~/code/payments-api" when it has none, and "Working in ~/code/notes, the folder you use most" when
  nothing in the task pointed to one; with Change beside it. Change opens the other folders as a
  menu, most recently used first, and "Another folder…" for the picker; picking one asks first
  ("The task starts again in ~/code/notes; what it did so far is dropped.") and starts it there.
- **The stream**, under the plan, oldest first. Two weights only:
  - *The agent's words* are the main text: base size, the text's own colour, the surface's width,
    Markdown drawn from its parts, no name repeated per line.
  - *Its tool calls* hang under the words they follow, indented by the fold's column, one line each
    in the small size and the muted colour, the target in the text's colour. Each line is a fold,
    closed, opened by the line itself; what is in it is described below.
  - *Time*: a line carries none; a pause of over a minute shows one quiet line with the time.
  - *What the person sent*: their own line, marked You, where it was sent.
- **A tool call's line** reads mark, verb, target, then its result as a state word in its tone:
  "Read payments-api/README.md", "Searched "credit report", 12 matches", "Edited runbook.md" with
  its change weight and counts, "Ran npm test" failed, "Read PAY-412 in Jira" refused. No middle
  dot joins its parts.
  - *The mark* sits first, in one fixed column: a turning ring in the working tone while it runs
    (still under reduced motion), a muted check once done, a cross in the danger tone when it
    failed, a slashed ring in the danger tone when it was refused.
  - *Names in the product's words.* A built-in tool is its verb: Read, Edited, Wrote, Ran,
    Searched, Fetched. An MCP tool is the same verb-first line, its source last: "Read PAY-412 in
    Jira", "Searched Confluence for "release notes"". The verb is the tool's name in words, with
    get, fetch and view said as "Read" and query as "Searched"; the target is the call's main
    argument, an issue key, a page's title, a query in quotes; the source is the service it reaches
    when known (Jira, Confluence, GitHub, GitLab, Sentry, Linear, Notion, Slack), else its server's
    name without a plugin prefix. A known tool whose target the event does not carry names what it
    acts on instead: "Read an issue in Jira". A tool nothing is known of reads "Used <its name in words> in
    <server>". The raw name shows only in the fold.
  - *Paths* are short: relative to the task's folder, and outside it with home as `~`; mono for
    the path and the command only.
  - *Calls of one kind in a row* join into one line that still says what: "Read deliver.ts,
    retry.ts and 2 more files", "Searched 3 times: "credit report", "credit score" and 1 more".
    Its fold lists each call as its own line.
  - *The fold* holds what the call did, closed until the person opens it: an edit's patch,
    numbered as on the changes; a command's output, its last 20 lines while it runs and once it
    ends, then "Show all 1,240 lines", which opens the rest in a box that scrolls on its own; a
    search's matches, a line each; a refusal's reason; and the raw tool name and its arguments,
    masked where a secret would show. A read's fold holds no file text, only what was read ("240
    lines of src/ChatService.kt"): the file is in the folder, and the run is the story of the work,
    not a copy of the code. Nothing a tool prints reaches the stream outside a fold, and the task's
    Log, which keeps every line as it came, stays folded under the run while it works.
- **A refused call** says so on its line, refused as its state word, and why in its fold ("Writing
  to the tracker is off for every task"). Refused again for the same reason, it joins the first
  line ("refused 4 times") rather than repeating. A refusal the person can lift, a tool this task
  is not allowed, brings the permission card into the stream once, the same card a request for
  permission draws (Allow once, Allow for this task, Deny); a firm refusal, a write to the tracker
  or a forge or to the orchestrator's own data, brings no card, only its line and its reason.
  When what was refused is the task's own issue, the card also offers "Paste the issue text", a
  field in place whose text the agent reads instead. While the card waits the agent waits too,
  spending nothing; the head's state says "needs you".
- **The current step** is the stream's last line while the agent works, never drawn twice: while
  a call runs, that call's own line is it, its words in the muted colour with the working tone
  passing across them once a second (still under reduced motion), next to its turning ring; a
  joined line whose last call runs is the one that shimmers. Between calls one line of its own,
  "Thinking…", takes the place, and goes once the next call starts.
- **Following.** The stream keeps its newest line in view. Scrolling up stops that, and "Jump to
  latest", one small secondary centred just above the foot row, takes the person back and resumes
  it; scrolling back to the bottom by hand does the same.
- **Cards.** A question or a request for permission sits in the stream where the agent asked it,
  the only block there with a hairline edge: the question, its options as rows, its one filled
  action. While it waits, the head's state says "needs you". Answered, it shrinks to one line ("You
  allowed npm test once").
- **The plan to start from.** A task started with "Show me the plan before it changes anything",
  one checkbox under the task form's field and off by default, stops once the agent has read and
  puts its plan in the stream as a card of the same kind: the plan as the agent wrote it, its steps
  a numbered list, then "Start with this plan" filled, "Change the plan" beside it, which turns
  the plan into a field in place, and Copy. Started, the card shrinks to one line ("You started
  with the plan, 5 steps") and its steps become the to-do list at the top. A plan is never saved
  or opened anywhere on the person's behalf; Copy is how it is kept.
- **The person's words** read as theirs at a squint: what they told the agent sits in the stream
  where they sent it, set to the right on the sunken surface with the radius, "You" (or the
  teammate's name) leading it, while the agent's lines stay flat on the left. A message sent while
  the agent is mid-step waits for its next one in the same block above the foot row, drawn as not
  sent yet: no fill, a dashed hairline. "Waiting for the agent's next step" heads them in one muted
  line, and each keeps Edit and Remove, quiet buttons, at its right end, so they line up row under
  row. On a phone the sentence keeps the whole width and its quote note, Edit and Remove go on a
  line under it, the buttons still at the right end. Read by the agent, a message leaves the
  waiting rows and appears in the stream as said.
- **The foot row** stays at the foot of the surface whenever the task is queued, running or waiting
  and the reader can stop it, even before the stream has a line: "Stop…", a danger action,
  outlined and asked first. Where the reader can steer the agent, the row also holds the steer
  field, one field that grows as it is typed in, "Tell the agent something while it works", and
  Send, filled once there is text. Enter sends, Shift+Enter starts a new line. While a card waits
  for its answer the field is not drawn and Stop stays: the agent waits on the card, so the card's
  answer is the one thing to type.
- **The right rail** grows as the run goes: Changed so far, each file with its change weight as it
  lands; then Run (agent, machine, started).
- **Ended**, the main surface turns back to the changes, and the stream folds under them as "How
  the agent got here", the same lines kept for the review.
- **Failed with nothing to review**, there are no changes to turn back to: the reason heads the
  main surface in the danger tone, the stream stays open under it so the last lines before the
  failure are in view, and the head's sentence says how long it ran ("The agent stopped after
  1m 26s.").
- **Stopped**, by a limit or by a person, the head's state says "stopped" and its sentence gives
  the one reason, never two: "Stopped at its $10 limit after 5m 15s.", "Stopped at its 60-minute
  limit.", "Ada stopped it after 2m 4s.". What it changed by then stays for review as on any ended
  task; with nothing changed, the stream stays open under the sentence as for a failure.
- **What never shows.** A secret is masked where it would appear, with a muted "masked" beside it.
  On a team orchestrator a call to a person's own MCP server shows as its line alone ("Used a tool
  on Ada's machine"); its output stays on that machine.
- **On a phone** the plan folds to the item in progress, the foot row stays at the foot of the
  screen, and the rail follows the stream.

The parts by name, for the screens that draw them: `.run-plan` (`li` with `data-state` of `todo`,
`doing` or `done`), `ol.run-stream > li.run-line` with `data-kind` of `say`, `tool`, `card`, `you`
or `time`, its fold a `details`, a tool line's mark `.run-mark` with `data-status` of `running`,
`done`, `failed` or `refused`, the running call's line `data-current`, "Thinking…" between calls `li.run-line[data-kind="now"]`,
"Jump to latest" `button.run-jump`, the messages waiting for the agent `section.queued`, a `li` each,
the foot row `form.run-steer` holding Stop and, where steering
is offered, the field and Send, and in the rail `ul.run-changed`, a file
a line with its path and its `ChangeWeight`.

## Controls

Every control is drawn by the design: select, checkbox, radio, the fold of a `details`, textarea.
No control shows the browser's own look beside a styled one. A textarea grows with what is typed
into it, so it has no resize handle. An outlined button's edge reaches 3:1 like a field's: a
secondary in `--border-field`, a danger in `--danger`. The fold mark is one drawn chevron, pointing
right when closed and down when open.

## Components and classes

| Thing | Markup |
|---|---|
| Page head | `<PageHead title summary actions crumb sticky>`: the title, one sentence, the actions at the title's right; `sticky` on a page about one thing |
| Whose turn | `<TurnSection name count why empty>`: name, count and sentence on the left, rows on the right; `.turn-columns` holds a list's column names once above it |
| Change weight | `<ChangeWeight added removed />`: five squares, the same on a row and on a file |
| Right rail | `div.with-rail` around the main surface and `aside.rail` of `section`s, each with an `h2`; below 1024px the rail follows |
| Search | the bar's Search button and `CommandPalette`; a page's own search field carries `data-page-search`, which `/` and Search focus there |
| Main action | `<button>` or `<a class="button">`, one per state |
| Other actions | `.secondary` (the field's 3:1 edge); `.ghost`; `.danger` (outlined, for what cannot be undone); `.link`; `.small` |
| Field | `input`, `select`, `textarea` with `--border-field`; `aria-invalid="true"` marks one in error |
| Section | `section.section > h2`: a heading, its content, a hairline above the next |
| State | `span.state.<tone>`: a dot in the tone's colour, then the word; the tone from `toneOf` |
| Steps | `ol.step-list > li.step-item` with `.step-mark` (`.done` once done) |
| Empty | `.empty-state`: what the place is for and the one action that fills it |
| Loading | `<Loading what="…" />`: the words, with the shape of what lands beside them |
| Failing | `<LoadFailed what="…" reason onRetry />`: "Couldn't load …", the reason, Retry |
| Folder picker | `.folder-picker`: its own field (`data-page-search`), `.folder-place` (`.folder-machine` label, `.folder-at` path in mono, Up one folder), `.folder-group` over `ul.folder-list > button.folder-row` parted by hairlines, one Open in the foot that stays in view |
| Task box | `form.task-box`: the folder, the field for what to do, Start |
| Changes | `ul.diff-files`: one box; each file a row (fold mark, path, change, `.diff-stat` counts), its patch (`DiffPatch`) joined under it |
| Patch | `DiffPatch`: hunks only, git's header lines left out once there is a hunk; read in the page's scroll; a line wider than its box scrolls sideways in `.patch-scroll`, whose right edge darkens while there is more |
| Waiting | `div.waiting`: why the task stands still, one line with a dot in the waiting tone, its one action beside it |
| Log | `ol.task-log` in a sunken well; `details.section.log-fold` folds it |
| Choice of a few | `.segmented`: the picked one lifted onto the surface, not filled |
| List table | `table.row-cards`: below a desktop's width each row becomes stacked lines divided by a hairline |
| Layers | `dialog.dialog`, `.toast`, menus: the only things with a shadow |
| Key | `kbd` |

## Loading, empty and failing

Every section that reads something draws all three: the loading words with the shape beside them,
the failure with its reason and the step that puts it right, and an empty place with the one action
that fills it. A count says nothing until its list has loaded. `browser-tests/design.spec.ts` draws
the main sections in all three and measures that moving between the top tabs does not make the page
jump.

## The top bar

One row: the wordmark in one colour, the four sections (Work, Tasks, Team, Integrations), then the
Search button and the account menu, which holds Settings, What's new and usage over time. On a
phone the sections gather into one menu and the wordmark is TeamHandbook alone; the bar has no
room for both words beside the menu, the search and the account. The bar has no search field of its own: Search and `/`
open the command palette, or on a page with its own search put the cursor there; Cmd/Ctrl+K always
opens the palette. The account menu holds the one switch for the browser's notices, "Notify me when
my tasks need me", and a browser that blocks them says so under it in one muted line.

A section's own pages (`SubNav`) sit as tabs under its title. Past five, on a phone they gather the
same way into one menu named for the open page, under a hairline, so Settings' eleven pages never
wrap into rows of tabs.

## Keyboard

Shared on every page: `?` lists the keys, `/` opens the command palette (or the page's own search,
where it has one), Cmd/Ctrl+K opens the palette from anywhere, a field included, `g` and a
section's first letter go to that section. In the palette the arrow keys move, Enter opens and Esc
closes; on a folder the right arrow looks inside it and Backspace after a "/" goes up one. A list moves with the arrow keys and Enter acts on its row. No page shows a permanent line
of keys; a key is in the `?` list and in its button's tip.

## Copy

- Each screen says the next step once: one button, or one short line.
- At most one help sentence in a region; anything longer goes behind the (i).
- A button is the name of what it does: "Keep these changes", not "Continue".
- Sentence case everywhere; no title case, no capitals for labels.
- No em dash, no "label — fragment" captions, no arrow after a button's words, no middle dots
  joining metadata.
- No may, might or could: say what happens.

## Signs of an unconsidered interface

Always a sign:

1. One untuned sans for everything; headings and body nearly the same size and weight.
2. Purple or indigo gradients, gradient text, glows, neon on dark.
3. Cream ground with italic serif and terracotta.
4. The card stack: equal rounded cards, one radius, the same soft shadow, cards in cards.
5. A rounded-square icon tile over every heading; emoji or generic line icons in place of content.
6. Letter-spaced capital eyebrows, pills over headings, numbered sections with no real order.
7. The hero metric: a big number, a small label, side stats.
8. Even spacing that groups nothing; drifting values (a 36 px button here, 40 px there).
9. Coloured edge stripes, frosted glass, blobs, dot-grid grounds.
10. Everything fading in, a status dot that pulses while nothing changes, bouncy easing.
11. Generic claims, em dashes, "WORD — fragment", arrows after button words, middle-dot metadata.
12. Grey text on a coloured ground; missing empty, error or loading states.

Not a sign in a developer tool:

- Mono for paths, SHAs, patches, logs and code (a sign only on small labels as decoration).
- A tinted near-black, when it is one step of the surface ladder.
- One interaction accent and semantic colours that carry meaning.
- A dot that pulses while something is actually being waited on, and stops when it arrives.
- The current step's words, swept by the working tone while the agent is at work on it; still under reduced motion.
- On a phone, a checkbox, a radio and the (i) reach 24 px to the touch.

Before a screen ships:

- **Swap.** Put this screen in another product; would anyone notice? If not, it has no point of view.
- **Squint.** Blur it; the main thing and the one action still lead.
- **Signature.** Name the detail that belongs to this product: the review of a task's changes in
  place, kept or undone in one step, with the folder it touched and nothing else around it.
- **Token name.** Every value on screen maps to a token by name.

## Gates

1. `web/src/design/tokens.test.ts`, without a browser: outside `tokens.css` no raw colour, radius,
   shadow or font size, in a stylesheet or a `style={{…}}`.
2. A computed-style audit in Playwright: every font, size, colour, radius and shadow on the main
   screens is a token; text at least 4.5:1, a field's edge 3:1; nothing overflows; both themes.
3. Screenshot baselines are added once the direction is accepted.
