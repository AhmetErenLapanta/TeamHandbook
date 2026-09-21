# TeamHandbook

**Your team's Claude Code setup, in one git repository.** One person creates it, everyone
else connects once, and every skill, MCP server, or slash command the team approves shows
up on its own.

[What your team gets](#what-your-team-gets) · [Install](#install) ·
[Who approves what](#nothing-ships-until-you-say-so) ·
[Why you might not want this](#why-you-might-not-want-this)

## What this is

TeamHandbook is a Claude Code plugin that makes one git repository your team's shared
setup: the skills everybody should have loaded, the MCP servers everybody needs
configured, the slash commands everybody should share. That repository is a Claude Code
plugin marketplace, so Claude Code itself does the delivering.

You explain a rule to Claude. Your teammates explain theirs, in their own sessions.
Everybody learns something today, and nobody else finds out. What one of you learns
should belong to all of you.

Approving something sends it to that repository as a merge request. Merge it and each
teammate's copy picks it up at their next session: no CI, no access token, and nobody
needing push rights on a protected branch.

Noticing the thing worth sharing is the part that never happens on its own, so
TeamHandbook reads each finished session and proposes what it found. That is how the
repository gets filled without anyone having to remember to fill it.

## What your team gets

Four things can go from your machine to the handbook, and each one travels as a merge
request that raises the repository's plugin version. That version is Claude Code's signal
that the plugin moved, which is what makes every teammate's copy refresh.

| What you share | Command | What lands in the repo |
|---|---|---|
| A skill the harvest proposed | `/handbook:review` | `skills/<name>/`, with the evidence it came from, plus a version bump |
| A skill you wrote yourself | `/handbook:share` | the same, through the same review |
| An MCP server already configured on this machine | `/handbook:share` | an entry in the repo's `.mcp.json`, plus a version bump |
| A slash command already installed on this machine | `/handbook:share` | `commands/<name>.md`, plus a version bump |

Nothing else is automated, and the repository is an ordinary plugin repo: agents and
hooks can be committed to it by hand and reach everyone the same way, as long as the
version is raised in the same commit. `/handbook:init --with-ci` scaffolds a job that
does that on merge, for teams who work that way.

If your team drops TeamHandbook tomorrow, the repository and its distribution keep
working: there is no lock-in.

## Install

**Requires** Claude Code >= 2.1 and Node.js >= 18.

### Setting it up for your team

One person, once.

```
/plugin marketplace add AhmetErenLapanta/TeamHandbook
/plugin install handbook@teamhandbook
```

Choose **"Install for you (user scope)"** when Claude Code asks: repeats are counted
across all your projects, so scoping it to one repository hides the thing it looks for.
Not project scope, which installs it for everyone who clones the repo
([why](SECURITY.md#install-it-for-yourself-not-for-your-teammates)).

Restart Claude Code so the hooks load, then:

```
/handbook:init
```

Give it an empty git repository or let it create one, and it lays the marketplace
scaffold into that repo. If the repo already has commits, the scaffold arrives as a merge
request and nothing is live for anyone until a human merges it. A repository with no
commits at all has no branch to open a request against, so there the scaffold goes
straight to the default branch. Either way, files that are already there are kept.

Three commands and a restart, plus the exchange where `init` settles which repository to
use. The output ends with the message to send your team, and it is worth reading before
you send it: a private handbook needs each teammate to have access to the repository and
git credentials on their own machine, and that sign-in is something they run themselves.

### Joining one your team already has

```
/plugin marketplace add AhmetErenLapanta/TeamHandbook
/plugin install handbook@teamhandbook
```

Same user-scope choice, same restart. Then:

```
/handbook:join <team-repo-url>
```

That clones the repo to check it and records it as where your approved skills will go. It
does not connect Claude Code to anything. It prints two more commands, and you are the
one who runs them:

```
/plugin marketplace add <team-repo-url>
/plugin install <team-plugin-name>@<team-plugin-name>
```

Five commands and a restart. Those last two are what brings merged skills to this
machine. Stop after `/handbook:join` and you can still share your own work; you just will
not receive anyone else's.

### Only receiving the handbook

If you want the team's skills and never intend to contribute your own, you do not need
this plugin at all:

```
/plugin marketplace add <team-repo-url>
/plugin install <team-plugin-name>@<team-plugin-name>
```

Two commands, and whoever set the repository up can send them to you already filled in:
`/handbook:init` prints that message for them. The team's own plugin carries a small hook
that tells you when new skills, servers, or commands have landed.

### Check the install

`/handbook:doctor` reports node, the `claude` CLI TeamHandbook shells out to, whether the
hooks are firing, your git identity, the config, and the team repo, with a fix for each
failure it finds. Run it before the restart and it reports the hooks as not firing,
correctly: they are not, yet.

## Nothing ships until you say so

Two decisions hide behind that sentence, and each one belongs to the person it affects.

### What leaves your machine

`/handbook:review` shows each candidate with the evidence that produced it - your own
words, the failing command, the fix:

```
candidate: no-db-mocks-in-integration-tests  [correction]  [scope: team]  [status: pending]
score:     8/10  (recurrence 1, unfindability 2, generality 2, durability 2, costOfError 1)
repeated:  you have told Claude this in 3 sessions

── grounded case ──
you said:  "we never mock the DB in integration tests here - use the testcontainer fixture"
expect:    Integration tests start a testcontainer instead of a mock.
```

Then it asks where the skill goes and you pick an answer:

- **Share with the team** - a merge request to the handbook repo: everyone, every project
- **Add to the project it came from** - that project's `.claude/skills`, named in the
  question: commit it and it travels with the code. A skill installs where it was
  captured, not whichever project you are reviewing from
- **Keep for yourself** - `~/.claude/skills`: every project you open, nobody else
- **Reject** - not worth keeping, and it can be silenced for good

You can also ask for an edit before deciding, or leave one pending and come back. No
other path reaches the team repo, and the one that does ends in a merge request somebody
reviews.

### What arrives on your machine

Nobody can put anything on your machine from the handbook repo. You subscribe yourself,
with the two `/plugin` commands above. Whoever set the repository up cannot do it for
you and cannot write to your `~/.claude`; what they can do is merge things into a
repository you chose to subscribe to.

That subscription is standing, not item by item. A merged skill, MCP server, or slash
command raises the repository's plugin version, Claude Code refreshes on that, and it is
there at your next session. The team plugin prints what landed ("2 new skill(s), 1 new
MCP server(s), and 1 new command(s) since your last session"), so a server or a command
never arrives in silence.

If you would rather see each change before it reaches you, do not subscribe: the skills
are plain directories you can read in the repo and copy. `/plugin marketplace remove
<team-plugin-name>` ends a subscription you already have. `/handbook:leave` is a separate
thing: it drops the contribution target and leaves the subscription alone.

## Why you might not want this

- **You are working alone.** It runs solo, and approved skills land in `~/.claude/skills`
  with no team repo involved. A queue you review by yourself is a poor trade against
  Claude Code's own memory, which keeps what you tell it without asking first. Running
  this pays off once other people read from the repository.
- **The harvest is one model call, and the model matters.** On an identical prompt from a
  real session the default (`sonnet`) proposed the developer's stated rule 3 times out of
  3; `haiku` managed 1 in 3. A skill buried in a very long session can still be missed,
  and the model can propose something plausible but wrong, which is why nothing installs
  itself.
- **A private handbook has a setup step you cannot automate away.** Every teammate needs
  access to the repository and git credentials on their own machine, and that is a
  one-time interactive sign-in they run in their own terminal. A plugin can never stop to
  ask for a password, so without it the commands fail with a bare git error.
- **A correction needs you to have said it.** Fix Claude's approach by editing the file
  yourself and there is nothing to quote.
- **Only conversational prose is read.** A skill living purely in tool output reaches the
  harvest only through the deterministic error-to-fix pairs the hooks captured.
- **Repeat matching is word overlap, not understanding.** Two phrasings of one rule match
  when they share most of their content words, and a word wearing a different suffix
  still counts as the same word - so it works whatever language you teach in, including
  one where every ending changes. A rule restated in completely different words reads as
  new. The bias is deliberate: a missed repeat, never a false one.
- **State is per-machine.** `~/.teamhandbook/` does not sync; team approvals travel
  through the merged request.

## How it works

<img src="docs/handbook-loop.svg" alt="What is already set up on your machine - a skill, an MCP server, or a slash command - travels to the team repository as a merge request, which somebody on the team reviews and merges. That repository is a Claude Code plugin marketplace, and the same merge raises the plugin version; that version is the signal every teammate's next session refreshes on, so what landed arrives with nothing installed or configured by hand." width="880">

- **One merge request, whatever the mix.** A selection of servers and commands travels as
  a single request, because each one raises the version and two requests opened before
  either is merged claim the same number. One clone, one bump, one request.
- **The version bump is the delivery.** Nothing pushes to your teammates. The raised
  version in `.claude-plugin/plugin.json` is Claude Code's only signal that the plugin
  moved, and refreshing on it is something each copy does for itself.
- **Nothing is installed by hand on the other end.** A merged server lands in the repo's
  `.mcp.json` and a merged command in `commands/`, both of which Claude Code reads by
  convention, so a teammate configures nothing.
- **Receiving is a standing subscription, not a push.** Nobody can write to your
  `~/.claude`; you subscribe yourself with `/plugin`, and the team plugin's own hook says
  what arrived instead of letting it land in silence.

### Where the skills come from

The servers and commands you share are already on your machine. Skills are the one thing
that has to be noticed first, and noticing never happens on its own, so that inlet is
automatic: TeamHandbook reads each finished session and proposes what it found. This is
the `/handbook:learn` and `/handbook:review` path, not the loop above.

- **Capture is a hook, not a tool call.** The model won't remember to save a skill at
  the worst moment - a failing build, a frustrated developer. Hooks fire every time.
- **A free check decides whether the model runs at all.** A trivial session - a
  question, a couple of `ls` calls - is never harvested and costs nothing.
- **Five criteria**, 0-2 each: recurrence, unfindability, generality, durability, cost
  of error. A skill needs **>=4/10** to reach your queue, and at most the top three per
  session do. The score decides what is worth *asking about*, not what ships.
- **Every skill carries its receipt**: your quoted words, the failing command, the fix,
  so you can judge it in seconds instead of trusting it.

The output is a spec-compliant [Agent Skill](https://agentskills.io). Delete
TeamHandbook tomorrow and your skills keep working, in any tool that reads `SKILL.md`.

## Commands

| Command | What it does |
|---|---|
| `/handbook:review` | Keep, scope, share, edit, or reject each skill. **The only way anything ships.** |
| `/handbook:init` | Scaffold the team handbook repo and print the message your team needs. |
| `/handbook:join <url>` | Point this machine at an existing team handbook. |
| `/handbook:share` | List every skill, MCP server, and slash command on this machine; pick which ones the team gets. |
| `/handbook:demo` | Walk the whole loop on a scratch project, in about five minutes. |
| `/handbook:learn` | Capture something on demand instead of waiting for the session to end. |
| `/handbook:status` | Queue, ledger, how often your skills actually fired, config. |
| `/handbook:doctor` | Diagnose node, the `claude` CLI, hooks, config, team repo. |
| `/handbook:leave` | Drop the team target and go back to solo. Deletes no skills. |

## Privacy

To find the skill, TeamHandbook sends a slice of the finished session to **your own**
`claude` CLI - no bundled key, no third-party model, no telemetry. Exactly what is read,
what is never read, and every file it writes: [SECURITY.md](SECURITY.md).

Turn it off in `~/.teamhandbook/config.json`:

```jsonc
{ "harvest": { "enabled": false } }   // no session is ever read or sent
{ "gate":    { "auto": false } }      // no automatic model calls at all
```

Both fail **closed** if the file cannot be parsed. Secrets are redacted before anything
is written or sent, though detection is pattern matching - eyeball a candidate before
approving it.

## Development

```
npm install
npm run build       # bundle the hooks into dist/
npm test
npm run typecheck
```

`dist/` is committed on purpose: the plugin is installed by git clone, so the built
hooks must be present.

## License

[Apache-2.0](LICENSE).
