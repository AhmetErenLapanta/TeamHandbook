import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MiddlewareHandler } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { localDescriptionRef, localRepoPath } from "../forge/local.js";
import { git } from "../git.js";
import type { OrchestratorContext } from "../app.js";
import type { OrchestratorEnv, Principal } from "../auth.js";
import { seededContext, storePrincipals } from "../test-fixtures.js";
import type { AgentCodec, AgentEvent } from "./adapters/contract.js";
import type { RunnerService } from "../runner-service.js";
import type { RunnerEvent } from "../../runner/link.js";
import type { ExecutorHooks } from "../../runner/task.js";
import { fakeAgentAdapter } from "./agents.js";
import type { AgentAdapter } from "./agents.js";
import { TRACKER_REASON } from "./profile.js";
import { createTaskRunner, TASK_LIMITS_SETTING } from "./runner.js";
import type { TaskRecord } from "./types.js";

const ADA: Principal = { id: "ada", name: "Ada Example", email: "ada@example.invalid", role: "member", ownedTeams: ["Payments"] };
const FAKE_AGENT = join(import.meta.dirname, "..", "..", "demo", "fake-agent.mjs");

const as = (user: Principal): MiddlewareHandler<OrchestratorEnv> => async (c, next) => {
  c.set("user", user);
  await next();
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A stand-in for an agent talked to over its input: told its prompt as `turn <json>`, it asks
 * `ask r1 Bash npm test`, waits for `allow r1` or `deny r1` (with a note after it), writes a note
 * when allowed, reports a result and exits once its input closes. Every answer it hears is kept in
 * the file its third argument names.
 */
const PROGRAM = [
  'import { appendFileSync, writeFileSync } from "node:fs";',
  'import { createInterface } from "node:readline";',
  'const tool = process.argv[2] ?? "Bash";',
  'const heard = process.argv[3];',
  'for await (const line of createInterface({ input: process.stdin })) {',
  '  if (line.startsWith("turn ") && tool === "Spend") { console.log(JSON.stringify({ type: "spend", usd: 0.12 })); process.exit(1); }',
  '  if (line.startsWith("turn ") && tool === "Once") { if (!globalThis.once) { globalThis.once = true; setTimeout(() => console.log(JSON.stringify({ type: "result", summary: "Did the work and what was added while it worked." })), 1500); } continue; }',
  '  if (line.startsWith("turn ") && tool === "Partial") { writeFileSync("notes.md", "Halfway.\\n"); console.log("ask r1 Bash npm test"); continue; }',
  '  if (line.startsWith("turn ")) console.log(`ask r1 ${tool} npm test`);',
  '  if (/^(allow|deny) r1/.test(line)) appendFileSync(heard, `${line}\\n`);',
  '  if (line === "allow r1") writeFileSync("notes.md", "Ran the tests.\\n");',
  '  if (/^(allow|deny) r1/.test(line)) console.log(JSON.stringify({ type: "result", summary: line === "allow r1" ? "Added a note." : "Declined, so nothing changed." }));',
  '  if (line.startsWith("reply r1 ")) { appendFileSync(heard, `${line}\\n`); writeFileSync("notes.md", "Picked a database.\\n"); console.log(JSON.stringify({ type: "result", summary: "Picked a database." })); }',
  '  if (line.startsWith("approve r1 ")) { appendFileSync(heard, `${line}\\n`); writeFileSync("notes.md", "Followed the plan.\\n"); console.log(JSON.stringify({ type: "result", summary: "Followed the plan." })); }',
  '}',
].join("\n");

/** What the stand-in asks when its tool is `Question`: one choice, its wording holding a token-shaped value. */
const QUESTION_TOKEN = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB";
const ASKED = [{ key: "db", title: `Which database, given ${QUESTION_TOKEN}?`, choice: "one" as const, options: [{ value: "pg", label: "Postgres" }, { value: "my", label: "MySQL" }] }];

const codec = (): AgentCodec => ({
  decode(line): AgentEvent[] {
    const ask = /^ask (\S+) (\S+) (.+)$/.exec(line);
    if (ask?.[2] === "Question") return [{ type: "request", request: { id: ask[1]!, kind: "question", tool: "AskUserQuestion", summary: ask[3]!, questions: ASKED } }];
    if (ask?.[2] === "Plan") return [{ type: "request", request: { id: ask[1]!, kind: "plan", tool: "ExitPlanMode", summary: "1. Read the notes", plan: `1. Read the notes\n2. Add a line with the token\n${QUESTION_TOKEN}` } }];
    if (ask) return [{ type: "request", request: { id: ask[1]!, kind: ask[2] === "Bash" ? "command" : "permission", tool: ask[2]!, summary: ask[3]! } }];
    if (line.startsWith("{")) {
      const frame = JSON.parse(line) as { type: string; usd?: number; summary?: string };
      if (frame.type === "spend") return [{ type: "spend", usd: frame.usd! }];
      return [{ type: "turn_finished", ok: true, summary: frame.summary ?? "", reason: null, turns: 1 }];
    }
    return [];
  },
  finish: (code) => ({ type: "terminal", status: code === 0 ? "completed" : "failed", summary: "" }),
  turn: (text) => `turn ${JSON.stringify(text)}`,
  answer: (id, decision, note) => (decision === "deny" ? `deny ${id}${note ? ` ${note}` : ""}` : `allow ${id}`),
  reply: (id, answers) => `reply ${id} ${JSON.stringify(answers)}`,
  approvePlan: (id, plan) => `approve ${id} ${JSON.stringify(plan)}`,
  grantKey: () => null,
  pending: () => [],
  interrupt: () => "interrupt",
});

async function asking(tool = "Bash", profile: "isolated" | "personal" = "isolated", leased = false, mode: "approval-required" | "auto" = "approval-required", planFirst = false, timeoutMs?: number, steer = false): Promise<{ ctx: OrchestratorContext; task: TaskRecord; launched: { personal?: boolean; questions?: boolean; plan?: boolean }[]; heard: () => string }> {
  const { ctx, root } = await seededContext("orchestrator-conversation-", ["payments-skills"]);
  await storePrincipals(ctx, ADA);
  dirs.push(root);
  const program = join(root, "asking-agent.mjs");
  writeFileSync(program, PROGRAM);
  const stand = fakeAgentAdapter(FAKE_AGENT);
  const launched: { personal?: boolean; questions?: boolean; plan?: boolean }[] = [];
  const agent: AgentAdapter = {
    ...stand,
    twoWay: {
      capabilities: { ...stand.capabilities, approvals: true, plan: true, steer, permissionModes: ["approval-required", "auto"] },
      launch: (_paths, _setup, options) => {
        launched.push(options);
        return { call: { program: process.execPath, args: [program, tool, join(root, "heard")] }, codec: codec(), mode: options.mode, notes: [] };
      },
    },
  };
  // With runners, the start is kept for one and nothing runs it here.
  if (leased) ctx.runnerService = { wake: () => {}, stop: () => {} } as unknown as RunnerService;
  ctx.tasks = createTaskRunner(ctx, { agents: [agent], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH }, profile, ...(timeoutMs ? { timeoutMs } : {}) });
  const task = await ctx.tasks.start({ repo: (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!, title: "Add a note", description: "", agent: "fake", user: ADA, mode, ...(planFirst ? { planFirst } : {}) });
  return { ctx, task, launched, heard: () => (existsSync(join(root, "heard")) ? readFileSync(join(root, "heard"), "utf8") : "") };
}

/** The request the agent's question became, once it is kept. */
async function askedOf(ctx: OrchestratorContext, task: TaskRecord) {
  for (;;) {
    const [asked] = await ctx.store.taskRequests(ctx.tenant, task.id);
    if (asked) return asked;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("a task whose agent asks before it acts", { timeout: 120_000 }, () => {
  it("given an agent that asks to run the tests, when its starter allows it once, then the request is kept, the answer reaches the agent and its request opens", async () => {
    // given
    const { ctx, task } = await asking();
    const asked = await askedOf(ctx, task);

    // when
    await ctx.store.answerTaskRequest(ctx.tenant, asked.id, { decision: "allow_once" }, ADA.email, "web", new Date().toISOString());
    await ctx.tasks!.idle();

    // then
    expect(asked).toMatchObject({ kind: "command", sourceKey: "r1", payload: { tool: "Bash", summary: "npm test" }, status: "pending", targetPosition: null });
    const log = (await ctx.store.taskLog(ctx.tenant, task.id, 0)).map((l) => l.text);
    expect(log).toContain(`The agent asks to use Bash on npm test; it waits for ${ADA.name}'s answer on this task's page.`);
    expect(log).toContain(`${ADA.email} answered the agent's Bash call: allow-once.`);
    expect(await ctx.store.getTask(ctx.tenant, task.id)).toMatchObject({ status: "needs-review", mode: "approval-required" });
  });

  it("given an agent that asks its starter a question, when they pick an answer on the task's page, then the question is kept with its wording masked, the answer reaches the agent as asked, and the task goes on", async () => {
    // given
    const { ctx, task, heard, launched } = await asking("Question");
    const asked = await askedOf(ctx, task);

    // when
    const answered = await createApp(ctx, as(ADA)).request(`/api/tasks/${task.id}/requests/${asked.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answer: { answers: { db: { chosen: ["pg"], other: null } } } }) });
    await ctx.tasks!.idle();

    // then
    expect(answered.status).toBe(200);
    expect(asked).toMatchObject({ kind: "question", payload: { questions: [{ key: "db", choice: "one", options: [{ value: "pg", label: "Postgres" }, { value: "my", label: "MySQL" }] }] } });
    expect(JSON.stringify(asked.payload)).not.toContain(QUESTION_TOKEN);
    expect(launched[0]).toMatchObject({ questions: true });
    expect(heard()).toBe('reply r1 {"db":{"chosen":["pg"],"other":null}}\n');
    const log = (await ctx.store.taskLog(ctx.tenant, task.id, 0)).map((l) => l.text);
    expect(log).toContain(`The agent asks ${ADA.name} a question; it waits for the answer on this task's page.`);
    expect(log).toContain(`${ADA.email} answered the agent's question.`);
    expect(await ctx.store.getTask(ctx.tenant, task.id)).toMatchObject({ status: "needs-review" });
  });

  it("given an agent that asks, when its starter declines, then the agent hears no and the task opens nothing", async () => {
    // given
    const { ctx, task } = await asking();
    const asked = await askedOf(ctx, task);

    // when
    await ctx.store.answerTaskRequest(ctx.tenant, asked.id, { decision: "deny" }, ADA.email, "web", new Date().toISOString());
    await ctx.tasks!.idle();

    // then
    const done = (await ctx.store.getTask(ctx.tenant, task.id))!;
    expect(done.status).toBe("failed");
    expect(done.requestNumber).toBeNull();
    expect((await ctx.store.taskLog(ctx.tenant, task.id, 0)).map((l) => l.text)).toContain(`${ADA.email} answered the agent's Bash call: deny.`);
  });

  it.each([["mcp__atlassian__createJiraIssue"], ["atlassian_createJiraIssue"]])("given an agent that asks to use a tracker's writing tool %s, in an organization that keeps tasks from its tracker, when it asks, then it hears no before any card is kept and the log says why", async (tool) => {
    // when
    const { ctx, task, heard } = await asking(tool);
    await ctx.tasks!.idle();

    // then
    expect(heard()).toBe(`deny r1 ${TRACKER_REASON}\n`);
    expect(await ctx.store.taskRequests(ctx.tenant, task.id)).toEqual([]);
    expect((await ctx.store.taskLog(ctx.tenant, task.id, 0)).map((l) => l.text)).toContain(`Declined the agent's ${tool} call: ${TRACKER_REASON}`);
  });

  it("given an agent that asks about a tool outside the fixed list, when it asks, then it is kept as a permission request for its starter to answer", async () => {
    // given
    const { ctx, task } = await asking("WebFetch");

    // when
    const asked = await askedOf(ctx, task);
    await ctx.store.answerTaskRequest(ctx.tenant, asked.id, { decision: "allow_for_task" }, ADA.email, "web", new Date().toISOString());
    await ctx.tasks!.idle();

    // then
    expect(asked).toMatchObject({ kind: "permission", payload: { tool: "WebFetch" } });
    expect((await ctx.store.taskLog(ctx.tenant, task.id, 0)).map((l) => l.text)).toContain(`${ADA.email} answered the agent's WebFetch call: allow-for-task.`);
  });

  it("given a one-person orchestrator running tasks as its person, when the agent asks, then it is started as a conversation in the person's own profile and the question still reaches the starter", async () => {
    // given
    const { ctx, task, launched } = await asking("Bash", "personal");
    const asked = await askedOf(ctx, task);

    // when
    await ctx.store.answerTaskRequest(ctx.tenant, asked.id, { decision: "allow_once" }, ADA.email, "web", new Date().toISOString());
    await ctx.tasks!.idle();

    // then
    expect(launched).toEqual([expect.objectContaining({ mode: "approval-required", personal: true })]);
    expect(asked).toMatchObject({ kind: "command", status: "pending" });
    expect((await ctx.store.getTask(ctx.tenant, task.id))!.status).toBe("needs-review");
  });

  it("given a one-person orchestrator running a task in Auto as its person, when the agent calls a tool off Auto's list, then the run is a conversation and the call waits on its starter's card instead of being refused", async () => {
    // given
    const { ctx, task, launched } = await asking("Bash", "personal", false, "auto");
    const asked = await askedOf(ctx, task);

    // when
    await ctx.store.answerTaskRequest(ctx.tenant, asked.id, { decision: "allow_once" }, ADA.email, "web", new Date().toISOString());
    await ctx.tasks!.idle();

    // then
    expect(launched).toEqual([expect.objectContaining({ mode: "auto", personal: true })]);
    expect(asked).toMatchObject({ kind: "command", status: "pending" });
    expect((await ctx.store.getTask(ctx.tenant, task.id))!.status).toBe("needs-review");
  });

  it("given a task started to plan first, when its agent puts its plan and its starter approves it as they changed it, then the agent was opened to plan, the card held the plan masked, the agent hears the changed plan, and the log and the request's description keep it as the plan", async () => {
    // given
    const { ctx, task, launched, heard } = await asking("Plan", "isolated", false, "approval-required", true);
    const asked = await askedOf(ctx, task);

    // when
    await ctx.store.answerTaskRequest(ctx.tenant, asked.id, { decision: "allow_once", plan: "1. Only read the notes" }, ADA.email, "web", new Date().toISOString());
    await ctx.tasks!.idle();

    // then
    expect(launched).toEqual([expect.objectContaining({ plan: true })]);
    expect(asked).toMatchObject({ kind: "plan", payload: { tool: "ExitPlanMode", plan: expect.stringContaining("2. Add a line with") } });
    expect(String(asked.payload.plan)).not.toContain(QUESTION_TOKEN);
    expect(heard()).toBe(`approve r1 ${JSON.stringify("1. Only read the notes")}\n`);
    const log = (await ctx.store.taskLog(ctx.tenant, task.id, 0)).map((l) => l.text);
    expect(log).toEqual(expect.arrayContaining([`${ADA.email} approved the plan as they changed it:`, "## Plan", "1. Only read the notes"]));
    expect((await ctx.store.getTask(ctx.tenant, task.id))!).toMatchObject({ status: "needs-review", planFirst: true });
    const request = (await ctx.store.listRequests(ctx.tenant))[0]!;
    const description = git(["notes", "--ref", localDescriptionRef(request.branch), "show", request.branch], localRepoPath((await ctx.store.getRepo(ctx.tenant, "payments-skills"))!.url)!);
    expect(description).toContain("## Plan");
    expect(description).toContain("1. Only read the notes");
  });

  it("given an agent that went into plan mode by itself, when its starter declines its plan, then the agent hears no and the run goes on rather than being cut", async () => {
    // given
    const { ctx, task, heard } = await asking("Plan", "isolated", false, "approval-required", false);
    const asked = await askedOf(ctx, task);

    // when
    await ctx.store.answerTaskRequest(ctx.tenant, asked.id, { decision: "deny" }, ADA.email, "web", new Date().toISOString());
    await ctx.tasks!.idle();

    // then
    expect(heard()).toBe("deny r1\n");
    expect((await ctx.store.getTask(ctx.tenant, task.id))!.error).not.toBe("The plan was declined; nothing changed.");
  });

  it("given an agent that puts its plan, when its starter declines it, then the run is cut there and the task ends with nothing changed", async () => {
    // given
    const { ctx, task } = await asking("Plan", "isolated", false, "approval-required", true);
    const asked = await askedOf(ctx, task);

    // when
    await ctx.store.answerTaskRequest(ctx.tenant, asked.id, { decision: "deny" }, ADA.email, "web", new Date().toISOString());
    await ctx.tasks!.idle();

    // then
    expect(await ctx.store.getTask(ctx.tenant, task.id)).toMatchObject({ status: "cancelled", error: "The plan was declined; nothing changed." });
  });

  it("given an agent that asks, when its starter declines with a note, then the agent hears the deny with the note and the log says a note went with it", async () => {
    // given
    const { ctx, task, heard } = await asking();
    const asked = await askedOf(ctx, task);

    // when
    await ctx.store.answerTaskRequest(ctx.tenant, asked.id, { decision: "deny", note: "Run only the unit tests." }, ADA.email, "web", new Date().toISOString());
    await ctx.tasks!.idle();

    // then
    expect(heard()).toBe("deny r1 Run only the unit tests.\n");
    expect((await ctx.store.taskLog(ctx.tenant, task.id, 0)).map((l) => l.text)).toContain(`${ADA.email} answered the agent's Bash call: deny, with a note.`);
  });

  it("given a task leased to a runner, when its agent asks and the starter declines with a note, then the request and its answer reach the runner's events masked and the agent hears the note", async () => {
    // given
    const { ctx, task, heard } = await asking("Bash", "isolated", true);
    const events: RunnerEvent[] = [];
    const hooks: ExecutorHooks = {
      signal: new AbortController().signal,
      onEvent: (event) => void events.push(event),
      log: () => {},
      record: () => {},
      onProcess: () => {},
      decide: async () => ({ decision: "deny", note: "Run only the unit tests." }),
      leaseHeld: async () => true,
    };

    // when
    const outcome = await ctx.tasks!.leased().run({ id: task.id, title: task.title, agent: "fake", nativeSession: null }, hooks);

    // then
    expect(events.filter((e) => e.type !== "output")).toEqual([{ type: "request", request: { id: "r1", kind: "command", tool: "Bash", summary: "npm test" } }, { type: "request_resolved", requestId: "r1", decision: "deny" }]);
    expect(heard()).toBe("deny r1 Run only the unit tests.\n");
    expect(outcome.status).toBe("failed");
  });

  it("given a run whose own time is half a second and an agent waiting on its starter's card, when they answer two seconds later, then the card was still open and the task goes on from the answer", async () => {
    // given
    const { ctx, task, heard } = await asking("Bash", "isolated", false, "approval-required", false, 500);
    const asked = await askedOf(ctx, task);
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // when
    await ctx.store.answerTaskRequest(ctx.tenant, asked.id, { decision: "allow_once" }, ADA.email, "web", new Date().toISOString());
    await ctx.tasks!.idle();

    // then
    expect(asked.expiresAt).toBeNull();
    expect(heard()).toBe("allow r1\n");
    expect((await ctx.store.getTask(ctx.tenant, task.id))!.status).toBe("needs-review");
  });

  it("given a task on the orchestrator's own runner whose agent puts its plan, when its starter approves it as they changed it long after the run's own time, then the agent hears the changed plan and no card was declined", async () => {
    // given
    const { ctx, task, heard } = await asking("Plan", "isolated", true, "approval-required", true, 500);
    const hooks: ExecutorHooks = {
      signal: new AbortController().signal,
      onEvent: () => {},
      log: () => {},
      record: () => {},
      onProcess: () => {},
      decide: () => new Promise((resolve) => setTimeout(() => resolve({ decision: "allow-once", plan: "1. Only read the notes" }), 1500)),
      leaseHeld: async () => true,
    };

    // when
    await ctx.tasks!.leased().run({ id: task.id, title: task.title, agent: "fake", nativeSession: null }, hooks);

    // then
    expect(heard()).toBe(`approve r1 ${JSON.stringify("1. Only read the notes")}\n`);
  });

  it("given an agent that steers and a follow-up waiting as its run starts, when the agent takes the follow-up into its one turn and ends it, then the session closes and the task leaves running", async () => {
    // given
    const { ctx, task } = await asking("Once", "isolated", false, "approval-required", false, undefined, true);
    await ctx.store.addFollowUp({ tenant: ctx.tenant, id: "fup_plan", taskId: task.id, source: "person", key: "plan:approved", text: "Carry out the approved plan.", quotes: null, createdAt: new Date().toISOString(), createdBy: ADA.email });

    // when
    const settled = await Promise.race([ctx.tasks!.idle().then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 20_000))]);

    // then
    expect(settled).toBe(true);
    expect((await ctx.store.getTask(ctx.tenant, task.id))!.status).not.toBe("running");
  });

  it("given an agent that changed a file and waits on its starter's card, when its starter stops the task, then what it changed waits for review with the stop as the reason, and a stop before any change still cancels", async () => {
    // given
    const { ctx, task } = await asking("Partial");
    const unchanged = await asking("Bash");
    await Promise.all([askedOf(ctx, task), askedOf(unchanged.ctx, unchanged.task)]);

    // when
    await ctx.tasks!.cancel(task.id);
    await unchanged.ctx.tasks!.cancel(unchanged.task.id);
    await Promise.all([ctx.tasks!.idle(), unchanged.ctx.tasks!.idle()]);

    // then
    const kept = (await ctx.store.getTask(ctx.tenant, task.id))!;
    expect(kept).toMatchObject({ status: "needs-review", error: "Stopped by the person who started the task." });
    expect(kept.requestNumber).not.toBeNull();
    expect((await unchanged.ctx.store.getTask(unchanged.ctx.tenant, unchanged.task.id))!.status).toBe("cancelled");
  });

  it("given an agent that changed a file and waits on its starter's card, when the task's cost cap stops it, then what it changed waits for review with the cap as the reason", async () => {
    // given
    const { ctx, task } = await asking("Partial");
    await ctx.store.setSetting(ctx.tenant, TASK_LIMITS_SETTING, JSON.stringify({ maxUsd: 1, maxMinutes: 60 }));
    await askedOf(ctx, task);

    // when
    const stopped = await ctx.tasks!.holdSpend(task.id, 1.5);
    await ctx.tasks!.idle();

    // then
    expect(stopped).toBe(true);
    const kept = (await ctx.store.getTask(ctx.tenant, task.id))!;
    expect(kept).toMatchObject({ status: "needs-review", error: "Stopped at the $1.00 cost cap for this task. The cost so far is an estimate made while it ran." });
    expect(kept.requestNumber).not.toBeNull();
  });

  it("given a task on its starter's machine that failed with its plan unanswered, when they approve the plan and continue and its agent that steers takes the plan into its one turn, then the run starts from the plan and its session closes when that turn ends", async () => {
    // given
    const { ctx, task } = await asking("Once", "isolated", true, "approval-required", false, undefined, true);
    await ctx.store.recordTaskRequest({ tenant: ctx.tenant, id: "req_plan", taskId: task.id, targetPosition: null, sourceKey: "plan-1", kind: "plan", payload: { tool: "ExitPlanMode", summary: "Add the note", plan: "# Add the note\n1. Edit notes.md" }, createdAt: new Date().toISOString(), expiresAt: null });
    await ctx.store.updateTask(ctx.tenant, task.id, { status: "failed", error: "The agent ran past its time limit of 30 minutes and was stopped." });
    const approved = await createApp(ctx, as(ADA)).request(`/api/tasks/${task.id}/continue`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ commandId: "continue-plan-chain", approvePlan: true }) });
    const pending = await ctx.store.pendingFollowUps(ctx.tenant, task.id);
    let handed = false;
    const hooks: ExecutorHooks = {
      signal: new AbortController().signal,
      onEvent: () => {},
      log: () => {},
      record: () => {},
      onProcess: () => {},
      decide: async () => ({ decision: "allow-once" }),
      leaseHeld: async () => true,
      followUps: () => (handed ? [] : ((handed = true), pending.map(({ id, source, text, quotes, createdBy }) => ({ id, source, text, quotes, createdBy })))),
      delivered: () => {},
    };

    // when
    const settled = await Promise.race([ctx.tasks!.leased().run({ id: task.id, title: task.title, agent: "fake", nativeSession: null }, hooks).then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 20_000))]);

    // then
    expect(approved.status).toBe(200);
    expect(pending.map((f) => f.text)).toEqual([expect.stringContaining("1. Edit notes.md")]);
    expect(settled).toBe(true);
  });

  it("given a task on its starter's machine whose agent changed a file and waits on a card, when its runner is stopped, then the change is pushed and the run ends in review rather than being thrown away", async () => {
    // given
    const { ctx, task } = await asking("Partial", "isolated", true);
    const stop = new AbortController();
    let carded: () => void = () => {};
    const card = new Promise<void>((resolve) => (carded = resolve));
    const hooks: ExecutorHooks = {
      signal: stop.signal,
      onEvent: () => {},
      log: () => {},
      record: () => {},
      onProcess: () => {},
      decide: () => {
        carded();
        return new Promise((_, reject) => stop.signal.addEventListener("abort", () => reject(stop.signal.reason), { once: true }));
      },
      leaseHeld: async () => !stop.signal.aborted,
    };
    const ran = ctx.tasks!.leased().run({ id: task.id, title: task.title, agent: "fake", nativeSession: null }, hooks);
    await card;

    // when
    stop.abort();
    const outcome = await ran;

    // then
    expect(outcome).toMatchObject({ status: "needs-review", branch: expect.stringContaining(`task/${task.id}`) });
  });

  it("given an agent that ends before reporting its turn's cost, when the run is over, then the task keeps the cost it estimated while it ran", async () => {
    // given
    const { ctx, task } = await asking("Spend", "isolated", false, "approval-required");

    // when
    await ctx.tasks!.idle();

    // then
    expect((await ctx.store.getTask(ctx.tenant, task.id))!).toMatchObject({ status: "failed", cost: { usd: 0.12 } });
  });

  it("given a task leased to a runner whose agent asks its starter a question, when the runner brings the answer back, then the agent hears the answer as asked", async () => {
    // given
    const { ctx, task, heard } = await asking("Question", "isolated", true);
    const hooks: ExecutorHooks = {
      signal: new AbortController().signal,
      onEvent: () => {},
      log: () => {},
      record: () => {},
      onProcess: () => {},
      decide: async () => ({ decision: "allow-once", answers: { db: { chosen: ["my"], other: null } } }),
      leaseHeld: async () => true,
    };

    // when
    await ctx.tasks!.leased().run({ id: task.id, title: task.title, agent: "fake", nativeSession: null }, hooks);

    // then
    expect(heard()).toBe('reply r1 {"db":{"chosen":["my"],"other":null}}\n');
  });

  it("given an agent waiting on its question, when the task is cancelled, then the agent ends and the question is no longer answerable", async () => {
    // given
    const { ctx, task } = await asking();
    await askedOf(ctx, task);

    // when
    await ctx.tasks!.cancel(task.id);
    await ctx.tasks!.idle();

    // then
    expect((await ctx.store.getTask(ctx.tenant, task.id))!.status).toBe("cancelled");
    expect(await ctx.store.taskRequests(ctx.tenant, task.id)).toEqual([expect.objectContaining({ status: "expired", responseCapability: "not_resumable" })]);
  });
});
