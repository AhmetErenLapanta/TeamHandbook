import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openSqliteStore } from "../store.js";
import type { RepoRecord } from "../store.js";
import { claudeCodeAdapter, fakeAgentAdapter, opencodeAdapter } from "./agents.js";
import { mcpInTasks } from "./mcp-tasks.js";
import { createTaskRunner } from "./runner.js";

// Adapters are only built here, never run: neither program is started.
const CLAUDE = claudeCodeAdapter("claude");
const OPENCODE_OFF = opencodeAdapter("opencode");
const OPENCODE_ON = opencodeAdapter("opencode", true);
const STAND_IN = fakeAgentAdapter("fake-agent.mjs");

const SERVERS = {
  tracker: { type: "http", url: "https://tracker.example.com/mcp", headers: { Authorization: "${TRACKER_AUTHORIZATION}" } },
  docs: { type: "http", url: "https://docs.example.com/mcp" },
  postgres: { command: "npx", args: ["-y", "@modelcontextprotocol/server-postgres", "${PAYMENTS_DB_URL}"] },
  warehouse: { command: "/home/grace/bin/warehouse-mcp" },
  my_queue: { command: "queue-mcp" },
};
const ALLOWED = [
  { server: "tracker", tool: "getIssue" },
  { server: "docs", tool: "search" },
  { server: "warehouse", tool: "query" },
  { server: "my_queue", tool: "peek" },
];

describe("each of a team's MCP servers as a task would get it", () => {
  it("given Claude Code and OpenCode with MCP off, when the servers are judged, then each says whether a task gets it and why, by the share rule, the named tools and each agent", () => {
    // when
    const verdicts = mcpInTasks([CLAUDE, OPENCODE_OFF], ALLOWED, SERVERS);

    // then
    expect(verdicts).toEqual({
      tracker: { usable: true, signIn: false, detail: "getIssue for Claude Code; OpenCode gets no MCP server without ORCHESTRATOR_OPENCODE_MCP=1" },
      docs: {
        usable: true,
        signIn: true,
        detail: "search for Claude Code; OpenCode gets no MCP server without ORCHESTRATOR_OPENCODE_MCP=1; it sends no credential, so a server that asks for a sign-in fails in a task: nobody is there to finish one in a browser",
      },
      postgres: { usable: false, signIn: false, detail: "no tool of it is allowed for tasks; name one in the repository's mcpTools in orchestrator.json; OpenCode gets no MCP server without ORCHESTRATOR_OPENCODE_MCP=1" },
      warehouse: { usable: false, signIn: false, detail: expect.stringMatching(/^warehouse is not shareable as written: its command carries a trace of one machine/) },
      my_queue: { usable: true, signIn: false, detail: "peek for Claude Code; OpenCode gets no MCP server without ORCHESTRATOR_OPENCODE_MCP=1" },
    });
  });

  it("given OpenCode with MCP on, when a server's name has an underscore, then OpenCode's own reason is given and Claude Code still gets it", () => {
    // when
    const verdicts = mcpInTasks([CLAUDE, OPENCODE_ON], ALLOWED, { my_queue: SERVERS.my_queue, tracker: SERVERS.tracker });

    // then
    expect(verdicts.my_queue).toEqual({ usable: true, signIn: false, detail: "peek for Claude Code; left out for OpenCode: its name has an underscore, which makes OpenCode's tool names ambiguous" });
    expect(verdicts.tracker).toEqual({ usable: true, signIn: false, detail: "getIssue for Claude Code and OpenCode" });
  });

  it("given a server that carries a credential, when it is judged, then no task gets it, the share rule's reason says why and the value is not repeated", () => {
    // given
    const token = `ghp_${"A1b2C3d4".repeat(5).slice(0, 36)}`;
    const servers = {
      tracker: { type: "http", url: "https://tracker.example.com/mcp", headers: { Authorization: "Bearer dGhpcy1pcy1hLXZlcnktbG9uZy10b2tlbg" } },
      queue: { command: "queue-mcp", args: ["--token", token] },
    };

    // when
    const verdicts = mcpInTasks([CLAUDE], [...ALLOWED, { server: "queue", tool: "peek" }], servers);

    // then
    expect(verdicts.tracker).toEqual({
      usable: false,
      signIn: false,
      detail: "tracker is not shareable as written: headers.Authorization holds a literal value; move the value into an environment variable referenced as ${VAR} and review again",
    });
    expect(verdicts.queue).toEqual({
      usable: false,
      signIn: false,
      detail: "queue is not shareable as written: its args[1] looks like it contains a secret (github-token); move the value into an environment variable referenced as ${VAR} and review again",
    });
    expect(JSON.stringify(verdicts)).not.toContain(token);
    expect(JSON.stringify(verdicts)).not.toContain("dGhpcy1pcy1hLXZlcnktbG9uZy10b2tlbg");
  });

  it("given only the stand-in agent, when the servers are judged, then none is usable and the reason names the stand-in", () => {
    // when
    const verdicts = mcpInTasks([STAND_IN], ALLOWED, { tracker: SERVERS.tracker });

    // then
    expect(verdicts.tracker).toEqual({ usable: false, signIn: false, detail: "Demo agent gets no MCP server, as it cannot be held to named tools" });
  });

  it("given a runner with its agents and a repository's mcpTools, when the repository page asks, then it answers by the same rule", async () => {
    // given
    const repo = { id: "payments-skills" } as RepoRecord;
    const dataDir = mkdtempSync(join(tmpdir(), "orchestrator-mcp-tasks-"));
    const runner = createTaskRunner(
      { store: openSqliteStore(":memory:"), dataDir, tenant: "acme" },
      { agents: [CLAUDE], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: {}, mcpTools: (r) => (r.id === "payments-skills" ? ALLOWED : []) },
    );

    // when
    const verdicts = runner.mcpInTasks(repo, { tracker: SERVERS.tracker, postgres: SERVERS.postgres });

    // then
    await runner.ready();
    rmSync(dataDir, { recursive: true, force: true });
    expect(verdicts).toEqual({
      tracker: { usable: true, signIn: false, detail: "getIssue for Claude Code" },
      postgres: { usable: false, signIn: false, detail: "no tool of it is allowed for tasks; name one in the repository's mcpTools in orchestrator.json" },
    });
  });
});
