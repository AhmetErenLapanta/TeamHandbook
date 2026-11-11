# How it works for a team

It works on the team repositories `/handbook:init` sets up. On one screen it shows every
team's skills, MCP servers, slash commands and request settings. It proposes each change to
them as a merge request a person approves, and shows which skills teammates use, once a team
asks and each teammate agrees. It also hands work to an agent CLI in a project: in a Git
repository that work ends in a request for review, and in a folder without Git on your own
machine in its changes, waiting in the folder for you (see [Tasks](tasks.md#tasks)).

The team repository stays the source of truth. The orchestrator reads it through a bare mirror,
and every change it makes goes back as a request. Its database holds only what git cannot:
which repositories are connected, who signs in, settings, sealed forge tokens, skill-use
counts, the requests it opened, and each task's outcome with its redacted log. Lose the
database and you reconnect the repositories; no skill, server or command lives only in the
orchestrator.

## How a change reaches the team

1. Someone edits a skill, an MCP server or a slash command on a repository's page, or hands a
   piece of work to an agent.
2. The orchestrator opens the change as a request on the team repository, named the team's way.
3. A reviewer merges it; nothing reaches the team before that.
4. Each teammate's Claude Code picks it up: on its own with the marketplace's auto-update, or
   with `claude plugin update <plugin>@<marketplace>`.

## What it promises

These hold for a team's or a cloud orchestrator, where tasks run under the orchestrator's
own rules. On your own machine the agent runs as you, with your own Claude Code setup and network, in any
folder you open as a project; see [Run it on your machine](../../README.md#run-it-on-your-machine).

- **A person merges every change.** What the orchestrator changes in a team repository is a
  branch and a request; no API key and no agent merges one. The one exception is the scaffold
  it writes as the first commit of a team repository it created or found empty.
- **Git stays the source of truth.** No skill, MCP server or command lives only in the
  orchestrator; losing its database loses none of them.
- **Secrets stay sealed.** Forge tokens, sign-ins and task secrets are sealed under a key the
  database never holds and are never shown back, and a task's log is redacted line by line
  before it is stored.
- **It talks only to what you connected.** Beyond fetching the connected repositories, it
  reaches only the forges, trackers, sign-in providers, MCP servers, MCP registry and Slack
  channel an operator, an owner or an admin set up; a task's agent CLI talks to its own model
  provider under the credential it was given.
- **Organizations stay apart.** Every table carries its organization and every query names it;
  on a cloud orchestrator an organization nobody created answers 404.
- **An agent gets only what its task needs:** a stripped environment, the team's skills and the
  MCP tools the team allowed, and its result is checked before a request opens.

[SECURITY.md](../../../SECURITY.md), section "The orchestrator", states each of these as measured.
