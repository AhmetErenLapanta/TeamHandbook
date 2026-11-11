import { describe, expect, it } from "vitest";
import type { RunnerEvent } from "./link.js";
import type { AgentEvent } from "../server/tasks/adapters/contract.js";
import { COMMAND_MAX, OUTPUT_LINES_MAX, PATCH_LINES_MAX, PLAN_TEXT_MAX, TODOS_MAX } from "../shared/runner-wire.js";
import { keepOwnToolsHere, maskEvent } from "./mask.js";

const mask = (text: string) => text.replaceAll("stand-in-secret-value", "[masked]");

describe("an event as it leaves the machine", () => {
  it("given events of the kinds the runner knows, when they are masked, then every text they carry is masked and the rest goes as it is", () => {
    // given
    const events: RunnerEvent[] = [
      { type: "message", text: "using stand-in-secret-value" },
      { type: "tool_call", tool: "Edit", target: "notes/stand-in-secret-value.md", status: "started" },
      { type: "tool_call", tool: "mcp__docs__search", target: null, status: "done", mcp: { server: "docs", tool: "search_stand-in-secret-value" } },
      { type: "tool_call", tool: "mcp__jira__edit", target: null, status: "refused", refusal: { kind: "tracker-write", reason: "no stand-in-secret-value" } },
      { type: "request", request: { id: "r1", kind: "command", tool: "Bash", summary: "echo stand-in-secret-value" } },
      { type: "request", request: { id: "p1", kind: "plan", tool: "ExitPlanMode", summary: "1. Read", plan: "1. Read\n2. Use stand-in-secret-value" } },
      { type: "usage", cost: { usd: null, inputTokens: 10, outputTokens: 2 } },
      { type: "context", tokens: 18_400 },
      { type: "spend", usd: 0.42 },
      { type: "mcp_status", needsSignIn: ["stand-in-secret-value-server", "notion"] },
      { type: "steer", text: "use stand-in-secret-value", by: "Ada" },
    ];

    // when
    const masked = events.map((event) => maskEvent(event, mask));

    // then
    expect(masked).toEqual([
      { type: "message", text: "using [masked]" },
      { type: "tool_call", tool: "Edit", target: "notes/[masked].md", status: "started" },
      { type: "tool_call", tool: "mcp__docs__search", target: null, status: "done", mcp: { server: "docs", tool: "search_[masked]" } },
      { type: "tool_call", tool: "mcp__jira__edit", target: null, status: "refused", refusal: { kind: "tracker-write", reason: "no [masked]" } },
      { type: "request", request: { id: "r1", kind: "command", tool: "Bash", summary: "echo [masked]" } },
      { type: "request", request: { id: "p1", kind: "plan", tool: "ExitPlanMode", summary: "1. Read", plan: "1. Read\n2. Use [masked]" } },
      { type: "usage", cost: { usd: null, inputTokens: 10, outputTokens: 2 } },
      { type: "context", tokens: 18_400 },
      { type: "spend", usd: 0.42 },
      { type: "mcp_status", needsSignIn: ["[masked]-server", "notion"] },
      { type: "steer", text: "use [masked]", by: "Ada" },
    ]);
  });

  it("given an event of a known kind that carries a field this runner does not know, when it is masked, then that field is not in what leaves the machine", () => {
    // given
    const events = [
      { type: "tool_call", tool: "Bash", target: null, status: "started", input: { command: "echo stand-in-secret-value" } },
      { type: "message", text: "done", raw: "stand-in-secret-value" },
      { type: "request", request: { id: "r1", kind: "command", tool: "Bash", summary: "ls", input: "stand-in-secret-value" } },
      { type: "error", failure: { class: "provider", message: "failed", retryable: false, body: "stand-in-secret-value" } },
      { type: "usage", cost: { usd: null, inputTokens: 1, outputTokens: 1, account: "stand-in-secret-value" } },
    ] as unknown as RunnerEvent[];

    // when
    const masked = events.map((event) => maskEvent(event, mask));

    // then
    expect(masked).toEqual([
      { type: "tool_call", tool: "Bash", target: null, status: "started" },
      { type: "message", text: "done" },
      { type: "request", request: { id: "r1", kind: "command", tool: "Bash", summary: "ls" } },
      { type: "error", failure: { class: "provider", message: "failed", retryable: false } },
      { type: "usage", cost: { usd: null, inputTokens: 1, outputTokens: 1 } },
    ]);
    expect(JSON.stringify(masked)).not.toContain("stand-in-secret-value");
  });

  it("given an event of a kind this runner does not know, when it would leave the machine, then it is not sent at all", () => {
    // given
    const unknown = { type: "screen_capture", id: "c1", lines: ["stand-in-secret-value"] } as unknown as RunnerEvent;

    // when
    const masked = maskEvent(unknown, mask);

    // then
    expect(masked).toBeNull();
  });

  it("given a call's command, its output, an edit and a to-do list, when they are masked, then each text is masked and cut to the live task's limits, and a credential file's patch is left out", () => {
    // given
    const events: RunnerEvent[] = [
      { type: "tool_call", id: "c1", tool: "Bash", target: null, status: "done", command: `echo stand-in-secret-value ${"x".repeat(COMMAND_MAX)}` },
      { type: "tool_output", id: "c1", lines: [...Array.from({ length: OUTPUT_LINES_MAX }, (_, i) => `line ${i}`), "token stand-in-secret-value"] },
      { type: "edit", id: "c2", path: "notes/stand-in-secret-value.md", additions: 2, deletions: 0, patch: ["+uses stand-in-secret-value", ...Array.from({ length: PATCH_LINES_MAX }, (_, i) => `+line ${i}`)].join("\n") },
      { type: "edit", id: "c3", path: "config/.env", additions: 1, deletions: 0, patch: "+KEY=stand-in-secret-value" },
      { type: "todos", items: Array.from({ length: TODOS_MAX + 1 }, (_, i) => ({ text: i === 0 ? "rotate stand-in-secret-value" : `step ${i}`, state: "todo" as const })) },
    ];

    // when
    const [call, output, edit, envEdit, todos] = events.map((event) => maskEvent(event, mask)) as [Extract<RunnerEvent, { type: "tool_call" }>, Extract<RunnerEvent, { type: "tool_output" }>, Extract<RunnerEvent, { type: "edit" }>, Extract<RunnerEvent, { type: "edit" }>, Extract<RunnerEvent, { type: "todos" }>];

    // then
    expect(call.command).toHaveLength(COMMAND_MAX);
    expect(call.command!.startsWith("echo [masked] ")).toBe(true);
    expect(output.lines).toHaveLength(OUTPUT_LINES_MAX);
    expect(output.lines.at(-1)).toBe("token [masked]");
    expect(edit.path).toBe("notes/[masked].md");
    expect(edit.patch!.split("\n")).toHaveLength(PATCH_LINES_MAX);
    expect(edit.patch!.split("\n")[0]).toBe("+uses [masked]");
    expect(envEdit).toEqual({ type: "edit", id: "c3", path: "config/.env", additions: 1, deletions: 0 });
    expect(todos.items).toHaveLength(TODOS_MAX);
    expect(todos.items[0]).toEqual({ text: "rotate [masked]", state: "todo" });
    expect(JSON.stringify([call, output, edit, envEdit, todos])).not.toContain("stand-in-secret-value");
  });

  it("given a call of one of the person's own MCP tools that carries a command, when it would leave the machine for its team, then only the tool's name, its id and whether it ran go", () => {
    // given
    const call: AgentEvent = { type: "tool_call", id: "c4", tool: "mcp__notebook__run", target: "page 7", status: "done", command: "notebook run --page 7" };

    // when
    const leaving = keepOwnToolsHere(call, (tool) => tool === "mcp__notebook__run");

    // then
    expect(leaving).toEqual({ type: "tool_call", id: "c4", tool: "mcp__notebook__run", target: null, status: "done" });
  });

  it("given the agent's own command printed something, when the event would leave the machine for its team, then it stays here, as only the team's tests' output goes", () => {
    // given
    const printed: AgentEvent = { type: "tool_output", id: "c1", lines: ["stand-in-secret-value"] };
    const said: AgentEvent = { type: "message", text: "the build passed" };

    // when
    const leaving = [printed, said].map((event) => keepOwnToolsHere(event, () => false));

    // then
    expect(leaving).toEqual([null, said]);
  });

  it("given a plan longer than a plan is kept, when its request is masked, then it is cut at the limit", () => {
    // when
    const masked = maskEvent({ type: "request", request: { id: "p1", kind: "plan", tool: "ExitPlanMode", summary: "1. Read", plan: "x".repeat(PLAN_TEXT_MAX + 50) } }, mask) as Extract<RunnerEvent, { type: "request" }>;

    // then
    expect(masked.request.plan).toHaveLength(PLAN_TEXT_MAX);
  });
});
