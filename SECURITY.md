# Security

TeamHandbook runs as a Claude Code plugin whose hooks observe your coding session.
This document states exactly what it reads, what it writes, and where data goes.

## What it reads

- **`PostToolUse` hook input:** the tool name, the command or file path, and the
  command result (exit code / output). This is how it detects an error followed by a
  fix. The transcript path Claude Code supplies is recorded for later.
- **`UserPromptSubmit` input:** the prompt you just typed. Any prompt long enough to
  carry a lesson and short enough not to be a task brief (12–600 characters, and not a
  slash command or a notice the harness injected) is stored in the session's local
  state, so the harvest cannot miss a rule you stated mid-session. It used to store
  only prompts matching a list of English phrases; that list is gone, because deciding
  which sentence states a rule is something the model does in any language and a phrase
  list only ever did it in one. **The practical effect is that more of your prompts are
  written to local state than before** - bounded to the 40 most recent per session, and
  a prompt carrying a secret the detector recognizes is still dropped and never
  stored. Nothing is sent anywhere by this hook.
- **`SessionEnd`: the session id, the working directory, and the path to Claude
  Code's transcript file for that session.** If the session did real work, that path
  and the captured evidence are queued as a harvest job; the background runner then
  reads the transcript - the conversation, your prompts included - slices it to at
  most 40 000 characters and redacts it before anything is sent.
- **`SessionStart`: the same, for sessions that ended without `SessionEnd` firing**
  (crash, terminal kill, power loss). A session file untouched for 3 hours is
  salvaged at the start of a later session, so a crashed session's transcript can be
  read and harvested after the fact. Each session is salvaged at most once. Its
  resolved error→fix pairs move into the local ledger then whether or not the harvest
  is on, and a session that was only idle and carried on is harvested again at its real
  end, but only if its transcript grew. A session file a week old is retired the way
  `SessionEnd` would have closed it: its open errors go to the ledger, and the file is
  deleted.
- Your local git config and credentials - only when *you* approve a candidate and it
  opens a pull request, using your own identity.
- **Your installed skills, read-only, and only when you run `/handbook:share`:** the
  directory names, `SKILL.md` frontmatter and file contents under `~/.claude/skills` and
  this project's `.claude/skills`, so the list can say which of them could travel. Nothing
  there is modified, moved or deleted, and the contents are read in order to screen them:
  a skill carrying a recognized credential in any of its files is refused rather than
  shared, and the whole skill is refused rather than redacted, because a blanked-out script
  installs and then fails. The screening happens before any git command runs, so a refused
  skill never reaches a clone. If you hand it a skill directory by path (`--skill-path`,
  for a skill you are writing somewhere the client does not load from) it reads that
  directory too, and only that one: it is screened exactly like a listed skill.
- **Your slash commands, read-only, and only when you run `/handbook:share`:** the files
  under `~/.claude/commands` and this project's `.claude/commands`, so the list can say
  which of them could travel. Nothing there is modified, moved or deleted, and the files
  are read in order to screen them: a command carrying a recognized credential or a trace
  of this machine (its home path, account name or an email address) is refused rather than
  shared.
- **`~/.claude.json`, read-only, and only when you run `/handbook:share`:** the MCP
  servers Claude Code has configured for your user and for
  the current project, so they can be offered to your team. TeamHandbook never writes to
  this file: it belongs to the running client, and sharing a server does not remove your
  own. A server definition holding a literal value in `headers` or `env` is refused rather
  than carried, because only a plain `${VAR}` reference proves the credential itself stays
  on this machine. That rule is structural and absolute for those two fields, and for no
  other. The rest of the definition, `args` included, goes through the same pattern
  detector as everything else that is shared, and that detector misses a credential in
  `args` whenever the flag and its value are separate arguments, as in
  `"--api-key", "<token>"`: it catches a token with a recognized prefix and a `key=value`
  argument such as `--api-key=<token>`, and a longer or more random value does not change
  the outcome. The scan for a token embedded in a URL covers the `url` field only, not a
  URL handed to a stdio command in its `args`. The merge request prints the endpoint and
  the full command so a person reads them before the server reaches anyone.
- **The team plugin's copy on this machine, read-only, and only when you run
  `/handbook:share`:** the skills, commands and `.mcp.json` under
  `~/.claude/plugins/marketplaces/<team>`, compared by content with your own copies so the
  screen can name the ones you now have twice. Nothing is removed: the screen prints the
  command that would remove your copy, and running it is yours to decide.

## What it writes, and where

All state lives under `~/.teamhandbook/` (override with `TEAMHANDBOOK_HOME`):

- `sessions/` - per-session working state: the failing command and its fix, the
  transcript path, any flagged teachings, and the paths of files written inside a
  repository, with a mark in place of any path shaped like a credential. Kept until the
  session ends, or for a week when it never does. A hook writing to one holds a `.lock`
  file beside it for that moment.
- `signals.jsonl` - the evidence ledger of captured error→fix pairs.
- `pending/` - harvest jobs waiting for the background runner: one file per session
  holding its id, cwd, the **path** to its transcript, and the captured evidence.
  The runner claims a job by rename and deletes it once the run is over, not before
  calling `claude`: a runner killed mid-call leaves the claim to be picked up again, and
  a failed call puts the job back in the queue. A job is claimed at most three times
  before it is set aside in `abandoned.jsonl`.
- `candidates/` - the review queue: each pending lesson's `SKILL.md`, its grounded
  case, and its metadata. A local orchestrator writes here too, a lesson from a task's
  review and nothing else ("The orchestrator", lessons from a task's review).
- `counters.json`, `pipeline.log` - activity counters and one line per harvest run
  (what was produced, sieved, or errored). `pipeline.log` is rotated, never deleted.
- `teachings.json` - what you have already said, so a rule you give twice is
  recognized as a repeat instead of scored as a guess. Holds the content words of each
  recorded prompt, a count, the ids of the last sessions that said it (so a session
  harvested twice is not counted as its own repeat), and a 160-character sample of your
  own sentence - the same text the session files already keep, behind the same secret
  scan, capped at the 2000 most recent - about three months. Since prompts are no longer
  pre-filtered by an English phrase list, this file now holds ordinary prompts alongside
  rules; nothing is ever read out of it except by matching against a lesson the model
  has already proposed, so what it remembers only surfaces when it is the thing you
  taught. Local only.
- `skill-usage.json` - how many times each skill has fired, and when. Claude Code
  reports a skill invocation to the same hook TeamHandbook already listens on, so this
  is a name, a running count, the time of the last call, and how many calls fell on each
  of the last 30 days (older days are pruned on the next write): no arguments, no file
  contents, no prompt. The call's arguments are what you asked the skill to do, and they
  never reach the file; a skill value that is not shaped like a name is dropped rather
  than kept. The hook sees **every** skill you invoke, including ones from other plugins,
  and the file records them all; what `/handbook:status` reports on is deliberately
  narrower - only the skills TeamHandbook itself delivered or pulled from your team repo,
  because counting the others would credit TeamHandbook with work it did not do. It is
  written only while session recording is on: `{"sessions": {"detect": false}}` stops it,
  and so does a config file that cannot be parsed. Either way it never leaves your machine.
- `usage-outbox.jsonl` - team skill uses waiting for the end of the turn, written only when
  your team asked for them and you agreed (item 5 under "What leaves your machine"): one line
  per use with the address it was agreed for, the team skill's name and the hour, deleted
  once sent or once no longer reportable.
- `config.json` - your settings. `muted.json` - fingerprints silenced by
  `reject --never`. Notice state (`welcomed`, `notified-counters.json`,
  `nudged-team`, `last-digest`, `seen-skills.json`) - what has
  already been shown to you, so a notice never repeats.
- `debug/` - raw hook payloads and the harvest model's raw reply, written only when you set
  `TEAMHANDBOOK_DEBUG=1`; any other value, `0` and `false` included, leaves it off.
- `abandoned.jsonl` - a harvest job that failed to reach `claude` three times is
  parked here rather than dropped silently, so the session's evidence stays
  recoverable. It persists until you delete it; `/handbook:status` reports the count.
- `workflows.jsonl`, `workflow-salt`, `mined-workflows.json` - the sessions recognized
  as a piece of workflow, the salt their hashes use, and the last `/handbook:mine` run
  they are named against. Field by field in
  [Recognizing a workflow in a session](#recognizing-a-workflow-in-a-session).
- `tmp/` - a scratch clone of the team repository for each command that reads or changes
  it: `/handbook:join`, `/handbook:init` (with `--upgrade` too), `/handbook:doctor`,
  `/handbook:share`, and `/handbook:review` when it sends a skill to the team. Each is a
  `--depth 1` clone, except the full one `/handbook:init` makes when it sets a repository
  up, in a directory only your account can open, and it is removed when the command
  finishes, whether it succeeded or stopped; `tmp/` itself stays, empty. Two things leave
  one behind: a file the system refuses to delete, which keeps its directory (measured for
  every command above), and a command killed while it runs (measured for `/handbook:review`
  only: SIGTERM and SIGINT both left the whole clone with its local commit).
  Only `/handbook:init`, when it sets a repository up, names what it left, and only when it
  succeeded; the other commands, `/handbook:init --upgrade` included, say nothing. A
  `handbook-*` directory under `tmp/` is such a leftover and is safe to
  delete. When `tmp/` cannot be created, the clone goes under the system's temporary
  directory instead and is removed from there the same way.

Approved skills are written **outside** `~/.teamhandbook/`, where Claude Code loads
them: `~/.claude/skills/<slug>/` (personal), the repo's `.claude/skills/<slug>/`
(project), or the team repo via a pull request.

`/handbook:demo` writes one more place: a scratch repository it builds under the system's
temporary directory (`handbook-demo-*/shop-api`), holding an invented history by invented
authors. Its draft goes to the same review queue as any other, marked as a demo draft, and
that mark limits it to two answers: committed into that scratch repository, or rejected.
Keeping it for yourself or sending it to the team is refused, and once the directory is
gone, so is adding it to any project - it never falls back to the one you are standing in.
Nothing deletes the directory for you.

- **A secret in a format the detector recognizes is redacted before anything is
  written - the session files included.** A captured command, error, or edit that
  matches a secret pattern is dropped entirely and reduced to a content-free
  fingerprint (only a redaction counter is kept). An error is checked with its token lines
  as they were printed: masking its numbers for the fingerprint never touches a line the
  detector flags, and the length cap never keeps only the head of one. For transcript slices the mechanism
  differs by necessity: a matching line is replaced in place with `[redacted:<type>]`
  rather than dropping the whole slice, and above that sits a coarser rule - a message
  carrying key material is dropped whole, because a per-line pass cannot follow a key
  body across the lines a paste, a narrow terminal or a `git diff` prefix breaks it
  into. Key material here means armor (PEM, armored PGP, PuTTY) or a long base64 run,
  including one wrapped across short lines. Two kinds of long base64 run are exempt, and
  neither is a shape a pasted key falls into by accident: a Subresource Integrity digest of
  exactly the length its hash produces, and a `data:image/…;base64` URI opening with a real
  image format's first bytes. Without those exemptions one lockfile line cost the whole
  message, and a lockfile is nothing but those lines. A per-line pass also needs each line
  to arrive whole, and the slice cuts an over-long developer turn down to its head and its
  tail, and an over-long assistant turn down to its head: no cut splits a line the detector
  would flag. Most credential rules are
  anchored to a keyword beside the value, so a cut through `password: ...` would leave the
  value on a line with no keyword left on it, where no rule can see it; such a line is
  taken whole or not at all. Two rules read across lines - a `.netrc` entry written one
  field per line, and an access key id with its secret a few lines below - so a second pass
  reads every run of up to four lines and redacts the whole run when it holds a secret that
  none of its lines holds alone. The number of redacted lines is recorded in `pipeline.log`.
  Either way the raw secret text reaches neither disk nor the model. Detection is
  best-effort pattern matching (see `src/lib/secrets.ts`); a secret in an unrecognized
  format can slip through, so review a candidate before approving it. What
  bounds that best effort is a corpus: the detector is measured against secret families in
  the contexts a session actually sees - a command line, stderr, a diff, a config file, a
  header - and the corpus lives in the test suite, so a family IN IT that the detector
  cannot name in any of those contexts fails the build; a shape it names nowhere, held only
  by the message-level drop, is asserted there instead. A format the corpus does not carry
  is covered by the sentence above and by nothing else. One shape is left alone on purpose:
  a URL whose password is wholly a variable reference (`https://oauth2:${CI_TOKEN}@host`, or
  a CI secret reference such as `${{secrets.CI_TOKEN}}`) names where the value comes from at
  run time and holds none, which is how the version-bump job pushes. The name has to read as
  an environment variable's: upper case, digits and underscores, in words of at most sixteen
  letters with at most two digits each. A token pasted between the braces, a single literal
  character beside the reference, or a bare `$CI_TOKEN` is still a secret.
- **Raw hook payloads are never written unless you opt in** with `TEAMHANDBOOK_DEBUG=1`
  (a diagnostics aid for confirming the payload schema). Raw payloads can contain
  secrets, so this is off by default.

## What leaves your machine

These, and only these:

1. **Automatically, before you review:** at the end of a substantive session,
   TeamHandbook calls `claude -p` (your own Claude CLI) **once**, with a redacted slice
   of that session's conversation - up to 40 000 characters, 60% of that budget
   reserved for your own messages - plus the captured error→fix pairs and the
   session's work shape. This reaches Anthropic exactly as any Claude Code prompt
   does. **This path ships switched off**: it runs only once you set
   `{"harvest": {"lessons": true}}` in `~/.teamhandbook/config.json`, so on a stock
   install no session is read and nothing is sent. `{"harvest": {"enabled": false}}` and
   `{"gate": {"auto": false}}` remain as the older switches, and all three are checked
   before a session is queued and again before a queued session is sent, so turning one
   off also stops the jobs already waiting. The prompt reaches `claude` on its standard
   input, never in its command line, where any local user could read it in a process
   listing. Capture itself keeps running either way: the hooks that
   record errors and activity write to your machine only. `/handbook:learn` follows the
   same switch and sends only what you asked it to capture.
   - Precisely: those switches stop the SENDING, not the local capture. The
     `PostToolUse` and `UserPromptSubmit` hooks keep writing evidence into
     `~/.teamhandbook/` (secret-redacted, as above) so the history is there if you turn
     harvesting back on. If you want no local capture either, uninstall the plugin.
   - If `config.json` exists but cannot be parsed, both switches fail **closed** -
     a trailing comma in a hand-edited file must never silently re-enable sending -
     and the next session-start notice tells you.
   - A session with no substance (no error→fix pair, no teaching, no real work) is
     never harvested and costs no model call at all.
   - Before that text is handed over, the traces of the machine it was read on are
     masked where they are recognized: an absolute path into a home directory, an
     address, the account name this process runs under. A path becomes `~` rather than
     being dropped, so the lesson survives it. This happens where a prompt is built
     rather than at one caller, so it covers every model call this product makes - the
     automatic harvest above, the `/handbook:learn` call you ask for, the promotion gate
     and the review sweep alike. Recognition is pattern-based and makes no claim to be
     complete - an account name that reads as an ordinary word, a home directory written
     in a shape these patterns do not know, or an address whose local part is one of the
     job names a shared mailbox uses (`ci@`, `support@`, `noreply@`, and their kind, which
     are treated as shareable) can still travel.
2. **On your approval:** `/handbook:review` → approve installs the skill locally or
   opens a PR to the team repo you configured (your git credentials, your chosen repo).
   That command is the gate for everything the HARVEST proposed: a candidate it produced
   reaches nobody until you give it a verdict.
   `/handbook:share` is the other approval, for content you already have. Whatever you
   pick on its screen - skills, MCP servers, slash commands - goes out together in a
   single PR you can read before merging. Picking it there is the approval, the same act
   for all three kinds; the harvest proposed none of it, so there is no second verdict to
   give. Nothing is shared with your team before one of these two.
   - Whatever you pick on the `/handbook:share` screen is screened for those same traces
     first, and all three kinds are screened: a skill (every file it carries, and its
     name), a slash command (its body and its name, the subdirectory it sits in included)
     and an MCP server (its whole definition, `command`, `args` and `env` included).
     Anything one is found in is refused rather than sent, and the refusal names the class
     and where it sits without printing the trace itself; the rest of your selection still
     goes.
   - The team repository is cloned and written to, and a repository can commit a
     symbolic link. A share, an approval to the team or a version bump that would write
     through one - `.mcp.json`, a command, a skill directory or `.claude-plugin/plugin.json`
     linked somewhere on your machine - is refused before its first write, so it can never
     edit or delete a file outside the clone.
   - `/handbook:review` screens a candidate the same way and prints what it finds before
     you choose where it goes. Approving it to the team, or into a project - where it is
     committed with the repository - is refused on those grounds. Keeping it for yourself
     is not: that copy stays on the machine the trace names, so it is recorded rather than
     refused. Approving it to the team, or approving a mined draft into the project it is
     committed to, also runs the share screen's whole audit first: a secret in any file the
     skill carries, a symlink, or a SKILL.md without its frontmatter refuses it before
     anything is copied, and the refusal names the class and the file, never the value.
   - The commit on that request is yours as well: TeamHandbook never commits with a
     message you have not seen; you can delegate the wording only at the moment the merge
     request is opened. This holds for every path that commits - `/handbook:review`
     approving to the team, `/handbook:share`, `/handbook:init` and its `--upgrade`.
     Delegating is answering "you decide" about one specific sentence, so it names that
     sentence's fingerprint: if the proposal has changed since you were shown it, the run
     is refused and shows you the new one. And because the delegation is given for the
     merge request, it is honoured only where one can actually be opened - on an empty
     repository, where the scaffold goes straight to the default branch, and on a machine
     whose `gh`/`glab` is missing or not signed in, the wording has to be yours. What this
     does not promise: if the CLI is signed in and opening the request still fails, the
     branch is pushed with the delegated message and the request is yours to open.
   - So is the branch it goes out on. Every push asks for the branch beside the message,
     in one question, and pushes exactly the name you confirm or give: never one derived
     from a forge's refusal, never a name with a suffix added. A name you give passes the
     same screen as the content - a trace of the machine or a credential in it is refused
     before git sees it - and is used for that one push: nothing about a push is written
     into `~/.teamhandbook/config.json`. On GitLab, with no `glab` to open the request,
     the push asks GitLab to open it (push options); the request's title is the commit
     message you approved, and its description, which a push cannot carry, is printed for
     you to paste. Every request `gh` or `glab` opens asks to be assigned to you: the
     command carries the literal `--assignee=@me`, which the CLI resolves against the
     account it is already signed in with, so no name from this machine - its account, its
     git identity - is sent. If the forge refuses it, the request is opened without it and
     the result says so. A request `glab` opens carries TeamHandbook's description and never
     the project's own merge request template, because GitLab does not apply that template
     to a request opened through its API, so nothing its quick actions set reaches it; when
     `.teamhandbook.json` has no `reviewers` key or no `labels` key, the result says so,
     names the key or keys that are missing and no other, and gives the one command that
     records them.
     A request GitLab opens from a push is assigned by GitLab to the account that pushed,
     unless the project's default template assigns someone else: the push-option handler
     sets the pusher as assignee on every request it creates, and an `/assign` in the
     template replaces that assignee when the request is created. That rule is in GitLab's
     code, not its documentation, and was read there; the handler has set the pusher since
     its first release, GitLab 11.10. If a request for the branch is already open, GitLab
     opens none and updates that one instead: it takes the push's title and labels and
     changes no assignee. GitLab answers both pushes with the same line, so the result
     names both outcomes. TeamHandbook sends no assignee with the push, because
     `merge_request.assign` takes a username or a numeric ID and, without `glab`, nothing
     here knows either of yours.
     The one push that does not ask is the first `/handbook:init`: it pushes the scaffold
     to `handbook/scaffold` by default, or `<prefix>scaffold` with `--branch-prefix`, or
     straight to the default branch of an empty repository, after you have confirmed the
     repository itself. Its message is still yours.
3. **On your explicit selection:** `/handbook:init` pushes the scaffold to a repository you
   name and confirm, and `/handbook:init --upgrade` opens a PR that brings an already
   scaffolded repository's scaffold files up to this version. `--upgrade` writes only files
   the scaffold itself generates, and only the ones you name one by one with `--file`:
   without a `--file` it prints the diff and makes no change at all. It never writes
   `skills/`, `commands/`, `agents/` or `.mcp.json`, and inside the two `.claude-plugin`
   manifests it carries the team's own entries across rather than replacing them - the
   plugin version included, or its absence. Only `--commit-versioning`, given on that run,
   takes the version line out of `plugin.json`, and nothing saves that choice. In the
   team's `README.md` it rewrites only what is between `<!-- teamhandbook:begin -->` and
   `<!-- teamhandbook:end -->`, each on a line of its own, once and in order. A README without
   them in that form is replaced whole. Either way the plan lists, before anything is picked,
   every non-blank line of the current README the new one does not keep in order: all of them
   for a whole replacement, the ones between the markers otherwise. TeamHandbook before 0.32.0
   does not know the markers and replaces the whole file when it refreshes it. An
   example branch name you give it with `--branch-example` is screened like a branch and
   written into the team's `.teamhandbook.json` in that same request, for teammates who
   join afterwards to read. Reviewer and label names given with `--reviewers` and
   `--labels`, at setup or on a refresh, are written there the same way, and every request
   TeamHandbook opens to that repository reads them back from its clone: `gh` and `glab`
   send both as the request's reviewers and labels, a push GitLab opens a request from
   carries the labels alone, and a request left to a link carries neither - the result
   lists what is still to add. The setup's own request is never asked of the push: `gh` or
   `glab` opens it, or it is left to a link. A key in that file this version does
   not write is carried across as it stands. Setup, and every refresh that can write that
   file, records there as `scaffoldVersion` the TeamHandbook release that wrote the
   scaffold - a version number and nothing else - and a copy older than the release
   recorded refuses to refresh at all. The record is read from 0.29.0 on: a copy at 0.28.0
   or older does not know it, refreshes as it always did, and offers to delete it. When a
   refresh cannot write the file (the repository
   has none and it was not sent, or it is not offered), the plan and the result say that
   nothing recorded the release. A
   commit-message prefix given to `--upgrade` with `--commit-prefix` goes into the files
   that embed it and the refresh commit's title, in that request only; it is not saved on
   this machine.
4. **A release check, carrying nothing of yours:** `/handbook:status` and
   `/handbook:doctor` ask the repository this plugin was installed from for its release
   tags - one `git ls-remote --tags`, run in the marketplace clone Claude Code keeps - to
   say whether a newer version exists. It sends no content, makes no model call, and is
   skipped silently when it cannot be made.
5. **Team skill use, only when your team asked and you agreed:** which of your team's skills
   you used, by name and hour, sent to the address your team repository's
   `.teamhandbook.json` names under `usage.endpoint` - a TeamHandbook Orchestrator, for the screen
   that shows a team what it has installed against what it uses. Two answers are needed and
   neither stands in for the other. The team's arrives only through a merge to the team
   repository, read from the copy Claude Code keeps on your machine. Yours is
   `{"usage": {"shareWith": "<that address>"}}` in `~/.teamhandbook/config.json`, naming the
   exact address your team file gives: an answer never carries over to another team, or to an
   address the team changes later, and both of those are asked again. Absent is undecided,
   undecided sends nothing, and until you answer a session starts with one line saying what
   is asked and where it would go; `"shareWith": false` declines and stops that line.
   `{"sessions": {"detect": false}}` stops it as well, and a config file that cannot be parsed
   counts as no answer.
   - What is sent: `{"events": [{"skill": "<name>", "hour": "YYYY-MM-DDTHH"}]}`. Only a skill
     Claude Code called under the team plugin's own name (`<team plugin>:<skill>`) and that
     the team repository ships is queued. A personal or project skill - including one with the
     same name as a team skill - the skill's arguments, a path, the session, your name and
     your machine never are.
   - When: the tool hook appends one line per use to `~/.teamhandbook/usage-outbox.jsonl`,
     tagged with the address it was agreed for; the hook at the end of each turn claims the
     queue, sends the newest 500 uses from the last month in one request with a 3-second
     limit, and deletes it once accepted, so two turns ending together send it once. Each use
     is rebuilt from its name and hour before it is sent, whatever else the file holds, and a
     claim left behind by a turn that was killed mid-send is deleted unsent.
     A queue that is no longer reportable when the turn ends - your answer changed, the team
     removed or changed the address, recording was switched off - is deleted unsent.
   - Where: only `https://`, or plain `http://` to this machine itself; an address with a
     user or password in it is refused, and so is a redirect. The address is printed in the
     session-start line, so one not written exactly as a URL normalizes it - with a space, a
     line break or a control character riding along - counts as no address at all, and so
     does one with a query or a fragment, or one longer than 256 characters.
   - Measured on the shipped hook bundles against a listener on this machine: no connection
     with no team key, with the key and no answer, with the key and the answer no, with both
     yeses and recording off, and with both yeses for a personal skill; with both yeses for a
     team skill, one request whose body held the skill's name and the hour and nothing else.

How far the list above holds was measured for the forge commands named below, and rests
on one more thing. To open a request, and to check that one can be opened, TeamHandbook
runs `gh` or `glab`, and git runs them too when one of them is its credential helper. Each
is a separate program with network traffic of its own besides the request it is asked to
make. Left to themselves:

- glab 1.123.0 sends a usage event for each command it was measured on - `auth status`,
  `api` and `mr list` - though not for `auth git-credential`: `POST
  /api/v4/usage_data/track_event`. Its body, as recorded, holds the event name,
  `send_to_snowplow`, the command and subcommand (`command_and_subcommand`, `label`,
  `property`), its version, the OS, the architecture, the name of the coding agent it runs
  under (also in its User-Agent header), the project path for a command given one with
  `-R`, and for `glab api` the endpoint path and HTTP method, a path that can itself name a
  project. It goes to glab's default host - the one `GITLAB_HOST` or its config names,
  gitlab.com when neither does - and not necessarily to the GitLab the command is about:
  `glab auth status --hostname` with a self-managed host sent it to gitlab.com. glab also
  asks gitlab.com for its latest release, `auth git-credential` included, once a day by its
  own documentation; an `auth status` whose sign-in check failed skipped it.
- gh 2.100.0 sends a usage event to GitHub (`cafe.github.com`) for a sampled share of runs;
  at its default sampling it was observed once, in 1 of 30 runs of `gh api`. Its body, as
  recorded, holds the command, the names of the flags given (not their values), a device
  id, an invocation id, a timestamp, its version, the OS, the architecture, the coding
  agent, whether it runs in a terminal, in CI or in GitHub Actions, the sampling rate, and
  its color, spinner and accessibility settings. It sent none for the commands this
  product and git run without opening a request - `auth status` and `auth git-credential`,
  0 of 5 each with sampling forced to every run - but it still wrote the device id file it
  keeps for the purpose. `auth status` was measured both with a failed sign-in and signed
  in to github.com, with and without `--hostname`, against a local stand-in for its API
  that returned the token's scopes; under the same setup `gh api` opened its connection to
  `cafe.github.com` in 5 of 5 runs. `auth git-credential` was measured returning a credential.

Every call this product makes to either CLI, and every git call it makes that reaches a
remote, carries `GLAB_SEND_TELEMETRY=0`, `GLAB_CHECK_UPDATE=false` and `GH_TELEMETRY=0` in
its environment, and that is all it changes: TeamHandbook neither reads nor writes your gh
and glab configuration, so the same CLI run from your own terminal keeps your setting.
Measured against a local recording server with every other connection refused, five runs
per case: glab's usage event and its release check each went from 5 of 5 to 0, including
with `telemetry: true` and `check_update: true` in its config file; with gh's sampling
forced to every run, its event went from 5 of 5 to 0 for `gh api` and `gh pr list`,
including with `telemetry: enabled` in its config file, and the device id file was not
written. The shipped `/handbook:share` screen, checking sign-in against a self-managed
GitLab it was signed in to, made 2 connections to gitlab.com per run before this, the
usage event and the release check, and none after; the same glab check against a host it
was not signed in to made 1, the usage event alone, and none with these switches.

So the list holds for the commands measured: glab's `auth status`, `api`, `mr list` and
`auth git-credential`, and gh's `auth status`, `api`, `pr list` and `auth git-credential`.
The two that open a request, `gh pr create` and `glab mr create`, were not run against the
recorder; that they are switched off the same way is inferred from the same variables
being read by the same programs, not measured. A CLI version that renames or ignores these
variables is not switched off by them.

glab still writes its own configuration file, and the switches above do not stop it. Before
a push, and on the `/handbook:share` and `/handbook:doctor` screens, TeamHandbook checks that
a request can be opened by asking `auth status`; for a team repository whose address does not
name GitHub that is glab, so `/handbook:doctor`, `/handbook:share`, `/handbook:init`,
`/handbook:init --upgrade` and `/handbook:review` approving to the team all run it. Measured
against a local stand-in for the forge, with every other connection refused, glab 1.123.0
wrote that file in three situations:

- holding an OAuth2 token past its expiry, it renewed the token with the forge that issued
  it and wrote the new token and expiry into the file: 3 of 3 runs with the product's
  environment and 6 of 6 without it;
- with no configuration at all, it created its configuration directory and file: 3 of 3;
- with a valid token it renewed nothing, and wrote only its own version into a file that did
  not yet record it: 3 of 3, and nothing at all in 3 of 3 runs on a file that did.

The token was kept in the file for these runs; a token kept in the operating system's keyring
was not measured. gh's own writes to its configuration were not measured.

## What `/handbook:mine` reads and sends

`/handbook:mine` with no arguments reads git history and nothing else. It walks the
repository you are in, plus any you name with `--repo` or list under `mine.repos`, and
prints what repeats. It makes no model call. In a full clone it opens no network
connection and writes nothing into the repository, so listing costs nothing and discloses
nothing. A partial clone is the exception: in a repository cloned with `--filter` (such as
`--filter=blob:none`), the history read (`git log --numstat`) needs file contents the
clone left on its remote, and git fetches each one it lacks from that remote and writes it
into the repository's `.git`. Measured on a local clone missing 6 blobs: 3 fetches and 0
blobs missing afterwards, against no fetch on a full clone of the same history. Those
fetches run in the environment of this product's other remote calls, measured carrying
`GLAB_SEND_TELEMETRY=0` and `GH_TELEMETRY=0`. A shallow clone without `--filter` fetched
nothing. When a partial clone's remote cannot be reached and the history read needs a file
content the clone does not hold yet, git cannot read that history: the listing names that
repository with git's reason and leaves it out, and when no repository was readable it says
so and exits with an error rather than reporting that nothing repeats. A clone whose contents
an earlier read already fetched reads offline as a full clone does: measured, the same work
was listed offline as online, 3 of 3.

Asking for a draft is what sends anything. Picking a workflow sends the screened
evidence for that one workflow to `claude -p`, exactly as any other Claude Code prompt
reaches Anthropic. The evidence is screened piece by piece on the way in, and the model's
reply is screened again before anything is kept; a piece that trips a screen is dropped
and counted, and the packet is built without it rather than abandoned.

`/handbook:demo` drafts the same way from its scratch repository, so its `live` draft sends
that invented history's screened evidence and nothing of yours. Its `recorded` draft sends
nothing: a draft that ships with the plugin is put through the same format check and screen
in place of a model's reply.

The line is drawn between PROSE and IDENTIFIERS, because the same word means different
things on either side of it:

- **Prose** - commit subjects, in-ticket corrections, series names, and the draft the
  model writes back - is screened for secrets, for this machine's own identity, for an
  optional list of organisation terms, and for people. Every part of every author's name
  counts here, along with the thanks and trailer phrases that name somebody who never
  committed. In a sentence a name is a name, and dropping one sentence is cheap.
- **Identifiers** - patch bodies, file paths and repository names - get the same layers
  with one documented relaxation: a single PART of a name is treated as a name only where
  it is rare in the work itself. Without it, a contributor whose first name is an ordinary
  word in the code would withhold most of the paths and patches that use that word, and
  take much of the quotable evidence with them. A FULL name is never
  narrowed: its parts count in order with any separator between them, or none, so the
  forms a path actually uses - `a-b`, `a/b`, `a.b`, `a_b`, `ab` - are caught as well as
  the spelling git records.
- **File paths and repository names in the evidence** - the file map, the order
  repositories were changed in, and the paths a fix touched - are additionally exempt from
  the organisation-term list alone. They ARE the workflow being described - the file map is
  the product - so a vocabulary list is not allowed to empty the evidence. The exemption
  ends there: the draft the model writes back is screened in full, so a draft that repeats
  a path carrying a listed term is dropped whole. `/handbook:mine` itself passes no term
  list, so on that path the layer is empty. A path that names a person is withheld and the
  row keeps its counts; a role that names a person is dropped with its row.
- **Author fields in quoted lines** - a database changelog's changeset author, a manifest's
  `author`, a properties or YAML `author` key, an `<author>` element, a formatted SQL
  `--changeset` author, an `Author:` line opening a line of a patch, a note or a text file,
  and a `@author` tag in any file - have their value replaced with `(withheld)` and counted,
  whatever the value is, unless it is one of a short list of role words (`team`, `system`,
  `bot` and the like). The handle such a field records is rarely the name git records, so
  the person screen above cannot be relied on to know it. Key and element forms are masked
  only in record files (XML, YAML, JSON, properties, TOML, SQL), where `author` is a field
  rather than a variable or a type in code, and the `Author:` line only in `.patch`, `.diff`,
  `.md` and `.txt` files.

Author names are held in memory only: the list itself never enters a packet, a prompt or
a file, and it is rebuilt from git each run.

**Limits this makes no promise about.** The person screen knows the people who authored
the work. A third party named in a code comment or in test data is not in that set; the
thanks and trailer phrases are what catch the common cases. The relaxation on identifier
text is a deliberate hole with a known shape: ONE part of a name, common enough in the
code to read as a word, can appear in a quoted path or hunk; the two parts together
cannot. Whether the person layer has ever caught a real leak in a patch or a path has not
been measured. And a draft mined from a private repository is specific to that repository
by construction - its file map is made of real paths - so it stays local until
`/handbook:review` sends it anywhere.

**Where a mined draft goes.** Into the review queue, and nowhere else. Approving one into
the project writes it to that repository's `.claude/skills/` and commits it there, which
is the one delivery that makes a commit without opening a merge request - so the commit
message is asked for first and never invented. It is screened for secrets and for traces
of this machine before that commit is made, and a failure to commit removes what was
written and leaves the candidate waiting. "That repository" is the checkout the draft was
mined in, and the approval is taken only there: run from any other repository, from outside
one, or after that checkout is gone, adding it to a project is refused before anything is
written or asked, and the refusal names the repository by a short hash of its path rather
than by the path or its name. Keeping it for yourself and sharing it with the team are
unaffected.

## Recognizing a workflow in a session

TeamHandbook notes when a session looks like a piece of repeated work, so that how often
that happens can be counted before anything is built on it. It asks nothing, drafts
nothing, makes no model call and opens no network connection. It is on by default;
`{"sessions": {"detect": false}}` in `config.json` turns it off, and a config file that
cannot be parsed counts as off.

**What it reads.** The `PostToolUse` input described above: the path an edit tool wrote,
and a shell command, parsed for the files it writes (a redirect, `tee`, `sed -i`, a copy
or a move), whether it runs a test or a build, and whether it commits, together with the
exit status Claude Code reports for the whole command. At a commit and at the end of a
session it also reads, for each repository written in: where its `.git` points, so a
worktree counts as the repository it belongs to; which of the written paths git ignores
(`git check-ignore`); and the current branch, from `.git/HEAD`. When Claude Code reports
an entry point in the `CLAUDE_CODE_ENTRYPOINT` variable, a session started in print mode or
through an agent SDK, which nobody is at the keyboard for, is left out and counted rather
than recorded. That variable is not a documented one, so whether it arrived is counted too:
a session it did not arrive for is treated as attended, and shows up in that count.

**What it keeps while the session runs.** The session's file under `sessions/` gains the
absolute paths of the files written inside a repository, whether the latest test or build
since the last of them passed, and which signals have already fired. It goes when the
rest of that file goes.

**What one recognized session writes.** A line in `workflows.jsonl` when a signal fires -
a passing test or build after the last write and then a commit, or the end of the session
with the latest such check passing - holding exactly:

- the time;
- a hash of the session id;
- which of the two signals fired;
- whether the files match a workflow `/handbook:mine` listed, and if so that workflow's id
  (itself a hash), or form a set of roles of their own;
- one hash per (repository, role) pair written, one hash per repository, and how many
  pairs there were;
- how many error and fix signals the session left in `signals.jsonl`;
- a hash of the ticket key in the branch name, or of the branch name when it carries none;
- whether the passing check's own exit status was hidden by what followed it on its line
  (`npm test | tail`), in which case the line's status was read in its place.

**What it never writes.** No file name, path, directory name or role; no command and no
output; no prompt or anything else you typed; no branch name or ticket key; no repository
name; no session id. The roles are hashed rather than kept because a role is made of a
path - for a file with no extension it is the file's own name.

**The hashes.** Each is salted with a random value made once per install and kept in
`workflow-salt`. A stable salt is what lets the same ticket, or the same set of roles,
hash alike across sessions, which is how repeated work gets counted. It sits on the same
disk as the hashes, and a ticket key is easy to guess: someone holding the whole
directory can test guesses against a hash. A hash here keeps a value out of a file that
is copied on its own, not away from someone who has your home directory.

**Screening.** Before a line is written, the repository-relative paths, the roles and the
branch it is built from are scanned for a trace of this machine's identity and for
secrets, and the finished line is scanned again. A hit drops the whole line rather than
masking part of it, and a counter in `counters.json` says how many were dropped. A file
written under a path shaped like a credential never reaches the session file: the session
is marked instead, and a line built from its other files is dropped and counted the same
way. When those files alone are no workflow, no line is built, so nothing is counted.

**The mined record.** `/handbook:mine` keeps its last listing in `mined-workflows.json`:
each mined repository's absolute root with the label it was mined under, the role
resolver's layout tables (repository-relative directory paths), the ticket prefixes the
history uses, and each listed workflow's id and core roles. It is what lets a session be
named in the miner's own roles without reading any history. It is not written while
detection is off, and it never leaves the machine.

**Counters.** `counters.json` gains how many attended sessions ended with detection on,
how many unattended ones were left out, how many sessions reported their entry point and
how many did not, what detection made of the sessions at their end whether or not a signal
fired, and how many lines screening dropped.

## Skill health

`/handbook:status` reports, for each skill TeamHandbook delivered, whether the files its
file map names still exist, whether recent work still follows that map, how often the
skill was called, and whether another skill's description answers the same requests. The
share screen shows the same overlap warning. Both are read-only: nothing is changed,
redrafted or deleted because of a finding, and no model is called. In a full clone no
connection is opened either. A partial clone is the same exception as for `/handbook:mine`,
because the history read is the same one: git fetches the file contents the clone left on
its remote and writes them into the repository's `.git`. Measured on a local blobless clone
of a six-commit history with 15 contents missing: `/handbook:status` made 5 fetches and left
none missing, against no fetch on a full clone, in 3 runs of each. Whichever of the two
commands reads that history first makes the fetches; the other then finds nothing missing.

**What it reads.** The `SKILL.md` of each delivered skill; the repository a skill was
installed into, or the repositories its map rows name when `mined-workflows.json` knows
them: the tracked file list (`git ls-files`) and the commit history (`git log`, the same
read `/handbook:mine` makes); `skill-usage.json` and `workflows.jsonl`; and the name and
description of every skill this machine loads - the project's `.claude/skills`, your
`~/.claude/skills`, and the team repository's skills as your local clone of it holds them.

**What it writes.** Nothing, apart from the file contents git fetches into a partial clone's
`.git` as described above. The only new data is in `skill-usage.json` as described above,
written by the hook rather than by this report: beside the name, running count and time of
the last call it already kept, how many calls fell on each of the last 30 days, and never
the call's arguments.

**What leaves your machine.** Nothing but, on a partial clone, requests to that
repository's own remote for the file contents the clone lacks, as above. The team repository's
skills are read from the clone already on disk, so the overlap warning makes no request.

## Removing your data

```
rm -rf ~/.teamhandbook
```

That deletes every byte TeamHandbook itself stores - ledger, queue, per-session state,
counters, `pipeline.log`, any `abandoned.jsonl`, and notice state. The only other place
it keeps anything of its own is a scratch repository `/handbook:demo` built, under the
system's temporary directory as `handbook-demo-*`; delete that the same way. There is no
remote copy.

Skills you already approved are ordinary files and are **not** removed by that
command: delete `~/.claude/skills/<slug>/` (personal) or the repo's
`.claude/skills/<slug>/` (project) yourself, and remove merged skills from the team
repo like any other commit.

## Trust model

Plugin hooks execute with your user privileges and run automatically once installed.
Everything captured from a session - stderr, commands, and the transcript slice - is
fenced as untrusted data inside every model prompt, and the prompt names the delimiter
exactly, so text that imitates one is read as data. Review the source before installing,
as you would any plugin. TeamHandbook is open source (Apache-2.0) specifically so this is
auditable.

### The model call

Fencing decides what the prompt says. It does not decide what the process reading that
prompt is able to do, and the whole input to that process is text a session could have
been talked into producing. So the child session is given nothing to do it with:

- **no tools and no MCP servers** - not Bash, not a file writer, not a network fetcher;
- **an empty working directory**, created for the call and removed after it, so your
  project's files, its `CLAUDE.md` and its hooks are all out of scope;
- **your machine's settings files ignored** - user, project and local - so no hook,
  permission or tool configured here applies to it. The CLI's own config directory is
  still pointed at, because that is where it finds how to authenticate;
- **a restricted environment**, passed as an explicit list rather than inherited.

Everything the harvest needs is already in the prompt, assembled by the plugin before the
call, so the child has no reason to read anything.

What the environment list carries, and why each part of it has to:

- where the CLI, Node and its own config live, on Unix and on Windows;
- how it reaches the network on a machine behind a proxy, and how it trusts that network
  where a corporate CA intercepts TLS;
- how it **authenticates** - the variable families belonging to each backend Claude Code
  can use (Anthropic directly, or Bedrock, Vertex or Foundry), the credentials themselves,
  and where its own configuration lives. These carry secrets deliberately: the call cannot
  happen without them, and the child has no tool with which to send them anywhere. Leaving
  them out is not a safer choice, it is a broken one - an earlier version of this list
  omitted them and the harvest simply failed on any machine that authenticates through a
  cloud backend;
- how it reaches a **gateway**, where one sits in front of the backend: the token it
  presents, the endpoint it talks to, and the switches that tell it the gateway has already
  signed the request. A shorter list refused those switches, and the child then tried to
  sign requests with a key such an install does not have;
- which handbook home the call belongs to.

The names were read out of the installed CLI rather than remembered, and each one is in the
source next to the reason it is there.

Two variables are refused even though they would plausibly help, and for the same reason
the rest of this exists: `NODE_OPTIONS` can load code into the child before it runs, and
`NODE_TLS_REJECT_UNAUTHORIZED` would switch certificate checking off. A machine that needs a
private certificate authority says so by adding trust, not by removing verification.

What it refuses next, and this is the part worth naming: **the handles of the session that
started the call**. The parent is usually an interactive Claude Code session, and that
session puts its own message socket, message token, session id and settings into the
environment. Forwarding those would wire the isolated child back into the very session
whose text is the untrusted input. So variables belonging to Claude Code are refused by
default and allowed only by name, one at a time, each because the call cannot reach a model
without it. Anything unrelated to reaching a model - your shell agent, your forge tokens -
is not on the list at all.

The exact names are in `src/lib/score.ts`, next to the reason each one is there, and
`/handbook:doctor` runs its own check through the same list, so a green report and a
working harvest cannot come apart.

This depends on flags your Claude Code CLI has to support (`--tools`,
`--strict-mcp-config`, `--restricted`). TeamHandbook reads your CLI's own `--help` at each
call and uses them only if it declares them, rather than assuming them or assuming their
absence. If your CLI is older than they are, **the harvest still runs and its model call is
not restricted** - it gets this machine's tools, MCP servers and settings, which is what
every version before this one did. `/handbook:doctor` reports which of the two you are on,
under `model call isolation`, and says so only after a real call has answered through the
restricted invocation; upgrading Claude Code is the fix.

### A team repository you joined

`/handbook:join` clones a repository somebody else controls. Three values are read out of
it, and each is screened where it is read.

The marketplace name in `.claude-plugin/marketplace.json` goes on to be a directory under
`~/.claude/plugins/marketplaces`, part of the plugin key `/handbook:doctor` looks for, and
part of the `/plugin install` commands join prints for you to run - so it is accepted only
when it is already a plain name (lowercase letters, digits and dashes, at most 64
characters), which is the form `/handbook:init` produces. Anything else is refused with the
reason, never rewritten into something usable: a rewritten name would point this machine at
a marketplace directory that does not exist.

The commit-message prefix in `.teamhandbook.json` is the string your forge requires at the
front of a commit title, and it is read because it belongs to the project's push rule
rather than to the person who happened to run `/handbook:init` - without it, every
teammate's first share is refused by a rule the team already knows the answer to. It
reaches your terminal, the `-m` of a commit this tool makes in a clone of that same
repository, and the commit message of the optional CI version-bump job, which runs with a
token that writes to the repository. So it is accepted only when it is at most 64
characters of letters, digits, spaces and `. , : / [ ] ( ) _ -`: a newline would end the
commit title and turn the rest into a body nobody wrote, an escape sequence would rewrite
what you are shown, and a quote, `$`, a backtick or a `;` would let a prefix such as
`X $(curl ...)` run in that job. The job carries the prefix only as the value of a
`BUMP_MESSAGE` variable, quoted where the shell reads it, and its loop guard matches the
fixed phrase `ci: bump plugin version` at the end of the commit message, so no prefix reaches a shell line, a rule or an
expression. A prefix that fails the check is refused with the reason and nothing is
recorded, exactly as a bad marketplace name is; one already in a team file or a config is
left unused, and a refresh withholds the CI job rather than write it, saying why. A job
written before the prefix moved into the variable still carries such a prefix in its shell
line, and a refresh cannot rewrite it without knowing the prefix the forge requires: the
refresh says so and names `--commit-prefix`, and the TeamHandbook Orchestrator's setup panel shows
it as a problem, with the token the job runs under. The Orchestrator reads the prefix the same way. It is never used to name a file, run a command, or reach
the network.

The example branch name in the same `.teamhandbook.json` shows how branches are named
there, so every push can propose a name in that shape. It is stored in your config and
only ever shown as a proposal you confirm or change, and it is accepted only when it is at
most 100 characters, carries no control character, and holds no trace of a machine and
nothing the secret detector flags; otherwise it is left out. A refresh that finds a recorded
example failing those checks does not offer the file at all, rather than regenerate it
without the example.

The release recorded in the same file as `scaffoldVersion` is read only by
`/handbook:init --upgrade`, and only to compare it with this copy's own version. It is used
only when it is three dot-separated numbers, so nothing else in it ever reaches your
terminal; anything else is treated as a release this copy cannot read, and the refresh is
refused in the same words as for a newer one.

The reviewer and label lists in the same file are not read by `/handbook:join`; they are
read from the clone each time a request to that repository is opened, and go to `gh` or
`glab` as that request's `--reviewer` and `--label`; on GitLab without `glab`, the labels
go as `merge_request.label` push options instead and the reviewers are printed for you to
add - except for the first `/handbook:init`, whose request is never asked of the push - and
where no request is opened for you - a server that takes no push options, GitHub
without `gh` - neither goes and both are printed to add when you open it. That is a command
line, so an entry travels only when it is at most 100 characters,
carries no control character and nothing the secret detector flags, and has the shape of a
username (letters, digits, `.`, `-`, `_`, one optional leading `@`) or of a label (no comma,
which would split it, and no trace of a machine); a list of more than 20 is not used at all.
A reviewer is not screened for traces of this machine: it is a public forge name, and the
username shape already refuses a path or an address. Each value travels as part of one
`--flag=value` argument, so none can be read as an option of its own. Whatever is left out
is counted, by reason and never quoted, in the result; the request is opened without it
rather than refused. If the forge refuses the assignment itself, the request is asked for
once more without it - unless the failed call already reported a request it opened, or
the forge answered that a request for the branch already exists. The assignee, `@me`, rides
on every request, so every failed open is asked for that second time, never a third; both
forges refuse a second open request for a branch, in the sentence read above. `glab`'s
message is read with its lines joined, because `glab` 1.123.0 wraps it at 118 columns and
was measured breaking that sentence across lines at a place that depends on the project's
path. When the
second attempt fails too or finds the request already open, the first failure is named as
a refusal of the assignment when its own words say so (`glab`, and `gh` on GitHub
Enterprise, name the user or label they could not find), and not when they are the words
`glab` 1.123.0 and `gh` 2.100.0 were measured printing for a dropped connection, a host
that does not resolve, a refused token or a forge error; any other words are named only if
the team's lists went with the request, a name there being the one thing to correct. A
second attempt that failed exactly as the first did names nothing. The team file is not
named as the thing to correct for a refused assignee, or for a failure in those measured
words. A request `gh` opened before its assignment failed is said to lack part of it, not
all of it, because `gh` sets the assignment after it creates the request.

The name, the prefix and the example are what `/handbook:join` itself reads. A repository you have joined also ships
skills, and a skill's **name** is read from its frontmatter wherever the plugin lists what
you already have - including into the prompt that decides whether a new candidate
duplicates one. A name is therefore screened too, at the point it would otherwise become
part of that prompt's structure rather than part of its data. The session-start notice that
announces a newly arrived skill prints its name only when it is a plain slug (lowercase
letters, digits and dashes), because that notice lands in a session that can run tools.
Skills, servers and commands merged into that repository arrive on this machine through
Claude Code's own marketplace subscription. TeamHandbook does not screen them: nothing
here reads them, and nothing here approves them - `/handbook:review` and
`/handbook:share` gate what leaves this machine, not what arrives from the team.

### The team's policies

The same `.teamhandbook.json` can carry `policies`: named groups of 1 to 20 rules, each
`{action, resource, effect, reason}`, that take a skill, an MCP server or tool, or a
Claude Code tool pattern away from every session with the team's copy. A `PreToolUse` hook
reads them from this machine's copy before each tool call and denies a call a rule
matches, in the words "Blocked by the team's policy: <reason> (<action> <resource>, added
in <commit>)". The commit is looked up in the copy's own history only for a call being
denied. Nothing is fetched and nothing leaves the machine: a policy reaches you the way a
skill does, merged into the team repository and pulled by your marketplace subscription.

A policy only takes away. The only effect is `deny`; there is no rule that grants a tool,
because giving a capability is adding a skill or a server through a reviewed request. A
rule whose action this release does not know, an `allow`, an unknown key, a reason with a
control character or anything the secret detector flags makes the whole file's policies
invalid rather than skipping the rule: a newer rule read as nothing would lift what it was
written to hold.

A team file that cannot be read, or whose policies are invalid, does not lift the rules.
The last policies read from a valid file stay in force, kept in
`~/.teamhandbook/policy-cache.json` for the team this machine joined, and the next session
start says why. When no valid policies were ever read here, nothing is blocked and the
session start says so too: a broken file in one repository must not lock every teammate
out of their tools. Leaving the team, or joining another, drops the old team's cached
rules.

The hook decides a Bash call on the whole line and on each command the shell would run
from it: past assignments and wrappers such as `env`, `timeout` and `xargs`, inside `{ }`
groups, `if`, `for` and `while` bodies, `$( )` and backticks, `sh -c` and `eval`, with the
program read by its base name and in lower case, so `npm test && git push`, `/usr/bin/git
push` and `GIT push` are all held by a rule on `git push *`. An absolute path is read as
written and as it resolves, so `..`, `.` and doubled slashes do not walk around a path rule.
A pattern is matched in time proportional to the line, never by backtracking. A rule naming
an MCP server or tool is read the way Claude Code names its tools, every character but
letters, digits, `_` and `-` as `_`. It is a guard against habit and drift, not a sandbox: a
command can still reach the same effect by a route no pattern names (a script, an alias,
another interpreter). Measured on this machine, the hook takes a median of 71 ms per tool call
with 51 rules, of which 35 ms is starting node.

### Install it for yourself, not for your teammates

Claude Code can install a plugin at three scopes. Two of them are yours alone: user
scope writes to `~/.claude/settings.json`, local scope to a repository's gitignored
`.claude/settings.local.json`. The third, project scope, writes to the repository's
committed `.claude/settings.json`, which means everyone who clones that repository gets
the plugin enabled without being asked.

Do not install TeamHandbook that way. Its hooks read the conversation of whoever is
sitting at the keyboard and send a slice of it to that person's own `claude`. Deciding
that this is an acceptable trade is exactly the decision this document exists to let
someone make for themselves, and a committed settings file makes it for them. "Nothing
is installed or shared without your approval" is a promise about the skills this
produces; project scope is the one place where the plugin itself could arrive
unannounced. Send your team the install commands and let each person run them.

## The orchestrator

The orchestrator (`orchestrator/`) is a separate server a team runs for itself. It is not part of the
plugin: installing TeamHandbook does not start it, and the plugin talks to it only as item 5
under "What leaves your machine" describes.

**What it reads.** Each connected team repository, through a bare mirror under its data
directory (`git clone --mirror`, then `git remote update --prune`). Reads are of git objects
at the mirror's head, so it keeps no working tree and runs no hook from a repository it reads.
Its git calls read neither the host account's global nor its system git configuration, and
never stop to ask for a password.

**What it keeps.** In its database (a SQLite file under its data directory, or Postgres when
`ORCHESTRATOR_DATABASE_URL` names one): which repositories are connected, the requests it opened
(number, branch, title, status, who opened it), skill-use counts per repository, skill and
hour, settings, and each task's record (title, description, issue link, agent, status, timings,
the cost its agent reported, the request it opened) with the task's log, redacted line by line
before it is written. Each stream of a process's output passes one redactor in order, the
lines the log leaves out as well, so a private key block is masked wherever in the output it
starts or ends; a failure's "Last line" is taken from that redacted text. A long line is cut
only after it is masked, in the log and in a request's description: a token cut first would
leave a part neither its value nor its pattern matches. No skill, MCP server or command is kept there; they stay in git, and a
lost database is rebuilt by connecting the repositories again. What Jira, GitLab or GitHub
answers for Work (boards, sprints, columns, and each issue's key, summary, status, assignee and
labels) is held
in the orchestrator process for a minute, at most 500 answers, and never written to the database,
a backup, an export or the log; what is stored for Work is which team each board is mapped to
and each board's "Move issues as the agent works" setting. A repository the configuration
file no longer lists is not fetched again, so a URL taken out with its token is not used; an
admin's Disconnect deletes its mirror (whose git config holds that URL), forge access, sealed
token and ingest id, and keeps its request, task and usage records. For sign-in it keeps:

- each account's address, name, role (owner, admin or member), the teams it owns, an optional
  forge login, and either an scrypt hash of its password (N=2^15, r=8, with its own salt) or the
  issuer and subject the identity provider gave it. No password is kept, and no provider token;
- on a cloud orchestrator, each person's identity apart from their organizations: the provider and
  that provider's own id for the account, the address only when the provider vouched for it,
  the name, which terms of use they accepted and when, and which organizations they created and
  when, so one person creates at most `ORCHESTRATOR_ORGS_PER_IDENTITY_DAY` a day. Each membership is
  an account of that organization's own, tied to the identity. No provider token is kept;
- each pending invitation: the address, the role and teams it joins with, who invited, and the
  SHA-256 of its one-time link, for seven days. The link is shown once, to whoever invited, and
  the orchestrator sends no mail; accepting it, or a single sign-on with that verified address,
  uses it up;
- each API key as its prefix (`th_sk_` and twelve hex digits) and the SHA-256 of the whole key,
  with its name, scopes, owner, expiry, last use (written at most once a minute) and revocation.
  The key is shown once when it is made; removing a member or a service account deletes its keys;
- each service account's name and the teams it owns;
- task secrets, for a team or a repository, sealed in the vault under their own name, with when
  and by whom each was set. An owner or an admin writes a value on the screen, or names the
  1Password item it is read from; no answer, event or page shows a value afterwards, and a
  named item is shown by its reference. A task's agent gets its team's and repository's values as
  environment variables when it starts; a value that does not open, for want of the key or
  because it was moved to another name, stops the task. Names a task's process depends on
  (`PATH`, `HOME`, `NODE_OPTIONS`, `LD_*`, model credentials and the like) are refused;
- the groups each member's last single sign-on listed in the configured claim, the mapping from
  groups to tags an owner applied, and tags added by hand;
- each session as the SHA-256 of its cookie token, the CSRF token it pairs with, and an expiry
  twelve hours out, deleted once it expires;
- each single sign-on that has started and not come back: its state, nonce and PKCE verifier,
  for ten minutes, deleted by the one callback that uses it or once it expires;
- for a repository on GitLab or GitHub, its API address and project, and its token sealed with
  AES-256-GCM under `ORCHESTRATOR_SECRET_KEY`, bound to its tenant, repository and the API origin it
  was entered for. Changing the forge, its address or the project needs a new token: a change
  sent without one is refused with nothing altered, and the old token is removed when the new
  one is stored. A repository connected in local mode with no token keeps only its API address
  and project. A repository connected from the screen keeps the same token a second time,
  sealed the same way and bound to the origin of its clone address, as its fetch credential; it
  is opened for each fetch and passed to git through its environment, never in an argument, a
  URL or the mirror's config, and removing the repository deletes it. The key is never
  written to the database; without it no token is stored at all. An orchestrator only its one user
  reaches (loopback address, no public address elsewhere, no `ORCHESTRATOR_TRUSTED_PROXY`, the
  built-in admin or at most one account) makes a key in its data directory, mode 600, when none is set, and logs that it did;
  while it seals with that key it refuses a second account, by hand, invitation, single sign-on or SCIM;
  a copy of that directory then opens what it sealed. An orchestrator others reach makes none. Measured in the container
  image: a token saved through the API appears zero times in the database file, its write-ahead
  log or the container's log, and the API answers only that one is set, when and by whom.
  A backup of the volume or a dump of the database carries the token only sealed: restored
  without the key, the orchestrator says a token is stored that it cannot open, and with another
  key that it does not open; tried on a restored demo on SQLite and Postgres. The copies the
  orchestrator takes of itself (`ORCHESTRATOR_BACKUP_DIR`, and the one before a schema upgrade) hold the
  database as it is, tokens sealed and passwords hashed, never the key, and are written
  readable by the orchestrator's own user alone (files 0600 in a directory 0700).

**What it shows, and withholds.** Every team's skills, MCP servers, commands and request
settings. An MCP server's address is withheld when the plugin's own share rule refuses it,
for a token in its query or path; environment and header values are never shown, only their
names; the user and password in a repository URL are masked in every answer the API gives,
to an admin as to anyone, and in every sync error, while the stored URL stays whole for git.
A repository's `memberUrl`, the address its page tells teammates to join by, is shown whole,
so one carrying a user, password or token stops the orchestrator at start, before its store opens.

**What it changes.** Nothing directly, and nothing on its own disk outside its data directory
but a local orchestrator's lessons below:
a change for the local forge is built from git objects, with no file written, and one that
passes through a symbolic link in the team repository is refused. Every change is a branch and
a request in the team repository, and its default branch moves only when a person merges the
request; the one exception is the team repository an owner or an admin sets up from the screen,
which gets TeamHandbook's scaffold as its first commit, written straight to it and never with
force, only when the orchestrator just created it or it has no branch and no commit at all. It deletes nothing from a team repository: a branch it made that no request names,
found at a start, is moved under `refs/orchestrator/orphaned/` with its description, where
`git update-ref` brings it back. A commit's
author is the person who asked for the change; its committer is the orchestrator. Only an owner or an admin,
or a member who owns the repository's team, proposes a change or merges a request on the local
forge, and a merge always takes a person signed in: no API key, a service account's included,
reaches the merge route;
the team is read from the orchestrator's own record of the repository, never from the request, and
every call that changes something carries the session's CSRF token. An MCP server proposed or edited from
the screen passes the plugin's own share rule or is refused, naming the key and never its value;
the definition an edit starts from is served only when that rule passes it,
a slash command passes the plugin's share rule for commands the same way, its text served to
an edit only when that rule passes it, and a skill whose text matches a secret pattern is
refused the same way. The browser suite checks
both refusals and that a member and another team's owner get a 403 from the API with a valid
CSRF token.

**Lessons from a task's review.** Only on a local orchestrator with one account, the person's
own, never in its demo, and only for tasks that end after it first looks. Once a task's run ends, what that person
said about it - a follow-up while it ran, with the diff lines it quotes, and a tool call they
denied with a note - goes to the task's agent as one question with no tool, skill, MCP server or
checkout, the words fenced as data, and the answer is no lesson or a draft skill. Words that
match a secret pattern never reach the question: a follow-up, a quoted line, a note or a denied
call's target that matches one drops the lesson, and so does a draft that matches one. A draft
that passes is written, with the machine's account name and home path masked, into that person's
own review queue (`candidates/` under `TEAMHANDBOOK_HOME`, or `~/.teamhandbook`), the task's id in
its `candidate.json` alone, and reaches nobody. Keep (`POST /api/lessons/<name>/keep`, from the
task page) copies it into the person's own skills folder (`$CLAUDE_CONFIG_DIR/skills`, or
`~/.claude/skills`), Reject marks it rejected or mutes it, and sharing it with the team stays in
`/handbook:review`. The database keeps, per task, the ids of the follow-ups and requests already
read, what came of it, and the lesson's name with when it was kept, never its text; the
question's cost is counted with the person's spend, and a question is asked once whatever its
answer. An orchestrator a team reaches has no person's home and writes no lesson itself: it asks
only while the task's person has a machine polling, screens the draft the same way, and hands that
machine the lesson's makings - the draft, what the person said and the task's title, never a file
or a path to write - on its signed poll, held in memory until the machine answers under the ask's
nonce and never in the store, the event log or a log line. The machine reads them only in full
shape (a safe name, bounded fields, quoted paths relative and inside the repository), builds the
candidate itself with its own account masked and the credentials of its own environment screened,
and queues it in its person's review queue; a lesson out of shape writes nothing. The orchestrator
keeps the lesson's name and machine, which only the task's person sees, on its page and in their
own list of lessons. From the task's page that person, and nobody else, reads the lesson, keeps it
or rejects it on that machine: the ask rides the machine's signed poll the same way, the machine
acts only on a lesson it queued from that task and sends its text only while it holds nothing
shaped like a credential, its own or its environment's, and the orchestrator records when it was
kept or rejected, never its text. A machine that is not connected is said to be so; the lesson is
then decided there, with `/handbook:review`.

**What it sends.** To each connected team repository, the git fetches that keep its mirror
current (`git clone --mirror`, then `git remote update`), with the credential the operator put
in the repository's address in the configuration file, or, for one an owner or an admin
connected from the screen, the token entered with it, sent only as an `Authorization` header to
the clone address's own origin, with redirects off and git held to the address the orchestrator
judged before the fetch: one inside this machine, a private network or a cloud's metadata
service is refused unless the operator names its host in `ORCHESTRATOR_INTERNAL_FORGE_HOSTS`. In local
mode, an orchestrator run by one person on their own machine, an address on this machine or a
private network is reached as well; a link-local, multicast, unspecified or NAT64 address is
refused in every mode. In local mode a GitLab or GitHub repository connected with no token is
fetched, its branch pushed, its request opened, and a request a runner reports read back
(`gh api` or `glab api`, GET alone) with the sign-in the person's own `gh` or
`glab` holds: git asks that CLI as its only credential helper, the push is held to the address
judged with redirects off as a fetch is, and the orchestrator neither reads, stores nor passes
the sign-in. The same holds on a self-hosted orchestrator one person runs and only their own
machine reaches (`ORCHESTRATOR_AUTH=dev-admin`, one account). There the card's **Sign in with
GitHub** or **Sign in with GitLab** runs the CLI's own browser sign-in with its token variables
removed from the CLI's environment, and reads only the lines the CLI prints, the one-time code
among them. Whether the CLI is used is decided again at every use: once a second account or a
service account exists, or the orchestrator listens beyond this machine, nothing is fetched,
pushed or opened with it, and a repository is connected with a token or through the
organization's connection. In local mode Work also reads, with that same `gh api` and GET alone, the issues
of each github.com repository a project's folder names as its origin, and a task started from
one of them gets the issue's text redacted line by line, as a tracker's issue text is; an issue
of any other repository gets its link alone. A task's end opens the local request alone for a
repository read by path, however many repositories of a folder the agent changed: its branch
reaches the clone's origin on GitLab or GitHub only when the person presses Open a merge request or
Open a pull request on that request, and is then pushed and its request opened there the same way,
over https alone, as the orchestrator checked it: a branch moved since is refused; an origin reached over ssh is never pushed to, and the forge's page that opens the request is
shown instead. Beyond that, nothing until an operator
configures one of these:

- **A GitLab, GitHub or Gitea repository.** When an admin has set a repository's project and token,
  a change to it goes to that forge's REST API at the address the admin entered (https, or
  http only to this machine): the files of the change, its title and description, the
  requester's name and address as the commit author, and the team's reviewers, labels and the
  requester's forge login from `.teamhandbook.json`. A branch a connected machine pushed to such a
  GitLab or GitHub repository gets its request opened the same way with no files sent: the
  orchestrator reads the branch where it was pushed and asks the forge for the request alone. A
  Gitea repository is given the forge's page to open it by hand instead. Afterwards the orchestrator asks the forge for
  that request's status when someone presses Refresh, and, when someone signed in opens the
  repository's page, for its open requests - at most 50, read only, and kept for half a minute
  so reloading the page does not spend the team's rate limit. When a signed-in person opens an
  image a request's description attaches on that forge (a GitLab upload of that project, a GitHub
  attachment or one of that repository's assets, a Gitea attachment named by its
  `/attachments/<uuid>` address or under that repository's path; nothing else is fetched), the orchestrator
  reads it with the repository's token sent to the forge's own address alone, follows at most
  three redirects by hand with no token, each address judged before it is reached, and passes
  on only a PNG, JPEG, GIF, WebP or AVIF image of at most 8 MB. The requests' titles, branches
  and authors come from whoever opened them, so they are shown as plain text, and a link the
  forge gives is shown only when it is an http(s) address. The token is looked up by the origin the
  provider is about to call, so it reaches only the address it was entered for; it travels only
  in the authorization header, never in a URL or a body, a redirect is not followed, and every
  message the forge returns is masked of it before it is shown. The tests record every request
  a fake forge receives and check each of these, including a saved address changed behind the
  orchestrator's back, which receives nothing.
  Gitea is off unless `ORCHESTRATOR_FORGE_GITEA=1` or a Gitea repository is already connected.
  On Gitea, and on Forgejo from 1.20, the token travels as `Authorization: token <token>` to the
  API address the admin entered (`<origin>/api/v1`) and nowhere else, and git sends it as the
  password with the user name `oauth2`, held to the address judged for that host as for any
  forge. Gitea has no organization connection here: its repository is connected with a token
  alone, sealed in the vault like any other, and the form's token page asks for
  `write:repository`, `write:issue` and `read:user`. A Gitea attachment is read at Gitea's own
  `/attachments/<uuid>` address with the repository's token, which Gitea checks against the
  repository the attachment belongs to; a path naming another repository is refused.
- **A task's agent.** A task hands the checkout of the chosen team repository, the task's
  title, description and issue link, and the team's skills to the agent CLI the operator
  configured, and that CLI sends them to its model provider under the credential the operator
  gave it. Starting the task is the consent for that run. The orchestrator itself sends nothing for
  a task besides the request, which goes to the repository's forge like any other change, and,
  on a cloud orchestrator, the agent's model requests, which it forwards. There no credential of the
  orchestrator's own reaches a task: the agent holds a stand-in
  key and reaches its model at `http://model.orchestrator.invalid`, and the orchestrator's proxy puts
  the key the operator set on the runner (`ANTHROPIC_API_KEY`) on those requests on the way to
  `api.anthropic.com`, so the key never enters the agent's environment, files or log. No
  organization enters a model key, and no page or endpoint takes one.
  The proxy is the only way out for every cloud task, its setup, agent and tests: it lets through
  the repository's `allowedDomains` and the hosts of the MCP servers placed for the task, and
  not the forge, since the orchestrator opens the request. Without the key a task on an agent that
  calls a model is refused with "No runner for this task" before any agent runs, and a skill
  suggestion answers none.
- **A task's own way back to the orchestrator.** When the operator gives the orchestrator a
  public address and tasks run as processes, each run gets a token of its own (`th_tt_`, 32
  random bytes) for the orchestrator's MCP server, in the agent's environment only: its config
  names the variable, never the value, the setup and the tests do not get it, and every line the
  task writes is masked of it. Only the token's SHA-256 is stored. It is revoked when the run
  ends, however it ends, and refused once the task is no longer queued or running. The server
  answers that token and nothing else, not a browser session and not an API key, and an API key
  route refuses it. The person is the task's starter, read again on every call; the tools reach
  only that task and the tasks it delegated. A delegated task starts like any other task, with
  the starter's rights, the policies and the budget, in a mode no higher than its parent's and
  with the parent's denied tools kept; the parent agent's words reach it quoted as data. A task
  delegates at most 3 tasks, a delegated task delegates none, and a parent that is cancelled or
  fails takes its running children with it.
- **An issue tracker.** When an admin has stored a tracker token, a task that names an issue
  on that tracker's own site has the orchestrator read it there just before the agent starts: two
  GET requests (the issue, its five latest comments) with the token in the authorization
  header, to the address the admin entered (https, or http only to this machine), no redirect
  followed. A Linear key is the exception: it is sent to Linear's API at
  `https://api.linear.app/graphql` alone (or to a stand-in on this machine), in one GraphQL query
  and never a mutation, while the workspace address it is stored with is held to `linear.app`; an
  issue in another Linear workspace is refused before anything is sent. An issue link on any other
  host is not read, and the token goes nowhere else. The
  text is redacted line by line before it enters the prompt, fenced as data; the log keeps only
  a line saying what was read. Changing the tracker, its address or the account needs the
  token again. The only write is moving an issue, below.
- **Moving an issue on its board.** Nothing is moved, and the tracker is not even asked for an
  issue's moves, until an owner or an admin turns on "Move Jira issues when a card moves on Work"
  on the tracker's card under Integrations; it is off by default. A task's agent never changes an
  issue, whatever the switch says. With it on, and a board's
  "Move issues as the agent works" on, a
  task's issue is moved forward at three moments (the agent starting, a request opening, the
  task's requests merged), and a person moves one by hand. With the organization's token it is
  a POST to Jira's `/rest/api/3/issue/<key>/transitions`, after reading the issue's status and
  the moves its workflow offers; through a person's own server it is that server's
  `getTransitionsForJiraIssue` and `transitionJiraIssue`, as that person. An automatic move
  needs the starter to be shown the board and the issue to be on it, and never goes back. Every
  move is written to the event log before it is sent; an orchestrator whose log refuses it moves
  nothing. Nothing else about an issue is changed: no comment, field or assignee.
- **Work, with the organization's Jira token.** When Jira is the connected tracker, opening Work
  has the orchestrator read, with the same token and to the same address, the boards, each board's
  configuration, its active and future sprints, a sprint's or the backlog's issues (key,
  summary, type, status, assignee, priority, labels, parent, issue links, the flag and story
  point fields), the site's statuses and fields, and whether the token has the permission to move issues
  (`mypermissions`). Every read is a GET with ten seconds to answer and no redirect followed.
  Boards read this way are shown to owners and admins and to the owners of the team a board is
  mapped to, and a board or sprint id is honoured only for a board the person is shown. A
  single issue follows the same rule: the task form's preview and a task's start read an issue
  with this token only for an owner or an admin, or when the issue's project is on a board
  mapped to a team the person owns; for anyone else the tracker is not asked, and the issue
  reaches them only through an MCP server of their own or as a link.
- **Work, with GitLab or GitHub.** When GitLab is the connected tracker, or the organization has
  a GitLab or GitHub connection, opening Work reads with that token alone: on GitLab the
  projects the account is a member of, a project's issue boards, active milestones, open
  iterations and issues; on GitHub the repositories the app is installed on, their open
  milestones and issues, with an installation token narrowed to reading issues and metadata.
  Every read is a GET with no redirect followed, the same board and issue rule holds, and
  nothing is written: these boards do not move issues.
- **A GitLab or GitHub connection for the organization.** With the operator's GitLab OAuth
  application (`ORCHESTRATOR_FORGE_GITLAB_*`) or GitHub App (`ORCHESTRATOR_FORGE_GITHUB_*`), an owner or an
  admin signed in to the orchestrator sends their browser to that forge with a single-use state that
  expires after ten minutes (on GitLab with the `api` scope and a PKCE S256 challenge); the
  return finishes only in the browser holding the cookie set when it began (httpOnly,
  SameSite=Lax, `__Host-` over https), and the person's role is read again then. On GitLab the
  orchestrator exchanges the code and later renews the tokens at that GitLab's `/oauth/token` with
  the application's secret, one renewal at a time across its processes under a lease in the
  database, reads the account's username, revokes the pair a new sign-in replaces, and on
  disconnect asks GitLab to revoke them; the access and refresh tokens are sealed in the vault
  and never shown. On GitHub it trades the code for the installer's own token, uses it once to
  check that the installation is one that person reaches, and keeps it nowhere; the org keeps
  the installation's id, and the orchestrator mints hour-long installation tokens with a JWT signed
  by the app's private key, held in its memory only, a token for reading issues narrowed to
  issues and metadata. Disconnecting GitHub deletes the org's record and leaves the app
  installed until the account removes it. The record beside each connection keeps the account,
  who connected it and when. The operator's application secret and the GitHub App's private
  key come from the environment or, preferred, a file (`ORCHESTRATOR_FORGE_GITLAB_CLIENT_SECRET_FILE`,
  `ORCHESTRATOR_FORGE_GITHUB_CLIENT_SECRET_FILE`, `ORCHESTRATOR_FORGE_GITHUB_PRIVATE_KEY_FILE`) and are
  never written to the database. An organization's own GitLab application, which an owner enters
  for a self-managed GitLab, takes the operator's place for that organization: its secret is
  sealed in the vault and never shown, its address is refused when it resolves inside the
  orchestrator's network unless `ORCHESTRATOR_INTERNAL_FORGE_HOSTS` names it, each call to it is held to
  the address judged for that call, and it changes only while
  no GitLab connection holds tokens made through it.
  Through the connection, and with its token alone, the orchestrator also lists the repositories it
  reaches (GitLab `GET /projects?membership=true` at developer access or above, GitHub
  `GET /installation/repositories`), fetches and opens requests on a repository connected from
  that list, which keeps no token of its own, and, when an owner or an admin sets up the team
  repository, creates it (GitLab `POST /projects`, GitHub `POST /orgs/<org>/repos`), checks that
  it has no branch, writes the scaffold (GitLab's commits API as one commit; GitHub's contents API
  for the README, then its Git Data API with the branch moved only forward), and registers a
  webhook to `/api/hooks/forge/<id>` with a secret of that repository's own, sealed in the
  vault, and deletes that webhook when the repository is disconnected; a webhook the forge
  keeps after that is answered as unknown, since its secret is gone. Only a repository the connection lists is connected this way, so the token goes to no
  address a person typed.
- **A person's own MCP server.** The orchestrator calls a server a person added, and the sign-in
  service it names, only for that person: to read its metadata, register as a client, exchange
  and renew their sign-in, and list its tools. Each address has to be https on a host that is
  not this machine or a private network (by its literal address; a public name that resolves to
  a private address is not caught), unless `ORCHESTRATOR_MCP_LOCAL=1`; no redirect is followed.
  The client it registers with a server's sign-in, a public one with no secret, is kept by its id
  in the organization's settings and used again for the next sign-in there, whoever begins it,
  while the last sign-in begun with it came back; it is dropped when the server calls it unknown,
  and the next sign-in registers a new one. A client the server gives a secret is not kept. A
  sign-in returns the browser to `ORCHESTRATOR_PUBLIC_URL` with a single-use state that expires
  after ten minutes and names the person who began it. The orchestrator's session cookie is not
  sent on that return; instead the browser that began the sign-in holds a cookie of its own
  (httpOnly, SameSite=Lax, `__Host-` over https), and the return finishes only in that browser,
  so a sign-in link someone else opens and approves stores nothing for the person who began it. Tokens are sealed under the person's id and never shown;
  a task gets them as environment values the server's definition names, and they are masked in
  every log line. The orchestrator calls none of the server's tools itself, with three exceptions,
  each for that person and as that person: when a person types an issue link into the
  task form, it reads that issue's key, title and status through the server a task of theirs
  would read it with (`getAccessibleAtlassianResources`, `getJiraIssue`), with ten seconds for
  each, and shows the title and status as text, withheld when they read like a secret; and
  when an Atlassian server of theirs is a Work source, it reads their sites, projects and
  issues (`getAccessibleAtlassianResources`, `getVisibleJiraProjects`,
  `searchJiraIssuesUsingJql`, with only a project key and a sprint id held to their shapes in
  the query), shown only to them; and when a board on that server has "Move issues as the agent
  works" on, it moves the issue of a task they started, or one they move by hand, through
  `getTransitionsForJiraIssue` and `transitionJiraIssue`, as described under moving an issue.
- **A Slack channel.** When an admin has connected one, the orchestrator posts the events they picked
  to its incoming webhook: the event's name, the repository id, who acted, and the event log's
  line for it: a request's title, or for something that stopped working its last failure, already
  masked of credentials and secrets; a line that still looks like a secret is left out. The webhook address is sealed in the vault, is accepted only
  on `hooks.slack.com` (or http on this machine), is never shown back, and is masked out of any
  error. Nothing is posted for an event the admin did not pick. With a Slack app the operator
  registered (`ORCHESTRATOR_SLACK_CLIENT_ID` and `ORCHESTRATOR_SLACK_CLIENT_SECRET`, or its `_FILE`),
  **Add to Slack** sends the admin's browser to Slack's approval screen asking for the
  `incoming-webhook` scope alone; the orchestrator exchanges the code with the app's secret, seals
  the channel's webhook address as a pasted one is, and keeps nothing else Slack returns.
- **Signing up to a cloud orchestrator.** For each provider the operator set up
  (`ORCHESTRATOR_SIGN_IN_*`), the orchestrator sends the person's browser to Google, Microsoft or GitHub
  and exchanges the code it returns with that provider's client secret: Google and Microsoft
  through OpenID Connect (discovery, signing keys, an ID token checked against its issuer), and
  GitHub through OAuth, reading the account and `/user/emails` for the verified primary address.
  Nothing else about the person is sent, and signup takes no organization until the operator's
  privacy policy and terms of use are named. Each provider's client secret comes from the
  environment or, preferred, `ORCHESTRATOR_SIGN_IN_<GOOGLE|GITHUB|MICROSOFT>_CLIENT_SECRET_FILE`
  (`secrets/sign-in/` in a release from `orchestrator/deploy/`), and is never written to the
  database. No provider token is kept after sign-in.
- **Single sign-on.** With `ORCHESTRATOR_OIDC_ISSUER` set, the orchestrator fetches the provider's
  discovery document and signing keys, and exchanges each sign-in's code, with the client
  secret and PKCE verifier, at the provider's token endpoint. The person's browser is sent to
  the provider; the orchestrator sends nothing else about them. From the ID token it keeps the
  subject, the address when the provider says it verified it, the name, and the groups the
  configured claim lists (at most 200), which give tags only through a mapping an owner
  previewed and applied.

**Which host names it answers.** Under `ORCHESTRATOR_AUTH=dev-admin`, where everyone who reaches
the port is an admin, only `127.0.0.1`, `localhost` and `[::1]`: a page that re-resolves its own
domain to this machine is refused with 421. Elsewhere the same check is on when
`ORCHESTRATOR_ALLOWED_HOSTS` lists names.

**Who may do what.** Owners have full control; admins manage members, service accounts and
settings; members read, and edit the teams they own. Nobody grants a role above their own or
changes their own role, an admin neither changes nor removes an owner, and the last owner can
be neither demoted nor removed: on Postgres two owners demoting each other at once are put one
after the other by a row lock, measured in the store's tests. An owner cannot leave the
organization; another owner changes their role first.

**Where team policies hold.** A Claude Code install whose managed settings set
`allowManagedHooksOnly` without force-enabling the TeamHandbook plugin in managed
`enabledPlugins`, or whose settings set `disableAllHooks`, runs no TeamHandbook hook, so the rules that reach teammates' sessions through
the TeamHandbook hook (skills, MCP servers and tool patterns) are not enforced there; for such an
organization the orchestrator's managed-settings export (`GET /api/policies/export`) is the way to
enforce them, while repository access, the task budget and the permission-mode ceiling, which the
orchestrator applies itself, hold either way. A policy's ceiling is the highest permission mode the
tasks on a repository run in; where several cover a person and the repository the lowest counts. A
start that asks for a higher mode is refused, from the screen or the orchestrator's MCP
`start_task`, a start that names no mode runs in Auto, or in the ceiling where that is lower, and the
ceiling is read again each time an agent starts and a connected machine takes a task.

**Directory provisioning (SCIM).** An owner makes a SCIM token (`th_scim_` and twelve hex
digits, then the secret; kept as the prefix and a SHA-256, shown once). It reaches the SCIM
routes and nothing else, and no session cookie or API key reaches them. With it the identity
provider adds members, renames them, turns them off and on, removes them, and keeps groups
whose names the directory sync maps to tags; every change is in the event log under
"Directory (SCIM)". A person turned off loses their sessions, keys and app tokens at once, and
every way in (a session, a key, an app token, a password, single sign-on) refuses them through
the same check a verified domain uses, until the directory turns them on. The last owner is
never turned off or removed this way. While a token is set, single sign-on adds nobody the
directory did not, and no longer rewrites a member's groups.

**Deleting one's own account.** A person deletes their own account in each organization they
are signed in to, after a summary, by typing their address back; never with an API key, and
never as the only owner. Their sessions, keys, team ownership and tags go; the requests and
tasks they started stay with the teams, under their address, and the deletion is in the event
log.

**Verified domains.** An owner adds an email domain and publishes the TXT record the orchestrator
gives (`_teamhandbook-orchestrator.<domain>`, a random value that is not a secret); the orchestrator reads
it through DNS when the owner presses Verify. While single sign-on is set up, everyone at a
verified domain but owners signs in only through it: a password sign-in for such an address,
or for one with no account, is refused before the password is checked, so the answer says
nothing about the password or the account; an invitation there is accepted only through SSO;
verifying ends the sessions of everyone at the domain but owners; and from then on their
personal API keys and the tokens of apps they approved are refused, and a new personal key is
not made, so someone the provider closes has no way in left (automation there uses a service
account). A verified domain covers its subdomains: `acme.example` covers `eu.acme.example`. Owners keep their
password, so a broken provider cannot lock the organization out, and without single sign-on
nothing is enforced. Once any domain is verified, the provider lets in without an invitation
only addresses at a verified domain. Only owners add, verify and remove domains, never with a key.

**What it accepts with an API key.** A request with `Authorization: Bearer th_sk_...` is read as
that key alone, whatever cookie came with it, and needs no CSRF token, since a browser never
attaches that header on its own. The key acts as its member, read again on every request, so it
shrinks with their role and stops with their account, and it reaches only the resources its
scopes give (none, read or write per resource) on the routes the orchestrator maps for keys. Every
other route answers 403 to a key: members, roles, invitations, settings, service accounts,
directory sync, sign-in and merging take a person signed in. A key mints keys only for its own
account, none wider than itself and none expiring later. On the orchestrator's MCP server a key is offered only the tools its scopes reach (reading
repositories, requests, tasks or policies; opening a request needs requests write, starting a
task tasks write), and a tool the orchestrator does not map is offered to no key. Revoking a key
revokes every key it minted, through every generation. A revoked or expired
key, or one of another tenant, answers 401. A key makes at most 120 calls a minute, and all the
keys of one person or service account 300 together; past that the orchestrator answers 429 with
`Retry-After`, and the event log notes it at most once per key per ten minutes. The limits are
kept in memory, per orchestrator process. A key does not follow its owner's identity
provider: a person the provider closes keeps their keys until an owner or admin removes them
here, which deletes them, so close the orchestrator account together with the provider's.

**Several orgs on one orchestrator.** Each org the configuration lists is its own tenant, reached at
`/api/orgs/<tenant>/...`, with the plain `/api/...` paths reaching the first. A session, a key
and an account are one org's: a session cookie is named for its tenant and read only by that
org's routes, so a session of one org answers 401 on another's. An org the configuration does
not list answers 404 and is never opened, since a shared database holds tenants other orchestrators
serve. `GET /api/orgs` names only the orgs whose session this browser holds. Single sign-on
reaches only the orgs that set `"sso": true`; the provider's answer returns to the one callback
address and goes to the org whose state cookie it carries. A usage report and an invitation
link go to the org that issued them.

**What it accepts without sign-in.** The sign-in routes (`/api/auth/*`: whether setup is
needed, the first owner's setup, which needs the setup code the orchestrator prints at every start
while it has no owner, or `ORCHESTRATOR_SETUP_TOKEN`, and works once; a password sign-in limited to
ten attempts a minute per address, counted on the trimmed, lower-case address it looks up, and
thirty a minute per client; and the single sign-on redirect and callback, which create no
account before the first owner exists and start at most ten sign-ins a minute per client, with
a ceiling of six hundred a minute for all clients together, so one client starting sign-ins in
a loop holds back only itself (measured in the tests: a second client still starts). A client
is the connection's address, an IPv6 one counted by its /64; `X-Forwarded-For` counts only
from a proxy named in `ORCHESTRATOR_TRUSTED_PROXY`. Each limit remembers at most ten thousand
clients, dropping those idle longest, so filling it with made-up ones refuses nobody else. Setup is limited per client the same way), the join page's two routes (`/api/join/read` and `/api/join`: reading an invitation and accepting
it with a name and password, thirty a minute per client, JSON only and refusing a foreign
`Origin`; the link's token travels after the `#`, which a browser never sends, and then only in
the request body, so no access log records it), and one route,
`POST /ingest/usage/<id>/<repository>`, for the counts in item 5. The id is random and issued for one repository of this orchestrator's tenant; an id of another tenant on a shared database is refused like an unknown one, and every refusal is the same `400 {"error":"refused"}`, naming no path. A batch is refused whole
unless every event names a skill that repository ships and an hour within the last month, and
it is capped at 500 events, 64 KB and 60 requests a minute per id. It keeps no address, user,
machine or session. A holder of a repository's id can inflate that repository's counts within
those limits; the id is in the team repository, so anyone who can read the repository holds it.
No webhook is taken from an issue tracker, and none is set up in one: an automation reads its
board once a minute, its active sprints and backlog, as the owner or admin who set it up, with the
same read a board makes, and what it read is kept in the orchestrator's memory alone, never in the
store. A webhook secret made before this is deleted when the tracker is disconnected.

**The orchestrator's MCP server.** `POST /mcp` sits outside the browser's sign-in and takes a bearer
credential alone: an access token from the orchestrator's own authorization server, or an API key
(bare or after `Bearer`); a session cookie is never read there, since the route takes no CSRF
token. A request with an `Origin` other than `ORCHESTRATOR_PUBLIC_URL` is refused, so a page that
re-resolves its own name to the orchestrator reaches nothing. Each tool call is written to the event
log before it runs, and a call the log does not take is not made. A key or token is offered only
the tools its scopes give (reading repositories, requests and tasks; `requests:write` to propose,
`tasks:write` to start a task), and tools that open a request or start a task are offered only
to someone who can change a team's repository; each call checks the repository it names against
the orchestrator's own record of its team; no tool merges or closes a request. Calls are rate limited:
a key or token spends the one budget every key spends through the orchestrator's key gate (the REST
API's and this server's together, per key and per account), the tools that open a request or
start a task have a smaller budget of their own, and a client address has one before any key is
looked up; each refusal is a 429 with how long to wait, and a key held back is written to the
event log once per ten minutes. The tests drive it with the official MCP client and check each
of these.

**The orchestrator's authorization server.** It issues tokens only for its own MCP server, to public
clients with PKCE S256. A client's registration is not stored: its id is the registration sealed
under `ORCHESTRATOR_SECRET_KEY`, so an altered id opens nothing, and its return addresses are https or
http on this machine only, matched exactly. The approval page is served with `frame-ancestors
'none'` and `X-Frame-Options: DENY`; its decision counts only from the browser session it was
shown to (the session cookie is SameSite=Strict, so another site's form arrives without it), and
the person approves as themselves, in an org they are signed in to. A code lives a minute and is
used once; tokens are kept as SHA-256 hashes only, name their org, and act as the person with
their role read at every call, so a role taken away or an account removed takes effect at once.
A refresh token is spent when used. Registration, approval, token and revocation are rate
limited per client address through the same limiter, answering 429 with how long to wait. Without `ORCHESTRATOR_PUBLIC_URL` and `ORCHESTRATOR_SECRET_KEY`, and
under `ORCHESTRATOR_AUTH=dev-admin`, nothing is issued.

**Where a task runs, and what leaves the machine.** Where the orchestrator runs decides who
reads a task's change and whether the code leaves the person's machine:

| Mode | The agent runs | Who reads the change | Who pushes and opens the request | The code stays on the person's machine |
|---|---|---|---|---|
| On your own machine (`local`, the default) | on that machine, as you: the Claude Code signed in there, with your own settings, memory, skills, plugins, hooks and MCP servers and the team's skills, behind the orchestrator's guard (below), unless `ORCHESTRATOR_TASK_PROFILE=isolated` gives it a profile of its own. OpenCode as you runs as a session of its own `opencode serve` on 127.0.0.1, behind a password made for the task, with your OpenCode sign-in, held to the same rules as Claude Code: they go with the session, which in OpenCode 1.19.4 comes after every config file, so no setting of yours outranks them. No shell or web tool runs, nothing outside the task's folder is reached and nothing is written into a `.git`, its own questions are refused, the team's path rules and denied tools are denied, an MCP tool's call is decided by its server, which the run reads from OpenCode itself: one that reads goes ahead, one of the organization's tracker or a forge that writes is refused, and a tracker's or a forge's call whose server cannot be told from its name is refused too; your other MCP tools are asked, and edits are asked or allowed by the task's mode. Under a policy that keeps your setup out, the task's own config directory takes the place of yours (`~/.config/opencode`); a `~/.opencode` folder of yours is still read. The project's checks run before and after the agent's change as you, with HOME pointed at the task's folder, inside the operating system's sandbox (`sandbox-exec` on macOS, bubblewrap on Linux): they write only to the task's folder, its HOME and its temp directory, read nothing of your home beyond its tool caches and toolchains, and nothing of your sign-ins, an agent's socket or the orchestrator's data (the checks paragraph below says what opens); where neither sandbox starts, no check runs and the task's page says why. | the orchestrator, on the same machine | in a folder without Git, nobody: the change stays in the folder for you to review; in a Git repository, your own git with the sign-in your `gh` or `glab` holds, and the same CLI, for a repository on a forge; the orchestrator's own copy for a repository read by path | yes: the code leaves only in your push and your request; what else leaves is what you connected (the forge your repositories are fetched from, a tracker such as Jira, your MCP servers) and what the agent sends its own model provider |
| A team's server with `ORCHESTRATOR_SERVER_TASKS=1` | on that server, or in a container there, with a profile of its own (`isolated`) by default | the orchestrator | the orchestrator, with the organization's forge access | no: the code is on the server |
| A team's or the cloud's orchestrator, with your machine connected (`runner connect`) | on your machine, as you: the Claude Code or OpenCode signed in there (OpenCode as on your own machine, a session of its own `opencode serve` on 127.0.0.1 under the same rules) and your own git, with your own Claude Code setup, or your sign-in alone where a team policy keeps it out, behind the same guard as on your own machine (your tracker tools that write denied, your other MCP tools as your own rules and the task's mode allow; the repository's own MCP servers off; the team's path rules as Claude Code's own deny rules). The orchestrator hands the machine the task's work with its lease: the prompt masked for the task's secrets, the address a teammate clones the repository from, the branch and base, and the project's checks, masked like the prompt, which run before and after the agent as you, with HOME pointed at the task's folder, inside the same operating system sandbox as on your own machine (below), and not at all where none starts; their exit codes and last lines go up with the request the machine pushes for | the agent on your machine; the orchestrator gets the task's log: the agent's messages, which tool it called on which file or command, its questions and its summary, masked for secrets on the machine, and no diff; for an MCP tool of your own, one the team did not give the task, only the tool's name, your answer and whether it ran, never what the call was aimed at. No tool's output is sent, though the agent can quote one in its own messages. A server the project shares reaches your machine with variable names in place of its values; your machine fills them from your own environment and gives each value only to that server, at its address or to the command it runs, and the task's log names which of your variables each server took, never their values | in a folder without Git on your machine, nobody: the change stays in the folder, and the orchestrator gets only the paths changed and their line counts; in a Git repository, your own git pushes the branch the orchestrator named, after the machine checked the change for a secret, and the orchestrator opens the request from that branch once it passes the checks below | yes: the code leaves only in your push, and the agent's own messages can quote it |

A connected machine pushes with your own git and identity, so it can push another branch or a
tag as well, and the orchestrator does not stop that. Before it opens a request from a machine's
branch, the orchestrator reads only the branch the task was given, from its own mirror: the
branch has to descend from the task's base, every commit on it is read for a secret, and the
change as a whole meets the team's policy, the task's template and the skills' rules.

A task in a folder of several repositories on a connected machine leaves its branch in each
repository it changed, on your machine, and pushes nothing to that repository's remote: the push is
yours. When you press to push one from the task's page, your machine pushes that branch alone, and
only while it is still at the commit the task left, with your own git, to that repository's origin;
it never pushes to the origin's default branch, and a branch you moved since is left for you. It reports each such repository and branch to the orchestrator, which records it as a change
kept on your machine: the task's page names its place in the folder, the branch, and why no request
opened (no remote, a push not made, or a remote this organization did not connect), and the task
waits for your review there. The orchestrator reads nothing from those repositories or their
remotes for it. A request opens only from a branch on a repository this organization connected,
read from the orchestrator's own copy with its own sign-in, never with a token sent to a host the
machine names: its base comes from that copy's default branch, a head other than the one reported
is refused, and the branch is held to the checks above.

A push to a task's request after it opened, by the task's follow-up, its machine or a person, is
checked the same way once the orchestrator sees the new head: its watch reads hosted requests'
heads every two minutes and its own forge's branches directly. Only the commits the target branch
does not have count, and a merge of the target into the branch counts for what the merge adds
itself. A head that fails holds the request with the reason on the task's page; the orchestrator's
own forge's **Merge** then refuses it, and refuses a branch pushed again since it was checked ("the branch moved since it was checked; it is checked again before it merges"). On GitHub and
GitLab the orchestrator merges nothing: it writes the verdict as the commit status
`teamhandbook/pushed-check` on that head, and the forge's own merge button is stopped by it only
when the repository's branch protection requires that status. A head the orchestrator cannot read,
or reads otherwise than the forge reported, holds the request too.

**The folders a connected machine lists.** When you open a project from your connected machine,
the screen asks that machine for folder names through its next poll. The machine lists them
itself, under the rule a local orchestrator's picker holds to (inside your home, no hidden folder,
not Library, not the runner's own data), whatever folder the orchestrator named, and every path
leaves as `~` and what follows it, so your home's path and account name stay on the machine. What
leaves is the names of the folders listed, whether each is a git repository with an origin, and
which project markers (such as `package.json`) it holds; no file's content. Only you, signed in to
that organization, ask your own machine; the answer passes through the orchestrator's memory to the
screen that asked and is not written to its database or a log, and one that is not a list of such
paths is refused.

**A folder of several repositories.** On your own machine a task in a folder that holds several
repositories works on a copy of each one's last commit, not the live folder: each copy is a bare
Git directory that borrows the person's objects, with symbolic links off, and the folder's own
Claude Code settings are never loaded. Nothing is written into the person's repositories until the
task ends; then each repository the agent changed gets the task's one branch by `git fetch` with
hooks and fsmonitor off, and a local request. Nothing is pushed: opening it on GitLab or GitHub
is a button the person presses, as above. A task that names a template, delegates or has targets is
refused there. Which folder a task works in is chosen by the person's own agent from the folders'
names and the first heading of each folder's `CLAUDE.md` (at most 120 characters, left out when it
looks like a secret), or is the folder the person uses most.

**A folder without Git.** On your own machine a task in a folder that is not a Git repository
runs in the folder itself, and the agent writes only inside it. Before and after the task the
orchestrator records the folder in a shadow Git kept in its own data folder (`shadow/`, readable
by its user alone), never in the folder. Links are not recorded; `node_modules`, virtual
environments and nested repositories are left out; and a file named like a key or password file
(`.env`, `*.pem`, `*.key`, `id_*`, `.npmrc`, `.netrc` and the like) is kept as its digest alone,
so its content never reaches the orchestrator's data and **Undo these changes…** cannot put it
back. A folder of more than 5,000 files, or with a file over 5 MB, is refused and the task does
not start. Git runs there with no hook, fsmonitor or protocol, and the folder is checked against
the project rule again on every call, so one turned into a link after it was opened is refused.
Undo writes back only the files still as the task left them: a file you changed since is kept
and named, and a link or a path out of the folder is not touched. None of this leaves the
machine.

Merging a request on your own machine moves the branch checked out in your working copy forward to
the merge, as `git merge --ff-only` does, with your folder's hooks and fsmonitor off; it is refused,
with the reason and the `git merge` command to run yourself, while a tracked file holds a change you
have not committed or the folder's own git settings would run a program or reach outside it.

In local mode the orchestrator reads, stores and passes no forge token: git asks your `gh` or
`glab` for its credential, and the CLI answers git directly. A Gitea repository connected with no
token is reached the same way with your own `tea` from 0.15.0: git's only credential helper is
`tea login helper`, which answers with the login stored for that host and port. tea otherwise uses
its default login whatever host it is for, so the orchestrator names on every call the one login
whose address is the repository's host and port, read from `tea login list`, and refuses when there
are two; `GITEA_TOKEN` and `GITEA_INSTANCE_URL`, which stand in for every login, are left out of
tea's environment. Without tea, a Gitea repository is connected with a token as before. With your
own `gh`, `glab` or `tea` the orchestrator opens a request with the team's reviewers, labels and
assignee (with tea, the reviewers are asked for in a second call right after the request opens),
and beyond that writes one thing: a commit status, on a full commit id, in its own
checks alone (`teamhandbook/pushed-check` on a request it opened, `teamhandbook/review-rules`
only where a repository's owner turned the review check on), its description at most 140
characters. It writes no comment and merges nothing with your sign-in. It also puts no limit on the
network there: an agent reaches whatever your machine reaches, as it does when you run it
yourself; the egress proxy below is for a task in a container on a server.

**What a task does.** Every member starts tasks on the organization's teams, except a team its
editors keep to its owners, where only its owners, the owners and the admins do. A task, its log,
its stream and the request it opened are read by the team's owners, the organization's owners and
admins, whoever started it, and a member it was shared with; anyone else gets the list without it
and "unknown task" for its id, the answer an id that does not exist gets. Only whoever started a
task or edits its team shares it, and only with an active member of the same organization, for
reading: a share never lets its reader stop, keep, undo or answer anything, nor pass the task on,
and each share and its end are in the organization's log. A teammate who reviews a task's request
can suggest a follow-up; it reaches the agent only after the person who started the task continues
the task with it, fenced as data like the starter's own words, the starter can dismiss it, it lapses
once the request is merged or closed, and the log names both people. The browser suite keeps a team to its owners and checks that a
member is then refused in the screen and with a 403 from the API, and that another team's owner is
offered only the repositories they can start on.

- *Where it works.* A checkout of the mirror's head in a directory of the task's own, with a
  HOME and temp directory beside it. The git directory the orchestrator reads the agent's result
  through is outside that directory, so a command the agent plants in a git config there never
  runs in the orchestrator; a test plants one and checks it did not run. The checkout, the HOME and
  the git directory are deleted when the run ends; measured in the container image, the data
  volume holds no task directory after a run.
- *What the agent sees of the host.* `PATH`, the locale, a HOME and temp directory of its own,
  and the variables its adapter names for its model credential, plus any an operator lists in
  `ORCHESTRATOR_TASK_ENV_PASS`. Nothing else of the orchestrator's environment crosses: a test builds the
  environment from a host holding the orchestrator's secret key, a forge token and a cloud key, and
  none of them is in it. The team's tests run without the model credential.
- *Which tools it gets.* The team's skills, and of the team's MCP servers only those the
  plugin's share rule lets travel, and of those only the tools the repository's `mcpTools`
  names one by one in the orchestrator's own configuration. A server none of whose tools is named is
  not given to the agent at all, so it does not start. Claude Code is given each tool by its
  full name and never a whole server, with Bash and the web tools denied, and is started with
  `--setting-sources user` and `--strict-mcp-config`, the flags that keep a repository's
  `.claude/settings.json` and `.mcp.json` out; a test runs a stand-in for the CLI and checks
  the arguments it receives. OpenCode gets MCP
  servers only when the operator sets `ORCHESTRATOR_OPENCODE_MCP=1`. With it, OpenCode is given a
  permission list that denies everything and then allows the file tools, skills and each named
  tool, the checkout's own `opencode.json` and `.opencode/` are ignored, and a server whose name
  holds an underscore or whose definition holds `{env:` or `{file:` is left out; this follows
  OpenCode's own source at version 1.18.31, and a test checks the configuration a stand-in
  receives.
- *An issue link.* The orchestrator never fetches it. It accepts an https address with no user name
  or password, nothing matching a secret pattern, and at most 500 characters once encoded, and
  the agent receives it inside a fence, told that what the issue says is data and not an
  instruction, and not to write to it. A test has a stand-in agent copy its prompt into the
  change and reads it back.
- *Nothing is written to the issue.* The setting for a comment after the request opens,
  `tracker.writeBack`, is refused at start unless absent or `false`. The commit carries its
  subject and one line the orchestrator writes, and none of the agent's words. The request's
  description quotes the task and the agent's report inside fences, with closing words such as
  `Fixes #1` bracketed and smart-commit commands such as `#done` broken, so merging the request
  closes or moves no issue through a tracker integration. A test has a stand-in agent print such
  lines and checks the commit holds none of them and the description holds them inert. A forge
  still notes on an issue that a commit or request mentions its key.
- *Before a request opens.* Every changed file is a regular text file of at most 1 MiB, at most
  200 of them, none a symbolic link, none matching a secret pattern and none holding a credential
  the orchestrator handed the agent; otherwise the task fails and no request opens. Tests cover
  each refusal.
- *The team's checks.* A task runs the configuration's test command, or the checks the project's
  owner approved, before its agent and after it, in the task's directory with the tests'
  environment, time limit and proxy. When a check passed before and fails on the agent's change,
  the orchestrator, not the agent, counts up to two repair rounds, each the same agent in the same
  directory with the failing output quoted as data. A check that still fails opens its request
  marked broken; one that failed before the agent too gets no repair round. The exit codes and the
  last 40 lines of each run reach the task's page and the request, masked as the log is. Finding a
  check reads the project's files and runs nothing. An approval holds a digest of what each command
  runs (every package script with the `.npmrc`, `.yarnrc`, `.yarnrc.yml` and `.pnpmfile.cjs` that
  change how they run, a whole Makefile with what it includes, a build wrapper with its
  properties), and when a digest changes, by a teammate or by the agent, no check runs until they
  are approved again. Only an owner or an admin signed in approves them, never an API key; a
  folder on a person's machine is theirs alone, so only that person signed in reads its checks or
  approves them, and to anyone else, an admin included, the project is not found. On a person's
  own orchestrator, a task started in a folder nothing yet approved checks for approves what the
  folder's files name on that start, the setup among them, under the starter's email, leaving out
  the checks marked as taking long, or taking the first of them when every check is; the task's first line says what
  it checked with. An approval whose files changed since is not renewed that way: the task runs
  without those checks until the person approves them again on the project's page. A folder holding several repositories runs no check at all. In a folder
  without Git the checks run before the folder is first recorded, and no setup runs there.
  On your own machine and on a connected one a check runs as you inside the operating system's
  sandbox, `sandbox-exec` on macOS and bubblewrap on Linux, found once when the first check runs.
  Your home and the orchestrator's or the runner's data directory are kept from it whole, but for the directories above the task's own, which it may stat (never list or read), as resolving a path needs. It reads back, without writing, only the
  caches and toolchains a build reaches by path (`TOOL_PLACES` in
  `orchestrator/server/tasks/check-sandbox.ts`: `~/.npm`, `~/.cache`, `~/.nvm`, `~/.cargo/bin`,
  `~/.m2`, `~/Library/Caches` and the like) and each directory of your PATH under your home on its
  own, never the folder around it, with the sign-in places and cache tokens hidden again inside them
  (`CREDENTIAL_PLACES`: `~/.ssh`, `~/.aws`, `~/.config`, `~/.local/share/keyrings`,
  `~/.cargo/credentials.toml`, `~/.cache/huggingface` and the like). It reads the task's git
  directory without writing to it, and writes only to the task's folder, its HOME and temp
  directory and the standard streams. On macOS it reaches neither the keychain's service nor a unix
  socket outside the task's directories, so not an ssh-agent's, name lookups' own socket aside; on
  Linux `/tmp` and your runtime directory under `/run/user`, where those sockets live, are empty to
  it, and an abstract socket stays reachable, as bubblewrap keeps the network namespace. The
  network stays open, as the tests' is. Where neither sandbox starts, no check runs and the task's
  page and its request say why in one line. Tests cover each case.
- *Files attached to a task.* A run on the orchestrator copies each file people attached to the
  task into the task's own folder, outside its working tree, so none reaches a commit or a request,
  and gives that folder to the agent for reading only: Claude Code gets it with `--add-dir` and every
  edit or write into it denied, and under Run as me the orchestrator's guard refuses a write outside
  the tree as well. The prompt names each file, quoted as data. The folder goes with the task's
  folder when the task ends. A connected machine is not handed attachments yet.
- *A task with no agent.* The scaffold refresh and the switch to versioning by commit are
  the plugin's own `upgradeCandidates`, run by the orchestrator in the task's checkout: nothing is
  started there, and no credential is handed to anything. It writes only the files the
  plugin offers (never `skills/`, `commands/`, `agents/` or `.mcp.json`), with the
  configured `memberUrl` as the address it writes, never the fetch address. Its result passes
  the same checks and opens a request a person merges, like any task's.
- *Readiness.* At an admin's request, or when the Tasks screen first needs one and then at
  most every 5 minutes, the orchestrator starts each offered agent CLI with `--version` and with
  its read-only status command (`claude auth status --json`, `opencode auth list`). Each
  starts as a task's agent does: the task's stripped environment and credentials, a fresh
  HOME deleted afterwards, a container of the task image under container isolation (an
  image the daemon lacks is inspected, never pulled), and a 20-second limit that ends its
  process group, and under container isolation the probe's container is removed with it.
  Under process isolation the probe has the network a task has. Of the status answer only
  whether a credential is there and its kind are kept, and an answer the orchestrator does not
  read is never quoted; an email, an organisation or a token in it is not shown. A line
  quoted from a failed `--version` is redacted, then clipped, like the log. The details (a
  CLI's path, what it printed) are shown to an admin only; anyone else is told whether an
  agent is ready. A test runs each against stand-in CLIs, never a real one, and so does the
  browser suite.
- *Limits.* A task stops at $10 of cost or 60 minutes of run time unless Settings changes either
  (a limit set to none means no limit), checked every 15 seconds; the cost counted mid-turn is an
  estimate, and the task stops on it too, saying so. The minutes pause while the agent waits on a
  question on the card, the cost never pauses. A task cut off by the orchestrator restarting is put
  back in line by itself at most three times in a row, then waits for **Continue**
  (`tasks.auto-continue` set to off ends that). A local orchestrator runs one task at a time, a
  delegated child apart; a connected machine runs two at once, three at most, and one under load or
  below 30% battery. A delegated task has at most three children, one level deep.
- *Stopping.* A time limit or a cancel ends the agent's whole process group, so whatever it
  started ends with it; a test starts a child of the agent and checks it is gone. A log line the
  store refuses stops the agent and fails the task. An orchestrator stopped by SIGTERM or SIGINT
  stops its running tasks the same way, deletes their directories and fails them before it
  exits. An orchestrator killed outright leaves its agents running until the next start, which ends
  each one's process group, only when a process in it still works in that task's directory or,
  on Linux, carries the task's marker in its environment, so a group id the system has handed
  to something else is left alone, and deletes the directories left behind. A task's branch
  that reached a local team repository before its request was recorded is moved under
  `refs/orchestrator/orphaned/` with its description, as the orchestrator's other unnamed branches are;
  a hosted forge's branch stays where the forge has it. macOS does not
  show one process another's environment, so there an agent that left its task's directory
  survives the restart. A second orchestrator started on the same data directory stops at once,
  without ending a process or deleting a directory, while the first one runs; measured with
  two orchestrators on one directory and with two containers on one volume. On Postgres a second
  orchestrator of the same tenant stops the same way whatever its data directory, by a lock the
  first holds in the database before it writes anything - one per org it serves, all on one
  connection, so an orchestrator refused one of its orgs holds none of them - and an orchestrator whose connection
  holding that lock closes exits at once without writing more; tested against a real Postgres
  and measured with two built orchestrators.
  Measured with the built server and a stand-in agent that starts a child: after SIGTERM the
  agent, its child and the directories were gone; after SIGKILL they remained until the next
  start ended and deleted them.
- *Isolation.* Under the default `process` isolation the agent runs as the orchestrator's own OS
  user, so it can read the orchestrator's environment and its files and change whatever that user
  can: the database, and `ORCHESTRATOR_SECRET_KEY` with it, which opens every forge token the
  database holds, the OIDC client secret and the setup code. Giving those as `NAME_FILE` keeps
  them out of the environment, `docker inspect` and process listings, and the agent can still
  read the file as the same user. Process isolation is not a sandbox: run work from a
  repository or an issue you do not trust in container isolation. `ORCHESTRATOR_TASK_NETWORK=none`
  is refused under `process` because nothing there enforces it. A task's agent can also read
  the team file's usage address, and with the network open it can raise that repository's
  skill-use counts within the receiver's limits, as anyone who reads the repository can;
  container isolation with `--network none` cuts that off. `container` isolation is off by default. Turning it on mounts the Docker socket into the
  orchestrator, and control of that socket is control of the host as root. It runs each process of a
  task in a new container with every capability dropped, `no-new-privileges`, a process limit,
  only the task's own directory mounted, `--network none` when asked, and credentials passed by
  name so that none appears on a command line; a test checks the docker command, and the browser
  suite has run a task through it with the network off.
- **A task's secrets are given by name and kept out of everything it writes.** The vault's
  secrets for a task's team and repository reach its setup, agent and tests as environment
  variables (by name, never on a container's command line). Every value joins the credentials
  the orchestrator masks in the task's log, each process's output and the request text, and a change
  carrying one is refused. A value shorter than 8 characters, too short to mask without masking
  ordinary text, refuses the task instead. Only the names are recorded, in the task log and the audit log. A
  name the orchestrator also passes refuses the task rather than letting either value win silently.
- **A task secret kept in 1Password is read by the orchestrator alone.** A task secret that names
  an item (`op://vault/item/field`) keeps the reference, sealed in the vault in the value's place.
  The orchestrator's own `op` CLI reads the value when a task starts and whenever a branch a
  machine pushed is checked, with the service account token its operator sets
  (`OP_SERVICE_ACCOUNT_TOKEN`), from the vaults named in `ORCHESTRATOR_1PASSWORD_VAULTS` and no
  other, with the CLI's cache off and 45 seconds for each call; the token is handed to `op` and to
  nothing else. A reference in another vault, or in a shape that would change the template it is
  read through, is refused when it is written. The value is held in memory only and masked as a
  value written on the screen is. A reference that reads no value stops the task, and keeps a
  pushed branch's request from opening or holds it, since a check that cannot see a value cannot
  mask it. A runner on a person's machine never reads that person's own 1Password session.
- **A repository's allow list is held, not advised.** When `.teamhandbook/environment.json`
  names `agent.allowedDomains`, the agent and the tests run in a container with `--network none`;
  their only way out is a socket to the orchestrator's proxy, which opens a listed name on port 80 or
  443 and refuses everything else, an IP address included. The proxy resolves the name itself,
  refuses it when any answer lies inside (this machine, a private network, a cloud's metadata
  service at 169.254.169.254), and connects to the address it judged, so neither a name pointed
  inward nor a second, different answer from DNS reaches what the container itself cannot. A program that ignores its proxy
  setting reaches nothing. The setup command runs before them with the network the orchestrator
  allows and none of its credentials, and what it creates stays out of the request. Under process
  isolation nothing holds a list, so such a repository's tasks are refused.
- **Run as me runs your own Claude Code, held by the orchestrator's guard.** A one-person orchestrator starts Claude Code as its user by default
  (`ORCHESTRATOR_TASK_PROFILE=isolated` turns it off), and a machine connected with `runner connect`
  starts it the same way. The task loads the person's own user settings, memory, CLAUDE.md, skills,
  plugins, hooks and MCP servers, as their own sessions do, the TeamHandbook plugin's hooks
  included, and writes its transcript into their profile as theirs do. Only their user settings
  load, until the person says that they trust a folder they opened themselves, once per project
  and off until they do, on the task's page (**Use them** or **Keep them off**): a folder's settings can run programs and send the model
  and the sign-in elsewhere (`apiKeyHelper`, `env`), and print mode asks nobody whether to trust
  them. Only the person who opened the folder answers (the owner of a one-person orchestrator, or
  the machine's person), the audit log records each answer, and a clone the orchestrator or the
  machine makes always loads the user's settings alone. A trusted folder whose own settings switch
  every hook off refuses the task, since Claude Code then drops the guard's hook, and its own
  `.mcp.json` servers stay off by name either way. The orchestrator adds the
  team's skills as a plugin of the task's own for that session, its own MCP server beside the
  person's from a file in the guard's folder that the agent cannot read, and the repository
  servers an admin approved; nothing is written into the profile. A team policy can keep the
  person's own setup out of a repository's tasks: on the orchestrator and in the work it hands a
  machine, the run then takes the sign-in alone in Claude Code's restricted mode with
  `--strict-mcp-config`, and on the orchestrator the team's skills as well. A runner on the person's own machine that someone
  changed is not held to that decision; the push check below holds a pushed branch to the team's
  rules apart from it. The mode is named on every start, so the person's own `defaultMode`
  decides nothing, and Full access runs as Auto. The shell is the person's, as in their own sessions:
  Bash runs in Auto and is asked about on the card in a mode that asks, unless the team's rules deny
  it, and the web is left to the person's own permission rules. The guard's deny rules on reading
  hold for Claude Code's file tools; a shell command reads what the person's account reads. The orchestrator's guard is a settings layer of
  its own, from the task's directory and never the profile: deny rules keep the agent's file tools
  out of the guard, the person's Claude Code settings and `.git` folders, its reads out of the
  person's `~/.ssh`, `~/.aws`, `gh` and `glab` sign-ins, `~/.netrc` and Claude Code's own `~/.claude` and `~/.claude.json` (not other places a cloud or tool keeps a sign-in, which a shell reads as the account does) and out of the orchestrator's data folder beside the
  task's own (its database with the secrets it keeps, its backups, its copies of the teams'
  repositories and the files people attached), and carry the team's rules on editing and reading
  paths; a PreToolUse hook denies every write outside the folder the task works in, a tracker's
  and a forge's tools that write (below), and a call it cannot read. It lets an MCP tool whose
  name reads (get, list, search and the like, after a product name such as `jira_` or `slack_`)
  run in every mode, Auto's included, as the person's own sessions do, so the agent reads the
  issue and the conversation the task is about. The person's other MCP tools run as their
  own permission rules allow; any other is asked about on the task's card, in Auto as in a mode
  that asks, and refused only on a run with no card. The agent waits on the card and spends
  nothing meanwhile, and the task's time limit does not count that wait. A session that plans first
  puts its plan to the person on the card before it goes on in the task's mode; the plan file sits
  inside the task's folder and is kept out of the change. Claude Code
  takes the strictest of several hooks' decisions and lets no hook's allow pass a deny rule, so a
  hook of the person's own cannot lift the guard; the layer turns `disableAllHooks` off over the
  person's own settings, and managed settings that switch hooks off (`disableAllHooks`,
  `allowManagedHooksOnly`, `strictPluginOnlyCustomization`) or cannot be read refuse the task
  before it starts. The person's own MCP servers and hooks start with
  the agent's environment, the task's secrets included, as they would in a session of theirs. The repository's own `.mcp.json` servers stay off by name. The change is
  checked against the team's rules again after the run, and reaches people only as a request a
  person reviews, or, in a folder without Git, as changes the person reviews in the folder. What
  the person's own MCP servers return stays with the agent: the task's log carries the agent's
  messages, which can quote it, and which tool it called on what, never a tool's result.
- **The orchestrator reads a person's own Claude Code setup by names alone.** For the task form and
  the Integrations page, a one-person orchestrator's owner session gets the names, descriptions
  and argument hints of their commands and skills, their plugins by name, marketplace, version,
  scope and whether each is on, and their MCP servers by name, kind, where each is defined and
  whether its definition carries a credential. Commands come from the CLI's answer to its first
  control request, with the user's settings alone, every hook off and no MCP server, ended as soon
  as it answers and before any model turn; plugins from `claude plugin list --json`, which does
  not connect their servers but can bring the person's plugin marketplaces up to date over the
  network, as their own Claude Code does when it starts; servers from the global config's and each opened folder's `mcpServers`
  read as files, never through `claude mcp list`, which connects to each one. No command, argument,
  address, header, value, path or account is kept, logged or answered, and claude.ai's connectors
  are not listed.
- **A task's agent writes nothing to the organization's tracker.** An MCP tool named for an issue
  tracker or its wiki (Jira, Confluence and the rest of Atlassian's, issues and worklogs), on any
  server and whatever the server is called, that does not start with a reading verb is refused
  in every task: left out of the tools an isolated task is given, the operator's own `mcpTools`
  included, and denied by the guard's hook in a run as you, ahead of the orchestrator's own tools
  and of the person's own allow rules, which a hook's deny wins over, and a request for one in a
  conversation is answered no before it reaches anyone's card. No setting lifts it: the tracker
  switch on Integrations lets the orchestrator move an issue, never a task's agent change one.
  A forge's tool is held the same way, on every path and under no setting: one named for GitHub,
  GitLab or Gitea, or for requests and reviews, that does not start with a reading verb is never
  given, denied by the hook and answered no before a card, so the agent merges, approves, reviews,
  comments on or changes nothing on the forge and its change reaches people only as a request a
  person reviews, past the team's push check and review.
- **A review check writes a status, never a comment, and is judged by rules the request cannot
  touch.** A repository's review check is off until a team owner or an admin turns it on, which
  the audit log records. It hears of requests only through the signed hook, reviews only
  requests into the default branch and reads the team's rules from it, runs with no one's
  own profile and under the orchestrator's repository access and budget rules for the person who
  turned it on, gives the agent the change as fenced data with no
  edit, shell, web, skill or MCP server, and writes only a commit status named
  `teamhandbook/review-rules`; a run that cannot decide writes an error status, which a forge
  requiring the check holds the merge on. The agent's reason is cut short, masked and screened
  for secrets before it becomes the status line.
- **A forge comment can start a job, and nothing more.** `POST /api/hooks/forge/<repository>`
  answers without a session, so it accepts a delivery only with GitHub's HMAC signature or
  GitLab's token made from the secret the repository's `triggerSecretEnv` names, compared in
  constant time; a repository with no such secret has no hook. The comment's author has to be a
  orchestrator user who can change that team, matched by forge login, and the job runs as them under
  the same rules, budget and policies as a start from the orchestrator, a forge login matched in any
  case and one that two accounts carry matching nobody. A comment already handled is ignored,
  known by its address inside the signed body and by the tasks it started, so neither a
  made-up delivery id nor a restart lets a captured delivery start the job again. The comment reaches the agent fenced as data, starts only a job the configuration
  names, and approves nothing: the task ends in a request a person merges.

## Reporting a vulnerability

Open a GitHub issue. Anything you send arrives in public; this repository has no
private reporting channel yet. Include the version (`.claude-plugin/plugin.json`) and
steps to reproduce.
