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
  read and harvested after the fact. Each session is salvaged at most once.
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
- **`~/.claude.json`, read-only, and only when you run `/handbook:share`:** the MCP
  servers Claude Code has configured for your user and for
  the current project, so they can be offered to your team. TeamHandbook never writes to
  this file: it belongs to the running client, and sharing a server does not remove your
  own. A server definition holding a literal value in `headers` or `env` is refused rather
  than carried, because only a plain `${VAR}` reference proves the credential itself stays
  on this machine. That rule is structural and absolute for those two fields. It is not a
  promise about the whole definition: a URL is additionally scanned for an embedded token,
  but that scan is a heuristic that can miss a short or word-shaped one, and a credential
  passed through a stdio server's `args` is not checked at all. The merge request prints
  the endpoint and the full command so a person reads them before the server reaches
  anyone.
- **The team plugin's copy on this machine, read-only, and only when you run
  `/handbook:share`:** the skills, commands and `.mcp.json` under
  `~/.claude/plugins/marketplaces/<team>`, compared by content with your own copies so the
  screen can name the ones you now have twice. Nothing is removed: the screen prints the
  command that would remove your copy, and running it is yours to decide.

## What it writes, and where

All state lives under `~/.teamhandbook/` (override with `TEAMHANDBOOK_HOME`):

- `sessions/` - per-session working state: the failing command and its fix, the
  transcript path, any flagged teachings, and the paths of files written inside a
  repository. Kept until the session ends or is salvaged.
- `signals.jsonl` - the evidence ledger of captured error→fix pairs.
- `pending/` - harvest jobs waiting for the background runner: one file per session
  holding its id, cwd, the **path** to its transcript, and the captured evidence.
  The runner claims a job by rename and deletes it before calling `claude`.
- `candidates/` - the review queue: each pending lesson's `SKILL.md`, its grounded
  case, and its metadata.
- `counters.json`, `pipeline.log` - activity counters and one line per harvest run
  (what was produced, sieved, or errored). `pipeline.log` is rotated, never deleted.
- `teachings.json` - what you have already said, so a rule you give twice is
  recognized as a repeat instead of scored as a guess. Holds the content words of each
  recorded prompt, a count, and a 160-character sample of your own sentence - the same
  text the session files already keep, behind the same secret scan, capped at the 2000
  most recent - about three months. Since prompts are no longer pre-filtered by an
  English phrase list, this file now holds ordinary prompts alongside rules; nothing is
  ever read out of it except by matching against a lesson the model has already
  proposed, so what it remembers only surfaces when it is the thing you taught. Local
  only.
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
- `config.json` - your settings. `muted.json` - fingerprints silenced by
  `reject --never`. Notice state (`welcomed`, `notified-counters.json`,
  `nudged-team`, `last-digest`, `seen-skills.json`) - what has
  already been shown to you, so a notice never repeats.
- `debug/` - raw hook payloads, written only when you set `TEAMHANDBOOK_DEBUG=1`.
- `abandoned.jsonl` - a harvest job that failed to reach `claude` three times is
  parked here rather than dropped silently, so the session's evidence stays
  recoverable. It persists until you delete it; `/handbook:status` reports the count.
- `workflows.jsonl`, `workflow-salt`, `mined-workflows.json` - the sessions recognized
  as a piece of workflow, the salt their hashes use, and the last `/handbook:mine` run
  they are named against. Field by field in
  [Recognizing a workflow in a session](#recognizing-a-workflow-in-a-session).

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
  fingerprint (only a redaction counter is kept). For transcript slices the mechanism
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
  tail: neither cut splits a line the detector would flag. Most credential rules are
  anchored to a keyword beside the value, so a cut through `password: ...` would leave the
  value on a line with no keyword left on it, where no rule can see it; such a line is
  taken whole or not at all. The number of redacted lines is recorded in `pipeline.log`.
  Either way the raw secret text reaches neither disk nor the model. Detection is
  best-effort pattern matching (see `src/lib/secrets.ts`); a secret in an unrecognized
  format can slip through, so review a candidate before approving it. What
  bounds that best effort is a corpus: the detector is measured against secret families in
  the contexts a session actually sees - a command line, stderr, a diff, a config file, a
  header - and the corpus lives in the test suite, so a family IN IT that the detector
  cannot name in any of those contexts fails the build; a shape it names nowhere, held only
  by the message-level drop, is asserted there instead. A format the corpus does not carry
  is covered by the sentence above and by nothing else.
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
   before a session is queued. Capture itself keeps running either way: the hooks that
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
     you to paste.
3. **On your explicit selection:** `/handbook:init` pushes the scaffold to a repository you
   name and confirm, and `/handbook:init --upgrade` opens a PR that brings an already
   scaffolded repository's scaffold files up to this version. `--upgrade` writes only files
   the scaffold itself generates, and only the ones you name one by one with `--file`:
   without a `--file` it prints the diff and makes no change at all. It never writes
   `skills/`, `commands/`, `agents/` or `.mcp.json`, and inside the two `.claude-plugin`
   manifests it carries the team's own entries across rather than replacing them. An
   example branch name you give it with `--branch-example` is screened like a branch and
   written into the team's `.teamhandbook.json` in that same request, for teammates who
   join afterwards to read.
4. **A release check, carrying nothing of yours:** `/handbook:status` and
   `/handbook:doctor` ask the repository this plugin was installed from for its release
   tags - one `git ls-remote --tags`, run in the marketplace clone Claude Code keeps - to
   say whether a newer version exists. It sends no content, makes no model call, and is
   skipped silently when it cannot be made.

## What `/handbook:mine` reads and sends

`/handbook:mine` with no arguments reads git history and nothing else. It walks the
repository you are in, plus any you name with `--repo` or list under `mine.repos`, all
read-only, and prints what repeats. It makes no model call and opens no network
connection, so listing costs nothing and discloses nothing.

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
written and leaves the candidate waiting.

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
masking part of it, and a counter in `counters.json` says how many were dropped.

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
redrafted or deleted because of a finding, no model is called and no connection is opened.

**What it reads.** The `SKILL.md` of each delivered skill; the repository a skill was
installed into, or the repositories its map rows name when `mined-workflows.json` knows
them: the tracked file list (`git ls-files`) and the commit history (`git log`, the same
read `/handbook:mine` makes); `skill-usage.json` and `workflows.jsonl`; and the name and
description of every skill this machine loads - the project's `.claude/skills`, your
`~/.claude/skills`, and the team repository's skills as your local clone of it holds them.

**What it writes.** Nothing. The only new data is in `skill-usage.json` as described above,
written by the hook rather than by this report: beside the name, running count and time of
the last call it already kept, how many calls fell on each of the last 30 days, and never
the call's arguments.

**What leaves your machine.** Nothing. The team repository's skills are read from the
clone already on disk, so the overlap warning makes no request.

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

`/handbook:join` clones a repository somebody else controls. Two values are read out of
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
reaches your terminal and the `-m` of a commit this tool makes in a clone of that same
repository, so it is accepted only when it is at most 64 characters and carries no control
character: a newline would end the commit title and turn the rest into a body nobody wrote,
and an escape sequence would rewrite what you are shown. A prefix that fails either check
is refused with the reason and nothing is recorded, exactly as a bad marketplace name is.
It is never used to name a file, run a command, or reach the network.

Those two are what `/handbook:join` itself reads. A repository you have joined also ships
skills, and a skill's **name** is read from its frontmatter wherever the plugin lists what
you already have - including into the prompt that decides whether a new candidate
duplicates one. A name is therefore screened too, at the point it would otherwise become
part of that prompt's structure rather than part of its data.
Skills, servers and commands merged into that repository arrive on this machine through
Claude Code's own marketplace subscription. TeamHandbook does not screen them: nothing
here reads them, and nothing here approves them - `/handbook:review` and
`/handbook:share` gate what leaves this machine, not what arrives from the team.

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

## Reporting a vulnerability

Open a GitHub issue. Anything you send arrives in public; this repository has no
private reporting channel yet. Include the version (`.claude-plugin/plugin.json`) and
steps to reproduce.
