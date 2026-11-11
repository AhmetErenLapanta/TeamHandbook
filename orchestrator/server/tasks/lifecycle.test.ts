import { randomBytes } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { MiddlewareHandler } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, NOT_CONFIGURED } from "../app.js";
import type { OrchestratorContext } from "../app.js";
import type { OrchestratorEnv, Principal } from "../auth.js";
import { localRepoPath } from "../forge/local.js";
import { git } from "../git.js";
import { forgeTokenName } from "../propose.js";
import { seededContext, storePrincipals } from "../test-fixtures.js";
import { createVault, storeSecret } from "../vault.js";
import { fakeAgentAdapter } from "./agents.js";
import { createTaskRunner, OUTPUT_HEAD_LINES, OUTPUT_HELD, OUTPUT_TAIL_LINES, outputCut } from "./runner.js";
import type { RunnerOptions, TaskRunner } from "./runner.js";
import type { TaskRecord } from "./types.js";
import { readEvidence } from "./verify.js";

const ADMIN: Principal = { id: "a", name: "Ada Example", email: "ada@example.invalid", role: "admin", ownedTeams: [] };
const FAKE_AGENT = join(import.meta.dirname, "..", "..", "demo", "fake-agent.mjs");

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

function as(user: Principal): MiddlewareHandler<OrchestratorEnv> {
  return async (c, next) => {
    c.set("user", user);
    await next();
  };
}

async function seeded(): Promise<{ ctx: OrchestratorContext; root: string }> {
  const { ctx, root } = await seededContext("orchestrator-lifecycle-");
  await storePrincipals(ctx, ADMIN);
  dirs.push(root);
  ctx.vault = createVault(randomBytes(32));
  return { ctx, root };
}

/** A stand-in agent script: the body runs in the checkout, then the result line the fake adapter reads is printed. */
function script(root: string, name: string, body: string): string {
  const file = join(root, `${name}.mjs`);
  writeFileSync(file, `import { existsSync, writeFileSync } from "node:fs";\n${body}\nconsole.log(JSON.stringify({ type: "result", summary: "Done." }));\n`);
  return file;
}

function runner(ctx: OrchestratorContext, agentScript: string, overrides: Partial<RunnerOptions> = {}): TaskRunner {
  return createTaskRunner(ctx, {
    agents: [fakeAgentAdapter(agentScript)],
    isolation: { mode: "process", network: "open" },
    testCommand: () => null,
    hostEnv: { PATH: process.env.PATH },
    ...overrides,
  });
}

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`never: ${what}`);
}

const post = (app: ReturnType<typeof createApp>, path: string) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

describe("a task whose request a person has decided", () => {
  it("given two tasks waiting for review on the local forge, when one request is merged and the other closed, then each task shows its request's decision in the list and on its own", async () => {
    // given
    const { ctx } = await seeded();
    // Side by side: the two runs are independent, and one after the other they alone filled
    // most of the time a loaded machine allows a test.
    ctx.tasks = runner(ctx, FAKE_AGENT, { concurrency: 2 });
    const app = createApp(ctx, as(ADMIN));
    const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;
    const merged = await ctx.tasks.start({ repo, title: "Add a merge note", description: "", agent: "fake", user: ADMIN });
    const closed = await ctx.tasks.start({ repo, title: "Add a close note", description: "", agent: "fake", user: ADMIN });
    await ctx.tasks.idle();
    const number = async (id: string) => (await ctx.store.getTask(ctx.tenant, id))!.requestNumber!;
    const before = (await (await app.request(`/api/tasks/${merged.id}`)).json()).task;
    expect(before.request).toMatchObject({ status: "open", provider: "local", branch: `task/${merged.id}` });

    // when
    expect((await post(app, `/api/repos/payments-skills/requests/${await number(merged.id)}/merge`)).status).toBe(200);
    expect((await post(app, `/api/repos/payments-skills/requests/${await number(closed.id)}/close`)).status).toBe(200);

    // then
    const one = async (id: string) => (await (await app.request(`/api/tasks/${id}`)).json()).task;
    expect([(await one(merged.id)).request.status, (await one(closed.id)).request.status]).toEqual(["merged", "closed"]);
    const listed = (await (await app.request("/api/tasks")).json()).tasks as { id: string; status: string; request: { status: string } }[];
    expect(listed.filter((t) => t.id === merged.id || t.id === closed.id).map((t) => [t.status, t.request.status]).sort()).toEqual([["needs-review", "closed"], ["needs-review", "merged"]]);
  });

  it("given a task whose request went to GitLab, when the request is closed there and a person refreshes it, then the task shows it closed", async () => {
    // given
    const { ctx } = await seeded();
    let state = "opened";
    const project = "/api/v4/projects/acme%2Fpayments-skills";
    const server = createServer((req, res) => {
      req.resume().on("end", () => {
        const answer = (status: number, body: unknown) => {
          res.statusCode = status;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(body));
        };
        const path = req.url!;
        if (path.startsWith("/api/v4/users?username=")) return answer(200, []);
        if (req.method === "GET" && path === project) return answer(200, { id: 7, default_branch: "main" });
        if (req.method === "GET" && path.startsWith(`${project}/repository/files/`)) return answer(200, {});
        if (req.method === "POST" && path === `${project}/repository/commits`) return answer(201, { id: "c0ffee".padEnd(40, "0") });
        if (req.method === "POST" && path === `${project}/merge_requests`) return answer(201, { iid: 5, web_url: "https://gitlab.example.invalid/acme/payments-skills/-/merge_requests/5", state: "opened" });
        if (req.method === "GET" && path === `${project}/merge_requests/5`) return answer(200, { iid: 5, state });
        return answer(404, { message: "404 Not found" });
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v4`;
    const entry = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;
    await ctx.store.upsertRepo({ ...entry, url: "https://gitlab.example.invalid/acme/payments-skills.git" });
    await ctx.store.setForgeConfig(ctx.tenant, { repoId: "payments-skills", kind: "gitlab", apiUrl, project: "acme/payments-skills" });
    await storeSecret(ctx.store, ctx.vault!, ctx.tenant, forgeTokenName({ repoId: "payments-skills", apiUrl }), "glpat-Ab12Cd34Ef56Gh78Ij90", ADMIN.email);
    ctx.tasks = runner(ctx, FAKE_AGENT);
    const app = createApp(ctx, as(ADMIN));
    const task = await ctx.tasks.start({ repo: (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!, title: "Add a hosted note", description: "", agent: "fake", user: ADMIN });
    await ctx.tasks.idle();
    const shown = async () => (await (await app.request(`/api/tasks/${task.id}`)).json()).task;
    expect((await shown()).request).toMatchObject({ status: "open", provider: "gitlab", url: "https://gitlab.example.invalid/acme/payments-skills/-/merge_requests/5" });

    // when
    state = "closed";
    expect((await post(app, "/api/repos/payments-skills/requests/5/refresh")).status).toBe(200);

    // then
    expect(await shown()).toMatchObject({ status: "needs-review", request: { status: "closed", provider: "gitlab" } });
  });
});

describe("a task's text the orchestrator cannot store or pass to git", () => {
  it("given a title with an escape or a description with a NUL, when the task is started, then each is refused and no task is created", async () => {
    // given
    const { ctx } = await seeded();
    ctx.tasks = runner(ctx, FAKE_AGENT);
    const app = createApp(ctx, as(ADMIN));
    const start = (title: string, description: string) =>
      app.request("/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, description, repoId: "payments-skills", agent: "fake" }) });

    // when
    const answers = [await start("Paint \u001b[31mred", ""), await start("Add a note", "line one\u0000line two")];

    // then
    expect(answers.map((r) => r.status)).toEqual([400, 400]);
    expect((await answers[1]!.json()).error).toBe("a description holds a control character; remove it and send it again");
    expect(await ctx.store.listTasks(ctx.tenant)).toEqual([]);
  });

  it("given a description with tabs and line breaks, when the task is started, then it is accepted", async () => {
    // given
    const { ctx } = await seeded();
    ctx.tasks = runner(ctx, FAKE_AGENT);
    const app = createApp(ctx, as(ADMIN));

    // when
    const res = await app.request("/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Add a note", description: "one\ttwo\r\nthree", repoId: "payments-skills", agent: "fake" }) });
    await ctx.tasks.idle();

    // then
    expect(res.status).toBe(201);
  });
});

describe("a repository out of the configuration or disconnected", () => {
  const startOn = (app: ReturnType<typeof createApp>, repoId: string, title = "Add a note") =>
    app.request("/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, description: "", repoId, agent: "fake" }) });

  it("given a repository the configuration no longer lists, when the form is loaded and a task is started on it, then it is not offered and the start is refused with the reason", async () => {
    // given
    const { ctx } = await seeded();
    ctx.configured = new Set(["payments-skills"]);
    ctx.tasks = runner(ctx, FAKE_AGENT);
    const app = createApp(ctx, as(ADMIN));

    // when
    const options = await (await app.request("/api/tasks/options")).json();
    const refused = await startOn(app, "platform-skills");

    // then
    expect(options.repos.map((r: { id: string }) => r.id)).toEqual(["payments-skills"]);
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toBe(NOT_CONFIGURED);
    expect(await ctx.store.listTasks(ctx.tenant)).toEqual([]);
  });

  it("given a failed task whose repository then left the configuration, when it is run again, then the start is refused and the failed task stays as it was", async () => {
    // given
    const { ctx, root } = await seeded();
    ctx.tasks = runner(ctx, script(root, "failing", "process.exit(1);"));
    const app = createApp(ctx, as(ADMIN));
    const failed = (await (await startOn(app, "platform-skills", "Fail first")).json()).task as TaskRecord;
    await ctx.tasks.idle();
    const before = await ctx.store.getTask(ctx.tenant, failed.id);
    ctx.configured = new Set(["payments-skills"]);

    // when
    const again = await startOn(app, before!.repoId, before!.title);

    // then
    expect(again.status).toBe(409);
    expect(await ctx.store.getTask(ctx.tenant, failed.id)).toEqual(before);
    expect((await ctx.store.listTasks(ctx.tenant)).map((t) => t.id)).toEqual([failed.id]);
  });

  it("given a disconnected repository, when the form is loaded and a task is started on it, then it is not offered and the start finds no repository", async () => {
    // given
    const { ctx } = await seeded();
    await ctx.store.removeRepo(ctx.tenant, "platform-skills");
    ctx.tasks = runner(ctx, FAKE_AGENT);
    const app = createApp(ctx, as(ADMIN));

    // when
    const options = await (await app.request("/api/tasks/options")).json();
    const refused = await startOn(app, "platform-skills");

    // then
    expect(options.repos.map((r: { id: string }) => r.id)).toEqual(["payments-skills"]);
    expect(refused.status).toBe(404);
    expect(await ctx.store.listTasks(ctx.tenant)).toEqual([]);
  });

  it("given a start that does not come through the API, when its repository is out of the configuration, then the task fails without reading the old copy or opening a request", async () => {
    // given
    const { ctx } = await seeded();
    ctx.configured = new Set(["payments-skills"]);
    const tasks = runner(ctx, FAKE_AGENT);
    const repo = (await ctx.store.getRepo(ctx.tenant, "platform-skills"))!;

    // when
    const started = await tasks.start({ repo, title: "Slip past the form", description: "", agent: "fake", user: ADMIN });
    await tasks.idle();

    // then
    const task = (await ctx.store.getTask(ctx.tenant, started.id))!;
    expect(task).toMatchObject({ status: "failed", error: `The task did not run: ${NOT_CONFIGURED}.`, baseSha: null, requestNumber: null });
    expect(git(["for-each-ref", "--format=%(refname:short)", "refs/heads/"], localRepoPath(repo.url)!).trim()).toBe("main");
  });
});

describe("tasks waiting their turn", () => {
  it("given one task at a time and five started in a row, when the third is cancelled while it waits, then the line shows each one's place, the cancelled one never starts and the rest start in the order they were asked for", async () => {
    // given
    const { ctx, root } = await seeded();
    const gate = join(root, "gate");
    ctx.tasks = runner(ctx, script(root, "gated", `while (!existsSync(${JSON.stringify(gate)})) await new Promise((r) => setTimeout(r, 50));\nwriteFileSync("note.md", "waited\\n");`), { concurrency: 1 });
    const app = createApp(ctx, as(ADMIN));
    const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;
    const started: TaskRecord[] = [];
    for (const n of [1, 2, 3, 4, 5]) started.push(await ctx.tasks.start({ repo, title: `Queued task ${n}`, description: "", agent: "fake", user: ADMIN }));
    await until(async () => (await ctx.store.getTask(ctx.tenant, started[0]!.id))!.status === "running", "the first task runs");
    const places = async () => {
      const listed = (await (await app.request("/api/tasks")).json()).tasks as { id: string; queuePosition: number | null }[];
      return started.map((s) => listed.find((t) => t.id === s.id)!.queuePosition);
    };
    expect(await places()).toEqual([null, 1, 2, 3, 4]);
    expect((await (await app.request(`/api/tasks/${started[4]!.id}`)).json()).task.queuePosition).toBe(4);

    // when
    const cancelled = await (await post(app, `/api/tasks/${started[2]!.id}/cancel`)).json();

    // then
    expect(cancelled.task).toMatchObject({ status: "cancelled", queuePosition: null });
    expect(await places()).toEqual([null, 1, null, 2, 3]);
    writeFileSync(gate, "");
    await ctx.tasks.idle();
    const records = await Promise.all(started.map(async (s) => (await ctx.store.getTask(ctx.tenant, s.id))!));
    expect(records.map((r) => r.status)).toEqual(["needs-review", "needs-review", "cancelled", "needs-review", "needs-review"]);
    expect(records[2]!.startedAt).toBeNull();
    expect((await ctx.store.taskLog(ctx.tenant, started[2]!.id, 0)).map((l) => l.text)).toEqual(["Cancelled before it started."]);
    const ran = [records[0]!, records[1]!, records[3]!, records[4]!];
    expect(ran.map((r) => r.startedAt!).every((at, i, all) => i === 0 || at >= all[i - 1]!)).toBe(true);
    expect(ran.map((r) => r.requestNumber)).toEqual([1, 2, 3, 4]);
    expect(await places()).toEqual([null, null, null, null, null]);
  });
});

describe("a task's log", () => {
  it("given an agent that prints more lines than the log keeps, when the task opens its request, then the log keeps the first and the last lines, says how many it left out between them, still holds the orchestrator's own lines, and reached the store in a few writes", async () => {
    // given
    const { ctx, root } = await seeded();
    const printed = (OUTPUT_HEAD_LINES + OUTPUT_TAIL_LINES) * 2;
    const talkative = script(root, "talkative", `for (let i = 1; i <= ${printed}; i++) console.log(JSON.stringify({ type: "log", text: "line " + i }));\nwriteFileSync("note.md", "said a lot\\n");`);
    let writes = 0;
    const appendTaskLog = ctx.store.appendTaskLog.bind(ctx.store);
    ctx.store.appendTaskLog = (tenant, id, lines) => {
      writes++;
      return appendTaskLog(tenant, id, lines);
    };
    ctx.tasks = runner(ctx, talkative);
    const app = createApp(ctx, as(ADMIN));
    const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;

    // when
    const task = await ctx.tasks.start({ repo, title: "Talk a lot", description: "", agent: "fake", user: ADMIN });
    await ctx.tasks.idle();

    // then
    expect((await ctx.store.getTask(ctx.tenant, task.id))!.status).toBe("needs-review");
    const log = (await ctx.store.taskLog(ctx.tenant, task.id, 0)).map((l) => l.text);
    const agentLines = log.filter((text) => /^line \d+$/.test(text));
    const numbers = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `line ${from + i}`);
    expect(agentLines).toEqual([...numbers(1, OUTPUT_HEAD_LINES), ...numbers(printed - OUTPUT_TAIL_LINES + 1, printed)]);
    const skipped = printed - OUTPUT_HEAD_LINES - OUTPUT_TAIL_LINES;
    expect(log.indexOf(OUTPUT_HELD)).toBe(log.indexOf(`line ${OUTPUT_HEAD_LINES}`) + 1);
    expect(log.indexOf(outputCut(skipped))).toBe(log.indexOf(`line ${printed - OUTPUT_TAIL_LINES + 1}`) - 1);
    expect(log.at(-1)).toBe(`Opened request #1 on task/${task.id}. It waits for a person to review and merge it.`);
    expect(writes).toBeLessThan(printed / 50);
    const answer = await (await app.request(`/api/tasks/${task.id}`)).json();
    expect(answer.outputCut).toBe(true);
  });

  it("given a talkative agent and tests that print more than the log keeps before they fail, when the task ends, then the failing line is in the log after the agent's lines and in the task's evidence", async () => {
    // given
    const { ctx, root } = await seeded();
    const printed = OUTPUT_HEAD_LINES + OUTPUT_TAIL_LINES + 10;
    const talkative = script(root, "talkative", `for (let i = 1; i <= ${printed}; i++) console.log(JSON.stringify({ type: "log", text: "line " + i }));\nwriteFileSync("note.md", "said a lot\\n");`);
    ctx.tasks = runner(ctx, talkative, { testCommand: () => `seq 1 ${OUTPUT_HEAD_LINES + OUTPUT_TAIL_LINES + 100} | sed 's/^/ok /'; echo 'FAIL rounding: expected 0.5, got 0.49'; exit 1` });
    const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;

    // when
    const task = await ctx.tasks.start({ repo, title: "Talk then fail", description: "", agent: "fake", user: ADMIN });
    await ctx.tasks.idle();

    // then
    expect((await ctx.store.getTask(ctx.tenant, task.id))!).toMatchObject({ status: "needs-review", tests: "failed" });
    const log = (await ctx.store.taskLog(ctx.tenant, task.id, 0)).map((l) => l.text);
    const failing = "FAIL rounding: expected 0.5, got 0.49";
    expect(log.indexOf(outputCut(10))).toBeGreaterThan(0);
    expect(log.lastIndexOf(failing)).toBeGreaterThan(log.indexOf(outputCut(10)));
    expect(log.indexOf(outputCut(10))).toBeLessThan(log.lastIndexOf("ok 1"));
    expect(log.lastIndexOf(outputCut(101))).toBe(log.lastIndexOf(`ok ${OUTPUT_HEAD_LINES}`) + 2);
    expect((await readEvidence(ctx.store, ctx.tenant, task.id, "payments-skills"))!.checks[0]!.after[0]!.output.split("\n").at(-1)).toBe(failing);
  });

  it("given an agent that fails after saying why, when the task fails, then its error carries the agent's last line, with a credential in it redacted", async () => {
    // given
    const { ctx, root } = await seeded();
    const failing = script(root, "failing", `console.log(JSON.stringify({ type: "log", text: "working" }));\nconsole.error("model refused the key " + process.env.SERVICE_TOKEN);\nprocess.exit(3);`);
    ctx.tasks = runner(ctx, failing, { hostEnv: { PATH: process.env.PATH, SERVICE_TOKEN: "svc-credential-9f8e7d6c5b4a" }, passEnv: ["SERVICE_TOKEN"] });
    const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;

    // when
    const task = await ctx.tasks.start({ repo, title: "Fail and say why", description: "", agent: "fake", user: ADMIN });
    await ctx.tasks.idle();

    // then
    const error = (await ctx.store.getTask(ctx.tenant, task.id))!.error!;
    expect(error).toMatch(/^The agent did not finish successfully \(exit code 3\)\. Last line: stderr: model refused the key /);
    expect(error).not.toContain("svc-credential-9f8e7d6c5b4a");
  });
});
