import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { agentSetup, CLAUDE_DENIED, CLAUDE_TOOLS, claudeCodeAdapter, DATA_FOLDER_PARTS, fakeAgentAdapter, opencodeAdapter, opencodeServer, opencodeToolName } from "./agents.js";
import type { AgentAdapter, AgentSetup } from "./agents.js";
import { makeTaskDirs, runProcess, taskEnv, taskPaths } from "./isolation.js";
import type { TaskPaths } from "./isolation.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SETUP: AgentSetup = {
  skills: [{ slug: "release-checklist", files: [{ path: "SKILL.md", content: "---\nname: release-checklist\ndescription: Use before a release.\n---\n" }, { path: "refs/notes.md", content: "notes\n" }] }],
  mcpServers: { docs: { type: "http", url: "https://docs.example.com/mcp", headers: { Authorization: "${DOCS_TOKEN}" } } },
  mcpTools: [{ server: "docs", tool: "search" }],
};

// Stand-ins for the real CLIs: each records what it was started with into its HOME and
// prints output in the shape the real one prints. No test here reaches a real agent.
const CLAUDE_STANDIN = `#!${process.execPath}
const { writeFileSync, readFileSync } = require("node:fs");
const stdin = readFileSync(0, "utf8");
writeFileSync(process.env.HOME + "/record.json", JSON.stringify({ argv: process.argv.slice(2), stdin, cwd: process.cwd(), env: process.env }));
const say = (e) => console.log(JSON.stringify(e));
say({ type: "system", subtype: "init" });
say({ type: "assistant", message: { content: [{ type: "text", text: "Editing the checklist." }, { type: "tool_use", name: "Edit", input: { file_path: "skills/release-checklist/SKILL.md" } }] } });
say({ type: "result", subtype: "success", is_error: false, num_turns: 3, result: "Updated the checklist.", total_cost_usd: 0.0425, usage: { input_tokens: 120, cache_creation_input_tokens: 30, cache_read_input_tokens: 50, output_tokens: 75 } });
`;

const OPENCODE_STANDIN = `#!${process.execPath}
const { writeFileSync } = require("node:fs");
writeFileSync(process.env.HOME + "/record.json", JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: process.env }));
const say = (e) => console.log(JSON.stringify(e));
say({ type: "step_start", part: {} });
say({ type: "tool_use", part: { tool: "edit" } });
say({ type: "text", part: { text: "Done with the edit." } });
say({ type: "step_finish", part: { cost: 0.01, tokens: { input: 100, output: 20 } } });
say({ type: "step_finish", part: { cost: 0.02, tokens: { input: 50, output: 10 } } });
`;

function standIn(root: string, name: string, body: string): string {
  const file = join(root, name);
  writeFileSync(file, body);
  chmodSync(file, 0o755);
  return file;
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
}

async function runAgent(adapter: AgentAdapter, root: string, title = "Add an on-call note") {
  const paths: TaskPaths = taskPaths(root, "t", "0123456789ab");
  await makeTaskDirs(paths);
  await adapter.configure(paths, SETUP);
  const call = adapter.invocation(paths, { title, prompt: `Task: ${title}` }, SETUP);
  const host = { PATH: process.env.PATH, ORCHESTRATOR_SECRET_KEY: "x".repeat(32), ANTHROPIC_API_KEY: "sk-ant-standin" };
  const env = { ...taskEnv(host, paths, adapter.credentialEnv), ...call.env };
  const lines: string[] = [];
  const outcome = await runProcess({ ...call, env, cwd: paths.work }, { timeoutMs: 20_000, signal: new AbortController().signal, onLine: (s, l) => {
    const text = s === "stdout" ? adapter.logLine(l) : l;
    if (text) lines.push(text);
  } });
  return { paths, outcome, lines, report: adapter.report(outcome.stdout, outcome.code) };
}

describe("every agent adapter honours the same contract", () => {
  const cases: { name: string; make: (root: string) => AgentAdapter; cost: { usd: number | null; inputTokens: number | null; outputTokens: number | null } }[] = [
    { name: "claude-code", make: (root) => claudeCodeAdapter(standIn(root, "claude", CLAUDE_STANDIN)), cost: { usd: 0.0425, inputTokens: 200, outputTokens: 75 } },
    { name: "opencode", make: (root) => opencodeAdapter(standIn(root, "opencode", OPENCODE_STANDIN)), cost: { usd: 0.03, inputTokens: 150, outputTokens: 30 } },
    { name: "fake", make: () => fakeAgentAdapter(join(import.meta.dirname, "..", "..", "demo", "fake-agent.mjs")), cost: { usd: null, inputTokens: null, outputTokens: null } },
  ];

  for (const c of cases) {
    it(`given the ${c.name} adapter and a team setup, when the agent runs, then the setup sits in the agent's HOME only, the run succeeds and the cost is what the agent reported`, async () => {
      // given
      const root = mkdtempSync(join(tmpdir(), `orchestrator-agent-${c.name}-`));
      dirs.push(root);

      // when
      const { paths, report, lines } = await runAgent(c.make(root), root);

      // then
      expect(report.ok).toBe(true);
      expect(report.cost).toEqual(c.cost);
      expect(lines.length).toBeGreaterThan(0);
      const homeFiles = filesUnder(paths.home).map((f) => f.slice(paths.home.length + 1));
      expect(homeFiles.some((f) => f.endsWith("release-checklist/SKILL.md"))).toBe(true);
      expect(homeFiles.some((f) => f.endsWith("release-checklist/refs/notes.md"))).toBe(true);
      expect(filesUnder(paths.work).every((f) => !f.includes("release-checklist"))).toBe(true);
    });
  }
});

describe("the Claude Code adapter", () => {
  it("given a run, when the CLI is started, then it gets the prompt on stdin, file tools plus the MCP tools allowed by name, and no project settings or project MCP file", async () => {
    // given
    const root = mkdtempSync(join(tmpdir(), "orchestrator-agent-claude-"));
    dirs.push(root);

    // when
    const { paths, lines } = await runAgent(claudeCodeAdapter(standIn(root, "claude", CLAUDE_STANDIN)), root);
    const record = JSON.parse(readFileSync(join(paths.home, "record.json"), "utf8"));

    // then
    const argv: string[] = record.argv;
    const value = (flag: string) => argv[argv.indexOf(flag) + 1];
    expect(argv).toContain("-p");
    expect(argv).toContain("--strict-mcp-config");
    expect(value("--setting-sources")).toBe("user");
    expect(value("--output-format")).toBe("stream-json");
    expect(value("--allowedTools")).toBe([...CLAUDE_TOOLS, "mcp__docs__search"].join(","));
    expect(argv.filter((a) => /(^|,)mcp__docs(,|$)/.test(a))).toEqual([]);
    const data = resolve(paths.root, "..", "..", "..");
    expect(value("--disallowedTools")).toBe([...CLAUDE_DENIED, ...["Edit", "Write", "NotebookEdit"].map((t) => `${t}(/${paths.home}/**)`), ...DATA_FOLDER_PARTS.map((part) => `Read(/${data}/${part})`)].join(","));
    expect(value("--disallowedTools")).toContain(`Read(/${data}/orchestrator.db*)`);
    expect(JSON.parse(readFileSync(value("--mcp-config")!, "utf8"))).toEqual({ mcpServers: SETUP.mcpServers });
    expect(record.stdin).toBe("Task: Add an on-call note");
    expect(record.cwd).toBe(realpathSync(paths.work));
    expect(record.env.CLAUDE_CONFIG_DIR).toBe(join(paths.home, ".claude"));
    expect(record.env.ANTHROPIC_API_KEY).toBe("sk-ant-standin");
    expect(record.env).not.toHaveProperty("ORCHESTRATOR_SECRET_KEY");
    expect(lines).toContain("Editing the checklist. · tool Edit skills/release-checklist/SKILL.md");
  });

  it("given output with no result line or an error result, when it is read, then the run is not ok and the cost stays unknown when none was reported", () => {
    const adapter = claudeCodeAdapter("claude");
    expect(adapter.report('{"type":"system"}\n', 0)).toEqual({
      ok: false,
      summary: "",
      cost: { usd: null, inputTokens: null, outputTokens: null },
      failure: { class: "transport", message: "Claude Code ended without reporting how its turn went.", retryable: true, code: "exit 0" },
    });
    const failed = adapter.report(JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, result: "" }), 1);
    expect(failed.ok).toBe(false);
    expect(failed.cost).toEqual({ usd: null, inputTokens: null, outputTokens: null });
  });
});

describe("the OpenCode adapter", () => {
  it("given MCP turned on and one allowed tool, when its config is written, then everything is denied first, the file tools, skills and that tool are allowed after, and the checkout's config is ignored", async () => {
    // given
    const root = mkdtempSync(join(tmpdir(), "orchestrator-agent-opencode-"));
    dirs.push(root);

    // when
    const { paths } = await runAgent(opencodeAdapter(standIn(root, "opencode", OPENCODE_STANDIN), true), root);
    const record = JSON.parse(readFileSync(join(paths.home, "record.json"), "utf8"));
    const config = JSON.parse(readFileSync(record.env.OPENCODE_CONFIG, "utf8"));

    // then
    expect(record.argv.slice(0, 3)).toEqual(["run", "--format", "json"]);
    expect(record.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("1");
    // Order matters: OpenCode applies the last rule that matches.
    expect(Object.entries(config.permission)).toEqual([
      ["*", "deny"],
      ["read", "allow"],
      ["edit", "allow"],
      ["glob", "allow"],
      ["grep", "allow"],
      ["list", "allow"],
      ["skill", "allow"],
      ["docs_search", "allow"],
    ]);
    expect(config.mcp).toEqual({ docs: { type: "remote", url: "https://docs.example.com/mcp", headers: { Authorization: "{env:DOCS_TOKEN}" }, oauth: false, enabled: true } });
    expect(existsSync(join(paths.home, ".config", "opencode", "skill", "release-checklist", "SKILL.md"))).toBe(true);
  });

  it("given MCP left at its default, when the setup is narrowed and written, then no server and no MCP tool reach its config", async () => {
    // given
    const root = mkdtempSync(join(tmpdir(), "orchestrator-agent-opencode-off-"));
    dirs.push(root);
    const paths = taskPaths(root, "t", "0123456789ab");
    await makeTaskDirs(paths);
    const adapter = opencodeAdapter("opencode");
    const team = { skills: [], mcpServers: SETUP.mcpServers, refused: [] };

    // when
    const { setup, notes } = agentSetup(team, SETUP.mcpTools, adapter.placesMcp, adapter.mcpProblem);
    await adapter.configure(paths, setup);
    const config = JSON.parse(readFileSync(join(paths.home, ".config", "opencode", "opencode.json"), "utf8"));

    // then
    expect(config.mcp).toEqual({});
    expect(Object.keys(config.permission)).not.toContain("docs_search");
    expect(notes).toEqual(["MCP servers left out, this agent cannot be held to named tools: docs."]);
  });

  it("given servers OpenCode would read two ways or fill in from the host, when the setup is narrowed, then they are left out with the reason", () => {
    // given
    const adapter = opencodeAdapter("opencode", true);
    const team = {
      skills: [],
      mcpServers: {
        my_tracker: { type: "http", url: "https://tracker.example.com/mcp" },
        leaky: { command: "tool", args: ["{file:/etc/hosts}"] },
        tracker: { command: "tracker-mcp", args: ["--token", "${TRACKER_TOKEN}"] },
      },
      refused: [],
    };
    const allowed = [
      { server: "my_tracker", tool: "get" },
      { server: "leaky", tool: "get" },
      { server: "tracker", tool: "get.issue" },
    ];

    // when
    const { setup, notes } = agentSetup(team, allowed, adapter.placesMcp, adapter.mcpProblem);

    // then
    expect(Object.keys(setup.mcpServers)).toEqual(["tracker"]);
    expect(setup.mcpTools).toEqual([{ server: "tracker", tool: "get.issue" }]);
    expect(notes).toEqual([
      "MCP server my_tracker left out for this agent: its name has an underscore, which makes OpenCode's tool names ambiguous.",
      "MCP server leaky left out for this agent: its definition holds {env:...} or {file:...}, which OpenCode fills in from the host.",
    ]);
    expect(opencodeToolName("tracker", "get.issue")).toBe("tracker_get_issue");
    expect(opencodeServer(team.mcpServers.tracker)).toEqual({ type: "local", command: ["tracker-mcp", "--token", "{env:TRACKER_TOKEN}"], enabled: true });
  });
});

describe("the MCP servers and tools a task's agent is given", () => {
  const team = {
    skills: [],
    mcpServers: { jira: { type: "http", url: "https://tracker.example.com/mcp" }, postgres: { command: "npx", args: ["-y", "pg-mcp"] } },
    refused: [],
  };

  it("given no allowed tool, when the setup is narrowed, then no server is placed and the log says which were left out", () => {
    const { setup, notes } = agentSetup(team, [], true);
    expect(setup.mcpServers).toEqual({});
    expect(setup.mcpTools).toEqual([]);
    expect(notes).toEqual(["MCP servers left out, no tool of theirs is allowed for tasks: jira, postgres."]);
  });

  it("given tools allowed by name, when the setup is narrowed, then only their servers are placed and only those tools are allowed", () => {
    const { setup, notes } = agentSetup(team, [{ server: "jira", tool: "getIssue" }, { server: "wiki", tool: "read" }], true);
    expect(Object.keys(setup.mcpServers)).toEqual(["jira"]);
    expect(setup.mcpTools).toEqual([{ server: "jira", tool: "getIssue" }]);
    expect(notes).toEqual(["MCP servers left out, no tool of theirs is allowed for tasks: postgres.", "Allowed tools whose server the team does not share: wiki/read."]);
  });

  it("given an agent the orchestrator cannot hold to named tools, when the setup is narrowed, then it gets no server even with tools allowed", () => {
    const { setup } = agentSetup(team, [{ server: "jira", tool: "getIssue" }], false);
    expect(setup.mcpServers).toEqual({});
    expect(setup.mcpTools).toEqual([]);
  });

  it("given no allowed tool, when Claude Code is started, then its arguments name no MCP tool and its MCP file holds no server", async () => {
    // given
    const root = mkdtempSync(join(tmpdir(), "orchestrator-agent-claude-none-"));
    dirs.push(root);
    const paths = taskPaths(root, "t", "0123456789ab");
    await makeTaskDirs(paths);
    const adapter = claudeCodeAdapter("claude");
    const { setup } = agentSetup(team, [], adapter.placesMcp);

    // when
    await adapter.configure(paths, setup);
    const call = adapter.invocation(paths, { title: "x", prompt: "x" }, setup);

    // then
    expect(call.args.join(" ")).not.toContain("mcp__");
    expect(JSON.parse(readFileSync(join(paths.home, "mcp.json"), "utf8"))).toEqual({ mcpServers: {} });
  });
});
