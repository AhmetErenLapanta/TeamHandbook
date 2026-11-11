# How a task runs

### Adapters

| Agent | `id` | Started as | Tools |
|---|---|---|---|
| Claude Code | `claude-code` | `claude -p --output-format stream-json`, prompt on stdin | Read, Edit, Write, Glob, Grep and the MCP tools in `mcpTools`, each by its full name (`mcp__server__tool`). Bash and web tools are denied. `--setting-sources user` and `--strict-mcp-config` keep a repository's own settings or `.mcp.json` from adding any |
| OpenCode | `opencode` | `opencode run --format json`, with the checkout's own `opencode.json` and `.opencode/` ignored (`OPENCODE_DISABLE_PROJECT_CONFIG=1`) | A permission list that denies everything first, then allows read, edit, glob, grep, list, skills and each tool in `mcpTools` by OpenCode's name for it (`server_tool`). MCP servers only with `ORCHESTRATOR_OPENCODE_MCP=1` |
| Stand-in | `fake` | `demo/fake-agent.mjs` | Writes one skill named after the task; for the demo and the tests. A description line `stand-in: wait <n> seconds`, `stand-in: fail`, `stand-in: print <n> lines`, `stand-in: write a <n> MB file`, `stand-in: write <n> files`, `stand-in: delete its directory`, `stand-in: leave the skill without frontmatter` or `stand-in: change a hook` makes it slow, failing, talkative, careless or rule-breaking |

The adapters were checked against Claude Code 2.1.309 and OpenCode 1.18.31 by reading those
CLIs: the flags the orchestrator passes and the output it reads exist there. Claude Code's two-way
session, which carries the agent's questions to the task's page, was checked against 2.1.316, and
one approval transcript (`server/tasks/adapters/transcripts/claude-code-approval.ndjson`) was
recorded from it; the other transcripts are written by hand. Another version works as long as
those flags and that output are unchanged. A new agent CLI goes through
[Adding an agent adapter](adding-an-adapter.md#adding-an-agent-adapter).

**Which credential.** A Claude subscription token (`claude setup-token`, `CLAUDE_CODE_OAUTH_TOKEN`)
is for one person's own use on their own machine. An orchestrator a team shares runs everyone's tasks
on it, so give it `ANTHROPIC_API_KEY`, a Team or Enterprise plan, or Bedrock, Vertex or Foundry
instead; see [Anthropic's terms](https://www.anthropic.com/legal/consumer-terms). The readiness
check warns when an orchestrator with more than one account would run tasks on a subscription token.

**Agent readiness.** *Settings → Agent readiness* is for an admin, and so is
`GET /api/agents/readiness` (`?fresh=1` for a new check). For each offered agent it shows:

- **Program.** Under `process`, the CLI on the orchestrator's `PATH` or at `ORCHESTRATOR_CLAUDE_BIN` /
  `ORCHESTRATOR_OPENCODE_BIN`. Under `container`, `ORCHESTRATOR_TASK_IMAGE` on the Docker daemon
  (inspected, never pulled), and then the CLI inside it.
- **Version**, from `--version`, against the version above. A different one is a warning,
  not a failure, that says which version to install.
- **Credential.** Which of the adapter's variables is set on the orchestrator (names only).
- **Sign-in.** The CLI's own read-only status command, started the way a task starts it: the
  task's stripped environment, a fresh HOME, and the image and network of a task container.
  For Claude Code that is `claude auth status --json`, of whose answer only whether a
  credential is there and its kind are kept. For OpenCode it is `opencode auth list`. An
  answer the orchestrator does not read shows as unknown.
- **MCP tools.** For each repository whose `mcpTools` names a tool: a server missing from the
  team's `.mcp.json`, a server the share rule holds back, or an agent that gets no MCP server.

A check runs when the screen needs one and the last is older than 5 minutes, or when an
admin asks; each probe waits 20 seconds at most. A probe container left by an orchestrator that
stopped in the middle of a check is removed at the next start. The form shows only where the
agent it has picked stands: *Ready*, *Ready with warnings* or *Not ready*, with *See details*
for an admin, which opens *Settings → Agent readiness*; anyone else is told an admin sees why.
Readiness informs and never blocks: a task started on an agent that is not ready
runs and fails the way it would have.

**Before the first real task:**

1. Pin the CLI in the image or on the host to the version above, or read the changelog of
   the one you run for changes to the flags in the table.
2. Set the model credential on the orchestrator: `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`
   for Claude Code, a provider key for OpenCode. A task gets these variables and a fresh
   HOME, so rely on them rather than a sign-in in your own account.
3. Open *Settings → Agent readiness* and clear every failure.
4. For a repository with `mcpTools`, check that each named server is in the team's
   `.mcp.json` and passes the share rule; for OpenCode, decide on `ORCHESTRATOR_OPENCODE_MCP=1`
   (see [OpenCode and MCP](../user/tasks.md#opencode-and-mcp)).
5. Run the first task on a small change in a repository you can clean up, and read its log
   from the top: the orchestrator's own lines say what was installed and what the agent was given.

### Isolation

**Process isolation is not a sandbox.** Under `process`, the default, the agent runs as the
orchestrator's own OS user. The stripped environment keeps the orchestrator's settings and the host
account's config away from it. But an agent can still read and change any file that user
can: the orchestrator's database, other repositories' mirrors, and the git directory the orchestrator
reads its result through. An agent that rewrites those can have the orchestrator run a command of
its choosing as that user, with the orchestrator's whole environment. `ORCHESTRATOR_TASK_NETWORK=none`
is refused under `process`, because nothing there enforces it. Run untrusted work in
container isolation.

**Container isolation** is optional and off by default:

```sh
docker compose -f docker-compose.yml -f docker-compose.container-tasks.yml up --build
```

Each process of a task (the agent, the tests) runs in a new container of `ORCHESTRATOR_TASK_IMAGE`:

- all capabilities dropped, `no-new-privileges` and a process limit;
- `--network none` when `ORCHESTRATOR_TASK_NETWORK=none`;
- only the task's own directory mounted out of the data volume (`ORCHESTRATOR_TASK_VOLUME`,
  `volume-subpath`, Docker Engine 26 or later).

The git directory the orchestrator reads the result through sits outside that directory, so
nothing in the container reaches a config the orchestrator's own git reads. Credentials reach the
container by name (`docker run -e NAME`), never on its command line.

The image an agent runs in is yours to build and pin. The orchestrator starts the agent as the
container's entrypoint (`docker run --entrypoint claude ...`), so the image needs the agent
CLIs on its `PATH`, git, and whatever the team's tests run. The override's own image
(`orchestrator-container-tasks`) has only the stand-in agent. A starting point:

```dockerfile
FROM node:22.22.0-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# The versions the adapters were checked against; another one is a warning in Agent readiness.
RUN npm install -g @anthropic-ai/claude-code@2.1.309 opencode-ai@1.18.31
USER node
```

Build it, then start the orchestrator with `ORCHESTRATOR_TASK_IMAGE` naming it. The task's files belong
to the orchestrator's user (`node`, uid 1000, in the orchestrator image); an image whose user has
another uid needs `ORCHESTRATOR_TASK_USER=1000:1000`. The model credential travels as the
adapter's own variables, set on the orchestrator: `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`
for Claude Code, the provider keys for OpenCode. Nothing else of the orchestrator's environment
reaches the container. An image built from the orchestrator's own, as `orchestrator-container-tasks`
is, also carries that image's defaults into a task (`ORCHESTRATOR_DATA_DIR`, `ORCHESTRATOR_HOST`,
`ORCHESTRATOR_PORT`, `ORCHESTRATOR_WEB_ROOT`, `NODE_ENV`); none of them is a secret, and an image of
your own carries only what you put in it.

Measured on a real daemon with an agent that reports what it sees: with
`ORCHESTRATOR_TASK_NETWORK=none` it resolved no name and reached no address, and with `open` it
did; of the data volume it saw only its own task's directory, not another task running at the
same time, the database, the lock, the mirrors or the task git directory; it ran with no
capabilities and `no-new-privileges`; the Docker socket was in the orchestrator and not in the
task; each container was gone when its task ended; `docker stop` on the orchestrator removed a
running task's container at once, and after the orchestrator was killed the next start removed
the one left running. `ORCHESTRATOR_TEST_DOCKER=1 npm test` repeats the network, mount, socket and
leftover-container checks against the daemon the Docker CLI reaches.

**This mounts the Docker socket into the orchestrator, and access to that socket is root on the
host.** A flaw in the orchestrator, or a sign-in someone obtains, then reaches the whole machine.
It stays off unless you add the override file, and belongs only on a host that runs nothing
else. If the socket's group is not `0` on your host, set `DOCKER_GID` to it.

### What leaves the machine

A task sends the checkout, the task's text and the team's skills to the agent's model
provider, through the agent CLI and under the credential you give it. Starting the task is
the consent for that run. The request goes to the repository's forge like any orchestrator change.
