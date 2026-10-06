---
description: Take what is already set up on this machine to the team: lists every skill you have installed, every MCP server you have configured, and every slash command you have, in one screen, you pick as many or as few as you want, and the picked ones go out together. This is the one door for sharing a thing you already have, whether it is one server or twenty skills. Everything you pick - a skill you wrote by hand, a server or a command - goes straight out together as one merge request to the team's plugin repository, so nobody has to install or configure it by hand. It only reads your own config and skill folders, and never modifies your copies. To capture something out of the session you are in, use /handbook:learn instead; to give a verdict on what TeamHandbook has already captured for you, use /handbook:review. Triggers: "share my setup with the team", "share this MCP server with everyone", "the team should have this server too", "one of my own skills should go to the team", "this skill of mine belongs in the team handbook", "move my skills to the team handbook", "push my MCP config to the team", "set this server up for the whole team", "distribute an MCP server", "update the team's MCP settings", "which of my skills should the team have", "send an existing skill to the team", "add a skill I already have to the team repo", "send several of these at once", "migrate my local setup", "I have a lot of skills, let me pick some".
argument-hint: [optional path to a skill directory that is not installed on this machine]
---

You are running TeamHandbook's sharing flow: what is already on this machine, chosen from
and carried to the team. It reads `~/.claude/skills`, `~/.claude/commands`, this project's
`.claude/skills` and `.claude/commands`, and `~/.claude.json`, and the team plugin's copy
under `~/.claude/plugins/marketplaces` to tell which of those it already carries word for
word. It writes to none of them, and the copies the user already uses keep working untouched.

This is the only command for sharing something that already exists here, and it always
opens the selection screen, including when the user names a single server or a single
skill. Naming one thing therefore costs one extra step, and that price is deliberate: a
plain sentence about sharing reached the wrong one of three commands often enough that
the split, not the wording of any one of them, was the fault.

Three kinds of thing can travel, and the same thing happens to all of them: they go out
together in ONE merge request to the team repository, which other people can see. The user
has to know that before they choose, not after:

- a **skill** goes out as `skills/<name>/`, with every file it carries.
- an **MCP server** goes out in that same request, declared in `.mcp.json`.
- a **slash command** goes out in that same request, as `commands/<name>.md`.

Picking something here IS the approval, which is why there is no second verdict to give:
the user opened this screen and chose their own content. /handbook:review is for the other
direction - the candidates the HARVEST proposed, which nobody asked for.

1. Run it read-only first: `node "${CLAUDE_PLUGIN_ROOT}/dist/share.js" list`
   If a team repository is configured this step clones it once, shallow, to see which names
   the team already carries - so it can take a moment, and it is the only part of this
   command that touches the network before anything is shared. A repository it cannot reach
   costs only the "already on the team" labels; the list still opens.
   Relay the whole list, all three sections, exactly as printed, including the entries it
   marks not shareable and the reason for each. Show everything before asking anything: the
   point of this command is that the user sees how much they have and decides where to
   spend their attention. Nothing is shared by this step.
   If the list ends with "This machine cannot open the merge request", relay that line too,
   now: it says how the request will reach the forge and that "you decide" is not an answer
   to the commit message on this machine. The user hears it before picking, not after a push.
2. Say that consequence in one line, then ask. Everything on this screen is seen by other
   people once it is picked, a skill no less than a server.
3. **If the list opens by saying how many rounds the dialogs would take, ask in words
   first.** Before any dialog, ask the user to name what they want: names, patterns
   (`add-*`), `all skills`, `no mcp`, separated by commas. Pass their answer verbatim, in
   quotes, to the read-only resolver:
   `node "${CLAUDE_PLUGIN_ROOT}/dist/share.js" pick "<their words, exactly>"`
   Never expand a pattern yourself, translate their words or add a name to them: the CLI
   matches them against this machine the same way every time, and that is what makes the
   result theirs. It refuses a name that matches nothing, and a bare `*` (picking
   everything has to be said with the word "all") - relay the error and ask again rather
   than guessing which name they meant. Relay what it prints as printed: how many were
   picked and which, anything a pattern matched that cannot be shared and why, and how
   many are not decided yet. Then ask once whether they want any of the undecided ones;
   only if they do, open the dialogs below over those entries alone. The command it printed
   at the end is the share for step 4, with any dialog picks added to it.
   Otherwise, and for what a pick left undecided, ask with the multiple-choice question
   tool (AskUserQuestion), `multiSelect` enabled, the same way /handbook:review asks for
   verdicts. **Nothing is pre-selected and nothing is recommended.** Do not mark an option
   as recommended, do not pre-tick, and
   never treat "all of them" as the default: the user asked for this command precisely
   because sharing everything is the wrong answer.
   - Put the MCP servers in their own question, and the commands in their own, since a
     server that connects and a command somebody types need different attention.
   - Put the skills in the questions that remain, four per question, in the order the list
     printed them. A dialog holds four questions, so a long inventory takes more than one
     pass; say how many are left after each.
   - Offer only what the list called shareable. A refusal is the point, not an obstacle.
   - An entry marked **already on the team** is a third state, not a refusal: it can still
     be picked. Picking it alone changes nothing about theirs - the share turns it back and
     tells you the command that would update it, which you then ask about (step 6).
     Say that where it is offered, because the user is choosing to overwrite something
     other people already use. That mark is absent when the team repository could not be
     read, so its absence never proves the team does not have it - the share itself makes
     the real check and turns the selection back if it does.
   - An entry carrying an **overlaps** line is a warning, not a refusal: its description
     answers the same requests as the skill it names, so a request may reach either one.
     It can still be picked. Say the overlap where the skill is offered, and leave whether
     to reword one of the two to the user.
   - Say once, before the first dialog, that they can answer in free text instead
     ("gitlab-*", "all servers, no skills") if they already know what they want, and
     resolve that answer with `pick` exactly as above. Twenty skills is six dialogs, and a
     person who knows their own setup should not have to click through them.
   - If the user is naming one single thing and nothing else, still show the list and still
     ask: confirming one entry is one click, and it is what stops a near-miss on a name
     from sharing the wrong server.
4. Run it with the names they picked, and only those:
   `node "${CLAUDE_PLUGIN_ROOT}/dist/share.js" share --skill <name> --mcp <name> --command <name>`
   Never add a name the user did not choose. With no flags the command shares nothing,
   which is the correct answer to an empty selection. If the user named a branch earlier in
   this conversation, for this command or another one, add `--branch-hint <that name>`: the
   proposal then reuses its ticket. Each run is a fresh process and remembers nothing, so
   the conversation is the only place that answer lives.
   **This first run commits and pushes nothing.** It comes back with one question on its
   first line - ``Branch `<name>` · message `<text>` - confirm or change either.`` - then
   `commit message required`, and any refusal or collision the selection hit. That is the
   screen steps 6 and 7 work from.
5. **A skill the list does not show** is shared by path instead:
   `node "${CLAUDE_PLUGIN_ROOT}/dist/share.js" share --skill-path <directory>`
   If the command was invoked with a directory path ($ARGUMENTS), that path is the
   `--skill-path` value; the CLI takes it only behind that flag, never as a bare argument.
   The list covers the two directories Claude Code loads skills from, so this is for a
   skill that is written but not installed: one being authored inside the repository it
   belongs to, say. It travels exactly like any other skill, through the same audit. Use
   it only when the user points at a directory; do not go looking for skills off the list.
6. **If something is refused, relay the reason as-is and stop there.** Each one names what
   to fix, and none of them is worked around:
   - a secret in one of a skill's files, or in a command's body. That one is NOT shared.
     The reason names the file and the line (`scripts/seed.sh:2`) and the kind of secret,
     never the value; relay it as printed, and that taking the credential out of that line
     is the fix. Never offer to redact it: a skill with a blanked-out script installs and
     then fails, and a command with its token blanked out is typed and then misfires.
   - a trace of this machine - a home directory path, the account name, an email address -
     in a skill's or a command's file. The reason names the file, the line and the kind of
     trace, never the value, and offers the fix in words: edit the line and run share
     again. Relay that offer; do not edit the file yourself. For a server it names the key
     in its definition (`args[1]`) instead of a line.
   - a literal in a server's `headers` or `env`, or a credential in its URL. The message
     names the exact key. The fix is to rewrite it as `${VAR}` in their own config, where
     the name travels and the value does not. Never offer to redact it either.
   - no SKILL.md in the directory, or a SKILL.md with no name and description frontmatter.
     It is not a skill Claude Code would load either; offer to write the frontmatter.
   - the team repository already has a skill, already declares a server, or already has a
     command, by that name. Theirs is untouched. On the first run nothing else travelled
     either, because that run stops for the commit message, so the answer goes on the SAME
     run as the rest of the selection rather than in a command of its own: the output says
     which. Never split one selection into two requests - two opened before either is
     merged claim the same plugin version, and the second reaches nobody. These are listed
     in their own group, apart from the real faults. This is the refusal that has a way
     forward: ask, per name, whether to send that one as an update to the team's copy, and
     never add the flag on your own initiative. Say the consequence before they pick: after
     the merge every teammate gets that definition instead of the one they have now.
     `--update` NAMES what it updates (`--update gitlab` updates gitlab and nothing else),
     so run it with only the names the user actually said yes to. Two collisions and one
     yes means one name on that flag, not both. Renaming is the other answer.
7. **Then ask the one question - branch and message - and ask it last.** The message
   proposal changes with the `--update` answers from step 6: a name sent as an update reads
   as "update" in it rather than "add". So if step 6 added any `--update`, run the whole
   selection once more WITH those flags and still no message or branch flag, and use that
   run's question - the first run's is stale and would put a sentence in front of the user
   that is not the one about to be committed. Show the question line exactly as the CLI
   printed it, ``Branch `<name>` · message `<text>` - confirm or change either.``, as ONE
   question: the user confirms both, or changes either one. When the branch reads
   `<TICKET>-...` the line also shows how branches look in this repository and asks which
   ticket this is; the user's answer is the branch. Then run the share again with
   everything from step 4, any `--update` flags from step 6, and their answers:
   - the branch: `--branch "<name>"`, the proposed one if they confirmed it, otherwise
     theirs, word for word. It is used exactly as given and for this request only: it is
     never written into any setting and never changed by a suffix.
   - they approved or wrote a message: `--message "<their wording>"`. If it has no team
     prefix and the team needs one, the CLI adds it and the result says what was committed.
   - they said you decide: `--delegate-message <fingerprint>`, with the fingerprint the
     refusal printed next to the proposal, and nothing else. That is the ONLY way a
     wording the user did not give reaches a commit, and it is theirs to say, never yours
     to assume. Do not compose a message and pass it as `--message`: `--message` means
     "these are the user's words". Naming the fingerprint is what ties the answer to the
     sentence they read: if the proposal has moved since, the run is refused and prints the
     new one, which you show them before asking again.
   A run missing either answer is refused and nothing is committed; one given only asks the
   other. That is deliberate, and it is not something to work around by picking a message
   or a branch yourself.
   **If the refusal names an unmerged branch that already raises the plugin version**,
   offer the two ways it names and nothing else: send this one past it, by running again
   with `--version-after-open`, or stop here so that branch is merged or closed first. Two
   requests raising the same number both merge, and the second reaches nobody.
   **If the refusal offers no `--delegate-message` at all, delegating is not available
   here** and the reason is in the same sentence: a machine with no `gh`/`glab` signed in
   has no merge request to open, and "you decide" is an answer about the request. Ask the
   user for the wording; do not retry. The same is true when the refusal says the message
   it would propose cannot be used - a name in the selection reads as a credential - and
   there the wording has to be theirs too.
8. Relay the output verbatim. It names what went out per kind rather than as one total,
   because a skill somebody reads, a server that connects and a command somebody types are
   not interchangeable, and it names the commit the request carries. The team repository
   got a COPY, so the skill the user already uses is untouched and keeps working. When
   GitLab opened the request from the push, the output ends with the request's description
   to paste into it: a push cannot carry one, and the reviewer needs it.
   **If the list or the result names copies that are on this machine twice** - the user's
   own and an identical one inside the team plugin, which is what a merged share leaves
   behind - relay that block as printed, commands included. Those commands are the user's
   to run: never run them yourself, and never remove anything on their behalf. Keeping
   their own copy is a choice they are allowed to make.
9. **If it fails because the forge refuses the branch NAME**, nothing reached the
   repository and nothing was retried. The error quotes the forge's own sentence and then
   the same one question, with the refused name in it. Relay the sentence exactly, then ask
   that question again with the refused name as the starting point for their edit; run the
   share once more with their new `--branch` and everything else unchanged. Do not invent
   a name for them and do not suggest a config setting: the name is theirs for this push.
10. **If it fails because the forge refuses the commit MESSAGE**, the error names both ways
   out and they are not equivalent. Recording the prefix in the team repository (whoever
   ran `/handbook:init` runs `/handbook:init --upgrade` once) fixes it for everyone who
   joins after; setting `commitPrefix` under `team` in `~/.teamhandbook/config.json` fixes
   this machine only. Offer the repository one first, and say which of the two you are
   proposing. Do not suggest `--commit-prefix` here: it is an `/handbook:init` flag and
   this command has never had one. A prefix the repository already records is picked up
   without any of this, on the next share.

`--update` is per name and repeatable, for the same reason every other flag here is: the
user consents to one thing at a time, and a single word standing in for several answers is
not consent. The result says which names it actually replaced; relay that line as printed
rather than summarising it, since "shared" and "replaced what the team was using" are not
the same event for the people on the other end.

Everything selected travels as ONE merge request, with one version bump, rather than one
request each. That is deliberate: two requests opened before either is merged both claim
the same plugin version, and the second one to be merged then reaches nobody. Picking five
skills is exactly that case five times over, which is why skills travel in this batch too.
It is also why this command is run once with everything the user picked, rather than once
per item.

A command in a subdirectory travels at the same path: `git/sync.md` is listed as `/git:sync`,
lands at `commands/git/sync.md`, and teammates type it as `/<plugin>:git:sync`. A `sync.md`
beside it is a different command, listed and shared on its own.

If no team repository is configured, nothing on this screen has anywhere to go until
/handbook:init or /handbook:join has been run. The command says so, and turns back every
name it was given rather than letting one kind look like it succeeded.
