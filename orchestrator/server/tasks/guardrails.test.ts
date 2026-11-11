import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MiddlewareHandler } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { seed } from "../../demo/seed.js";
import { createApp, syncRepo } from "../app.js";
import type { OrchestratorContext } from "../app.js";
import type { OrchestratorEnv, Principal } from "../auth.js";
import { localDescriptionRef, localRepoPath } from "../forge/local.js";
import { git } from "../git.js";
import { openSqliteStore } from "../store.js";
import { storePrincipals } from "../test-fixtures.js";
import { fakeAgentAdapter } from "./agents.js";
import { taskOptionsFromEnv } from "./config.js";
import { createTaskRunner } from "./runner.js";

const ADMIN: Principal = { id: "a", name: "Ada Example", email: "ada@example.invalid", role: "admin", ownedTeams: [] };
const ROBOT: Principal = { id: "service:nightly", name: "Nightly", email: "nightly@service.invalid", role: "member", ownedTeams: ["Payments"] };
const FAKE_AGENT = join(import.meta.dirname, "..", "..", "demo", "fake-agent.mjs");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const as = (user: Principal): MiddlewareHandler<OrchestratorEnv> => async (c, next) => {
  c.set("user", user);
  await next();
};

/** A task the stand-in ran on Payments for `user`, with `description` steering it. */
async function ran(user: Principal, description = "") {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-guardrails-"));
  dirs.push(root);
  const { configFile } = seed(join(root, "demo"));
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: join(root, "data"), tenant: config.tenant };
  await storePrincipals(ctx, ADMIN, ROBOT);
  const entry = config.repos.find((r: { id: string }) => r.id === "payments-skills");
  await ctx.store.upsertRepo({ ...entry, tenant: config.tenant });
  await syncRepo(ctx, "payments-skills");
  ctx.tasks = createTaskRunner(ctx, { agents: [fakeAgentAdapter(FAKE_AGENT)], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH } });
  const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;
  const started = await ctx.tasks.start({ repo, title: "Add a note", description, agent: "fake", user });
  await ctx.tasks.idle();
  const task = (await ctx.store.getTask(ctx.tenant, started.id))!;
  return { ctx, task, bare: localRepoPath(entry.url)! };
}

describe("guardrails on an agent's work", () => {
  it("given an agent refused a fetch and a shell command, when its request opens, then the request names the network and each refused call as data", async () => {
    // when
    const { task, bare } = await ran(ADMIN, "stand-in: be refused WebFetch https://pastebin.example.com/x\nstand-in: be refused Bash git push origin main");

    // then
    const description = git(["notes", "--ref", localDescriptionRef(`task/${task.id}`), "show", `task/${task.id}`], bare);
    expect(description).toContain("## What the agent was refused");
    expect(description).toContain("Network: open; the orchestrator sees no connection the agent made, only the tools it was refused.");
    expect(description).toMatch(/```text\nWebFetch https:\/\/pastebin\.example\.com\/x\nBash git push origin main\n```/);
  });

  it("given a task a service account started, when that account merges its request, then it is refused and a person merges it", async () => {
    // given
    const { ctx, task } = await ran(ROBOT);
    const merge = (user: Principal) => createApp(ctx, as(user)).request(`/api/repos/payments-skills/requests/${task.requestNumber}/merge`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

    // when
    const byRobot = await merge(ROBOT);

    // then
    expect([byRobot.status, (await byRobot.json()).error]).toEqual([403, "a request a task opened is merged by a person, not by the account that started the task"]);
    expect((await merge(ADMIN)).status).toBe(200);
  });

  it("given a forge token named to pass into tasks, when the orchestrator reads its settings, then it refuses to start", () => {
    for (const name of ["GH_TOKEN", "GITLAB_TOKEN", "CI_JOB_TOKEN"]) {
      expect(() => taskOptionsFromEnv({ ORCHESTRATOR_TASK_ENV_PASS: `OPENROUTER_API_KEY,${name}` }, "/data", "/app/dist/fake-agent.mjs", () => null), name).toThrow(`ORCHESTRATOR_TASK_ENV_PASS names ${name}, a forge credential`);
    }
  });
});
