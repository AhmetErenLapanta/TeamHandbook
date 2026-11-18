import { describe, expect, it } from "vitest";

import { claudeCodeDecoder } from "./claude-code.js";
import type { AgentDecoder, AgentEvent } from "./contract.js";
import { MANIFEST } from "./manifest.js";
import { opencodeDecoder, opencodeServeCodec } from "./opencode.js";

const S = "session-1";

/**
 * One piece of work as each agent writes it: the agent loads the skill add-entity-field, and its
 * one request reads 600 tokens plain, 9 000 from the cache and 400 written to it, writes 20 tokens
 * and reasons 10, for $0.05, on a model whose context window is 200 000 tokens.
 */
const CLAUDE = [
  { type: "system", subtype: "init", model: "claude-sonnet-5-5", session_id: S },
  { type: "assistant", parent_tool_use_id: null, message: { id: "msg_1", model: "claude-sonnet-5-5", usage: { input_tokens: 600, cache_read_input_tokens: 9_000, cache_creation_input_tokens: 400, output_tokens: 30 }, content: [{ type: "tool_use", id: "toolu_1", name: "Skill", input: { skill: "add-entity-field" } }] }, session_id: S },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "Loaded." }] }, session_id: S },
  { type: "result", subtype: "success", is_error: false, num_turns: 1, result: "Done.", total_cost_usd: 0.05, usage: { input_tokens: 600, cache_read_input_tokens: 9_000, cache_creation_input_tokens: 400, output_tokens: 30 }, modelUsage: { "claude-sonnet-5-5": { contextWindow: 200_000 } }, session_id: S },
];

const TOKENS = { input: 600, output: 20, reasoning: 10, cache: { read: 9_000, write: 400 } };

const OPENCODE_RUN = [
  { type: "tool_use", part: { type: "tool", tool: "skill", callID: "c1", state: { status: "completed", input: { name: "add-entity-field" }, output: "Loaded." } } },
  { type: "step_finish", part: { type: "step-finish", cost: 0.05, tokens: TOKENS } },
];

const OPENCODE_1 = [
  { type: "message.updated", properties: { info: { sessionID: S, role: "assistant", providerID: "anthropic", modelID: "claude-sonnet-5-5" } } },
  { type: "message.part.updated", properties: { part: { sessionID: S, id: "p1", type: "tool", tool: "skill", callID: "c1", state: { status: "running", input: { name: "add-entity-field" } } } } },
  { type: "message.part.updated", properties: { part: { sessionID: S, id: "p1", type: "tool", tool: "skill", callID: "c1", state: { status: "completed", input: { name: "add-entity-field" }, output: "Loaded." } } } },
  { type: "message.part.updated", properties: { part: { sessionID: S, id: "s1", type: "step-finish", cost: 0.05, tokens: TOKENS } } },
];

const OPENCODE_2 = [
  { type: "session.tool.input.started", data: { sessionID: S, id: "c1", name: "skill" }, created: 1 },
  { type: "session.tool.called", data: { sessionID: S, id: "c1", input: { name: "add-entity-field" } }, created: 2 },
  { type: "session.tool.success", data: { sessionID: S, id: "c1", content: [{ type: "text", text: "Loaded." }], metadata: {} }, created: 3 },
  { type: "session.step.ended", data: { sessionID: S, cost: 0.05, tokens: TOKENS }, created: 4 },
];

/** What the task's page and its records read of a run: the skills loaded, what it spent, its context at the start and in use at the end. */
function record(decoder: AgentDecoder, frames: object[]) {
  const events: AgentEvent[] = frames.flatMap((frame) => decoder.decode(JSON.stringify(frame)));
  const add = (a: number | null, b: number | null) => (a === null || b === null ? null : a + b);
  const spent = events.flatMap((e) => (e.type === "usage" ? [e.cost] : [])).reduce((sum, c) => ({ usd: add(sum.usd, c.usd), inputTokens: add(sum.inputTokens, c.inputTokens), outputTokens: add(sum.outputTokens, c.outputTokens) }), { usd: 0, inputTokens: 0, outputTokens: 0 });
  return {
    skills: events.flatMap((e) => (e.type === "tool_call" && e.status === "started" && e.tool.toLowerCase() === "skill" ? [e.target] : [])),
    spent,
    atStart: events.flatMap((e) => (e.type === "context" ? [e.tokens] : [])),
    inUse: events.filter((e) => e.type === "context_used").at(-1),
  };
}

describe("one piece of work as Claude Code and OpenCode report it", () => {
  it("given the same work in each agent's own frames, when it is decoded, then the skill loaded, the cost with its tokens and the context at the start read the same for both", () => {
    // when
    const claude = record(claudeCodeDecoder(), CLAUDE);
    const opencode = [record(opencodeDecoder(), OPENCODE_RUN), record(opencodeServeCodec(S, 1), OPENCODE_1), record(opencodeServeCodec(S, 2), OPENCODE_2)];

    // then
    expect(claude).toMatchObject({ skills: ["add-entity-field"], spent: { usd: 0.05, inputTokens: 10_000, outputTokens: 30 }, atStart: [10_000] });
    for (const each of opencode) expect({ skills: each.skills, spent: each.spent, atStart: each.atStart }).toEqual({ skills: claude.skills, spent: claude.spent, atStart: claude.atStart });
  });

  it("given the model's window known to each, when the work is decoded, then the context in use reads the same for Claude Code and an OpenCode server given that window", () => {
    // when
    const claude = record(claudeCodeDecoder(), CLAUDE).inUse;
    const opencode = record(opencodeServeCodec(S, 1, undefined, false, [], { "anthropic/claude-sonnet-5-5": 200_000 }), OPENCODE_1).inUse;

    // then
    expect(claude).toEqual({ type: "context_used", tokens: 10_000, window: 200_000 });
    expect(opencode).toEqual(claude);
  });
});

describe("the commands a person is shown for an agent that is not ready", () => {
  it("given each agent's manifest, when its commands are read, then installing, updating and signing in are each one command of that agent's own, over https where it downloads", () => {
    for (const [program, { commands }] of [["claude", MANIFEST["claude-code"]], ["opencode", MANIFEST.opencode]] as const) {
      expect(commands.update.startsWith(`${program} `)).toBe(true);
      expect(commands.signIn.startsWith(`${program} `)).toBe(true);
      expect(commands.install).toMatch(/^curl -fsSL https:\/\/[a-z.]+\/install(\.sh)? \| bash$/);
    }
  });
});
