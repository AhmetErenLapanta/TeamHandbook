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
| Handbook | Where a skill, command, MCP server or hook comes from: yours, a folder's, a plugin (the team's handbook is one), or the team's repository | source, scope, marketplace (except as where a plugin comes from) |
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

On a Personal orchestrator nothing shows a team, a role or an identity the person did not give:

| Seen on a Personal orchestrator | Says instead |
|---|---|
| "owner@this-machine.invalid allowed once." | "You allowed writing src/endpoints/delivery-window.ts once." |
| "Read with a token set by owner@this-machine.invalid" | "Read with your API token." |
| "Enabled by Solo Person" | nothing: the switch's state says it |
| "An owner or an admin turns it on under Integrations." | "Turn it on under Integrations." with the link |
| "on the request's branch ... the request gets its new changes" (no forge request) | "where this one left off ... its changes join this review" |
| "The agent changed nothing, so no request was opened." | the "finished, nothing changed" state and its sentence |

A request is named only once one is open on a forge, in its link; a team's orchestrator names its
people by name and its roles as they are.

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
| Ended with nothing to keep | finished, nothing changed | neutral |
| Taken back | undone | neutral |
| Ended badly | failed | danger |
| Ended by a person or a limit | stopped | neutral |

"finished, nothing changed" is a result, not a failure: the agent ended without changing a file
(it answered, or found nothing to change). It sits under Done this week, not Your turn, and counts
in the day's sentence neither as waiting nor as kept. A task in line says why when the reason is
another task: "Starts once you answer Expose the delivery-window endpoint to customers, which works
in the same folder.", the other task's title a link, in its row's second line and its head's
sentence.

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
- **Space.** 4 px steps, `--space-1` 4 to `--space-12` 48. `--fold-indent`, 16, is how far what
  opens under a row goes in (see The layout).
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
- **What opens under a row starts under its name.** A skill's text, a handbook's items, a
  sub-tab, a fold's contents: everything that opens under a row or a heading begins where that
  row's name does, `--fold-indent` in from the edge (the chevron and its gap), never under the
  chevron and never against the left edge. It is one rule in `components.css`; a screen sets no
  indent of its own, and a fold inside a fold goes in by the same step again. A fold's chevron
  turns as it opens, on every fold, a name that opens included.
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
     audit, a board's teams, a task's team, the team picker for a task secret, and Getting set
     up (its steps are a team repository and invitations).
  3. *Other computers*, Team only: Your machines, waiting for a computer, a task waiting for its
     person's machine.
  4. *This computer*, Personal only: Updates, what the person's Claude Code loads, the count of
     their MCP servers, the agent's sign-in line in the task form, adding a skill source from the
     form.
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
  section: the orchestrator is one person's. The one thing a folder carries is its checks: the
  first time a task works in a folder, the agent reads it for the commands that test and build
  it, and the folder's row gains one line, "Found: npm test from package.json, npm run lint from
  package.json", with "Approve" as the row's one action and, beside it, "Not these…", which
  turns the line into the commands as checkboxes to keep or leave. Nothing found runs until it
  is approved; approved, the line reads "Checks after each task: npm test, npm run lint" and
  "Change…" stays. That task's review says it once, under its checks: "npm test and npm run lint
  were found for this folder; approve them to run after each task." with "Review them", which
  opens that row. Otherwise a row is not a link. On a Team server the same page holds the same two sections: Repositories tasks work
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

- **A task that repeats** is set in the form's More options, "Repeat": Once first, then "Every
  day", "Every weekday", "Every Monday" (and the other days) with a time, at most once a day; the
  rail then says "Runs every weekday at 9:00 on this machine, under the same limits; a run this
  machine is off for is skipped and said." Repeats are a section of Tasks, drawn only when there
  are some, above Done this week: each a row with what it does, when, its next run, and "Stop
  repeating…" asked first. A skipped run is a muted line in that row: "Skipped Tue 9:00: this
  machine was off." Each run is an ordinary task in the list.
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
- **A request the person opened** shows its forge's state in the group, under its link, as one
  line in the forge's own facts: "Merge request !12 on GitLab: checks passing, 1 approval, 3
  comments, read at 10:42". It is read once as the page opens, with the person's own sign-in, and
  never refreshed in the background; "Read again" beside it reads it on the press. Not readable,
  the line says why and nothing else: "Not read from GitLab for now: sign in to GitLab from
  Integrations." Merged or closed there, the task's state follows ("merged"), and the line says
  by whom when the forge says.
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
- **Getting set up**, on a team's orchestrator only: a team with nothing set up yet sees the setup steps as the page's empty state
  (connect the team's repository, invite teammates, send them the join command, hand a task to an
  agent), each with its one action, the next one first. Once a step is done it leaves; a step
  that later breaks comes back only as the setup problem line above. A person's own orchestrator
  has no setup list and no sentence about "before the team works here": a task finds its folder
  itself and asks once, in the first task, when it cannot (Where your code lives), and a folder is
  added only from Settings > Where your code lives.
- **On one person's own orchestrator** Team has no people; it holds the lessons to review and
  "Your handbooks" (see Handbooks below) in the place of the Team handbook, the team's handbook
  being one of its rows once there is one. With no team repository yet, "Share with a team" under
  that section offers "Start a team handbook" or "Join a team handbook". The top bar keeps its four
  sections either way.
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

## Handbooks

Everything an agent loads, a skill, a command, an MCP server or a hook, comes from one handbook,
and every screen names it the same way, muted after the thing's name in mono: `add-endpoint`
from payments-skills 1.4.0. The handbooks and their labels:

| Handbook | Label | Is |
|---|---|---|
| Yours | yours | the person's own Claude Code setup on this machine |
| This folder | this folder (payments-api) | a folder's own `.claude`, CLAUDE.md and `.mcp.json` |
| A plugin | payments-skills 1.4.0 | a Claude Code plugin, its name and version; where it comes from is said when it is opened |
| The team's | the team's payments-skills | the team's repository the orchestrator serves |

A thing whose handbook is not known reads "from an unknown handbook", never blank. Only names are
shown of what a handbook holds; a server's settings and any secret in them are never read.

**One list, three places, two levels.** The same list, `HandbookList`, is drawn in three places:

| Where | What it sets | Its line above the list |
|---|---|---|
| Team, "Your handbooks" | how every agent started here begins | "How agents started here begin. Turning a plugin off turns it off in your terminal too." |
| New task form, "This task will use" | this task alone, as changes from your default | "Only for this task. Your default stays the same." |
| Task page, "Started with" | nothing: what the task started with and used, read only | none |

Your handbooks reads the person's Claude Code setup as it is: what they change in their terminal
shows here. A switch means the same on every row, "agents started here do not start with it", and
what else it does is said on the row it is on:

| Switched off | What happens | The row then says |
|---|---|---|
| A plugin | Claude Code's own command runs, so it is off in the terminal too | "off", and the reach label beside its switch, "here and in your terminal", says the rest |
| A skill, a command or an MCP server | the orchestrator keeps it for this person and leaves it out of each task it starts | "off", and "here" beside its switch; opened, "Off for agents started here. Your terminal still has it." |
| One skill of a plugin | the same, as far as the agent allows | "off"; opened, "Off for agents started here: the agent cannot call it; its name still shows." |

Where a switch reaches is read before it is pressed, not after. The line above the list is set
in the text colour at the body size, never muted or small. Each switch carries its reach beside
it, always, in two words or four: "here" on a skill, a command or a server, "here and in your
terminal" on a plugin. A plugin's switch says which command ran, once, muted: "Ran claude plugin
disable payments-skills."; refused, the row keeps its state and shows the CLI's own reason. The
orchestrator writes no setting into the person's Claude Code files; the one thing written as a
file is the person's own skill or command, edited, removed or made, with its change shown first.
A task's setup is the other level: it is how that one task's agent is started, written nowhere on
disk, and gone with the task.
All four kinds are managed there, each by its own way of writing:

| Kind | What the person does | How it is written |
|---|---|---|
| Skill, Command | reads, edits, removes, makes a new one (Yours and This folder) | its own text file, the change shown first |
| MCP server | sees, adds, removes, signs in | Claude Code's own `mcp` commands |
| Plugin | turns on and off, updates, removes, installs from a marketplace Claude Code knows | Claude Code's own `plugin` commands |
| Hook | sees, and switches where Claude Code has a command for it | never edited |

An action Claude Code has no command for is not drawn, as a switch is not.

- **At first glance** the list is its handbooks, a row each: Yours, This folder, then plugins by
  name. A handbook's row: its name, its version where it has one, how much of it is on ("5 of 7
  on"), and its switch, which shows a mixed state when some of it is off; Yours and This folder
  have no switch of their own, only their items do. A handbook that is off has no count: its row
  says only "off", and the reach label beside its switch stays. Above the rows one summary line,
  which carries the counts, so the section's heading has none: "14 handbooks, 84 of 159 on",
  with ", 2 updates" when there are some. Its context part, "about 2.1k tokens in every task", is
  there only where something was measured: skills, commands, CLAUDE.md and memory are counted
  before a task, and MCP servers as measured in the last task, "plus about 6k for servers, as
  measured in your last task"; nothing is started to measure them. Where nothing was measured the
  summary has no context part, and "not measured yet" is said only on a server's own row once it
  is opened. Past a tenth of the context the summary takes the waiting tone. A search field shows
  only past 20 items. Handbooks that are off do not sit among the others: they are folded under
  "Off (9)" below the list, the same rows, "off" where a count would be.
- **A handbook opened**, in place, lists its items, at most seven, then "Show all (14)"; what is
  off comes last, folded under "Off (2)". An item's row, the same in all three places: the name,
  its kind in one word (Skill, Server, Command, Hook, Rules), and at the end its switch, or on
  the task page its state word. At 390 it breaks in two lines, the name and the switch above,
  the kind and what the row says under.
- **A row opened**, in place, starts with what it is: a skill's description as one plain sentence,
  read from its frontmatter however that is written, then its body in reading form; the
  frontmatter itself is not shown raw, only when the text is edited. Then what it costs ("in
  every task about 146 tokens, when used about 30") and its text links, "Edit" for Yours and This
  folder, "Remove". How it is used is on the row itself, at its right, muted: "used in 14 tasks,
  last 3 days ago", or "Not used in 30 days; turn off?" for one that takes context; never inside
  what opened. A hook opened shows its event, its matcher and the command it runs, in mono,
  masked as the stream masks and cut at 200 characters, a part that looks like a secret reading
  "(withheld)"; environment values are never shown. A hook is never edited or switched from here,
  only seen. CLAUDE.md and rules open into their text in reading form, with "Edit" for Yours and
  This folder, as a skill does. A row whose content cannot be shown has no chevron. Switches
  save at once; there is no Save.
- **A switch is drawn only where it does something**, and what one task can leave out is what the
  default can; with Claude Code:

  | Item | Switch | What the row says, when it needs to |
  |---|---|---|
  | A plugin | yes | "Kept on by your organization's policy." and no switch, where that is so |
  | A skill or command of Yours or This folder | yes | |
  | One skill of a plugin | yes | "The agent cannot call it; its name still shows." |
  | An MCP server of Yours or This folder | yes | |
  | One MCP server of a plugin | no | "It comes with its plugin; turn the plugin off." |
  | One hook | no | "Claude Code does not leave out one hook; turn off the plugin it comes with." A hook of the person's own settings says "Claude Code runs your own hooks in every session." |

  With OpenCode a server is switched, one skill is switched and still listed to the agent, and
  its plugins are switched only all together; nothing of OpenCode's setup is installed, updated or
  removed from here, and the list says so once: "OpenCode's plugins are changed in its own
  settings." There is never a switch that does nothing.
- **Two of the same name** from different handbooks say which one an agent gets, on both rows:
  "Two skills are named release-notes: yours is the one loaded; this folder's is not.", the
  order being the agent's own, as its CLI shows it (for Claude Code: what an organization manages,
  then Yours, then This folder, then a command of the same name). A plugin's skill carries its
  plugin's name and so never takes another's place. Where the order is not known the row says so
  rather than guess: "Two skills are named release-notes, in yours and this folder; which one an
  agent gets is not known."
- **Editing** opens a skill's SKILL.md, or a command's file, in the right rail, as plain text; "Save…" shows the change
  as a patch first, then "Save" and "Keep editing", and names the file it writes; a value that
  looks like a password or key stops the save with one line saying so, and a name already taken
  is refused rather than written over. "Remove…" asks first, naming the folder it deletes, or for a plugin the command it runs and that it
  is not undone here: "This runs claude plugin uninstall payments-skills; your terminal loses it
  too, and it cannot be put back from here. Turn it off instead?", with "Turn off" first and
  "Remove" beside it as the danger action. A plugin's or
  the team's skill or command is not edited here: "Copy to Yours" makes it yours, and for the
  team's, "Improve this skill…" opens the request flow to its repository.
- **Adding** is one quiet control over the list, "Add", a menu of four: New skill, New command, Add
  an MCP server, Add a plugin; each opens the right rail. A new skill is three fields, its name,
  when to use it, and its body, saved under the plugin's skill rules; a new command is its name
  and its text. A plugin is picked from a search: a field and a marketplace choice first; with nothing typed only
  the plugins of the marketplaces the person added are listed, and the official catalogue only
  when searched. A list never spills onto the page: at most eight rows, then "Show more", in a
  box of fixed height that scrolls. A row is the name, one sentence kept to one line and cut with
  an ellipsis, and "Install…" at its right; what it brings ("6 skills, 1 hook") is said when the
  row is opened, then "Install",
  asked first with the command it runs and, named one by one, the hooks and MCP servers it
  brings: the person agrees to them there. A marketplace Claude Code does not know yet is added in
  the terminal: the rail shows that command as `CopyText` and adds none itself.
- **An MCP server's row** opened says who it is for, how it is reached ("a local command", "over
  HTTP"), whether it needs a sign-in, with "Sign in" beside that as on the task form, and its
  context as measured in the last task. Who it is for is one of three, in these words everywhere:

  | For | Means |
  |---|---|
  | every folder | the person's, wherever they work |
  | this folder, only you (payments-api) | the person's, in this folder; nothing in the repository changes |
  | this folder, shared in its repository (payments-api) | written in the folder's `.mcp.json`, which the repository shares with the team |

  Its one text link is "Remove…", asked first with the command it runs. Claude Code has no command
  to move a server from one of these to another, and its values are not read, so moving is the
  person's own removing and adding again; nothing here offers it. A server an organization
  manages has no actions and says "Set by your organization." The two kinds of server are told apart
  by who uses them: what Claude Code holds is the agent's tools in a task; what the orchestrator
  holds (the Integrations cards) is what the orchestrator itself reads, for Work and an issue's
  text. Those show in the same list as "from this orchestrator", with their own actions,
  "Disconnect…" and "Choose tools", so there is one list of servers and one place to add one for
  agents: "Add" here. On a person's own orchestrator Integrations > Your MCP servers has no Add
  form and says one line: "Servers your tasks use are in Team, under Your handbooks." On a
  team's orchestrator, where no Claude Code of the person's runs, that section keeps its Add
  form, since only the orchestrator holds a server there.
- **Adding an MCP server** is one form in the rail: its name, "Reached by" as a `.segmented`
  choice (Over HTTP, A local command), then the address, or the command and its arguments, and
  "For", the three above, "this folder, only you" picked first: nothing reaches a repository on
  its own. Environment values and headers are rows of a name and a password field; under a
  command field, muted: "Put no secret in the command; a secret goes in a value below." Before it
  runs the form shows the whole command with each value as dots, "This runs claude mcp add
  --transport http tracker https://tracker.example.invalid/mcp --header Authorization: ••••",
  then "Add the server" and "Keep editing". Shared in its repository, the question adds what that
  writes: "…; this writes .mcp.json in payments-api, which the repository shares." Under the
  value fields, muted: "Kept by Claude Code in its own settings, not by the orchestrator." The
  values go to that command as they are typed and are kept nowhere else: not in the orchestrator,
  not in a log, and once added only their names are ever shown again. What the command prints is
  not shown, since it repeats headers and commands; the result is the orchestrator's own sentence,
  "tracker is added for every folder." or "Claude Code did not add tracker.", the second with the
  command, its values left out, as `CopyText` to run in the terminal and see why. On a team's
  orchestrator a server that needs a value is not added from the page: the rail shows the command
  to run in the person's own terminal as `CopyText`.
- **An update** reads on the plugin's row "1.4.2 → 1.5.0"; opened, what it adds, changes and
  removes, the hooks (event and command) and MCP servers it brings named first, a changed skill's
  patch readable, and "Update" is the surface's one filled action while
  that row is open, asked first, the question saying again what the press brings: "This runs
  claude plugin marketplace update payments-market and claude plugin update payments-skills. 1.5.0
  brings 1 hook (after each edit) and 1 MCP server, adds add-webhook and removes old-deploy.",
  the CLI's result after it.
- **What a handbook runs** is told, never held back. The orchestrator turns off nothing the person
  installed: a task starts with everything they have not turned off, as their terminal does.
  Plugins seen for the first time, or updated, that run hooks or MCP servers are told in one
  line, never one line each, on Team and on the task form: "3 plugins run hooks or servers:
  payments-skills, docs-kit, release-tools." with "Look", which opens the first of them with its
  hooks and servers listed first, and a written button, "Got it". Pressing Got it puts the line
  away and says once, muted, where the line was, "Put away; nothing changed." There is no ×,
  which a person takes for deleting. Nothing waits on the line. Where the orchestrator itself installs or updates, the agreeing is on that press,
  which shows what it brings before it runs.
- **What the screen says is what the agent got.** What the form and the task page show as on and
  off is what the agent reports it loaded. A difference is written on the task page, in its
  block's first line: "payments-skills was on and did not load." Something off that loaded
  stops the task, as below.
- **On the new task form** "This task will use" is one folded line under the agent: "This task
  will use your default setup, 14 items". It sits in the form's main column, never in the right
  rail, which is too narrow to hold a list of a hundred items. Opened, the same list in the same
  order with switches alone, no Edit, Update or Remove, as wide as the column, each row's switch
  at the column's right edge; a plugin opens to switch its items. A row switched here reads
  "Changed" and keeps its place. With changes the folded line reads "2 changes from your default"
  with "Reset", and under the list "Change your default on Team" links there. Start task stays the
  form's one filled action.
- **On the task page** one block in the rail says it all, "Started with", and nothing else there
  counts skills: no separate Loaded row, no "called 3 skills" line. Its first line is the count
  of what the task started with, "12 skills, 3 plugins, 4 MCP servers, CLAUDE.md". Under it,
  only what was used, a row each: the name, a link to the stream line where the agent called it,
  and its handbook, "add-endpoint from payments-skills 1.4.0", "jira from yours". Then two folds,
  "Loaded (9)" and "Off for this task (2)", each the same rows. Used is a skill the agent called
  or an MCP server whose tool it called; hooks, rules and CLAUDE.md are always Loaded, since
  their use is not recorded. Rows carry those words, never the form's counts ("8 of 8 on"). The
  handbooks are the ones the form and Team show, This folder among them, the same in all three
  places. The version is the one the task started with. Something turned off that loaded anyway
  stops the task before its first step: its state is "stopped", its sentence "Stopped before its
  first step: release-notes is off and was loaded anyway.", and its row reads "Loaded, though
  off" in the danger tone. No switch or button; the names are its only links.
- **A used skill the task corrected** (a change undone, a request denied, a follow-up sent) is
  offered once in the task's review, not in the list: "add-endpoint was used, and its change was
  undone." with "Improve this skill…", or "Copy to Yours" for a plugin's skill outside the team's
  repository.
- **A lesson kept from a task** asks where it lands, a `.segmented` choice in its Keep: Yours
  (first and picked), This folder (payments-api), The team (a request to its repository, the
  Team handbook's own Add).
- **On a team's orchestrator** Your handbooks shows only what a person's own machine reports
  ("Read from ada-laptop"), and a change there is made on that machine by its runner, with the
  same commands; the shared server touches nobody's home folder. With no machine of theirs
  connected the section is not drawn. The
  Team handbook keeps its rows, each skill gaining its last change ("changed Tue by Lin") and
  "N tasks this month".
- **At 390** what opens in the right rail elsewhere (a skill's text, its editor, an adding form)
  opens as the side panel over the page, full width, its head staying in view with its title, ×
  and, while editing, "Save…". The list under it keeps its place.
- **Built in this order**, and a control is not drawn before its slice lands: first the list as
  read (handbooks, items, the summary, what each row says), the switches and the task page's "Started with";
  then editing, removing and making a skill or command, and a plugin's update with what it
  changes; then adding an MCP server and installing a plugin.
- **Empty**, the list is one sentence: "Your Claude Code has no skills of its own yet." with
  "Add".

## Integrations

One card a service, one question asked once. Not connected, the card's one button is Connect (or
"Sign in with …"); connected, it has no main action, only its state and the account ("Connected as
ada-dev"), with Disconnect under Other ways to connect. Nothing asks for a repository: connecting a
forge is the whole step. A service already answered elsewhere on the page is not asked again (with
Jira connected, no "Issue tracker: Not set up" row). The page is the same in every mode: Start
here (the trackers), Code hosting, Notifications, each card's words the same. A section's heading
runs the full width and its cards sit side by side under it in a grid of at least 320 px a
column, the same minimum in every section, so a wide screen gives three or four columns and a
phone one; no section is a single narrow column beside empty space. A person's own
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
- **The columns share the page's width** while no card is picked: there is no rail, and no "No
  issue picked" placeholder holding a third of the width, so a sprint of seven statuses fits a
  1440 screen side by side. The board scrolls sideways, with the edge fading, only where the
  columns would fall under their narrowest readable width, the card's title on at most three lines.
- **The right rail** opens for the picked card: the key, the title, its facts, what the issue says,
  and what agents did on it. Its one action is Start an agent; the card itself carries none.
  Closing it gives the width back to the columns.
  Under Start an agent, a secondary "Ask about it…" opens one field in the rail, filled with "How
  big is this, and which files would it touch?", and "Ask". It starts a task that reads the issue
  and the folder and changes nothing ("It reads; nothing in your folder changes." under the
  field); its answer is that task's "finished, nothing changed" page. The rail shows it itself,
  under "The agent's answer, 10:42": its first two lines and "Read it", which opens that page.
  The rail has one filled action, Start an agent; "Open the issue" is a link beside it, never a
  second filled button.
- **On a phone** the columns become one switch and the picked column's cards stack under it.

## The new task form

It opens under the Tasks page head in place of the list's first section, with its own right rail beside it.
The form fills the column between the page's edge and that rail, the field and the lists below
it as wide as the column and nothing in it held to a narrower width except a running sentence,
which keeps its reading measure; on a 1440 screen it is not a thin strip against the left edge
with the rest empty.
The field for what to do comes first and takes an issue link as well as words; the agent sits
under it, and nothing asks where the task works; what the agent loads is "This task will use"
(see Handbooks below);
model, budget and tools fold under More options. A task on a team's skills repository is any
change at first, so its Kind of task (Any change, Write a new skill, Improve a skill) folds under
More options too; picking another kind keeps the fold open with the skill's name or the skill
under it. Start task is the
one filled action, Cancel beside it. The rail says before it starts where the agent works, whether
Undo or a request takes the change back, and the limits a task stops at (on a team's orchestrator
also the team's commands and network); on a person's own orchestrator where it works is said once
it starts, in its run's first line. MCP servers the task will load that need a sign-in are said
before Start, under the field, as one folded line: "2 MCP servers need sign-in", since a task
cannot sign in once it runs. Opened, the buttons are inside it, side by side and wrapping to the
width, "Sign in to GitLab", "Sign in to Atlassian (from payments-skills)": a server's own name,
with "(from <plugin>)" where it comes from a plugin, never the raw id, and one button for a name
however many times it is configured. Under them, small: "Or run claude, then /mcp, in your
terminal.". The limits link to Settings > Task limits, so the settings a
task runs under are one step from the place that starts it.

- **Files given to a task.** Under the field one quiet link, "Attach files"; dropping or pasting
  into the field attaches as well, the field showing its focus edge and "Drop to attach" while a
  file is held over it. Each file is a chip under the field, the same chip as a quoted line: its
  name in mono, its size muted ("240 KB"), and × ("Remove schedule.pdf"). A chip being sent reads
  "Sending…" muted; one that failed reads "Not sent" in the danger tone with "Try again". A file
  refused is said at once in one line under the chips, naming it: "notes.heic is not a file the
  agent reads: PNG, JPEG, GIF, WebP, PDF, text or JSON.", "logs.zip is over 10 MB.", "A task takes
  up to 20 files." The follow-up box and the steer field take files the same way. No thumbnails,
  no queue panel.
- **What a task costs before it starts.** Where the agent reports it, one muted line under Start
  with the limits: "Tasks like this have cost $0.30 to $1.20; 34% of this week's Claude limit is
  left." Below 10% left the line takes the waiting tone: "6% of this week's Claude limit is left;
  a task stops when it is reached." It never stops Start and never asks a question.

**Settings > Your data**, on a person's own orchestrator, opens with one sentence of what the
orchestrator keeps on this machine: "It keeps 412 MB here: 300 MB of task folders, 70 MB of
backups and 42 MB of the rest." The parts named are those of at least a tenth of the whole,
largest first, three at most; the others are summed as "the rest". Their words: task folders,
backups, repository copies, attached files, task records; sizes in KB, MB or GB, one decimal
under 10 GB. Where part of it was not readable the sentence says "at least 412 MB". With backups,
one muted line under it names their folder in mono and how they are kept: "Backups are in
~/Library/Application Support/TeamHandbook Orchestrator/backups, the last 7 kept;
ORCHESTRATOR_BACKUP_HOURS and ORCHESTRATOR_BACKUP_KEEP set how often and how many." From 5 GB the
sentence takes the waiting tone and one more line says what makes it smaller: "Task folders of
ended tasks go when the orchestrator starts, task logs after the days you set for them, and fewer backups
are kept with ORCHESTRATOR_BACKUP_KEEP." Nothing is deleted from this line.

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
  is. Its question says what goes and what stays: "This drops the agent's change; your checkout
  stays as it is.", and on a run that follows a kept change, "This drops this run's change; what
  you kept before stays, and your checkout stays as it is."; no line or link names the request behind them, and a merge refused where the branch is
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
- **One turn of a change.** A task's change grows a turn at a time: its first ask, then each
  message, steer or follow-up the person sent. Over the Changes list a `Select`, "All changes"
  first, then a turn each, named by the person's own first words and the time ("“Also return the
  window…” at 10:44"), shows that turn's files alone. With a turn picked, the section's own
  action, a secondary, is "Undo from this turn…", asked first: "The files go back to how they were
  before “Also return the window…”; the 2 turns after it go too, and the conversation stays."
  then "Undo these turns" and "Keep them". In the stream, a turn that changed files ends with one
  muted line, "This turn changed 3 files", which picks that turn in Changes. A turn undone keeps
  its place in the Select as "undone". Where the orchestrator kept no turn points, or the task has
  one turn, the Select is not drawn: there is nothing to pick. Drawn, it sits at the end of the
  Changes heading line at its own width, no label over it ("Show" is its accessible name), so the
  files start where they would without it.
  Beside it, a second secondary, "Start a new task from here…", asks in place: "A new task starts
  from the files as this turn left them; this task and its branch stay as they are.", an optional
  field "What should it do differently?", then "Start new task" and "Keep reading". The new task
  opens on its own page, its stream's first line naming where it came from ("Started from
  “Also return the window…” in Expose the delivery-window endpoint to customers", the title a
  link), and the old task's stream gains one muted line at that turn, "A new task started from
  here", linking it. In a folder without Git the action is not drawn.
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
  ran, cost), "Started with" (what the agent loaded and used; see Handbooks) and the log, folded
  once the task ended.
  What a run cost reads beside what made it large: Cost ("$0.41"), then Context ("48k tokens at
  its start"; while it runs, how full it is, "62% used", and once ended "48k at its start, 71% at
  its end"; at 80% and past it the row takes the waiting tone, as the agent soon compacts it), and
  Started with under them, facts with no sentence joining them, since the
  orchestrator measures each but not how much one caused the other. Ran is the agent's own time:
  the minutes a card stood waiting for its person are not in it, and read on their own row once
  they pass a minute ("Waited 7m for you"). An ended run whose agent reported no cost reads "Cost
  Not reported" in the rail, since that is a fact about the run; a list's cost column says nothing.
  Files the task was given follow You asked as "Files", a row each, the name in mono as a link
  that opens it and its size, with "The agent reads them; they are not part of its change."
  under them; with none the heading is not drawn.
  While it runs, the head's sentence counts on its own, a second at a time, the time and the
  running total: "The agent has worked 3m 12s; $0.41 so far." A value not known is left out.
- **Notices, asked where they mean something.** On a working task its person started, one muted
  line under the head, until the browser has been asked: "Away from this page when it needs you?"
  with "Get a notification" and "Not now" as links beside it, spaced, with no dot between. The
  account menu keeps the standing switch.
- **On a phone** the rail follows the changes, and a patch scrolls sideways with a visible edge
  saying there is more. The head and the plan do not stay in view there: on a 390 screen they
  took a third of it and covered what a card asks. They scroll away with the page, and what stays
  is the foot row at the bottom, in reach of a thumb: while it runs, the steer field and Stop as
  everywhere; waiting for review, the state's main action and its counterpart ("Keep these
  changes" filled, "Discard these changes…" beside it). While a card waits nothing stays in view
  over the stream, the foot row included, so the card's title, what it asks and its actions read
  together; its answer is the one action.
- **Going on from a review**, the same section in both experiences: under the changes of a task
  waiting for its starter's review, "Continue with a follow-up", one field, the quoted lines as
  chips over it, and "Start the next run". Its note says where the next run starts, in the words
  of where the change is now: with a request open, "A new run starts on the request's branch with
  your words, and the request gets its new changes."; with none yet, "A new run starts where this
  one left off, with your words, and its changes join this review."; once kept, "A new run starts
  from the kept change, with your words, and its new changes come to you for review." A team's
  orchestrator offers it as a person's own does, and where the task worked does not change it: a
  Git checkout, a copy and a folder without Git all go on, a folder without Git in place from the
  files as the last run left them. Undone or discarded, there is nothing to go on from and the
  section is not drawn; a new task starts fresh.
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
  Where the person named a second Claude Code sign-in (Settings > Task limits, "Another Claude
  Code sign-in", the folder of that profile, off until named), the line's action is "Continue
  with your second sign-in": the task goes on at once, nothing asked first, and its stream says
  "Continued with your second sign-in." at that point. The orchestrator starts Claude Code with
  that folder and reads nothing in it.

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
- **Finding in a task.** On a task's page the palette's first row is "Find in this task", and `/`
  there goes to it: a find row over the stream, one field, "3 of 12", Previous and Next, and ×.
  It finds in the stream and the log, the same masked text the page shows; a match inside a fold
  opens that fold, and the match is marked in the selection colour. The browser's own find is
  left alone.
- **Following.** The stream keeps its newest line in view. Scrolling up stops that, and "Jump to
  latest", one small secondary centred just above the foot row, takes the person back and resumes
  it; scrolling back to the bottom by hand does the same.
- **Cards.** A question or a request for permission sits in the stream where the agent asked it,
  the only block there with a hairline edge: the question, its options as rows, its one filled
  action. While it waits, the head's state says "needs you". Answered, it shrinks to one line ("You
  allowed npm test once").
- **A secret asked for** is a card of the same kind: "The agent asks for STRIPE_TEST_KEY", the
  agent's reason under it as quoted data, then one password field labelled with the name, "Give it
  to the agent" filled and "Decline" beside it, and under them, muted: "It is sealed for
  this task alone; the agent gets it by name, and the value is never in the chat or the log." It sits where the agent asked, beside a
  request for permission if both wait, each its own card. Answered, one line, the value never
  shown: "You gave STRIPE_TEST_KEY." or "You did not give STRIPE_TEST_KEY."; an agent that stopped waiting turns it into
  "The agent no longer waits for STRIPE_TEST_KEY." Only the task's starter sees the card and
  answers it; anyone else reading the task sees one line in its place, "Waiting for Ada to give
  STRIPE_TEST_KEY." The browser keeps nothing: the field empties once sent, and nothing of the
  value is stored on the page.
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
- **Stopping a step, not the task.** Beside "Stop…" in the foot row, while the agent works, a
  secondary "Stop this step" ends what the agent is doing now and keeps the task and its session:
  the head's state turns to "needs you", its sentence "You stopped the agent's step; tell it what
  to do next.", a card waiting then reads "The agent no longer waits for …", and the steer field
  is the one thing left to use; Send goes on from there. It asks nothing first, since nothing is
  lost. "Stop…" still ends the task. While a card waits it is not drawn: the agent is not at a
  step, it waits on the card.
- **The right rail** grows as the run goes: Changed so far, each file with its change weight as it
  lands; then Run (agent, machine, started).
- **Ended**, the main surface turns back to the changes, and the stream folds under them as "How
  the agent got here", the same lines kept for the review.
- **Failed with nothing to review**, there are no changes to turn back to: the reason heads the
  main surface in the danger tone, the stream stays open under it so the last lines before the
  failure are in view, and the head's sentence says how long it ran ("The agent stopped after
  1m 26s.").
- **Finished, nothing changed**, the agent ended without changing a file: the head's state reads
  "finished, nothing changed" in the neutral tone and its sentence "The agent finished in 1m 12s
  without changing a file."; the main surface opens with the agent's last message as its answer,
  under "The agent's answer", then the stream folded as "How the agent got here". Run again is a
  secondary in the head; "Continue with a follow-up" stays under the answer, the next run starting
  in the same place.
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
my tasks need me", and a browser that blocks them says so under it in one muted line. On a
person's own orchestrator the switch also reaches this browser with the orchestrator's page
closed. It has three states, each one muted line under it:

| State | The switch | Under it |
|---|---|---|
| Off | off | "A notice says only that a task needs you, failed or stopped; it opens the task." |
| On | on | "On in this browser, with this page closed too." |
| Blocked | off, disabled | "This browser blocks notices; allow them in its site settings to turn this on." |

Turning it on is the person's click, and the browser's own permission prompt comes on that click,
never before. The working task page's quiet line ("Away from this page when it needs you? Get a
notification") is the same switch, offered once where it means something. A notice carries no
title, path or text of the task, only that one changed: "A task needs you", "A task failed", "A
task stopped", and opens that task. The task already on screen raises none. With no vault on this
machine the switch reaches open pages only, and says so under it: "Notices with this page closed
need this machine's vault." On a team's orchestrator it reaches open pages only.

**A page that lost the orchestrator** says so under the top bar in one line in the waiting tone,
after five seconds without it, never as a toast: "Reconnecting to the orchestrator…". Back, the
page reads itself again (what changed meanwhile, a task kept or ended, is there without a reload)
and the line goes. Gone for a minute, the line becomes "The orchestrator does not answer; this
page shows what it had at 10:42." with "Try again". Nothing on the page is greyed out.

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
