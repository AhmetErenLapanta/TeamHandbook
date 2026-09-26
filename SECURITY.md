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

## What it writes, and where

All state lives under `~/.teamhandbook/` (override with `TEAMHANDBOOK_HOME`):

- `sessions/` - per-session working state: the failing command and its fix, the
  transcript path, and any flagged teachings. Kept until the session ends or is
  salvaged.
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
  is a name and a count: no arguments, no file contents, no prompt. The hook sees
  **every** skill you invoke, including ones from other plugins, and the file records
  them all; what `/handbook:status` reports on is deliberately narrower - only the
  skills TeamHandbook itself delivered or pulled from your team repo, because counting
  the others would credit TeamHandbook with work it did not do. Either way it never
  leaves your machine.
- `config.json` - your settings. `muted.json` - fingerprints silenced by
  `reject --never`. Notice state (`welcomed`, `notified-counters.json`,
  `nudged-team`, `last-digest`, `seen-skills.json`) - what has
  already been shown to you, so a notice never repeats.
- `debug/` - raw hook payloads, written only when you set `TEAMHANDBOOK_DEBUG=1`.
- `abandoned.jsonl` - a harvest job that failed to reach `claude` three times is
  parked here rather than dropped silently, so the session's evidence stays
  recoverable. It persists until you delete it; `/handbook:status` reports the count.

Approved skills are written **outside** `~/.teamhandbook/`, where Claude Code loads
them: `~/.claude/skills/<slug>/` (personal), the repo's `.claude/skills/<slug>/`
(project), or the team repo via a pull request.

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
  message, and a lockfile is nothing but those lines. The number of redacted lines is
  recorded in `pipeline.log`. Either way the raw secret text reaches neither disk nor the
  model. Detection is best-effort pattern matching (see `src/lib/secrets.ts`); a secret in
  an unrecognized format can slip through, so review a candidate before approving it. What
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

Two things, and only these:

1. **Automatically, before you review:** at the end of a substantive session,
   TeamHandbook calls `claude -p` (your own Claude CLI) **once**, with a redacted slice
   of that session's conversation - up to 40 000 characters, 60% of that budget
   reserved for your own messages - plus the captured error→fix pairs and the
   session's work shape. This reaches Anthropic exactly as any Claude Code prompt
   does. Disable it with `{"harvest": {"enabled": false}}`, or disable every
   automatic model call with `{"gate": {"auto": false}}`, in
   `~/.teamhandbook/config.json`; both are checked before a session is queued, so the
   transcript is never read and nothing is sent. `/handbook:learn` still works and
   sends only what you asked it to capture.
   - Precisely: those switches stop the SENDING, not the local capture. The
     `PostToolUse` and `UserPromptSubmit` hooks keep writing evidence into
     `~/.teamhandbook/` (secret-redacted, as above) so the history is there if you turn
     harvesting back on. If you want no local capture either, uninstall the plugin.
   - If `config.json` exists but cannot be parsed, both switches fail **closed** -
     a trailing comma in a hand-edited file must never silently re-enable sending -
     and the next session-start notice tells you.
   - A session with no substance (no error→fix pair, no teaching, no real work) is
     never harvested and costs no model call at all.
2. **On your approval:** `/handbook:review` → approve installs the skill locally or
   opens a PR to the team repo you configured (your git credentials, your chosen repo).
   That command is the gate for everything the HARVEST proposed: a candidate it produced
   reaches nobody until you give it a verdict.
   `/handbook:share` is the other approval, for content you already have. Whatever you
   pick on its screen - skills, MCP servers, slash commands - goes out together in a
   single PR you can read before merging. Picking it there is the approval, the same act
   for all three kinds; the harvest proposed none of it, so there is no second verdict to
   give. Nothing is shared with your team before one of these two.
3. **On your explicit selection:** `/handbook:init` pushes the scaffold to a repository you
   name and confirm, and `/handbook:init --upgrade` opens a PR that brings an already
   scaffolded repository's scaffold files up to this version. `--upgrade` writes only files
   the scaffold itself generates, and only the ones you name one by one with `--file`:
   without a `--file` it prints the diff and makes no change at all. It never writes
   `skills/`, `commands/`, `agents/` or `.mcp.json`, and inside the two `.claude-plugin`
   manifests it carries the team's own entries across rather than replacing them.

## Removing your data

```
rm -rf ~/.teamhandbook
```

That deletes every byte TeamHandbook itself stores - ledger, queue, per-session state,
counters, `pipeline.log`, any `abandoned.jsonl`, and notice state. There is no other
storage location and no remote copy.

Skills you already approved are ordinary files and are **not** removed by that
command: delete `~/.claude/skills/<slug>/` (personal) or the repo's
`.claude/skills/<slug>/` (project) yourself, and remove merged skills from the team
repo like any other commit.

## Trust model

Plugin hooks execute with your user privileges and run automatically once installed.
Everything captured from a session - stderr, commands, and the transcript slice - is
fenced as untrusted data inside every model prompt, so text that looks like an
instruction can never steer the harvest. Review the source before installing, as you
would any plugin. TeamHandbook is open source (Apache-2.0) specifically so this is
auditable.

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

That is the whole of what is checked, because those two are the whole of what is read.
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
