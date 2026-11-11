import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Principal } from "../auth.js";
import { claudeArgvStandIn, seededContext, storePrincipals } from "../test-fixtures.js";
import { claudeCodeAdapter, fakeAgentAdapter } from "./agents.js";
import type { AgentAdapter } from "./agents.js";
import type { AgentEvent } from "./adapters/contract.js";
import { createTaskRunner } from "./runner.js";

const ADMIN: Principal = { id: "a", name: "Ada Example", email: "ada@example.invalid", role: "admin", ownedTeams: [] };
const TOKEN = "stand-in-registry-token-0123456789";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A task on the seeded Payments repository run by `agent`, with the orchestrator handing tasks NPM_TOKEN; its log once it ends. */
async function ran(agent: (root: string) => AgentAdapter) {
  const { ctx, root } = await seededContext("orchestrator-live-log-", ["payments-skills"]);
  await storePrincipals(ctx, ADMIN);
  dirs.push(root);
  const tasks = createTaskRunner(ctx, { agents: [agent(root)], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH, NPM_TOKEN: TOKEN }, passEnv: ["NPM_TOKEN"] });
  const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;
  const started = await tasks.start({ repo, title: "Note the incident", description: "", agent: agent(root).id, user: ADMIN });
  await tasks.idle();
  return ctx.store.taskLog(ctx.tenant, started.id, 0);
}

describe("the task's log as the page's live view reads it", { timeout: 120_000 }, () => {
  it("given Claude Code whose MCP server waits for a sign-in it cannot finish, when the task runs, then the task keeps that server's name for its page", async () => {
    // given
    const { ctx, root } = await seededContext("orchestrator-live-log-", ["payments-skills"]);
    await storePrincipals(ctx, ADMIN);
    dirs.push(root);
    const bin = join(root, "claude-signin.mjs");
    writeFileSync(bin, `#!${process.execPath}
import { readFileSync } from "node:fs";
readFileSync(0, "utf8");
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "s-1", permissionMode: "dontAsk", mcp_servers: [{ name: "gitlab", status: "needs-auth" }, { name: "docs", status: "connected" }] }));
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "Done.", total_cost_usd: 0 }));
`, { mode: 0o755 });
    const tasks = createTaskRunner(ctx, { agents: [claudeCodeAdapter(bin)], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH } });
    const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;

    // when
    const started = await tasks.start({ repo, title: "Note the incident", description: "", agent: "claude-code", user: ADMIN });
    await tasks.idle();

    // then
    await expect.poll(async () => (await ctx.store.getTask(ctx.tenant, started.id))!.mcpNeedsSignIn).toEqual(["gitlab"]);
  });

  it("given Claude Code whose first request carried 1,200 tokens with what it read from its cache, when the task runs, then the task keeps that context and its log shows no line for it", async () => {
    // given
    const { ctx, root } = await seededContext("orchestrator-live-log-", ["payments-skills"]);
    await storePrincipals(ctx, ADMIN);
    dirs.push(root);
    const bin = join(root, "claude-context.mjs");
    writeFileSync(bin, `#!${process.execPath}
import { readFileSync } from "node:fs";
readFileSync(0, "utf8");
console.log(JSON.stringify({ type: "assistant", message: { content: [], usage: { input_tokens: 200, cache_creation_input_tokens: 600, cache_read_input_tokens: 400 } } }));
console.log(JSON.stringify({ type: "assistant", message: { content: [], usage: { input_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 1300 } } }));
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "Done.", total_cost_usd: 0 }));
`, { mode: 0o755 });
    const tasks = createTaskRunner(ctx, { agents: [claudeCodeAdapter(bin)], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH } });
    const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;

    // when
    const started = await tasks.start({ repo, title: "Note the incident", description: "", agent: "claude-code", user: ADMIN });
    await tasks.idle();

    // then
    await expect.poll(async () => (await ctx.store.getTask(ctx.tenant, started.id))!.context).toEqual({ tokens: 1200 });
    expect((await ctx.store.taskLog(ctx.tenant, started.id, 0)).some((l) => l.kind === "context" || /context/i.test(l.text))).toBe(false);
  });

  it("given an agent that says two things, one quoting a credential the task is handed, when the task runs, then each is a row of its own with its kind and the event, and the credential is masked in both", async () => {
    // when
    const log = await ran((root) => {
      const script = join(root, "agent.mjs");
      writeFileSync(script, `import { writeFileSync } from "node:fs";\nconsole.log(JSON.stringify({ type: "log", text: "Reading the runbook." }));\nconsole.log(JSON.stringify({ type: "log", text: "The registry wants " + process.env.NPM_TOKEN }));\nwriteFileSync("note.md", "x\\n");\nconsole.log(JSON.stringify({ type: "result", summary: "Done." }));\n`);
      return fakeAgentAdapter(script);
    });

    // then
    const said = log.filter((l) => l.kind === "message");
    expect(said.map((l) => [l.text, l.data])).toEqual([
      ["Reading the runbook.", { type: "message", text: "Reading the runbook." }],
      ["The registry wants [redacted:credential]", { type: "message", text: "The registry wants [redacted:credential]" }],
    ]);
    expect(JSON.stringify(log)).not.toContain(TOKEN);
  });

  it("given an agent whose events of a known kind carry a field the list of event fields does not name, when the task runs, then the stored event has only the fields that list keeps", async () => {
    // when
    const log = await ran((root) => {
      const script = join(root, "agent.mjs");
      writeFileSync(script, `import { writeFileSync } from "node:fs";\nconsole.log("say");\nwriteFileSync("note.md", "x\\n");\nconsole.log(JSON.stringify({ type: "result", summary: "Done." }));\n`);
      const stand = fakeAgentAdapter(script);
      const said = stand.decoder;
      return { ...stand, decoder: () => {
        const inner = said();
        return { ...inner, decode: (line: string) => (line === "say" ? [{ type: "message", text: "Reading the runbook.", extra: "an unnamed field" } as unknown as AgentEvent] : inner.decode(line)) };
      } };
    });

    // then
    expect(log.find((l) => l.kind === "message")?.data).toEqual({ type: "message", text: "Reading the runbook." });
    expect(JSON.stringify(log)).not.toContain("an unnamed field");
  });

  it("given Claude Code that reports a running total over two turns, when the task runs, then each usage event is the addition, so the events add up to the cost the task keeps", async () => {
    // given
    const turns = (root: string) => {
      const bin = join(root, "claude-two-turns.mjs");
      const result = (total: number) => JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "Done.", total_cost_usd: total, usage: { input_tokens: 10, output_tokens: 5 } });
      const script = [
        `#!${process.execPath}`,
        'import { readFileSync } from "node:fs";',
        'if (process.argv[2] === "plugin") { console.log("[]"); process.exit(0); }',
        'if (readFileSync(0, "utf8").includes("teamhandbook-probe-initialize")) process.exit(0);',
        `console.log(${JSON.stringify(result(0.25))});`,
        `console.log(${JSON.stringify(result(0.75))});`,
      ];
      writeFileSync(bin, script.join("\n") + "\n");
      chmodSync(bin, 0o755);
      return claudeCodeAdapter(bin);
    };

    // when
    const log = await ran(turns);

    // then
    const usage = log.filter((l) => l.kind === "usage");
    expect(usage.map((l) => (l.data as { cost: { usd: number } }).cost.usd)).toEqual([0.25, 0.5]);
    expect(usage.map((l) => l.text)).toEqual(["Spent so far: $0.2500.", "Spent so far: $0.7500."]);
  });

  it("given Claude Code that reports what it spent, when the task runs, then the log carries the run's cost so far as an event the page counts from", async () => {
    // when
    const log = await ran((root) => claudeCodeAdapter(claudeArgvStandIn(root)));

    // then
    expect(log.find((l) => l.kind === "usage")).toMatchObject({ text: "Spent so far: $0.0000.", data: { type: "usage", cost: { usd: 0 } } });
  });
});
