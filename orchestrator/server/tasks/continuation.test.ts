import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OrchestratorContext } from "../app.js";
import type { Principal } from "../auth.js";
import { newId } from "../ids.js";
import { seededContext, storePrincipals } from "../test-fixtures.js";
import type { AgentCodec, AgentEvent } from "./adapters/contract.js";
import { fakeAgentAdapter } from "./agents.js";
import type { AgentAdapter } from "./agents.js";
import { createTaskRunner, keepChildEnd } from "./runner.js";
import type { TaskRecord } from "./types.js";
import { UNKNOWN_COST } from "./types.js";

const ADA: Principal = { id: "ada", name: "Ada Example", email: "ada@example.invalid", role: "member", ownedTeams: ["Payments"] };
const FAKE_AGENT = join(import.meta.dirname, "..", "..", "demo", "fake-agent.mjs");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A stand-in for an agent that goes on after its turn. Its first turn waits for the file `go` in
 * the directory its argument names, then, told `background`, says one piece of work is left
 * running, ends the turn and writes its note only when that work ends a second later. Every later
 * turn is kept in `heard` and writes the note. It exits once its input closes, so a session closed
 * too soon leaves no note.
 */
const PROGRAM = [
  'import { appendFileSync, existsSync, writeFileSync } from "node:fs";',
  'import { join } from "node:path";',
  'import { createInterface } from "node:readline";',
  'const [dir, how] = process.argv.slice(2);',
  'const done = () => console.log(JSON.stringify({ type: "result", summary: "Done." }));',
  'process.stdin.on("end", () => process.exit(0));',
  'let turns = 0;',
  'for await (const line of createInterface({ input: process.stdin })) {',
  '  if (!line.startsWith("turn ")) continue;',
  '  turns++;',
  '  if (turns > 1) { appendFileSync(join(dir, "heard"), JSON.parse(line.slice(5)) + "\\n"); writeFileSync("notes.md", "A note.\\n"); done(); continue; }',
  '  while (!existsSync(join(dir, "go"))) await new Promise((r) => setTimeout(r, 50));',
  '  if (how === "background") {',
  '    console.log("bg 1");',
  '    setTimeout(() => { writeFileSync("notes.md", "A note.\\n"); console.log("bg 0"); }, 1000);',
  '  }',
  '  done();',
  '}',
].join("\n");

const codec = (): AgentCodec => ({
  decode(line): AgentEvent[] {
    const bg = /^bg (\d+)$/.exec(line);
    if (bg) return [{ type: "background", pending: Number(bg[1]) }];
    return line.startsWith("{") ? [{ type: "turn_finished", ok: true, summary: "Done.", reason: null, turns: 1 }] : [];
  },
  finish: (code) => ({ type: "terminal", status: code === 0 ? "completed" : "failed", summary: "" }),
  turn: (text) => `turn ${JSON.stringify(text)}`,
  answer: () => null,
  grantKey: () => null,
  pending: () => [],
  interrupt: () => "interrupt",
});

async function started(how: "background" | "child"): Promise<{ ctx: OrchestratorContext; task: TaskRecord; go: () => void; heard: () => string }> {
  const { ctx, root } = await seededContext("orchestrator-continuation-", ["payments-skills"]);
  await storePrincipals(ctx, ADA);
  dirs.push(root);
  const program = join(root, "going-on-agent.mjs");
  writeFileSync(program, PROGRAM);
  const stand = fakeAgentAdapter(FAKE_AGENT);
  const agent: AgentAdapter = {
    ...stand,
    twoWay: {
      capabilities: { ...stand.capabilities, approvals: true, permissionModes: ["approval-required", "auto"] },
      launch: (_paths, _setup, { mode }) => ({ call: { program: process.execPath, args: [program, root, how] }, codec: codec(), mode, notes: [] }),
    },
  };
  ctx.tasks = createTaskRunner(ctx, { agents: [agent], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH } });
  const task = await ctx.tasks.start({ repo: (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!, title: "Add a note", description: "", agent: "fake", user: ADA, mode: "approval-required" });
  return { ctx, task, go: () => writeFileSync(join(root, "go"), ""), heard: () => (existsSync(join(root, "heard")) ? readFileSync(join(root, "heard"), "utf8") : "") };
}

/** A task delegated by `parent`, kept as it would be while it waits for its place. */
async function delegated(ctx: OrchestratorContext, parent: TaskRecord): Promise<string> {
  const id = newId("tsk");
  const at = new Date().toISOString();
  await ctx.store.createTask({ tenant: ctx.tenant, id, repoId: parent.repoId, team: parent.team, title: "Child", description: "", issueUrl: null, issueKey: null, agent: "fake", status: "queued", createdBy: ADA.email, createdAt: at, startedAt: null, finishedAt: null, baseSha: null, tests: null, cost: UNKNOWN_COST, requestNumber: null, error: null, parentId: parent.id, depth: 1 });
  return id;
}

async function until(check: () => Promise<boolean> | boolean): Promise<void> {
  while (!(await check())) await new Promise((r) => setTimeout(r, 50));
}

describe("an agent's session after its turn ends", { timeout: 120_000 }, () => {
  it("given an agent that ends its turn with work still running in the background, when that work ends, then the session was open for it and its change is the task's", async () => {
    // given
    const { ctx, task, go } = await started("background");

    // when
    go();
    await ctx.tasks!.idle();

    // then
    expect((await ctx.store.getTask(ctx.tenant, task.id))!.status).toBe("needs-review");
  });

  it("given an agent whose task delegated one that is still going, when the delegated task ends, then the agent is told in a turn of its own and goes on from it", async () => {
    // given
    const { ctx, task, go, heard } = await started("child");
    await until(async () => (await ctx.store.getTask(ctx.tenant, task.id))!.status === "running");
    const child = await delegated(ctx, task);
    go();
    await new Promise((r) => setTimeout(r, 2500));
    const whileGoing = (await ctx.store.getTask(ctx.tenant, task.id))!.status;

    // when
    await ctx.store.updateTask(ctx.tenant, child, { status: "needs-review", finishedAt: new Date().toISOString() });
    await keepChildEnd(ctx, child, false);
    await ctx.tasks!.idle();

    // then
    expect(whileGoing).toBe("running");
    expect(heard()).toBe(`Task ${child}, which this task delegated, ended: needs-review. task_status with its id reads its phase and its requests.\n`);
    expect((await ctx.store.getTask(ctx.tenant, task.id))!.status).toBe("needs-review");
  });

  it("given a delegation that waited for its child's end, when the run keeps that end too, then nothing is left for the parent's agent to be told again", async () => {
    // given
    const { ctx, task, go } = await started("child");
    const child = await delegated(ctx, task);
    await ctx.store.updateTask(ctx.tenant, child, { status: "failed", finishedAt: new Date().toISOString() });

    // when
    await keepChildEnd(ctx, child, true);
    await keepChildEnd(ctx, child, false);

    // then
    expect(await ctx.store.pendingFollowUps(ctx.tenant, task.id)).toEqual([]);
    go();
    await ctx.tasks!.idle();
  });
});
