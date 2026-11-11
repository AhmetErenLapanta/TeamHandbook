# Adding an agent adapter

An adapter is how the orchestrator starts one agent CLI, reads what it says and checks that it is
ready. Claude Code and OpenCode are the two it has; the stand-in (`fake`) is the third, for the
demo and the tests. [How a task runs](tasks-runtime.md#how-a-task-runs) describes what each one
does today; this page is the list of places a new one touches. The CLI is never run to write or
test an adapter: its flags and output are read from its own help text and code, and the tests
replay recorded transcripts.

## 1. The adapter itself

Write an `AgentInstance` and wrap it with `adapterFrom` (`server/tasks/agents.ts`), next to
`claudeCodeAdapter` and `opencodeAdapter`. It gives:

- `id` and `label`, the name the task form and the readiness check show.
- `capabilities` (`AgentCapabilities` in `server/tasks/adapters/contract.ts`): what the
  orchestrator can count on. `permissionModes` decides which modes a task can start in, `mcp`
  whether a team MCP server is placed for it, `runsAsYou` whether it runs under Run as me, and
  `resume` and `steer` whether a task can continue or take a message mid-turn. Leave a
  capability off until the CLI's own code shows it: a task in a mode, with an option or resuming
  a session the agent does not claim is refused.
- `credentialEnv`: the host variables the agent needs to reach its model, and `modelHosts` when
  a repository's egress list has to let its model through.
- `configure(paths, setup)`: writes the team's skills and the agent's config into the task's own
  home, never into the checkout.
- `invocation(paths, task, setup, personal)`: the program, arguments, stdin and environment for
  a one-shot run, with the shell and the web kept away from the agent.
- `decoder()`: a fresh reader of one run's output, turning its lines into the events in
  `contract.ts` (`message`, `tool_call`, `usage`, `terminal` and the rest). An unknown line is
  data, never an instruction.
- `twoWay`, when the CLI holds a session over stdio: a `launch` returning the call and a codec
  that sends turns and answers the agent's questions.
- `probe`, for the readiness check (step 3).

`adapterFrom` refuses a task's option the agent does not offer, and a resume where the two-way
session cannot resume.

## 2. Register it

- `server/tasks/config.ts`: an entry in the `available` map, with an `ORCHESTRATOR_<AGENT>_BIN`
  setting for the program as the others have. Add it to the default list only once it is meant
  to be offered without `ORCHESTRATOR_AGENTS`.
- `server/tasks/transcript.ts`: the `agent` union and the per-agent filter in `keptLine`.
- `web/src/AgentLine.tsx`: the sign-in command `SIGN_IN` shows for a signed-out agent.
- `server/tasks/readiness.ts`: the subscription warning names an agent by id; check whether the
  new one needs the same.
- The task form reads its agents, modes and options from the runner, so it needs nothing.

## 3. Manifest and readiness

- `server/tasks/adapters/manifest.ts`: a `MANIFEST` entry with `checkedVersion`, the version the
  one-shot flags and output were read from, and `twoWayVersion` or `mcpVersion` when those paths
  rest on a different one. `options` lists what the task form offers (a model, an effort), in
  values the CLI itself takes.
- The adapter's `probe` names the program, its setting, the version to compare and, when the
  CLI has a read-only status command, how to read the sign-in from it (`readClaudeAuthStatus`
  and `readOpencodeAuthList` in `agents.ts` are the two models). Readiness then checks, in order,
  the program, `--version` against `checkedVersion`, the profile under Run as me, the credential,
  the sign-in and the MCP settings. An agent with no probe is reported ready.

## 4. Transcripts and tests

- `server/tasks/transcripts/<agent>-edit-skill.ndjson`: one end-to-end run, played as a process
  by `transcript.test.ts`, which expects one such file per agent the orchestrator runs and holds
  its `cliVersion` to the probe's `checkedVersion`.
- `server/tasks/adapters/transcripts/<agent>-<case>.ndjson`: a session replayed by
  `replayTransport` (`adapters/replay.ts`) for each path the adapter claims: an approval, a sign-in
  failure, a usage limit. A write the transcript does not expect fails the test.
- Each file starts with a `meta` line (`agent`, `cliVersion`, `source`: `hand` or `recorded`) and
  an `expect_outbound` line with the arguments and stdin, then the steps and an `exit`. A
  transcript written by hand says so; one recorded from a real CLI is recorded only by a person,
  with `ORCHESTRATOR_RECORD_AGENT` and `transcript.record.test.ts`.
- The adapter's own `<agent>.test.ts` beside `claude-code.test.ts` and `opencode.test.ts`, and the
  table in [How a task runs](tasks-runtime.md#how-a-task-runs) and the `ORCHESTRATOR_AGENTS` row in
  [configuration](../operations/configuration.md#configuration).

## 5. A connected machine

A machine runs only the adapters `runner/cli.ts` lists, Claude Code today, and always as its
person (`personal`), through `twoWay` when the task's mode needs it. A new agent reaches a machine
once it runs as you there and its `probe` reads its version and sign-in for
`runner/agent-status.ts`; until then a task for it fails on the machine with "This machine runs
no <agent> for tasks yet."
