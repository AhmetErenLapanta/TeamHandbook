import { describe, expect, it } from "vitest";
import { parseMcpTools, parseTracker, taskOptionsFromEnv } from "./config.js";

const build = (env: Record<string, string>) => taskOptionsFromEnv(env, "/data", "/app/dist/fake-agent.mjs", () => null);

describe("how tasks run, from the orchestrator's environment", () => {
  it("given nothing set, when the options are read, then tasks run under process isolation with the network open and only the real agents offered", () => {
    // when
    const options = build({});

    // then
    expect(options.isolation).toEqual({ mode: "process", network: "open" });
    expect(options.agents.map((a) => a.id)).toEqual(["claude-code", "opencode"]);
  });

  it("given one person's orchestrator, a team's and a local one with containers, when the options are read, then only the one person's runs tasks as that person unless told otherwise", () => {
    // when
    const profiles = [
      build({}),
      build({ ORCHESTRATOR_TASK_PROFILE: "isolated" }),
      build({ ORCHESTRATOR_MODE: "self-hosted" }),
      build({ ORCHESTRATOR_TASK_ISOLATION: "container", ORCHESTRATOR_TASK_IMAGE: "agent:1" }),
    ].map((options) => options.profile);

    // then
    expect(profiles).toEqual(["personal", "isolated", "isolated", "isolated"]);
  });

  it("given the demo, when the options are read, then the stand-in agent is offered first", () => {
    expect(build({ ORCHESTRATOR_DEMO: "1" }).agents.map((a) => a.id)).toEqual(["fake", "claude-code", "opencode"]);
  });

  it("given an isolation, network or agent the orchestrator does not know, when the options are read, then the orchestrator refuses to start rather than fall back", () => {
    expect(() => build({ ORCHESTRATOR_TASK_ISOLATION: "contianer" })).toThrow(/must be process or container/);
    expect(() => build({ ORCHESTRATOR_TASK_NETWORK: "off" })).toThrow(/must be open or none/);
    expect(() => build({ ORCHESTRATOR_TASK_ISOLATION: "container" })).toThrow(/needs ORCHESTRATOR_TASK_IMAGE/);
    expect(() => build({ ORCHESTRATOR_AGENTS: "claude-code,codex" })).toThrow(/unknown agents: codex/);
    expect(() => build({ ORCHESTRATOR_TASK_TIMEOUT_MINUTES: "-1" })).toThrow(/positive number/);
  });

  it("given container isolation with a volume, when the options are read, then the image, volume and network carry through", () => {
    expect(build({ ORCHESTRATOR_TASK_ISOLATION: "container", ORCHESTRATOR_TASK_IMAGE: "agents:1", ORCHESTRATOR_TASK_VOLUME: "orchestrator-data", ORCHESTRATOR_TASK_NETWORK: "none" }).isolation).toEqual({
      mode: "container",
      network: "none",
      image: "agents:1",
      dataDir: "/data",
      volume: "orchestrator-data",
    });
  });
});

describe("the MCP tools a repository's tasks may call", () => {
  it("given server/tool names, when they are read, then each is one tool of one server", () => {
    expect(parseMcpTools(undefined, "payments-skills")).toEqual([]);
    expect(parseMcpTools(["jira/getIssue", "docs/search_pages"], "payments-skills")).toEqual([
      { server: "jira", tool: "getIssue" },
      { server: "docs", tool: "search_pages" },
    ]);
  });

  it("given a whole server, a pattern or something that is not a name, when they are read, then the orchestrator refuses to start", () => {
    for (const bad of [["jira"], ["jira/*"], ["jira/get,mcp__x"], ["a/b/c"], [42], "jira/getIssue"]) {
      expect(() => parseMcpTools(bad, "payments-skills"), JSON.stringify(bad)).toThrow(/mcpTools of payments-skills/);
    }
  });
});

describe("writing back to an issue", () => {
  it("given no tracker setting or write-back set false, when it is read, then write-back is off", () => {
    expect(parseTracker(undefined, "payments-skills")).toEqual({ writeBack: false });
    expect(parseTracker({ writeBack: false }, "payments-skills")).toEqual({ writeBack: false });
  });

  it("given write-back turned on, or a setting the orchestrator does not know, when it is read, then the orchestrator refuses to start", () => {
    expect(() => parseTracker({ writeBack: true }, "payments-skills")).toThrow(/is not available/);
    expect(() => parseTracker({ writeBack: "yes" }, "payments-skills")).toThrow(/must be false/);
    expect(() => parseTracker({ comment: true }, "payments-skills")).toThrow(/unknown settings: comment/);
  });
});

describe("MCP for OpenCode", () => {
  it("given the operator's switch, when the options are read, then OpenCode places MCP servers only with it set to 1, and another value stops the orchestrator", () => {
    const opencode = (env: Record<string, string>) => build(env).agents.find((a) => a.id === "opencode")!;
    expect(opencode({}).placesMcp).toBe(false);
    expect(opencode({ ORCHESTRATOR_OPENCODE_MCP: "0" }).placesMcp).toBe(false);
    expect(opencode({ ORCHESTRATOR_OPENCODE_MCP: "1" }).placesMcp).toBe(true);
    expect(() => build({ ORCHESTRATOR_OPENCODE_MCP: "yes" })).toThrow(/ORCHESTRATOR_OPENCODE_MCP must be 1 or 0/);
  });
});
