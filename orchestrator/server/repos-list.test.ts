import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MiddlewareHandler } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { seed } from "../demo/seed.js";
import { createApp, syncRepo } from "./app.js";
import type { OrchestratorContext } from "./app.js";
import type { OrchestratorEnv, Principal } from "./auth.js";
import { openSqliteStore } from "./store.js";

const MEMBER: Principal = { id: "m", name: "Max Example", email: "max@example.invalid", role: "member", ownedTeams: [] };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function as(user: Principal): MiddlewareHandler<OrchestratorEnv> {
  return async (c, next) => {
    c.set("user", user);
    await next();
  };
}

describe("the repositories list as a lead reads it", () => {
  it("given the demo's repositories, one with two requests waiting and one never read, when the list is read, then each says what it shares, what waits and how its setup stands", async () => {
    // given
    const root = mkdtempSync(join(tmpdir(), "orchestrator-repos-list-"));
    dirs.push(root);
    const config = JSON.parse(readFileSync(seed(join(root, "demo")).configFile, "utf8"));
    const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: join(root, "data"), tenant: config.tenant };
    for (const repo of config.repos) {
      await ctx.store.upsertRepo({ ...repo, tenant: config.tenant });
      await syncRepo(ctx, repo.id);
    }
    await ctx.store.upsertRepo({ tenant: ctx.tenant, id: "unread-skills", team: "Data", name: "unread-skills", url: "file:///nonexistent.git" });
    const request = (number: number, status: "open" | "merged") => ({ tenant: ctx.tenant, repoId: "payments-skills", number, provider: "local" as const, url: "", branch: `b${number}`, headSha: "a".repeat(40), title: "t", status, createdAt: new Date().toISOString(), createdBy: "x" });
    for (const [n, status] of [[1, "open"], [2, "open"], [3, "merged"]] as const) await ctx.store.saveRequest(request(n, status));

    // when
    const { repos } = await (await createApp(ctx, as(MEMBER)).request("/api/repos")).json();
    const of = (id: string) => repos.find((r: { id: string }) => r.id === id).summary;

    // then
    expect(of("payments-skills")).toEqual({ skills: 2, mcpServers: 2, commands: 1, waiting: 2, health: "fine" });
    expect(of("platform-skills")).toMatchObject({ waiting: 0, health: expect.any(String) });
    expect(of("unread-skills")).toEqual({ skills: 0, mcpServers: 0, commands: 0, waiting: 0, health: null });
  });
});
