---
description: Take what is already set up on this machine to the team: lists every skill you have installed, every MCP server you have configured, and every slash command you have, in one screen, you pick as many or as few as you want, and the picked ones go out together. This is the one door for sharing a thing you already have, whether it is one server or twenty skills. A skill you wrote by hand goes into the review queue; a server or a command goes straight out as a merge request to the team's plugin repository, so nobody has to install or configure it by hand. It only reads your own config and skill folders, and never modifies your copies. To capture something out of the session you are in, use /handbook:learn instead; to give a verdict on what TeamHandbook has already captured for you, use /handbook:review. Triggers: "share my setup with the team", "share this MCP server with everyone", "the team should have this server too", "one of my own skills should go to the team", "this skill of mine belongs in the team handbook", "move my skills to the team handbook", "push my MCP config to the team", "set this server up for the whole team", "distribute an MCP server", "update the team's MCP settings", "which of my skills should the team have", "queue an existing skill", "add a skill I already have to the queue", "send several of these at once", "migrate my local setup", "I have a lot of skills, let me pick some".
argument-hint: [optional path to a skill directory that is not installed on this machine]
---

You are running TeamHandbook's sharing flow: what is already on this machine, chosen from
and carried to the team. It reads `~/.claude/skills`, `~/.claude/commands`, this project's
`.claude/skills` and `.claude/commands`, and `~/.claude.json`. It writes to none of them,
and the copies the user already uses keep working untouched.

This is the only command for sharing something that already exists here, and it always
opens the selection screen, including when the user names a single server or a single
skill. Naming one thing therefore costs one extra step, and that price is deliberate: a
plain sentence about sharing reached the wrong one of three commands often enough that
the split, not the wording of any one of them, was the fault.

Three kinds of thing can travel, and two different things happen to them. The user has to
know which before they choose, not after:

- a **skill** is copied into the review queue. Nothing leaves this machine. The verdict is
  still theirs to give in /handbook:review.
- an **MCP server** goes out immediately as a merge request to the team repository. That
  one other people can see.
- a **slash command** goes out in that same merge request, as `commands/<name>.md`. Also
  visible to other people, and merged the moment the request is.

1. Run it read-only first: `node "${CLAUDE_PLUGIN_ROOT}/dist/share.js" list`
   If a team repository is configured this step clones it once, shallow, to see which names
   the team already carries — so it can take a moment, and it is the only part of this
   command that touches the network before anything is shared. A repository it cannot reach
   costs only the "already on the team" labels; the list still opens.
   Relay the whole list, all three sections, exactly as printed, including the entries it
   marks not shareable and the reason for each. Show everything before asking anything: the
   point of this command is that the user sees how much they have and decides where to
   spend their attention. Nothing is shared by this step.
2. Say the two consequences above in one line, then ask. A user picking a command is
   picking the one that other people see, the same as a server.
3. Ask with the multiple-choice question tool (AskUserQuestion), `multiSelect` enabled,
   the same way /handbook:review asks for verdicts. **Nothing is pre-selected and
   nothing is recommended.** Do not mark an option as recommended, do not pre-tick, and
   never treat "all of them" as the default: the user asked for this command precisely
   because sharing everything is the wrong answer.
   - Put the MCP servers in their own question, and the commands in their own, since
     picking either is what opens a merge request.
   - Put the skills in the questions that remain, four per question, in the order the list
     printed them. A dialog holds four questions, so a long inventory takes more than one
     pass; say how many are left after each.
   - Offer only what the list called shareable. A refusal is the point, not an obstacle.
   - An entry marked **already on the team** is a third state, not a refusal: it can still
     be picked. Picking it alone changes nothing about theirs — the share turns it back and
     tells you the command that would update it, which you then ask about (step 7).
     Say that where it is offered, because the user is choosing to overwrite something
     other people already use. That mark is absent when the team repository could not be
     read, so its absence never proves the team does not have it — the share itself makes
     the real check and turns the selection back if it does.
   - Say once, before the first dialog, that they can answer in free text instead
     ("the three gitlab ones", "all of the servers, none of the skills") if they already
     know what they want. Twenty skills is six dialogs, and a person who knows their own
     setup should not have to click through them.
   - If the user is naming one single thing and nothing else, still show the list and still
     ask: confirming one entry is one click, and it is what stops a near-miss on a name
     from sharing the wrong server.
4. Share what they picked, naming each one:
   `node "${CLAUDE_PLUGIN_ROOT}/dist/share.js" share --skill <name> --mcp <name> --command <name>`
   Never add a name the user did not choose. With no flags the command shares nothing,
   which is the correct answer to an empty selection.
5. **A skill the list does not show** is shared by path instead:
   `node "${CLAUDE_PLUGIN_ROOT}/dist/share.js" share --skill-path <directory>`
   The list covers the two directories Claude Code loads skills from, so this is for a
   skill that is written but not installed: one being authored inside the repository it
   belongs to, say. It is queued exactly like any other skill, through the same audit. Use
   it only when the user points at a directory; do not go looking for skills off the list.
6. Relay the output verbatim. It reports the two groups separately, on purpose: the queued
   skills are still here, and the shared servers and commands are already out. The queue
   got a COPY, so the skill the user already uses is untouched and keeps working. Then
   point at /handbook:review as the next step for the queued half.
7. **If something is refused, relay the reason as-is and stop there.** Each one names what
   to fix, and none of them is worked around:
   - a secret in one of a skill's files, or in a command's body. That one is NOT shared.
     Tell them which file, and that taking the credential out is the fix. Never offer to
     redact it: a skill with a blanked-out script installs and then fails, and a command
     with its token blanked out is typed and then misfires.
   - a literal in a server's `headers` or `env`, or a credential in its URL. The message
     names the exact key. The fix is to rewrite it as `${VAR}` in their own config, where
     the name travels and the value does not. Never offer to redact it either.
   - no SKILL.md in the directory, or a SKILL.md with no name and description frontmatter.
     It is not a skill Claude Code would load either; offer to write the frontmatter.
   - already waiting in the review queue, or already decided there. The queued copy is
     left exactly as it is. A waiting one is decided in /handbook:review; a decided one has
     already been through it.
   - the team repository already declares a server, or already has a command, by that
     name. Theirs is untouched; the rest of the selection still went. These are listed in
     their own group, apart from the real faults, and the output prints the exact command
     for each one. This is the refusal that has a way forward: ask, per name, whether to
     send that one as an update to the team's copy, and never add the flag on your own
     initiative. Say the consequence before they pick: after the merge every teammate gets
     that definition instead of the one they have now. `--update` NAMES what it updates
     (`--update gitlab` updates gitlab and nothing else), so run it with only the names the
     user actually said yes to. Two collisions and one yes means one name on that flag, not
     both. Renaming is the other answer.
8. **If it fails because the forge refuses the branch NAME**, the error quotes the pattern.
   Handle it exactly as `/handbook:init` does: propose one prefix that satisfies the
   pattern, confirm it with the user, and have them set `branchPrefix` under `team` in
   `~/.teamhandbook/config.json`. A prefix discovered by a successful retry is remembered.

`--update` is per name and repeatable, for the same reason every other flag here is: the
user consents to one thing at a time, and a single word standing in for several answers is
not consent. The result says which names it actually replaced; relay that line as printed
rather than summarising it, since "shared" and "replaced what the team was using" are not
the same event for the people on the other end.

The selected MCP servers and commands travel as ONE merge request, with one version bump,
rather than one request each. That is deliberate: two requests opened before either is
merged both claim the same plugin version, and the second one to be merged then reaches
nobody. It is also why this command is run once with everything the user picked, rather
than once per item.

Commands namespaced in a subdirectory (`/git:sync`) cannot travel yet, and the list says so
rather than leaving them out silently.

If no team repository is configured, skills can still be queued; the servers and commands
cannot go anywhere until /handbook:init or /handbook:join has been run. The command says
so.
