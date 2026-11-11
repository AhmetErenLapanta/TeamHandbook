# TeamHandbook Orchestrator documentation

One entry for people and for agents: find the question, open the file. The repository's
[SECURITY.md](../../SECURITY.md), section "The orchestrator", is the promise each data flow
keeps; the files below link to it rather than repeat it.

`user/` says what a person does and sees, `operations/` what an operator runs, and `internals/`
how the orchestrator is built and why. An internals file is rewritten when the code changes, not
added to, so it says what is true now rather than how it got there.

## Using it

Running it on your own machine, with one command: [the README](../README.md#run-it-on-your-machine).

| Question | File |
|---|---|
| What it does for a team, and what it promises | [user/overview.md](user/overview.md) |
| The tabs, the search box, a cloud organization's welcome and Your machines | [user/screens.md](user/screens.md) |
| A three-minute demo on one machine, with the steps and what the screen says at each | [user/demo.md](user/demo.md) |
| Connecting a team repository, the setup panel, changing skills, servers and commands as requests, forges and the token vault, reading a request's checks and review before merging | [user/repositories-and-requests.md](user/repositories-and-requests.md) |
| Signing in, signing up to a cloud orchestrator, roles, invitations, API keys, single sign-on, SCIM | [user/people-and-access.md](user/people-and-access.md) |
| GitLab and GitHub, Slack, the issue tracker, your own and the team's MCP servers, the orchestrator's MCP server | [user/integrations.md](user/integrations.md) |
| The sprint board, starting agents on issues together, moving issues | [user/work.md](user/work.md) |
| Handing work to an agent, issues, several repositories, skills first, policies, task secrets, jobs, review rules, guardrails | [user/tasks.md](user/tasks.md) |
| Which skills teammates use, and how many merged requests an agent helped write | [user/skill-use.md](user/skill-use.md) |

## Running it

| Question | File |
|---|---|
| Running it for a team on a server of your own, with Docker or without, on SQLite or Postgres | [operations/self-hosted.md](operations/self-hosted.md) |
| A cloud release on a host of your own: env file, secrets, release, health gate, rollback, restoring a dump, observability, `deploy:local` | [operations/run-as-a-service.md](operations/run-as-a-service.md) |
| Every setting | [operations/configuration.md](operations/configuration.md) |
| Registering the GitLab OAuth application and the GitHub App for one-click connecting | [operations/forge-apps.md](operations/forge-apps.md) |
| Backups, restoring, upgrading, `migrate` and expand and contract steps | [operations/backup-restore-upgrades.md](operations/backup-restore-upgrades.md) |

## How it works inside

| Question | File |
|---|---|
| The server, the store, git, the web app and where each piece lives | [internals/architecture.md](internals/architecture.md) |
| The web app's design: its decisions, tokens, components, light and dark | [internals/design.md](internals/design.md) |
| How a task's agent is started and held: adapters, isolation, what leaves the machine | [internals/tasks-runtime.md](internals/tasks-runtime.md) |
| Adding another agent CLI: the adapter, where it is registered, its readiness and its transcripts | [internals/adding-an-adapter.md](internals/adding-an-adapter.md) |
| The security model in short | [internals/security-model.md](internals/security-model.md) |
| Running the tests and the lab | [internals/tests-and-lab.md](internals/tests-and-lab.md) |
| What it does not do yet | [internals/known-limits.md](internals/known-limits.md) |
| The design the cloud release was built from | [internals/deployment-design.md](internals/deployment-design.md) |
