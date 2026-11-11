import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { approvedProjectMcpFile, approvedProjectServers, claudeCodeAdapter, DATA_FOLDER_PARTS, fakeAgentAdapter, personalMcp, projectServerHash, teamSkillsDir, writeApprovedProjectMcp } from "../agents.js";
import type { AgentSetup } from "../agents.js";
import { taskPaths } from "../isolation.js";
import { FORGE_REASON, releasePersonalGuard, TRACKER_REASON, writePersonalGuard } from "../profile.js";
import { readTranscript } from "../transcript.js";
import type { Step, Transcript } from "../transcript.js";
import { claudeCodeCodec, claudeCodeDecoder } from "./claude-code.js";
import type { AgentEvent } from "./contract.js";
import { resetAtFrom } from "./failure.js";
import { foldRun, foldStdout, logLineOf } from "./fold.js";
import { replayTransport } from "./replay.js";
import { openSession } from "./session.js";

const init = (permissionMode: string) => JSON.stringify({ type: "system", subtype: "init", permissionMode, session_id: "session-1" });
const result = (total: number, output: number) => JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "Done.", total_cost_usd: total, usage: { input_tokens: 10, output_tokens: output }, session_id: "session-1" });

const NO_MCP: AgentSetup = { skills: [], mcpServers: {}, mcpTools: [] };
const paths = taskPaths("/data", "t", "0123456789ab");
// The task's home closed to writes, and the orchestrator's data folder (/data here) beside the task's own closed to reads.
const GUARD = [...["Edit", "Write", "NotebookEdit"].map((t) => `${t}(/${paths.home}/**)`), ...DATA_FOLDER_PARTS.map((part) => `Read(//data/${part})`)].join(",");

describe("the Claude Code decoder in a session of several turns", () => {
  it("given two turns whose results carry the session's running total, when they are folded, then the cost is the last total and the tokens are each turn's added up", () => {
    // when
    const report = foldStdout(claudeCodeDecoder(), [result(0.25, 5), result(0.75, 7)].join("\n"), 0);

    // then
    expect(report.cost).toEqual({ usd: 0.75, inputTokens: 20, outputTokens: 12 });
  });

  it("given one reply split into three assistant frames that each repeat its usage, when the run is folded, then only the result counts and nothing is counted three times", () => {
    // given
    const usage = { input_tokens: 4, cache_creation_input_tokens: 900, cache_read_input_tokens: 100, output_tokens: 50 };
    const part = (content: Record<string, unknown>) => JSON.stringify({ type: "assistant", message: { id: "msg_1", usage, content: [content] } });
    const lines = [part({ type: "text", text: "Reading first." }), part({ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "a.md" } }), part({ type: "text", text: "Done." }), result(0.02, 50)];

    // when
    const report = foldStdout(claudeCodeDecoder(), lines.join("\n"), 0);

    // then
    expect(report.cost).toEqual({ usd: 0.02, inputTokens: 10, outputTokens: 50 });
  });

  it("given one reply split into three assistant frames, the last with its whole output, when they are decoded, then the turn's estimate is that reply's priced once at its last usage", () => {
    // given
    const decoder = claudeCodeDecoder();
    const usage = (output: number) => ({ input_tokens: 1_000, cache_creation_input_tokens: 2_000, cache_creation: { ephemeral_5m_input_tokens: 2_000, ephemeral_1h_input_tokens: 0 }, cache_read_input_tokens: 10_000, output_tokens: output });
    const part = (output: number, content: Record<string, unknown>) => JSON.stringify({ type: "assistant", message: { id: "msg_1", model: "claude-opus-5-5", usage: usage(output), content: [content] } });

    // when
    const spends = [part(1, { type: "text", text: "Reading first." }), part(1, { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "a.md" } }), part(500, { type: "text", text: "Done." })]
      .flatMap((line) => decoder.decode(line))
      .filter((e) => e.type === "spend");

    // then
    const whole = (1_000 * 4 + 2_000 * 5 + 10_000 * 0.2 + 500 * 20) / 1_000_000;
    expect(spends).toHaveLength(2);
    expect(spends[1]).toEqual({ type: "spend", usd: expect.closeTo(whole, 12) });
  });

  it("given two replies in a turn, a result and a reply in the next turn, when they are decoded, then the estimate adds the turn's replies up and starts again from the next turn's first", () => {
    // given
    const decoder = claudeCodeDecoder();
    const reply = (id: string, output: number) => JSON.stringify({ type: "assistant", message: { id, model: "claude-sonnet-5-5", usage: { input_tokens: 0, output_tokens: output }, content: [{ type: "text", text: "Working." }] } });

    // when
    const spends = [reply("msg_1", 100_000), reply("msg_2", 100_000), result(2, 200_000), reply("msg_3", 100_000)]
      .flatMap((line) => decoder.decode(line))
      .filter((e) => e.type === "spend")
      .map((e) => (e as { usd: number }).usd);

    // then
    expect(spends).toEqual([1, 2, 1]);
  });

  it("given a model named only by the init frame, a model without a price and a fast reply of a model with no fast price, when their replies are decoded, then the first is priced by the init frame's model and the others give no estimate", () => {
    // given
    const decoder = claudeCodeDecoder();
    const reply = (id: string, model: string | undefined, usage: Record<string, unknown> = { input_tokens: 0, output_tokens: 1_000_000 }) => JSON.stringify({ type: "assistant", message: { id, ...(model ? { model } : {}), usage, content: [{ type: "text", text: "Working." }] } });

    // when
    decoder.decode(JSON.stringify({ type: "system", subtype: "init", model: "claude-haiku-4-5-20251001", session_id: "session-1" }));
    const fromInit = decoder.decode(reply("msg_1", undefined));
    const unpriced = decoder.decode(reply("msg_2", "<synthetic>"));
    const fastWithout = decoder.decode(reply("msg_3", "claude-sonnet-5-5", { input_tokens: 0, output_tokens: 1_000_000, speed: "fast" }));

    // then
    expect(fromInit.filter((e) => e.type === "spend")).toEqual([{ type: "spend", usd: 5 }]);
    expect([...unpriced, ...fastWithout].filter((e) => e.type === "spend")).toEqual([]);
  });

  it("given Haiku 5.5 replies whose prompts are under and over 100,000 tokens, a fast Opus 5.5 reply and a cache write that does not say its cache, when each is decoded alone, then each is priced at its own rate", () => {
    // given
    const priced = (model: string, usage: Record<string, unknown>) =>
      claudeCodeDecoder()
        .decode(JSON.stringify({ type: "assistant", message: { id: "msg_1", model, usage, content: [{ type: "text", text: "Working." }] } }))
        .filter((e) => e.type === "spend")
        .map((e) => (e as { usd: number }).usd)[0];

    // when
    const short = priced("claude-haiku-5-5", { input_tokens: 50_000, cache_read_input_tokens: 50_000, output_tokens: 10_000 });
    const long = priced("claude-haiku-5-5", { input_tokens: 50_000, cache_read_input_tokens: 50_001, output_tokens: 10_000 });
    const fastOpus = priced("claude-opus-5-5", { input_tokens: 1_000_000, output_tokens: 0, speed: "fast" });
    const unsaid = priced("claude-opus-5-5", { input_tokens: 0, cache_creation_input_tokens: 1_000_000, output_tokens: 0 });

    // then
    expect(short).toBeCloseTo((50_000 * 0.1 + 50_000 * 0.01 + 10_000 * 0.5) / 1_000_000, 12);
    expect(long).toBeCloseTo((50_000 * 0.5 + 50_001 * 0.05 + 10_000 * 2.5) / 1_000_000, 12);
    expect(fastOpus).toBe(8);
    expect(unsaid).toBe(8);
  });

  it("given the init and result frames, when the run ends, then the terminal carries the agent's session id for a resume", () => {
    const decoder = claudeCodeDecoder();
    for (const line of [init("dontAsk"), result(0.1, 5)]) decoder.decode(line);
    expect(decoder.finish(0)).toEqual({ type: "terminal", status: "completed", summary: "Done.", nativeSessionId: "session-1" });
  });

  it("given Auto opened as Claude Code's default so that it asks, when the init frame names default, then nothing is said, and a mode other than the one it was opened in is still said", () => {
    // given
    const opened = claudeCodeCodec("auto", () => false, undefined, false, "default");

    // when
    const asOpened = opened.decode(init("default"));
    const plain = claudeCodeCodec("auto").decode(init("default"));

    // then
    expect(asOpened).toEqual([]);
    expect(plain).toEqual([{ type: "notice", text: "Auto was asked for, and the agent runs in Approval required: its own settings refuse Auto." }]);
    expect(claudeCodeCodec("auto", () => false, undefined, false, "default").decode(init("plan"))).toMatchObject([{ type: "notice" }]);
  });

  it("given full access asked for and an init frame naming another mode, when it is decoded, then one notice says the agent's settings refused it", () => {
    // given
    const decoder = claudeCodeDecoder("full-access");

    // when
    const first = decoder.decode(init("default"));
    const again = decoder.decode(init("default"));

    // then
    expect(first).toEqual([{ type: "notice", text: "Full access was asked for, and the agent runs in Approval required: its own settings refuse Full access." }]);
    expect(again).toEqual([]);
    expect(claudeCodeDecoder("full-access").decode(init("bypassPermissions"))).toEqual([]);
  });
});

describe("the Claude Code two-way codec", () => {
  it("given a message and an interrupt, when they are written, then they are a user frame and an interrupt control request", () => {
    const codec = claudeCodeCodec("auto");
    expect(JSON.parse(codec.turn("also update the readme"))).toEqual({ type: "user", message: { role: "user", content: "also update the readme" }, parent_tool_use_id: null });
    expect(JSON.parse(codec.interrupt())).toEqual({ type: "control_request", request_id: "interrupt-1", request: { subtype: "interrupt" } });
    expect(JSON.parse(codec.interrupt()).request_id).toBe("interrupt-2");
  });
});

describe("a two-way Claude Code session's start", () => {
  const adapter = claudeCodeAdapter("claude");
  const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];

  it("given Auto, when it is started, then stream-json goes both ways, the mode is dontAsk and no prompt is put on stdin", () => {
    // when
    const { call, mode, notes } = adapter.twoWay!.launch(paths, NO_MCP, { mode: "auto" });

    // then
    expect(mode).toBe("auto");
    expect(notes).toEqual([]);
    expect(flag(call.args, "--input-format")).toBe("stream-json");
    expect(flag(call.args, "--output-format")).toBe("stream-json");
    expect(flag(call.args, "--permission-mode")).toBe("dontAsk");
    expect(flag(call.args, "--disallowedTools")).toBe(`Bash,WebFetch,WebSearch,${GUARD}`);
    expect(call).not.toHaveProperty("stdin");
  });

  it("given full access for a task with an MCP server, when it is started, then it runs as Auto and says why", () => {
    // given
    const setup: AgentSetup = { skills: [], mcpServers: { docs: { type: "http", url: "https://docs.example.com/mcp" } }, mcpTools: [{ server: "docs", tool: "search" }] };

    // when
    const { call, mode, notes } = adapter.twoWay!.launch(paths, setup, { mode: "full-access" });

    // then
    expect(mode).toBe("auto");
    expect(flag(call.args, "--permission-mode")).toBe("dontAsk");
    expect(notes).toEqual(["Full access runs as Auto for this task: it would let every tool of the task's MCP servers run, not only the allowed ones."]);
  });

  it("given full access and no MCP server, when it is started, then it bypasses permissions and the shell and the web stay denied", () => {
    const { call, mode } = adapter.twoWay!.launch(paths, NO_MCP, { mode: "full-access" });
    expect(mode).toBe("full-access");
    expect(flag(call.args, "--permission-mode")).toBe("bypassPermissions");
    expect(flag(call.args, "--disallowedTools")).toBe(`Bash,WebFetch,WebSearch,${GUARD}`);
  });
});

const FILE_TOOLS = new Set(["Read", "Edit", "Write", "Glob", "Grep"]);
const ask = (id: string, tool: string, input: Record<string, unknown>) => ({ emit_inbound: { type: "control_request", request_id: id, request: { subtype: "can_use_tool", tool_name: tool, input, tool_use_id: `toolu-${id}` } } });
const answered = (id: string, response: Record<string, unknown>) => ({ stdin: { type: "control_response", response: { subtype: "success", request_id: id, response } } });
const done = { emit_inbound: JSON.parse(result(0.25, 1)) };
const script = (...steps: Step[]): Pick<Transcript, "steps" | "exit"> => ({ steps, exit: 0 });

async function run(transcript: Pick<Transcript, "steps" | "exit">, onEvent: (e: AgentEvent, s: ReturnType<typeof openSession>) => void, permitted = FILE_TOOLS) {
  const transport = replayTransport(transcript);
  const session = openSession(claudeCodeCodec("approval-required", (tool) => permitted.has(tool)), transport);
  const events: AgentEvent[] = [];
  for await (const e of session.events) {
    events.push(e);
    onEvent(e, session);
  }
  return { events, transport };
}

describe("Claude Code's permission questions", () => {
  it("given the recorded run that asked to write a file, when a person allows it once, then the answer carries the call's input back and the run completes", async () => {
    // given
    const recorded = readTranscript(join(import.meta.dirname, "transcripts", "claude-code-approval.ndjson"));
    const opening = recorded.steps[0] as { stdin: { message: { content: string } } };
    const transport = replayTransport(recorded);
    const session = openSession(claudeCodeCodec("approval-required", (tool) => FILE_TOOLS.has(tool)), transport);

    // when
    session.sendTurn(opening.stdin.message.content);
    const events: AgentEvent[] = [];
    for await (const e of session.events) {
      events.push(e);
      if (e.type === "request") session.respond(e.request.id, "allow-once");
    }

    // then
    expect(events.filter((e) => e.type === "request")).toEqual([{ type: "request", request: { id: "request-1", kind: "file-change", tool: "Write", summary: "/checkout/hello.txt" } }]);
    expect(events).not.toContainEqual(expect.objectContaining({ type: "notice" }));
    expect(events.at(-1)).toEqual({ type: "terminal", status: "completed", summary: "Created `hello.txt` in the current directory containing `hi`.", nativeSessionId: "session-1" });
    expect(transport.written).toHaveLength(2);
  });

  it("given a question about an edit, when a person declines it with a note, then the agent is told the note and no standing rule is written", async () => {
    const { transport } = await run(script(ask("r1", "Edit", { file_path: "/checkout/a.md" }), answered("r1", { behavior: "deny", message: "use the template" }), done), (e, s) => e.type === "request" && s.respond("r1", "deny", "use the template"));
    expect(transport.written.join("\n")).not.toContain("updatedPermissions");
  });

  it("given a question about a tool the task does not allow, when it arrives, then it is refused at once and no person is asked", async () => {
    // given
    const transcript = script(ask("r1", "mcp__docs__delete_page", { path: "/handbook" }), answered("r1", { behavior: "deny", message: "This task does not allow this tool." }), done);

    // when
    const { events } = await run(transcript, () => {}, new Set([...FILE_TOOLS, "mcp__docs__search"]));

    // then
    expect(events.some((e) => e.type === "request")).toBe(false);
    expect(events).toContainEqual({ type: "tool_call", id: "toolu-r1", tool: "mcp__docs__delete_page", target: "/handbook", mcp: { server: "docs", tool: "delete_page" }, status: "refused", refusal: { kind: "not-allowed", reason: "This task does not allow this tool." } });
  });

  it("given a question the agent takes back, when a person answers it after, then the card is withdrawn and the answer is refused", async () => {
    let late: unknown = null;
    const { events } = await run(script(ask("r1", "Write", { file_path: "/checkout/b.md" }), { emit_inbound: { type: "control_cancel_request", request_id: "r1" } }, done), (e, s) => {
      if (e.type !== "request_withdrawn") return;
      try {
        s.respond("r1", "allow-once");
      } catch (error) {
        late = error;
      }
    });
    expect(events).toContainEqual({ type: "request_withdrawn", requestId: "r1" });
    expect(String(late)).toMatch(/no request/);
  });
});

describe("a Claude Code session that plans first", () => {
  const adapter = claudeCodeAdapter("claude");
  const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];
  const PLANS = "/checkout/.orchestrator-plans";
  const PLAN_FIRST = "This task plans first: change nothing until the plan is approved, then finish the plan with ExitPlanMode.";
  const plan = { plan: "# Add an on-call note\n\n1. Write the note.", planFilePath: `${PLANS}/note.md` };
  const exitedPlan = (id: string) => ({ emit_inbound: { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "User has approved your plan." }] }, session_id: "session-1" } });
  const modeSet = (mode: string) => ({ stdin: { type: "control_request", request_id: "mode-1", request: { subtype: "set_permission_mode", mode } } });

  async function planned(transcript: Pick<Transcript, "steps" | "exit">, onEvent: (e: AgentEvent, s: ReturnType<typeof openSession>) => void, after = "dontAsk") {
    const transport = replayTransport(transcript);
    const session = openSession(claudeCodeCodec("auto", (tool) => FILE_TOOLS.has(tool), "/checkout", false, "plan", { mode: after, dir: PLANS }), transport);
    const events: AgentEvent[] = [];
    for await (const e of session.events) {
      events.push(e);
      onEvent(e, session);
    }
    return { events, transport };
  }

  it("given Auto with a plan first, when it is started, then it opens in Claude Code's plan mode with the permission prompt on stdio and Auto's own tool list for after the plan", () => {
    // given
    const setup: AgentSetup = { skills: [], mcpServers: { docs: { type: "http", url: "https://docs.example.com/mcp" } }, mcpTools: [{ server: "docs", tool: "search" }] };

    // when
    const { call, mode, notes } = adapter.twoWay!.launch(paths, setup, { mode: "auto", plan: true });

    // then
    expect(mode).toBe("auto");
    expect(notes).toEqual([]);
    expect(flag(call.args, "--permission-mode")).toBe("plan");
    expect(flag(call.args, "--permission-prompt-tool")).toBe("stdio");
    expect(flag(call.args, "--allowedTools")).toBe("Read,Edit,Write,Glob,Grep,mcp__docs__search");
    expect(adapter.twoWay!.capabilities.plan).toBe(true);
    expect([adapter.capabilities.plan, fakeAgentAdapter("fake.mjs").twoWay!.capabilities.plan]).toEqual([false, false]);
  });

  it("given full access with a plan first, when it is started, then it plans and goes on as Auto, and says why", () => {
    const { call, mode, notes } = adapter.twoWay!.launch(paths, NO_MCP, { mode: "full-access", plan: true });
    expect([mode, flag(call.args, "--permission-mode")]).toEqual(["auto", "plan"]);
    expect(notes).toEqual(["Full access runs as Auto once the plan is approved: Claude Code takes Full access only in a session that starts in it."]);
  });

  it("given a session planning first, when it asks to edit a file, writes its plan file and puts its plan, and the person approves the plan, then the edit is refused unasked, the plan file is written unasked, the plan reaches a card, and the approval changes no mode until ExitPlanMode has run, then sets the task's own", async () => {
    // given
    const transcript = script(
      ask("r1", "Edit", { file_path: "/checkout/a.md" }),
      answered("r1", { behavior: "deny", message: PLAN_FIRST }),
      ask("r2", "Write", { file_path: `${PLANS}/note.md`, content: plan.plan }),
      answered("r2", { behavior: "allow", updatedInput: { file_path: `${PLANS}/note.md`, content: plan.plan } }),
      ask("r3", "ExitPlanMode", plan),
      answered("r3", { behavior: "allow", updatedInput: plan }),
      exitedPlan("toolu-r3"),
      modeSet("dontAsk"),
      ask("r4", "Edit", { file_path: "/checkout/a.md" }),
      answered("r4", { behavior: "allow", updatedInput: { file_path: "/checkout/a.md" } }),
      done,
    );

    // when
    const { events } = await planned(transcript, (e, s) => e.type === "request" && s.respond(e.request.id, "allow-once"));

    // then
    expect(events).toContainEqual({ type: "tool_call", id: "toolu-r1", tool: "Edit", target: "a.md", status: "refused", refusal: { kind: "not-allowed", reason: "This task plans first: nothing changes until its plan is approved." } });
    expect(events.filter((e) => e.type === "request").map((e) => (e as { request: unknown }).request)).toEqual([
      { id: "r3", kind: "plan", tool: "ExitPlanMode", summary: "Add an on-call note", plan: plan.plan },
      { id: "r4", kind: "file-change", tool: "Edit", summary: "a.md" },
    ]);
  });

  it("given a plan the person changed, when it is approved as changed, then the agent gets the changed plan, the request is resolved, and a plan cannot be granted for the task", async () => {
    // given
    const changed = "# Add an on-call note\n\n1. Write the note.\n2. Link it from the runbook.";
    const transcript = script(ask("r1", "ExitPlanMode", plan), answered("r1", { behavior: "allow", updatedInput: { ...plan, plan: changed } }), exitedPlan("toolu-r1"), modeSet("dontAsk"), done);
    let forTask: unknown = null;

    // when
    const { events } = await planned(transcript, (e, s) => {
      if (e.type !== "request") return;
      try {
        s.respond("r1", "allow-for-task");
      } catch (error) {
        forTask = error;
      }
      s.approvePlan("r1", changed);
    });

    // then
    expect(String(forTask)).toMatch(/no request/);
    expect(events).toContainEqual({ type: "request_resolved", requestId: "r1", decision: "allow-once" });
  });

  it("given a task whose mode is Claude Code's default, as Approval required and Auto as you are, when its plan is approved and ExitPlanMode has run, then no mode is set, so the rules Claude Code set aside while planning come back", async () => {
    // given
    const transcript = script(ask("r1", "ExitPlanMode", plan), answered("r1", { behavior: "allow", updatedInput: plan }), exitedPlan("toolu-r1"), done);

    // when
    const { transport } = await planned(transcript, (e, s) => e.type === "request" && s.respond(e.request.id, "allow-once"), "default");

    // then
    expect(transport.written).toHaveLength(1);
  });

  it("given a task that did not plan first, when the agent leaves a plan mode it went into by itself, then its plan reaches a card, and the approval sets no mode, since Claude Code returns to the mode the agent left", async () => {
    // given
    const transport = replayTransport(script(ask("r1", "ExitPlanMode", plan), answered("r1", { behavior: "allow", updatedInput: plan }), exitedPlan("toolu-r1"), done));
    const session = openSession(claudeCodeCodec("approval-required", (tool) => FILE_TOOLS.has(tool), "/checkout"), transport);
    const requests: unknown[] = [];

    // when
    for await (const e of session.events) {
      if (e.type !== "request") continue;
      requests.push(e.request);
      session.respond(e.request.id, "allow-once");
    }

    // then
    expect(requests).toEqual([{ id: "r1", kind: "plan", tool: "ExitPlanMode", summary: "Add an on-call note", plan: plan.plan }]);
    expect(transport.written).toHaveLength(1);
  });

  it("given a declined plan and a plan the agent did not write, when they come, then the decline reaches the agent and the plan it did not write is turned back with no card", async () => {
    // given
    const transcript = script(
      ask("r1", "ExitPlanMode", { plan: "  " }),
      answered("r1", { behavior: "deny", message: "The plan could not be read. Write the plan to its file, then call ExitPlanMode again." }),
      ask("r2", "ExitPlanMode", plan),
      answered("r2", { behavior: "deny", message: "The person reviewing this task declined the plan." }),
      done,
    );

    // when
    const { events } = await planned(transcript, (e, s) => e.type === "request" && s.respond(e.request.id, "deny"));

    // then
    expect(events.filter((e) => e.type === "request").map((e) => (e as { request: { id: string } }).request.id)).toEqual(["r2"]);
  });

  it("given a task's own Claude Code profile and the guard layer of a run as you, when they are written, then both put plans in the task's folder, never in a config directory", async () => {
    // given
    const root = mkdtempSync(join(tmpdir(), "orchestrator-claude-plans-"));
    const home = taskPaths(root, "t", "0123456789ab");
    mkdirSync(home.work, { recursive: true });

    // when
    await adapter.configure(home, NO_MCP);
    const guard = await writePersonalGuard(home);

    // then
    expect(JSON.parse(readFileSync(join(home.home, ".claude", "settings.json"), "utf8")).plansDirectory).toBe(".orchestrator-plans");
    expect(JSON.parse(readFileSync(guard, "utf8")).plansDirectory).toBe(".orchestrator-plans");
    await releasePersonalGuard(home.root);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("a two-way Claude Code session in a mode that asks", () => {
  const adapter = claudeCodeAdapter("claude");
  const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];
  const setup: AgentSetup = { skills: [], mcpServers: { docs: { type: "http", url: "https://docs.example.com/mcp" } }, mcpTools: [{ server: "docs", tool: "search" }] };

  it("given Approval required, when it is started, then questions come on stdio and only the tools that read run without one", () => {
    const { call } = adapter.twoWay!.launch(paths, setup, { mode: "approval-required" });
    expect(flag(call.args, "--permission-mode")).toBe("default");
    expect(flag(call.args, "--permission-prompt-tool")).toBe("stdio");
    expect(flag(call.args, "--allowedTools")).toBe("Read,Glob,Grep");
  });

  it("given Auto, when it is started, then nothing asks and the allowed MCP tool runs by its full name", () => {
    const { call } = adapter.twoWay!.launch(paths, setup, { mode: "auto" });
    expect(call.args).not.toContain("--permission-prompt-tool");
    expect(flag(call.args, "--allowedTools")).toBe("Read,Edit,Write,Glob,Grep,mcp__docs__search");
  });
});

describe("a two-way Claude Code session that runs as you", () => {
  const adapter = claudeCodeAdapter("claude");
  const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];
  const question = (tool: string) => JSON.stringify({ type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: tool, input: {}, tool_use_id: "toolu-1" } });

  it("given Approval required as you, when it is started, then your sign-in is used under the orchestrator's guard layer, none of your MCP servers connect, questions come on stdio and the shell and the web ask rather than being refused", () => {
    // when
    const { call, mode } = adapter.twoWay!.launch(paths, NO_MCP, { mode: "approval-required", personal: true });

    // then
    expect(mode).toBe("approval-required");
    expect(call.env?.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(call.args).toEqual(expect.arrayContaining(["--restricted", "--strict-mcp-config"]));
    expect(flag(call.args, "--settings")).toBe(`${paths.root}/guard/personal-settings.json`);
    expect(flag(call.args, "--permission-prompt-tool")).toBe("stdio");
    expect(flag(call.args, "--allowedTools")).toBe("Read,Glob,Grep");
    expect(flag(call.args, "--disallowedTools")).toBe(GUARD);
    // In Auto as you the shell runs without asking, and a tool off that list is put to the card rather than refused.
    const auto = adapter.twoWay!.launch(paths, NO_MCP, { mode: "auto", personal: true });
    expect(flag(auto.call.args, "--allowedTools")).toBe("Read,Edit,Write,Glob,Grep,Bash");
    expect([flag(auto.call.args, "--permission-mode"), flag(auto.call.args, "--permission-prompt-tool")]).toEqual(["default", "stdio"]);
    expect(auto.codec.decode(init("default")).filter((e) => e.type === "notice")).toEqual([]);
    expect(["Bash", "WebFetch"].map((tool) => auto.codec.decode(question(tool))[0])).toEqual([expect.objectContaining({ type: "request" }), expect.objectContaining({ type: "request" })]);
    expect(flag(auto.call.args, "--disallowedTools")).toBe(GUARD);
  });

  it("given any start as you, when its settings are read, then it runs restricted, reading none of your settings, hooks, CLAUDE.md, skills or MCP servers, and never the checkout's .mcp.json", () => {
    // Restricted mode is an empty --setting-sources and more: the project source being off keeps a checkout's .mcp.json unread.
    const starts = [
      adapter.invocation(paths, { title: "t", prompt: "p" }, NO_MCP, true).args,
      ...(["approval-required", "auto-accept-edits", "auto", "full-access"] as const).map((mode) => adapter.twoWay!.launch(paths, NO_MCP, { mode, personal: true }).call.args),
    ];
    for (const args of starts) {
      expect(args.filter((a) => a === "--restricted")).toHaveLength(1);
      expect(args).toContain("--strict-mcp-config");
      expect(args).not.toContain("--setting-sources");
    }
  });

  it("given a run as you with the person's own setup, in a folder they opened and in a clone, when each start is built, then none runs restricted, the folder loads its own settings and the clone the user's alone, and every one names its mode, the guard layer and the team's skills", () => {
    // given
    const skills = [{ slug: "on-call", files: [{ path: "SKILL.md", content: "---\nname: on-call\ndescription: d\n---\n" }] }];
    const folder: AgentSetup = { ...NO_MCP, skills, personal: { ownSetup: true, folderSettings: true } };
    const clone: AgentSetup = { ...folder, personal: { ownSetup: true, folderSettings: false } };

    // when
    const starts = (setup: AgentSetup) => [
      adapter.invocation(paths, { title: "t", prompt: "p" }, setup, true).args,
      ...(["approval-required", "auto-accept-edits", "auto", "full-access"] as const).map((mode) => adapter.twoWay!.launch(paths, setup, { mode, personal: true }).call.args),
    ];

    // then
    for (const [setup, sources] of [[folder, "user,project,local"], [clone, "user"]] as const) {
      for (const args of starts(setup)) {
        expect(args).not.toContain("--restricted");
        expect(args).not.toContain("--strict-mcp-config");
        expect(flag(args, "--setting-sources")).toBe(sources);
        expect(flag(args, "--settings")).toBe(`${paths.root}/guard/personal-settings.json`);
        expect(flag(args, "--plugin-dir")).toBe(teamSkillsDir(paths));
        expect(["default", "acceptEdits", "dontAsk"]).toContain(flag(args, "--permission-mode"));
      }
    }
    expect(flag(adapter.invocation(paths, { title: "t", prompt: "p" }, clone, true).args, "--permission-mode")).toBe("dontAsk");
  });

  it("given a policy that keeps the person's own setup out, when a run as you starts, then it takes the sign-in alone in restricted mode with none of their MCP servers, and still the team's skills", () => {
    // given
    const setup: AgentSetup = { ...NO_MCP, skills: [{ slug: "on-call", files: [] }], personal: { ownSetup: false, folderSettings: true } };

    // when
    const args = adapter.twoWay!.launch(paths, setup, { mode: "approval-required", personal: true }).call.args;

    // then
    expect(args).toEqual(expect.arrayContaining(["--restricted", "--strict-mcp-config"]));
    expect(args).not.toContain("--setting-sources");
    expect(flag(args, "--plugin-dir")).toBe(teamSkillsDir(paths));
  });

  it("given the orchestrator's own server for a run as you, when it starts, then the server comes from the guard's file with its token there and in no argument or environment variable, and its tools run by name", () => {
    // given
    const setup: AgentSetup = { ...NO_MCP, orchestrator: { url: "http://127.0.0.1:1/mcp", bearer: "th_task_stand-in-token", tools: ["start_task"] }, personal: { ownSetup: true, folderSettings: false } };

    // when
    const call = adapter.invocation(paths, { title: "t", prompt: "p" }, setup, true);
    const mcp = personalMcp(setup);

    // then
    expect(flag(call.args, "--mcp-config")).toBe(`${paths.root}/guard/mcp.json`);
    expect(flag(call.args, "--allowedTools")!.split(",")).toContain("mcp__th-orchestrator__start_task");
    expect(JSON.stringify([call.args, call.env ?? {}])).not.toContain("th_task_stand-in-token");
    expect(mcp).toEqual({ "th-orchestrator": { type: "http", url: "http://127.0.0.1:1/mcp", headers: { Authorization: "Bearer th_task_stand-in-token" } } });
  });

  it("given a project server approved on the card, when a run as you starts, then it is the only server added, from the task's file, and with none no file is named", async () => {
    // given
    const root = mkdtempSync(join(tmpdir(), "orchestrator-approved-mcp-"));
    const home = taskPaths(root, "t", "0123456789ab");
    mkdirSync(home.home, { recursive: true });
    const approved: AgentSetup = { ...NO_MCP, approvedProjectMcp: { lint: { command: "node", args: ["lint-server.mjs"] } } };

    // when
    await writeApprovedProjectMcp(home, approved);
    const { call } = adapter.twoWay!.launch(home, approved, { mode: "approval-required", personal: true });
    const plain = adapter.twoWay!.launch(home, NO_MCP, { mode: "approval-required", personal: true }).call;

    // then
    expect(flag(call.args, "--mcp-config")).toBe(approvedProjectMcpFile(home));
    expect(call.args).toContain("--strict-mcp-config");
    expect(JSON.parse(readFileSync(approvedProjectMcpFile(home), "utf8"))).toEqual({ mcpServers: approved.approvedProjectMcp });
    expect(statSync(approvedProjectMcpFile(home)).mode & 0o777).toBe(0o600);
    expect(adapter.invocation(home, { title: "t", prompt: "p" }, approved, true).args).toContain(approvedProjectMcpFile(home));
    expect(plain.args).not.toContain("--mcp-config");
    rmSync(root, { recursive: true, force: true });
  });

  it("given an approval bound to the definition the card showed, when the checkout's definition changed or the server is gone, then it stays off and is named", () => {
    // given
    const shown = { command: "node", args: ["lint-server.mjs"] };
    const approvals = { lint: projectServerHash(shown), docs: projectServerHash({ url: "https://docs.example.com/mcp" }), gone: projectServerHash({ command: "x" }) };

    // when
    const result = approvedProjectServers(approvals, { lint: { args: ["lint-server.mjs"], command: "node" }, docs: { url: "https://attacker.example.com/mcp" } });

    // then
    expect(result.servers).toEqual({ lint: { args: ["lint-server.mjs"], command: "node" } });
    expect(result.changed).toEqual(["docs", "gone"]);
  });

  it("given full access as you, when it is started, then it runs as Auto, asking about a tool off its list as Auto as you does, and says why", () => {
    const { mode, notes, call } = adapter.twoWay!.launch(paths, NO_MCP, { mode: "full-access", personal: true });
    expect(mode).toBe("auto");
    expect(flag(call.args, "--permission-mode")).toBe("default");
    expect(notes).toEqual(["Full access runs as Auto when the agent runs as you: it would let every tool of your MCP servers run without a question."]);
  });

  it("given a question about one of your own MCP tools, when it arrives as you, then you are asked, and with the task's profile it is refused", () => {
    const yours = adapter.twoWay!.launch(paths, NO_MCP, { mode: "approval-required", personal: true }).codec.decode(question("mcp__tracker__getIssue"));
    const task = adapter.twoWay!.launch(paths, NO_MCP, { mode: "approval-required" }).codec.decode(question("mcp__tracker__getIssue"));
    expect(yours).toEqual([{ type: "request", request: { id: "r1", kind: "mcp", tool: "mcp__tracker__getIssue", summary: "mcp__tracker__getIssue" } }]);
    expect(task).toEqual([{ type: "tool_call", id: "toolu-1", tool: "mcp__tracker__getIssue", target: "mcp__tracker__getIssue", mcp: { server: "tracker", tool: "getIssue" }, status: "refused", refusal: { kind: "not-allowed", reason: "This task does not allow this tool." } }]);
  });
});

describe("why a Claude Code turn failed", () => {
  const soon = Math.floor(Date.now() / 1000) + 3600;
  const failedResult = (over: Record<string, unknown>) => JSON.stringify({ type: "result", subtype: "success", is_error: true, num_turns: 1, result: "You've hit your limit", ...over });
  const run = (lines: string[], exit: number | null = 1) => {
    const decoder = claudeCodeDecoder();
    const events = lines.flatMap((l) => decoder.decode(l));
    return { events, terminal: decoder.finish(exit) };
  };

  it("given a refused rate-limit event and a 429, when the turn ends, then it is a usage limit that resumes at the reported reset", () => {
    // when
    const { terminal } = run([JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: soon, rateLimitType: "five_hour" } }), failedResult({ api_error_status: 429, terminal_reason: "api_error" })]);

    // then
    expect(terminal.failure).toEqual({ class: "usage_limit", message: "Claude Code reached its usage limit.", retryable: true, code: "HTTP 429", resetAt: new Date(soon * 1000).toISOString(), detail: "You've hit your limit" });
  });

  it("given a rate-limit event during a turn that goes well, when it ends, then nothing failed", () => {
    const { events, terminal } = run([JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", resetsAt: soon } }), result(0.25, 1)], 0);
    expect(terminal.status).toBe("completed");
    expect(terminal.failure).toBeUndefined();
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("given Claude Code's own limit reason without a status, when the turn ends, then it is a usage limit with no reset it did not report", () => {
    expect(run([failedResult({ terminal_reason: "blocking_limit" })]).terminal.failure).toMatchObject({ class: "usage_limit", code: "blocking_limit" });
    expect(run([failedResult({ terminal_reason: "blocking_limit" })]).terminal.failure).not.toHaveProperty("resetAt");
  });

  it("given a refused sign-in, when the turn ends, then the person is asked to sign in again and trying again alone does not help", () => {
    const { terminal } = run([JSON.stringify({ type: "assistant", error: "authentication_failed", message: { content: [{ type: "text", text: "Not logged in" }] } }), failedResult({ result: "Not logged in" })]);
    expect(terminal.failure).toMatchObject({ class: "sign_in", retryable: false });
  });

  it("given the provider overloaded, when Claude Code retries and then gives up, then the retries are not terminal and the turn is a provider failure worth trying later", () => {
    const { events, terminal } = run([JSON.stringify({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: 529 }), failedResult({ api_error_status: 529 })]);
    expect(events[0]).toEqual({ type: "error", failure: { class: "provider_retrying", message: "The model provider is having trouble (HTTP 529), and Claude Code is trying again on its own.", retryable: true, code: "HTTP 529" } });
    expect(terminal.failure).toMatchObject({ class: "provider", code: "HTTP 529", retryable: true });
  });

  it("given an interrupted turn, when it ends, then it is interrupted and nothing failed", () => {
    const { events, terminal } = run([JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_tools", result: "" })], 0);
    expect(terminal.status).toBe("interrupted");
    expect(terminal.failure).toBeUndefined();
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("given a process that ends with no result, when it ends, then it is a transport failure, and the agent's own failure has no class", () => {
    expect(run([init("dontAsk")]).terminal.failure).toMatchObject({ class: "transport", code: "exit 1" });
    expect(run([failedResult({ subtype: "error_max_turns", result: "" })]).terminal.failure).toBeUndefined();
  });

  it("given a reset in milliseconds, in the past or past a month, when it is read, then it is dropped rather than guessed", () => {
    const now = Date.UTC(2026, 10, 2);
    expect(resetAtFrom(now / 1000 + 60, now)).toBe(new Date(now + 60_000).toISOString());
    expect(resetAtFrom(now + 60_000, now)).toBeUndefined();
    expect(resetAtFrom(now / 1000 - 60, now)).toBeUndefined();
    expect(resetAtFrom(now / 1000 + 40 * 86_400, now)).toBeUndefined();
    expect(resetAtFrom("1793577600", now)).toBeUndefined();
  });
});

describe("the committed end-to-end failures of Claude Code", () => {
  afterEach(() => vi.useRealTimers());
  const stdoutOf = (name: string) => {
    const t = readTranscript(join(import.meta.dirname, "transcripts", `${name}.ndjson`));
    return { exit: t.exit, stdout: t.steps.flatMap((s) => ("emit_inbound" in s ? [JSON.stringify(s.emit_inbound)] : [])).join("\n") };
  };

  it("given the usage-limit run, when the runner reads its report, then the task fails as a usage limit that resumes at the refused event's reset", () => {
    // given
    vi.useFakeTimers({ now: new Date("2026-11-02T12:00:00Z") });
    const { stdout, exit } = stdoutOf("claude-code-usage-limit");

    // when
    const report = claudeCodeAdapter("claude").report(stdout, exit);

    // then
    expect(report.ok).toBe(false);
    expect(report.failure).toMatchObject({ class: "usage_limit", code: "HTTP 429", retryable: true, resetAt: "2026-11-03T03:00:00.000Z" });
  });

  it("given the signed-out run, when the runner reads its report, then the task fails as a sign-in the person has to renew", () => {
    const { stdout, exit } = stdoutOf("claude-code-sign-in");
    expect(claudeCodeAdapter("claude").report(stdout, exit).failure).toMatchObject({ class: "sign_in", retryable: false, code: "authentication_failed" });
  });
});

describe("the model and effort a task chooses", () => {
  const adapter = claudeCodeAdapter("claude");
  const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];

  it("given Claude Code, when its options are read, then it offers its model aliases and effort levels, and the two-way session offers the same", () => {
    expect(adapter.capabilities.options.map((o) => [o.id, o.choices.map((c) => c.value)])).toEqual([
      ["model", ["fable", "opus", "sonnet"]],
      ["effort", ["low", "medium", "high", "xhigh", "max"]],
    ]);
    expect(adapter.twoWay!.capabilities.options).toBe(adapter.capabilities.options);
  });

  it("given a task that chose Opus at extra high effort, when it starts one-shot or two-way, then both flags reach Claude Code", () => {
    const choices = { model: "opus", effort: "xhigh" } as const;
    for (const args of [adapter.invocation(paths, { title: "t", prompt: "p", choices }, NO_MCP).args, adapter.twoWay!.launch(paths, NO_MCP, { mode: "auto", choices }).call.args]) {
      expect(flag(args, "--model")).toBe("opus");
      expect(flag(args, "--effort")).toBe("xhigh");
    }
    expect(adapter.invocation(paths, { title: "t", prompt: "p" }, NO_MCP).args).not.toContain("--model");
  });

  it("given a value the agent does not offer, or a choice for an agent with no options, when it starts, then the start is refused rather than run on a default", () => {
    expect(() => adapter.invocation(paths, { title: "t", prompt: "p", choices: { model: "gpt-5" } }, NO_MCP)).toThrow(/offers no model "gpt-5"/);
    expect(() => adapter.twoWay!.launch(paths, NO_MCP, { mode: "auto", choices: { effort: "ultra" } })).toThrow(/offers no effort "ultra"/);
    expect(() => fakeAgentAdapter("fake.mjs").invocation(paths, { title: "t", prompt: "p", choices: { model: "opus" } }, NO_MCP)).toThrow(/offers no model choice/);
  });
});

describe("the orchestrator's instructions and a resumed session", () => {
  const adapter = claudeCodeAdapter("claude");
  const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];
  const SYSTEM = "You may delegate a part of this task with delegate_task.";

  it("given the orchestrator's instructions, when Claude Code starts one-shot or two-way, then they go in as an appended system prompt and the person's prompt stays apart", () => {
    const oneShot = adapter.invocation(paths, { title: "t", prompt: "Fix the build.", system: SYSTEM }, NO_MCP);
    expect(flag(oneShot.args, "--append-system-prompt")).toBe(SYSTEM);
    expect(oneShot.stdin).toBe("Fix the build.");
    expect(flag(adapter.twoWay!.launch(paths, NO_MCP, { mode: "auto", system: SYSTEM }).call.args, "--append-system-prompt")).toBe(SYSTEM);
  });

  it("given an agent with no place for them, when it starts, then the instructions come before the prompt", () => {
    expect(fakeAgentAdapter("fake.mjs").invocation(paths, { title: "t", prompt: "Fix the build.", system: SYSTEM }, NO_MCP).stdin).toBe(`${SYSTEM}\n\nFix the build.`);
  });

  it("given a session kept for later, when it is resumed by the agent's own id, then the session is kept and continued, and by default nothing is kept", () => {
    const kept = adapter.twoWay!.launch(paths, NO_MCP, { mode: "auto", persist: true }).call.args;
    const resumed = adapter.twoWay!.launch(paths, NO_MCP, { mode: "auto", resume: "6f1c2b9e-0d4a-4c1e-9a7b-2f3e4d5c6b7a" }).call.args;
    expect(kept).not.toContain("--no-session-persistence");
    expect(flag(resumed, "--resume")).toBe("6f1c2b9e-0d4a-4c1e-9a7b-2f3e4d5c6b7a");
    expect(resumed).not.toContain("--no-session-persistence");
    expect(adapter.twoWay!.launch(paths, NO_MCP, { mode: "auto" }).call.args).toContain("--no-session-persistence");
  });

  it("given a resume id that is not a plain id, or an agent that cannot resume, when it starts, then the start is refused", () => {
    expect(() => adapter.twoWay!.launch(paths, NO_MCP, { mode: "auto", resume: "--dangerously-skip-permissions" })).toThrow(/cannot be resumed/);
    expect(() => fakeAgentAdapter("fake.mjs").twoWay!.launch(paths, NO_MCP, { mode: "auto", resume: "abc" })).toThrow(/cannot be resumed/);
  });
});

describe("the orchestrator's guard in the task's home", () => {
  const adapter = claudeCodeAdapter("claude");
  const editOf = (file: string) => JSON.stringify({ type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: "Edit", input: { file_path: file }, tool_use_id: "toolu-1" } });

  it("given any start, when its rules are read, then edits anywhere in the task's home are refused by Claude Code itself, asked or not", () => {
    for (const args of [adapter.invocation(paths, { title: "t", prompt: "p" }, NO_MCP).args, adapter.invocation(paths, { title: "t", prompt: "p" }, NO_MCP, true).args, adapter.twoWay!.launch(paths, NO_MCP, { mode: "full-access" }).call.args]) {
      expect(args[args.indexOf("--disallowedTools") + 1]).toContain(`Edit(/${paths.home}/**)`);
      expect(args[args.indexOf("--disallowedTools") + 1]).toContain(`Write(/${paths.home}/**)`);
    }
  });

  it("given a question to edit the guard layer, directly, through a path that walks into the home or through a link above the task's folder, when it arrives, then it is refused and no person is asked, while an edit in the checkout asks", () => {
    for (const personal of [false, true]) {
      const codec = adapter.twoWay!.launch(paths, NO_MCP, { mode: "approval-required", personal }).codec;
      expect(codec.decode(editOf(`${paths.home}/personal-settings.json`))).toEqual([{ type: "tool_call", id: "toolu-1", tool: "Edit", target: `${paths.home}/personal-settings.json`, status: "refused", refusal: { kind: "not-allowed", reason: "This task does not allow this tool." } }]);
      expect(codec.decode(editOf(`${paths.work}/../home/personal-guard.mjs`))[0]).toMatchObject({ type: "tool_call", status: "refused" });
      expect(codec.decode(editOf(`/private${paths.home}/personal-settings.json`))[0]).toMatchObject({ type: "tool_call", status: "refused" });
      expect(codec.decode(editOf(`${paths.work}/README.md`))[0]).toMatchObject({ type: "request" });
    }
  });
});

describe("the account's usage windows", () => {
  const limit = (info: Record<string, unknown>) => claudeCodeDecoder().decode(JSON.stringify({ type: "rate_limit_event", rate_limit_info: info }));

  it("given a warning on the five-hour window, when it arrives, then the window's state and reset cross and how full it is does not", () => {
    // given
    const soon = Math.floor(Date.now() / 1000) + 1800;

    // when
    const events = limit({ status: "allowed_warning", resetsAt: soon, rateLimitType: "five_hour", utilization: 0.92, overageStatus: "allowed" });

    // then
    expect(events).toEqual([{ type: "limit", window: "five_hour", status: "warning", resetAt: new Date(soon * 1000).toISOString() }]);
  });

  it("given a window or a status Claude Code does not name, when it arrives, then nothing crosses", () => {
    expect(limit({ status: "rejected", rateLimitType: "per_minute" })).toEqual([]);
    expect(limit({ status: "paused", rateLimitType: "five_hour" })).toEqual([]);
  });
});

describe("the manifest of what the orchestrator checked", () => {
  it("given the manifest, when the adapters are built, then their probes and options come from it, and the recorded two-way run is of the version it names", async () => {
    const { MANIFEST } = await import("./manifest.js");
    const claude = claudeCodeAdapter("claude");
    expect(claude.probe).toMatchObject({ checkedVersion: MANIFEST["claude-code"].checkedVersion, twoWayVersion: MANIFEST["claude-code"].twoWayVersion });
    expect(claude.capabilities.options).toBe(MANIFEST["claude-code"].options);
    expect(readTranscript(join(import.meta.dirname, "transcripts", "claude-code-approval.ndjson")).cliVersion).toBe(MANIFEST["claude-code"].twoWayVersion);
  });
});

describe("a session id the runner chooses", () => {
  const adapter = claudeCodeAdapter("claude");
  const ID = "0b6f8e2a-4c1d-4e7a-9f3b-5a2c8d1e6f40";

  it("given a UUID chosen before the start, when a session starts with it, then Claude Code keeps the session under that id", () => {
    const args = adapter.twoWay!.launch(paths, NO_MCP, { mode: "auto", sessionId: ID }).call.args;
    expect(args[args.indexOf("--session-id") + 1]).toBe(ID);
    expect(args).not.toContain("--no-session-persistence");
  });

  it("given an id that is not a UUID, one with a resume, or an agent that cannot resume, when it starts, then the start is refused", () => {
    expect(() => adapter.twoWay!.launch(paths, NO_MCP, { mode: "auto", sessionId: "--model=opus" })).toThrow(/UUID/);
    expect(() => adapter.twoWay!.launch(paths, NO_MCP, { mode: "auto", sessionId: ID, resume: ID })).toThrow(/UUID/);
    expect(() => fakeAgentAdapter("fake.mjs").twoWay!.launch(paths, NO_MCP, { mode: "auto", sessionId: ID })).toThrow(/UUID/);
  });
});

describe("work the agent leaves running in the background", () => {
  const system = (frame: Record<string, unknown>) => JSON.stringify({ type: "system", session_id: "session-1", ...frame });

  it("given a task started in the background and one in the foreground, when they start and end, then only the background one counts, until its notification says it ended", () => {
    // given
    const decoder = claudeCodeDecoder();

    // when
    const steps = [
      decoder.decode(system({ subtype: "task_started", task_id: "t1", description: "watch the build", is_backgrounded: true })),
      decoder.decode(system({ subtype: "task_started", task_id: "t2", description: "read a file", is_backgrounded: false })),
      decoder.decode(system({ subtype: "task_notification", task_id: "t2", status: "completed", output_file: "o", summary: "s" })),
      decoder.decode(system({ subtype: "task_notification", task_id: "t1", status: "completed", output_file: "o", summary: "s" })),
      decoder.decode(system({ subtype: "task_notification", task_id: "t9", status: "stopped", output_file: "o", summary: "s" })),
    ];

    // then
    expect(steps).toEqual([[{ type: "background", pending: 1 }], [], [], [{ type: "background", pending: 0 }], []]);
  });
});

describe("the live view of a Claude Code run", () => {
  const work = "/data/tasks/t/0123456789ab/work";

  it("given the recorded run that kept a to-do list, wrote a file and edited it, when it is replayed, then the plan moves step by step to done, both changes are named inside the folder with their lines, and the only calls shown are the write and the edit, each ending by its id, with no line for the agent's own list or tool search", async () => {
    // given
    const recorded = readTranscript(join(import.meta.dirname, "transcripts", "claude-code-live.ndjson"));
    const opening = recorded.steps[0] as { stdin: { message: { content: string } } };
    const session = openSession(claudeCodeCodec("auto-accept-edits", (tool) => FILE_TOOLS.has(tool), "/checkout"), replayTransport(recorded));

    // when
    session.sendTurn(opening.stdin.message.content);
    const events: AgentEvent[] = [];
    for await (const e of session.events) {
      events.push(e);
      if (e.type === "turn_finished") session.close();
    }

    // then
    const plans = events.flatMap((e) => (e.type === "todos" ? [e.items.map((i) => `${i.text}: ${i.state}`).join(", ")] : []));
    expect(plans.at(0)).toBe("Write the note: todo");
    expect(plans.at(-1)).toBe("Write the note: done, Change the note: done");
    expect(events.filter((e) => e.type === "edit").map((e) => e.type === "edit" && [e.path, e.additions, e.deletions])).toEqual([["notes.md", 3, 0], ["notes.md", 1, 1]]);
    const calls = events.filter((e) => e.type === "tool_call");
    expect(calls.map((e) => e.type === "tool_call" && `${e.tool} ${e.target} ${e.status}`)).toEqual(["Write notes.md started", "Write notes.md done", "Edit notes.md started", "Edit notes.md done"]);
    expect(events.at(-1)).toMatchObject({ type: "terminal", status: "completed" });
  });
  const use = (id: string, name: string, input: Record<string, unknown>) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
  const ended = (id: string, toolUseResult: unknown, isError = false, content: unknown = "") =>
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] }, tool_use_result: toolUseResult });
  const decodeAll = (decoder: { decode(line: string): AgentEvent[] }, lines: string[]) => lines.flatMap((l) => decoder.decode(l));

  it("given a shell call and its result, when they are decoded, then the call starts with its command, ends done by its id, and its output comes as whole lines without colour codes", () => {
    // given
    const decoder = claudeCodeDecoder(null, work);

    // when
    const events = decodeAll(decoder, [use("toolu_1", "Bash", { command: "npm test" }), ended("toolu_1", { stdout: "\x1b[32mok\x1b[0m 3 tests\npassed\n", stderr: "", interrupted: false })]);

    // then
    expect(events).toEqual([
      { type: "tool_call", id: "toolu_1", tool: "Bash", target: null, command: "npm test", status: "started" },
      { type: "tool_call", id: "toolu_1", tool: "Bash", target: null, command: "npm test", status: "done" },
      { type: "tool_output", id: "toolu_1", lines: ["ok 3 tests", "passed"] },
    ]);
  });

  it("given an edit and a new file the agent wrote in the task's folder, when their results come, then each is a change named inside the folder with its lines counted from the patch", () => {
    // given
    const decoder = claudeCodeDecoder(null, work);
    const hunk = { oldStart: 3, oldLines: 2, newStart: 3, newLines: 3, lines: [" keep", "-old line", "+new line", "+another"] };

    // when
    const events = decodeAll(decoder, [
      use("toolu_1", "Edit", { file_path: `/private${work}/docs/runbook.md`, old_string: "old line", new_string: "new line\nanother" }),
      ended("toolu_1", { filePath: `/private${work}/docs/runbook.md`, structuredPatch: [hunk] }),
      use("toolu_2", "Write", { file_path: `${work}/notes.md`, content: "a\nb\n" }),
      ended("toolu_2", { type: "create", filePath: `${work}/notes.md`, content: "a\nb\n", structuredPatch: [] }),
    ]).filter((e) => e.type === "edit");

    // then
    expect(events).toEqual([
      { type: "edit", id: "toolu_1", path: "docs/runbook.md", additions: 2, deletions: 1, patch: "@@ -3,2 +3,3 @@\n keep\n-old line\n+new line\n+another" },
      { type: "edit", id: "toolu_2", path: "notes.md", additions: 2, deletions: 0, patch: "+a\n+b" },
    ]);
  });

  it("given an edit that failed, one outside the task's folder and one with no folder known, when their results come, then none is a change", () => {
    // given
    const inside = claudeCodeDecoder(null, work);
    const patch = { filePath: `${work}/a.ts`, structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] }] };

    // when
    const failed = decodeAll(inside, [use("toolu_1", "Edit", { file_path: `${work}/a.ts`, old_string: "a", new_string: "b" }), ended("toolu_1", "Error: String to replace not found in file.", true)]);
    const outside = decodeAll(inside, [use("toolu_2", "Edit", { file_path: "/etc/hosts" }), ended("toolu_2", { ...patch, filePath: "/etc/hosts" })]);
    const above = decodeAll(inside, [use("toolu_3", "Edit", { file_path: `${work}/../home/settings.json` }), ended("toolu_3", { ...patch, filePath: `${work}/../home/settings.json` })]);
    const unknown = decodeAll(claudeCodeDecoder(), [use("toolu_4", "Edit", { file_path: `${work}/a.ts` }), ended("toolu_4", patch)]);

    // then
    expect(failed.map((e) => e.type === "tool_call" && e.status)).toEqual(["started", "failed"]);
    for (const events of [failed, outside, above, unknown]) expect(events.some((e) => e.type === "edit")).toBe(false);
  });

  it("given an edit whose result frame carries no output of its own, when it ends, then its input says what changed, and a write's input says nothing", () => {
    // given
    const decoder = claudeCodeDecoder(null, work);
    const two = JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }, { type: "tool_result", tool_use_id: "toolu_2", content: "ok" }] }, tool_use_result: { filePath: "x" } });

    // when
    const events = decodeAll(decoder, [use("toolu_1", "Edit", { file_path: `${work}/a.ts`, old_string: "a", new_string: "b\nc" }), use("toolu_2", "Write", { file_path: `${work}/b.ts`, content: "x" }), two]);

    // then
    expect(events.filter((e) => e.type === "edit")).toEqual([{ type: "edit", id: "toolu_1", path: "a.ts", additions: 2, deletions: 1, patch: "-a\n+b\n+c" }]);
  });

  it("given the agent's to-do list, when it writes it, then the whole list comes in the live view's states, an item in no known state is left out and at most thirty are kept", () => {
    // given
    const todos = [
      { content: "Read the code", status: "completed", activeForm: "Reading the code" },
      { content: "Write the runbook", status: "in_progress", activeForm: "Writing the runbook" },
      { content: "Open the request", status: "pending", activeForm: "Opening the request" },
      { content: "Something else", status: "blocked", activeForm: "x" },
    ];

    // when
    const events = claudeCodeDecoder().decode(use("toolu_1", "TodoWrite", { todos }));
    const many = claudeCodeDecoder().decode(use("toolu_2", "TodoWrite", { todos: Array.from({ length: 40 }, (_, i) => ({ content: `step ${i}`, status: "pending" })) }));

    // then
    expect(events.find((e) => e.type === "todos")).toEqual({
      type: "todos",
      items: [
        { text: "Read the code", state: "done" },
        { text: "Write the runbook", state: "doing" },
        { text: "Open the request", state: "todo" },
      ],
    });
    expect(many.find((e) => e.type === "todos")).toMatchObject({ items: expect.any(Array) });
    expect((many.find((e) => e.type === "todos") as Extract<AgentEvent, { type: "todos" }>).items).toHaveLength(30);
  });

  it("given the agent keeping its list as tasks, when it creates two, starts one and deletes the other, then each change sends the whole list", () => {
    // given
    const decoder = claudeCodeDecoder();

    // when
    const lists = decodeAll(decoder, [
      use("toolu_1", "TaskCreate", { subject: "Read the code", description: "d" }),
      ended("toolu_1", { task: { id: "1", subject: "Read the code" } }),
      use("toolu_2", "TaskCreate", { subject: "Write the runbook", description: "d" }),
      ended("toolu_2", { task: { id: "2", subject: "Write the runbook" } }),
      use("toolu_3", "TaskUpdate", { taskId: "1", status: "in_progress" }),
      ended("toolu_3", { success: true, taskId: "1", updatedFields: ["status"] }),
      use("toolu_4", "TaskUpdate", { taskId: "2", status: "deleted" }),
      ended("toolu_4", { success: true, taskId: "2", updatedFields: ["status"] }),
    ]).flatMap((e) => (e.type === "todos" ? [e.items] : []));

    // then
    expect(lists).toEqual([
      [{ text: "Read the code", state: "todo" }],
      [{ text: "Read the code", state: "todo" }, { text: "Write the runbook", state: "todo" }],
      [{ text: "Read the code", state: "doing" }, { text: "Write the runbook", state: "todo" }],
      [{ text: "Read the code", state: "doing" }],
    ]);
  });

  it("given a call Claude Code refuses on its own, when it says so at once, then the call is refused then and there, its error result does not turn it into a failure, and the turn's list does not count it twice", () => {
    // given
    const decoder = claudeCodeDecoder(null, work);
    const deniedAt = JSON.stringify({ type: "system", subtype: "permission_denied", tool_name: "mcp__tracker__getIssue", tool_use_id: "toolu_1", decision_reason_type: "rule", message: "Permission to use mcp__tracker__getIssue has been denied." });
    const end = JSON.stringify({ ...JSON.parse(result(0.1, 5)), permission_denials: [{ tool_name: "mcp__tracker__getIssue", tool_use_id: "toolu_1", tool_input: { issueKey: "OPS-1" } }] });

    // when
    const events = decodeAll(decoder, [use("toolu_1", "mcp__tracker__getIssue", { issueKey: "OPS-1" }), deniedAt, ended("toolu_1", "Error: denied", true, "Permission to use mcp__tracker__getIssue has been denied."), end]);

    // then
    expect(events.filter((e) => e.type === "tool_call").map((e) => e.type === "tool_call" && `${e.id} ${e.status}`)).toEqual(["toolu_1 started", "toolu_1 refused"]);
    expect(foldRun(events, decoder.finish(0)).denied).toEqual([{ tool: "mcp__tracker__getIssue", target: null }]);
  });

  it("given calls Claude Code refuses on its own for a tracker's write, a forge's write, a deny rule and its mode, when it says so, then each refusal names its kind in the orchestrator's words and never the agent's", () => {
    // given
    const deniedAs = (id: string, type: string, reason: string) => JSON.stringify({ type: "system", subtype: "permission_denied", tool_name: "mcp__tracker__createIssue", tool_use_id: id, decision_reason_type: type, decision_reason: reason, message: "agent-facing words" });
    const decoder = claudeCodeDecoder(null, work);

    // when
    const refusals = [
      deniedAs("toolu_1", "hook", TRACKER_REASON),
      deniedAs("toolu_2", "hook", FORGE_REASON),
      deniedAs("toolu_3", "rule", "Permission rule Read(/data/**) denies it"),
      deniedAs("toolu_4", "mode", "running in don't ask mode"),
    ].flatMap((line) => decoder.decode(line)).map((e) => e.type === "tool_call" && e.refusal);

    // then
    expect(refusals.map((r) => r && r.kind)).toEqual(["tracker-write", "forge-write", "data-folder", "not-allowed"]);
    expect(refusals.slice(0, 2).map((r) => r && r.reason)).toEqual([TRACKER_REASON, FORGE_REASON]);
    expect(JSON.stringify(refusals)).not.toContain("agent-facing words");
  });

  it("given a call refused in Auto and one refused without a question in a mode that asks, when their ends come, then each is refused by its own id and stays refused", () => {
    // given
    const decoder = claudeCodeDecoder(null, work);
    const codec = claudeCodeCodec("approval-required", () => false, work);
    const denial = JSON.stringify({ ...JSON.parse(result(0.1, 5)), permission_denials: [{ tool_name: "Edit", tool_use_id: "toolu_1", tool_input: { file_path: `${work}/a.ts` } }] });
    const asks = JSON.stringify({ type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: "Edit", input: { file_path: `${work}/b.ts` }, tool_use_id: "toolu_2" } });

    // when
    const auto = decodeAll(decoder, [use("toolu_1", "Edit", { file_path: `${work}/a.ts` }), ended("toolu_1", "Error: denied", true), denial]).filter((e) => e.type === "tool_call");
    const asked = decodeAll(codec, [use("toolu_2", "Edit", { file_path: `${work}/b.ts` }), asks, ended("toolu_2", "Error: This task does not allow this tool.", true)]).filter((e) => e.type === "tool_call");

    // then
    expect(auto.map((e) => e.type === "tool_call" && `${e.id} ${e.status}`)).toEqual(["toolu_1 started", "toolu_1 failed", "toolu_1 refused"]);
    expect(asked.map((e) => e.type === "tool_call" && `${e.id} ${e.status}`)).toEqual(["toolu_2 started", "toolu_2 refused"]);
  });

  it("given calls on files inside and outside the task's folder, when they start and when one asks, then the live view and the card name the inside ones by their place in the folder and the others as the agent named them", () => {
    // given
    const codec = claudeCodeCodec("approval-required", (tool) => tool === "Write", work);
    const asks = JSON.stringify({ type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: "Write", input: { file_path: `${work}/docs/runbook.md` }, tool_use_id: "toolu_3" } });

    // when
    const inside = decodeAll(codec, [use("toolu_1", "Read", { file_path: `/private${work}/src/deliver.ts` })]);
    const outside = decodeAll(codec, [use("toolu_2", "Read", { file_path: "/etc/hosts" })]);
    const card = codec.decode(asks);

    // then
    expect(inside[0]).toMatchObject({ type: "tool_call", target: "src/deliver.ts" });
    expect(outside[0]).toMatchObject({ type: "tool_call", target: "/etc/hosts" });
    expect(card).toMatchObject([{ type: "request", request: { summary: "docs/runbook.md" } }]);
  });
});

describe("an MCP call's server and tool, apart", () => {
  it("given calls to a plugin's server, a plain server, a name with a second '__' and a file tool, when they start, then the first two name their server and tool and the others name none", () => {
    // given
    const decoder = claudeCodeDecoder();
    const use = (id: string, name: string) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input: { issueKey: "PAY-412" } }] } });

    // when
    const calls = ["mcp__plugin_team-tools_atlassian__getJiraIssue", "mcp__docs__search", "mcp__a__b__c", "Read"].flatMap((name, at) => decoder.decode(use(`toolu_${at}`, name)));

    // then
    expect(calls.map((e) => e.type === "tool_call" && (e.mcp ?? null))).toEqual([{ server: "atlassian", tool: "getJiraIssue" }, { server: "docs", tool: "search" }, null, null]);
  });
});

describe("MCP servers waiting for a sign-in when a session opens", () => {
  it("given an init frame where two servers need a sign-in and one is connected, when it is decoded, then one notice names the two, a plugin's by its own name, and a session with none waiting says nothing", () => {
    // given
    const opened = (servers: unknown[]) => JSON.stringify({ type: "system", subtype: "init", session_id: "s", mcp_servers: servers });

    // when
    const waiting = claudeCodeDecoder().decode(opened([{ name: "gitlab", status: "needs-auth" }, { name: "plugin_team-tools_notion", status: "needs-auth", source: "plugin" }, { name: "docs", status: "connected" }]));
    const none = claudeCodeDecoder().decode(opened([{ name: "docs", status: "connected" }]));

    // then
    expect(waiting).toEqual([
      { type: "mcp_status", needsSignIn: ["gitlab", "notion"] },
      { type: "notice", text: "gitlab and notion need a sign-in, so their tools are not in this task. Sign them in on this machine, then start the task again." },
    ]);
    expect(none).toEqual([]);
  });
});

describe("the context a Claude Code run starts with", () => {
  it("given replies that each report what their request carried, when they are decoded, then the first one's input, cache written and read included, is the run's context, said once and with no log line", () => {
    // given
    const reply = (input: number, written: number, read: number) => JSON.stringify({ type: "assistant", message: { usage: { input_tokens: input, cache_creation_input_tokens: written, cache_read_input_tokens: read, output_tokens: 5 }, content: [{ type: "text", text: "Reading." }] } });
    const decoder = claudeCodeDecoder();

    // when
    const events = [reply(4, 12_000, 6_400), reply(2, 300, 18_400)].flatMap((line) => decoder.decode(line));

    // then
    expect(events.filter((e) => e.type === "context")).toEqual([{ type: "context", tokens: 18_404 }]);
    expect(logLineOf(claudeCodeDecoder(), reply(4, 12_000, 6_400))).toBe("Reading.");
  });
});

describe("Claude Code's own task list", () => {
  it("given any start, one-shot or two-way, with the task's profile or as you, when it is built, then Claude Code's task list is turned on, which current models keep off", () => {
    const adapter = claudeCodeAdapter("claude");
    const starts = [
      adapter.invocation(paths, { title: "t", prompt: "p" }, NO_MCP).env,
      adapter.invocation(paths, { title: "t", prompt: "p" }, NO_MCP, true).env,
      adapter.twoWay!.launch(paths, NO_MCP, { mode: "auto" }).call.env,
      adapter.twoWay!.launch(paths, NO_MCP, { mode: "approval-required", personal: true }).call.env,
    ];
    for (const env of starts) expect(env?.CLAUDE_CODE_ENABLE_TODO_TOOLS).toBe("true");
  });
});

describe("the agent's own questions to the person", () => {
  const questions = [
    { question: "Which logger should the runbook use?", header: "Logger", options: [{ label: "pino", description: "the one the service uses" }, { label: "winston" }], multiSelect: false },
    { question: "Which sections should change?", header: "Sections", options: [{ label: "Paging" }, { label: "Escalation" }], multiSelect: true },
  ];
  const asks = (input: Record<string, unknown>) => ask("r1", "AskUserQuestion", input);
  const replying = (questionsOn: boolean, transcript: Pick<Transcript, "steps" | "exit">, onEvent: (e: AgentEvent, s: ReturnType<typeof openSession>) => void) =>
    (async () => {
      const transport = replayTransport(transcript);
      const session = openSession(claudeCodeCodec("approval-required", (tool) => FILE_TOOLS.has(tool), undefined, questionsOn), transport);
      const first = transcript.steps[0] as { stdin?: { type?: string; message?: { content?: string } } };
      if (first.stdin?.type === "user") session.sendTurn(first.stdin.message!.content!);
      const events: AgentEvent[] = [];
      for await (const e of session.events) {
        events.push(e);
        onEvent(e, session);
      }
      return { events, transport };
    })();

  it("given AskUserQuestion with questions on, when the person answers, then the card holds each question and its answers reach the agent in its input keyed by the question's text, a choice of several as a list with the person's own words last", async () => {
    // given
    const answers = { "Which logger should the runbook use?": "pino", "Which sections should change?": ["Paging", "and the on-call rota"] };
    const transcript = script(asks({ questions }), answered("r1", { behavior: "allow", updatedInput: { questions, answers } }), done);

    // when
    const { events } = await replying(true, transcript, (e, s) => e.type === "request" && s.reply("r1", { q1: { chosen: ["pino"], other: null }, q2: { chosen: ["Paging"], other: "and the on-call rota" } }));

    // then
    expect(events.find((e) => e.type === "request")).toEqual({
      type: "request",
      request: {
        id: "r1",
        kind: "question",
        tool: "AskUserQuestion",
        summary: "Which logger should the runbook use?",
        questions: [
          { key: "q1", title: "Which logger should the runbook use?", choice: "one", options: [{ value: "pino", label: "pino", description: "the one the service uses" }, { value: "winston", label: "winston" }], other: true },
          { key: "q2", title: "Which sections should change?", choice: "many", options: [{ value: "Paging", label: "Paging" }, { value: "Escalation", label: "Escalation" }], other: true },
        ],
      },
    });
    expect(events.at(-1)).toMatchObject({ type: "terminal", status: "completed" });
  });

  it("given the recorded run where Claude Code asked two questions, when the person answers on the card, then the agent gets exactly the answer it was recorded taking and repeats both back", async () => {
    // given
    const recorded = readTranscript(join(import.meta.dirname, "transcripts", "claude-code-question.ndjson"));
    const opening = recorded.steps[0] as { stdin: { message: { content: string } } };

    // when
    const { events, transport } = await replying(true, recorded, (e, s) => {
      if (e.type === "request") s.reply(e.request.id, { q1: { chosen: ["pino"], other: null }, q2: { chosen: ["Paging"], other: "and the on-call rota" } });
      if (e.type === "turn_finished") s.close();
    });

    // then
    expect(transport.written[0]).toContain(opening.stdin.message.content.slice(0, 40));
    expect(events.find((e) => e.type === "request")).toMatchObject({ request: { kind: "question", questions: [{ choice: "one" }, { choice: "many" }] } });
    expect(events.at(-1)).toMatchObject({ type: "terminal", status: "completed", summary: expect.stringContaining("Paging,and the on-call rota") });
  });

  it("given a question card, when it is allowed without answers, granted for the task or answered in part, then nothing reaches the agent, and a deny turns it down", () => {
    // given
    const codec = claudeCodeCodec("approval-required", () => false, undefined, true);
    codec.decode(JSON.stringify(asks({ questions }).emit_inbound));

    // when
    const allowed = codec.answer("r1", "allow-once");
    const granted = codec.grantKey("r1");
    const half = codec.reply!("r1", { q1: { chosen: ["pino"], other: null } });
    const declined = codec.answer("r1", "deny");

    // then
    expect([allowed, granted, half]).toEqual([null, null, null]);
    expect(JSON.parse(declined!).response.response).toEqual({ behavior: "deny", message: "The person reviewing this task declined this call." });
  });

  it("given questions this page cannot show (a kind other than a choice, five of them, or nine choices), when they arrive, then no person is asked, the agent is told to ask in its reply and the page says where the question went", () => {
    const shapes = [
      { questions: [{ question: "How many replicas?", header: "Replicas", kind: "number", options: [] }] },
      { questions: Array.from({ length: 5 }, (_, i) => ({ question: `Question ${i}?`, header: "Q", options: [{ label: "a" }, { label: "b" }] })) },
      { questions: [{ question: "Which one?", header: "Pick", options: Array.from({ length: 9 }, (_, i) => ({ label: `option ${i}` })) }] },
    ];
    for (const input of shapes) {
      const codec = claudeCodeCodec("approval-required", () => false, undefined, true);
      expect(codec.decode(JSON.stringify(asks(input).emit_inbound))).toEqual([{ type: "notice", text: "The agent asked with a form this page cannot show and stopped at that step; answer it in a follow-up message." }]);
      expect(JSON.parse(codec.pending()[0]!).response.response).toEqual({ behavior: "deny", message: "This question cannot be shown to the person. Ask it in your reply instead." });
    }
  });

  it("given a two-way start, when the runner says it carries answers back, then AskUserQuestion becomes a card, and a start that does not say so, or runs as you on a machine that does not, refuses it as before", () => {
    // given
    const adapter = claudeCodeAdapter("claude");
    const frame = JSON.stringify(asks({ questions }).emit_inbound);
    const started = (options: { personal?: boolean; questions?: boolean }) => adapter.twoWay!.launch(paths, NO_MCP, { mode: "approval-required", ...options }).codec;

    // when
    const carried = started({ questions: true }).decode(frame);
    const silent = started({}).decode(frame);
    const yours = started({ personal: true }).decode(frame);

    // then
    expect(adapter.twoWay!.capabilities.questions).toBe(true);
    expect(carried).toMatchObject([{ type: "request", request: { kind: "question" } }]);
    expect([silent, yours]).toEqual([[expect.objectContaining({ type: "tool_call", status: "refused" })], [expect.objectContaining({ type: "tool_call", status: "refused" })]]);
  });

  it("given questions off, when AskUserQuestion arrives, then it is refused at once as a tool the task does not name, as before", () => {
    const codec = claudeCodeCodec("approval-required", () => false);
    expect(codec.decode(JSON.stringify(asks({ questions }).emit_inbound))).toEqual([{ type: "tool_call", id: "toolu-r1", tool: "AskUserQuestion", target: "AskUserQuestion", status: "refused", refusal: { kind: "not-allowed", reason: "This task does not allow this tool." } }]);
  });
});
