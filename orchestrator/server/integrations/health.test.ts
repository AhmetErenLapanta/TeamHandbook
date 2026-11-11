import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { syncRepo } from "../app.js";
import type { OrchestratorContext } from "../app.js";
import { ForgeHttpError } from "../forge/http.js";
import type { ForgeProvider } from "../forge/types.js";
import { openSqliteStore } from "../store.js";
import type { RepoRecord } from "../store.js";
import { FAILURES_BEFORE_ALERT, noteHealth, REALERT_MS, resetHealth, watchedForge } from "./health.js";

const dirs: string[] = [];
afterEach(() => {
  resetHealth();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function orchestrator_(): OrchestratorContext {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-health-"));
  dirs.push(root);
  return { store: openSqliteStore(":memory:"), dataDir: join(root, "data"), tenant: "acme", allowedHosts: null };
}

async function told(ctx: OrchestratorContext): Promise<string[]> {
  const page = await ctx.store.eventPage(ctx.tenant, { kindPrefix: "health" }, null, 100);
  return page.events.reverse().map((e) => `${e.kind} ${e.repoId ?? "-"} ${e.subject}`);
}

const failed = { ok: false as const, detail: "the forge did not answer" };
const TASKS = { kind: "tasks" as const };

describe("telling when something the orchestrator does on its own stops working", () => {
  it("given failures one short of the line, when a third comes, then one degraded event is written, and the failures after it write nothing more", async () => {
    // given
    const ctx = orchestrator_();
    for (let i = 1; i < FAILURES_BEFORE_ALERT; i++) await noteHealth(ctx, TASKS, failed);
    const before = await told(ctx);

    // when
    await noteHealth(ctx, TASKS, failed);
    await noteHealth(ctx, TASKS, failed);
    await noteHealth(ctx, TASKS, failed);

    // then
    expect(before).toEqual([]);
    expect(await told(ctx)).toEqual(["health.degraded - health:tasks"]);
  });

  it("given a check that was told broken, when it works again, then a recovered event follows once; one that never crossed the line says nothing", async () => {
    // given
    const ctx = orchestrator_();
    for (let i = 0; i < FAILURES_BEFORE_ALERT; i++) await noteHealth(ctx, TASKS, failed);
    await noteHealth(ctx, { kind: "sync", repoId: "platform-skills" }, failed);

    // when
    await noteHealth(ctx, TASKS, { ok: true });
    await noteHealth(ctx, TASKS, { ok: true });
    await noteHealth(ctx, { kind: "sync", repoId: "platform-skills" }, { ok: true });

    // then
    expect(await told(ctx)).toEqual(["health.degraded - health:tasks", "health.recovered - health:tasks"]);
  });

  it("given a check that broke, recovered and breaks again within hours, when it crosses the line again, then nothing more is told until the quiet time has passed", async () => {
    // given
    const ctx = orchestrator_();
    const at = Date.parse("2026-10-26T08:00:00Z");
    for (let i = 0; i < FAILURES_BEFORE_ALERT; i++) await noteHealth(ctx, TASKS, failed, at);
    await noteHealth(ctx, TASKS, { ok: true }, at + 60_000);

    // when
    for (let i = 0; i < FAILURES_BEFORE_ALERT; i++) await noteHealth(ctx, TASKS, failed, at + 3_600_000);
    await noteHealth(ctx, TASKS, { ok: true }, at + 3_700_000);
    for (let i = 0; i < FAILURES_BEFORE_ALERT; i++) await noteHealth(ctx, TASKS, failed, at + REALERT_MS + 1);

    // then
    expect(await told(ctx)).toEqual(["health.degraded - health:tasks", "health.recovered - health:tasks", "health.degraded - health:tasks"]);
  });

  it("given a repository whose remote is gone, when it is synced three times, then the sync check tells it broken, naming the repository and the failure masked of credentials", async () => {
    // given
    const ctx = orchestrator_();
    await ctx.store.upsertRepo({ tenant: "acme", id: "payments-skills", team: "Payments", name: "payments-skills", url: "https://user:s3cr3t-token@127.0.0.1:9/nowhere.git" });

    // when
    for (let i = 0; i < FAILURES_BEFORE_ALERT; i++) await syncRepo(ctx, "payments-skills");

    // then
    const page = await ctx.store.eventPage(ctx.tenant, { kindPrefix: "health" }, null, 10);
    expect(page.events.map((e) => [e.kind, e.repoId, e.actor.kind])).toEqual([["health.degraded", "payments-skills", "orchestrator"]]);
    expect(page.events[0]!.detail).toMatch(/^Reading the repository failed 3 times in a row; the last: /);
    expect(page.events[0]!.detail).not.toContain("s3cr3t-token");
  });

  it("given a hosted forge that refuses the token, when its calls fail, then the forge check tells it; a refusal of one change counts for nothing", async () => {
    // given
    const ctx = orchestrator_();
    const repo = { id: "payments-skills", tenant: "acme" } as RepoRecord;
    let answer: Error | null = new ForgeHttpError("GitLab answered 409 on POST /merge_requests: Another open merge request already exists", 409);
    const provider: ForgeProvider = { kind: "gitlab", open: async () => Promise.reject(answer), list: async () => (answer ? Promise.reject(answer) : []) };
    const watched = watchedForge(ctx, repo, provider);

    // when
    for (let i = 0; i < 5; i++) await watched.open(repo, {} as never).catch(() => undefined);
    const afterRefusals = await told(ctx);
    answer = new ForgeHttpError("GitLab answered 401 on GET /merge_requests: 401 Unauthorized", 401);
    for (let i = 0; i < FAILURES_BEFORE_ALERT; i++) await watched.list!(repo).catch(() => undefined);
    answer = null;
    await watched.list!(repo);

    // then
    expect(afterRefusals).toEqual([]);
    expect(await told(ctx)).toEqual(["health.degraded payments-skills health:forge", "health.recovered payments-skills health:forge"]);
  });

  it("given a hosted forge that opens a request for a pushed branch, when that call fails on the token, then the forge check counts it as any other forge call", async () => {
    // given
    const ctx = orchestrator_();
    const repo = { id: "payments-skills", tenant: "acme" } as RepoRecord;
    const refused = new ForgeHttpError("GitHub answered 401 on POST /pulls: Bad credentials", 401);
    const provider: ForgeProvider = { kind: "github", open: async () => Promise.reject(refused), openForBranch: async () => Promise.reject(refused) };
    const watched = watchedForge(ctx, repo, provider);

    // when
    for (let i = 0; i < FAILURES_BEFORE_ALERT; i++) await watched.openForBranch!(repo, {} as never).catch(() => undefined);

    // then
    expect(await told(ctx)).toEqual(["health.degraded payments-skills health:forge"]);
  });

  it("given a hosted forge that updates a request's branch, when that call fails on the token, then the forge check counts it as any other forge call", async () => {
    // given
    const ctx = orchestrator_();
    const repo = { id: "payments-skills", tenant: "acme" } as RepoRecord;
    const refused = new ForgeHttpError("GitHub answered 401 on PATCH /git/refs: Bad credentials", 401);
    const provider: ForgeProvider = { kind: "github", open: async () => Promise.reject(refused), updateBranch: async () => Promise.reject(refused) };
    const watched = watchedForge(ctx, repo, provider);

    // when
    for (let i = 0; i < FAILURES_BEFORE_ALERT; i++) await watched.updateBranch!(repo, "th/task-1", {} as never).catch(() => undefined);

    // then
    expect(await told(ctx)).toEqual(["health.degraded payments-skills health:forge"]);
  });
});
