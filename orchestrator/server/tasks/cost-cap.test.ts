import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Principal } from "../auth.js";
import { seededContext, storePrincipals } from "../test-fixtures.js";
import { fakeAgentAdapter } from "./agents.js";
import { createTaskRunner, TASK_LIMITS_SETTING } from "./runner.js";

const ADA: Principal = { id: "ada", name: "Ada Example", email: "ada@example.invalid", role: "member", ownedTeams: ["Payments"] };
const FAKE_AGENT = join(import.meta.dirname, "..", "..", "demo", "fake-agent.mjs");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("a task held to its cost cap while it runs", { timeout: 120_000 }, () => {
  it("given a cap of $0.30, when the agent's estimate of its one turn comes at $0.40 long before the turn ends, then the run is cut there and the task says it stopped at the cap on an estimate", async () => {
    // given
    const { ctx, root } = await seededContext("orchestrator-cost-cap-", ["payments-skills"]);
    dirs.push(root);
    await storePrincipals(ctx, ADA);
    await ctx.store.setSetting(ctx.tenant, TASK_LIMITS_SETTING, JSON.stringify({ maxUsd: 0.3, maxMinutes: 60 }));
    ctx.tasks = createTaskRunner(ctx, { agents: [fakeAgentAdapter(FAKE_AGENT)], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH } });
    const started = Date.now();

    // when
    const task = await ctx.tasks.start({ repo: (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!, title: "Add a note", description: "stand-in: spend 0.40\nstand-in: wait 60 seconds", agent: "fake", user: ADA });
    await ctx.tasks.idle();

    // then
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(await ctx.store.getTask(ctx.tenant, task.id)).toMatchObject({ status: "cancelled", error: "Stopped at the $0.30 cost cap for this task. The cost so far is an estimate made while it ran." });
  });
});
