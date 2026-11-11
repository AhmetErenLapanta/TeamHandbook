import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MiddlewareHandler } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { seed } from "../demo/seed.js";
import { createApp, syncRepo } from "./app.js";
import type { OrchestratorContext } from "./app.js";
import type { OrchestratorEnv, Principal } from "./auth.js";
import { localRepoPath } from "./forge/local.js";
import { git } from "./git.js";
import { openSqliteStore } from "./store.js";

const ADMIN: Principal = { id: "a", name: "Ada Example", email: "ada@example.invalid", role: "admin", ownedTeams: [] };
const MEMBER: Principal = { id: "m", name: "Max Example", email: "max@example.invalid", role: "member", ownedTeams: [] };
const PLATFORM_OWNER: Principal = { id: "p", name: "Pat Example", email: "pat@example.invalid", role: "member", ownedTeams: ["Platform"] };

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

/** The seeded repositories, Payments asked to report skill use. */
async function seeded(): Promise<OrchestratorContext> {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-removal-"));
  dirs.push(root);
  const { configFile } = seed(join(root, "demo"));
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: join(root, "data"), tenant: config.tenant };
  const payments = config.repos.find((r: { id: string }) => r.id === "payments-skills");
  const bare = localRepoPath(payments.url)!;
  const work = mkdtempSync(join(root, "work-"));
  git(["clone", "--quiet", bare, work], work);
  const file = join(work, ".teamhandbook.json");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), usage: { endpoint: "https://orchestrator.example.invalid/ingest/usage/x/payments-skills" } }, null, 2) + "\n");
  git(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qam", "chore: report skill use"], work);
  git(["fetch", "--quiet", work, "main:main"], bare);
  for (const repo of config.repos) {
    await ctx.store.upsertRepo({ ...repo, tenant: config.tenant });
    await syncRepo(ctx, repo.id);
  }
  return ctx;
}

const hourAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 13);

const send = (app: ReturnType<typeof createApp>, method: string, path: string, body: unknown) =>
  app.request(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("what removing a skill or an MCP server takes away", () => {
  it("given a skill teammates used this month and before, when its removal is read, disabled instead and merged, then the month's use is counted, the policy blocks it and the next read offers no second policy", async () => {
    // given
    const ctx = await seeded();
    const app = createApp(ctx, as(ADMIN));
    await ctx.store.addUsage(ctx.tenant, "payments-skills", "release-checklist", hourAgo(2), 3);
    await ctx.store.addUsage(ctx.tenant, "payments-skills", "release-checklist", hourAgo(1), 2);
    await ctx.store.addUsage(ctx.tenant, "payments-skills", "release-checklist", hourAgo(45), 9);
    await ctx.store.addUsage(ctx.tenant, "payments-skills", "add-ledger-migration", hourAgo(1), 4);

    // when
    const impact = await (await app.request("/api/repos/payments-skills/removal?skill=release-checklist")).json();
    const head = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!.head;
    const saved = await (await send(app, "POST", "/api/policies", { policy: impact.disable, message: "chore: disable release-checklist", baseShas: { "payments-skills": head } })).json();
    await send(app, "POST", `/api/repos/payments-skills/requests/${saved.requests[0].number}/merge`, {});
    await syncRepo(ctx, "payments-skills");
    const after = await (await app.request("/api/repos/payments-skills/removal?skill=release-checklist")).json();

    // then
    expect(impact).toMatchObject({
      subject: "skill:release-checklist",
      usage: { counted: true, days: 30, count: 5, lastHour: hourAgo(1) },
      blockedBy: [],
      remove: { kind: "skill.delete", slug: "release-checklist" },
      disable: { name: "Disable release-checklist", audience: { kind: "teams", ids: ["Payments"] }, rules: [{ kind: "skill-access", effect: "deny", resources: ["skill:release-checklist"] }] },
    });
    expect(impact.usage.daily.map((d: { count: number }) => d.count)).toEqual([3, 2]);
    expect(saved.failed).toEqual([]);
    expect(after.blockedBy).toEqual([{ id: saved.id, name: "Disable release-checklist" }]);
    expect(after.disable).toBeNull();
  });

  it("given an MCP server, when its removal is read, then no use is claimed, since servers report none, and it is removed or blocked by its server name", async () => {
    // given
    const ctx = await seeded();
    const app = createApp(ctx, as(ADMIN));

    // when
    const impact = await (await app.request("/api/repos/payments-skills/removal?mcp=docs")).json();

    // then
    expect(impact).toMatchObject({ subject: "mcp:docs", usage: null, remove: { kind: "mcp.remove", name: "docs" }, disable: { rules: [{ kind: "mcp-access", resources: ["mcp:docs"] }] } });
  });

  it("given a team that is not asked to report, when a skill's removal is read, then it says use is not counted rather than unused", async () => {
    // given
    const ctx = await seeded();
    const app = createApp(ctx, as(ADMIN));
    const platform = (await (await app.request("/api/repos/platform-skills/inventory")).json()).inventory.skills[0].slug;

    // when
    const impact = await (await app.request(`/api/repos/platform-skills/removal?skill=${platform}`)).json();

    // then
    expect(impact.usage).toMatchObject({ counted: false, count: 0, lastHour: null, daily: [] });
  });

  it.each([
    ["a member", MEMBER, "/api/repos/payments-skills/removal?skill=release-checklist", 403],
    ["another team's owner", PLATFORM_OWNER, "/api/repos/payments-skills/removal?skill=release-checklist", 403],
    ["a skill the repository does not ship", ADMIN, "/api/repos/payments-skills/removal?skill=on-call", 404],
    ["both a skill and a server", ADMIN, "/api/repos/payments-skills/removal?skill=release-checklist&mcp=docs", 400],
    ["an unknown repository", ADMIN, "/api/repos/nowhere/removal?skill=release-checklist", 404],
  ])("given %s, when a removal is read, then it is refused", async (_label, user, path, status) => {
    // given
    const ctx = await seeded();

    // when
    const res = await createApp(ctx, as(user)).request(path);

    // then
    expect(res.status).toBe(status);
  });
});
