import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MiddlewareHandler } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { OrchestratorContext } from "./app.js";
import type { OrchestratorEnv, Principal } from "./auth.js";
import { sweepLessons } from "./lessons.js";
import type { LessonPlace } from "./lessons.js";
import { seededContext } from "./test-fixtures.js";
import type { AgentCodec, AgentEvent } from "./tasks/adapters/contract.js";
import { fakeAgentAdapter } from "./tasks/agents.js";
import type { AgentAdapter } from "./tasks/agents.js";
import { createTaskRunner } from "./tasks/runner.js";
import type { TaskRecord } from "./tasks/types.js";

const ADA: Principal = { id: "usr_ada", name: "Ada Example", email: "ada@example.invalid", role: "owner", ownedTeams: ["Payments"] };
const FAKE_AGENT = join(import.meta.dirname, "..", "demo", "fake-agent.mjs");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const as = (user: Principal): MiddlewareHandler<OrchestratorEnv> => async (c, next) => {
  c.set("user", user);
  await next();
};

// A two-way stand-in: its first turn waits for a message, the next one ends the task with a change.
const PROGRAM = [
  'import { writeFileSync } from "node:fs";',
  'import { createInterface } from "node:readline";',
  "let turns = 0;",
  'const done = () => console.log(JSON.stringify({ type: "result", summary: "Done." }));',
  "const first = setTimeout(done, 10_000);",
  "for await (const line of createInterface({ input: process.stdin })) {",
  '  if (!line.startsWith("turn ")) continue;',
  "  turns++;",
  "  if (turns === 1) continue;",
  '  clearTimeout(first); writeFileSync("notes.md", "Logged through the logger.\\n"); done(); done();',
  "}",
].join("\n");

const codec = (): AgentCodec => ({
  decode: (line): AgentEvent[] => (line.startsWith("{") ? [{ type: "turn_finished", ok: true, summary: "Done.", reason: null, turns: 1 }] : []),
  finish: (code) => ({ type: "terminal", status: code === 0 ? "completed" : "failed", summary: "" }),
  turn: (text) => `turn ${JSON.stringify(text)}`,
  answer: () => null,
  grantKey: () => null,
  pending: () => [],
  interrupt: () => "interrupt",
});

async function steerable(ctx: OrchestratorContext, task: TaskRecord): Promise<void> {
  while (ctx.tasks!.followUp((await ctx.store.getTask(ctx.tenant, task.id))!) !== "steer") await new Promise((r) => setTimeout(r, 50));
}

describe("a lesson from a running task's review, end to end on one person's orchestrator", { timeout: 120_000 }, () => {
  it("given a line of the diff quoted back to a working agent, when the task ends and its review is swept, then the agent's own answer becomes a lesson in the person's queue and Keep installs it in their skills folder", async () => {
    // given
    const { ctx, root } = await seededContext("orchestrator-lessons-flow-", ["payments-skills"]);
    dirs.push(root);
    await ctx.store.insertUser({ tenant: ctx.tenant, id: ADA.id, email: ADA.email, name: ADA.name, role: "owner", passwordHash: null, oidcIssuer: null, oidcSubject: null, forgeLogin: null, createdAt: "2026-11-01T00:00:00.000Z" });
    await ctx.store.setSetting(ctx.tenant, "lessons.since", "2026-01-01T00:00:00.000Z");
    const program = join(root, "steering-agent.mjs");
    writeFileSync(program, PROGRAM);
    const stand = fakeAgentAdapter(FAKE_AGENT);
    const agent: AgentAdapter = {
      ...stand,
      twoWay: {
        capabilities: { ...stand.capabilities, approvals: true, steer: true, permissionModes: ["approval-required", "auto"] },
        launch: (_paths, _setup, { mode }) => ({ call: { program: process.execPath, args: [program] }, codec: codec(), mode, notes: [] }),
      },
    };
    ctx.tasks = createTaskRunner(ctx, { agents: [agent], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH } });
    const home = mkdtempSync(join(tmpdir(), "orchestrator-lessons-flow-home-"));
    dirs.push(home);
    const place: LessonPlace = { kind: "queue", queue: { home: join(home, ".teamhandbook"), skillsDir: join(home, ".claude", "skills"), host: { names: [] }, tenants: [ctx.tenant] } };
    ctx.lessons = place;
    const app = createApp(ctx, as(ADA));
    const task = await ctx.tasks.start({ repo: (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!, title: "Add a refunds note", description: "", agent: "fake", user: ADA, mode: "approval-required" });
    await steerable(ctx, task);
    const sent = await app.request(`/api/tasks/${task.id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "use our logger here, never console.log", quotes: [{ path: "src/refunds.ts", lines: "12", text: "console.log(order)" }], commandId: "cmd-0001-logger" }) });
    await ctx.tasks.idle();

    // when
    const reviewed = await sweepLessons(ctx, place, new Date());
    const line = await (await app.request(`/api/tasks/${task.id}/lessons`)).json();
    const slug = line.candidates?.[0]?.slug as string;
    const opened = await (await app.request(`/api/tasks/${task.id}/lessons/${slug}`)).json();
    const kept = await app.request(`/api/tasks/${task.id}/lessons/${slug}/keep`, { method: "POST" });

    // then
    expect(sent.status).toBe(202);
    expect((await ctx.store.taskFollowUps(ctx.tenant, task.id)).map((f) => f.status)).toEqual(["delivered"]);
    expect(reviewed).toBe(1);
    expect(line.candidates).toEqual([expect.objectContaining({ slug: "use-our-logger-here-never", status: "pending", taskId: task.id })]);
    expect(opened.lesson).toMatchObject({ quote: "use our logger here, never console.log", skillMd: expect.stringContaining("use our logger here, never console.log") });
    expect(kept.status).toBe(200);
    expect(readFileSync(join(home, ".claude", "skills", slug, "SKILL.md"), "utf8")).toContain(`name: ${slug}`);
    expect(existsSync(join(home, ".claude", "skills", slug, "candidate.json"))).toBe(false);
    expect((await (await app.request(`/api/tasks/${task.id}/lessons`)).json()).candidates[0].status).toBe("approved");
    expect(await ctx.store.extraSpendRows(ctx.tenant, {})).toEqual([expect.objectContaining({ createdBy: ADA.email })]);
  });
});
