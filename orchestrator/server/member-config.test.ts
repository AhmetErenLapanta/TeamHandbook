import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MiddlewareHandler } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { seed } from "../demo/seed.js";
import { createUser, principalOf } from "./accounts.js";
import { createApp, syncRepo } from "./app.js";
import type { OrchestratorContext } from "./app.js";
import type { OrchestratorEnv, Principal } from "./auth.js";
import { openSqliteStore } from "./store.js";

const OWNER: Principal = { id: "o", name: "Olu Example", email: "olu@example.invalid", role: "owner", ownedTeams: [] };

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

async function seeded(): Promise<{ ctx: OrchestratorContext; pat: Principal; lin: Principal }> {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-member-config-"));
  dirs.push(root);
  const { configFile } = seed(join(root, "demo"));
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: join(root, "data"), tenant: config.tenant };
  for (const repo of config.repos) {
    await ctx.store.upsertRepo({ ...repo, tenant: config.tenant });
    await syncRepo(ctx, repo.id);
  }
  const teams = new Set(["Payments", "Platform"]);
  const pat = await principalOf(ctx.store, await createUser(ctx.store, ctx.tenant, teams, { email: "pat@example.invalid", name: "Pat Example", role: "member", teams: ["Payments"] }, OWNER));
  const lin = await principalOf(ctx.store, await createUser(ctx.store, ctx.tenant, teams, { email: "lin@example.invalid", name: "Lin Example", role: "member", teams: ["Platform"] }, OWNER));
  return { ctx, pat, lin };
}

const send = (app: ReturnType<typeof createApp>, method: string, path: string, body: unknown) =>
  app.request(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const block = {
  name: "Payments holds",
  audience: { kind: "teams", ids: ["Payments"] },
  rules: [
    { kind: "skill-access", effect: "deny", resources: ["skill:release-checklist"], reason: "Releases go through the release team." },
    { kind: "mcp-access", effect: "deny", resources: ["mcp:postgres/query"], reason: "Read the warehouse instead." },
    { kind: "tool-access", effect: "deny", resources: ["tool:Bash:rm *"], reason: "Nothing is deleted from a session." },
  ],
};

describe("what reaches one member", () => {
  it("given a merged policy on the Payments team, when a Payments member's configuration is read, then only Payments' repository reaches them and each rule names what it takes away", async () => {
    // given
    const { ctx, pat } = await seeded();
    const admin = createApp(ctx, as(OWNER));
    const head = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!.head;
    const saved = await (await send(admin, "POST", "/api/policies", { policy: block, message: "chore: hold payments", baseShas: { "payments-skills": head } })).json();
    await send(admin, "POST", `/api/repos/payments-skills/requests/${saved.requests[0].number}/merge`, {});
    await syncRepo(ctx, "payments-skills");

    // when
    const config = await (await createApp(ctx, as(pat)).request(`/api/members/${pat.id}/config`)).json();

    // then
    expect(config.teams).toEqual(["Payments"]);
    expect(config.repos.map((r: { repoId: string }) => r.repoId)).toEqual(["payments-skills"]);
    const [repo] = config.repos;
    expect(repo.skills.find((s: { slug: string }) => s.slug === "release-checklist").removedBy).toEqual({ resource: "skill:release-checklist", reason: "Releases go through the release team." });
    expect(repo.skills.find((s: { slug: string }) => s.slug === "add-ledger-migration").removedBy).toBeNull();
    expect(repo.mcpServers.find((m: { name: string }) => m.name === "postgres")).toEqual({ name: "postgres", removedBy: null, tools: [{ tool: "query", resource: "mcp:postgres/query", reason: "Read the warehouse instead." }] });
    expect(repo.tools).toEqual([{ resource: "tool:Bash:rm *", reason: "Nothing is deleted from a session." }]);
    expect(repo.problem).toBeNull();
    expect(config.tasks.map((t: { refusal: string | null }) => t.refusal)).toEqual([null, null]);
  });

  it("given a member, when they read their own configuration and another member's, then theirs answers and the other is refused", async () => {
    // given
    const { ctx, pat, lin } = await seeded();
    const app = createApp(ctx, as(pat));

    // when
    const own = await app.request(`/api/members/${pat.id}/config`);
    const other = await app.request(`/api/members/${lin.id}/config`);

    // then
    expect(own.status).toBe(200);
    expect(other.status).toBe(403);
    expect((await other.json()).code).toBe("forbidden");
  });

  it("given a draft blocking a skill for Payments and one keeping a member off a repository, when each is previewed for that member, then only the draft's effect differs and nothing is saved", async () => {
    // given
    const { ctx, pat } = await seeded();
    const admin = createApp(ctx, as(OWNER));
    const policiesBefore = (await (await admin.request("/api/policies")).json()).policies.length;

    // when
    const developer = await (await send(admin, "POST", `/api/members/${pat.id}/config/preview`, { audience: block.audience, rules: [block.rules[0]] })).json();
    const orchestrator = await (await send(admin, "POST", `/api/members/${pat.id}/config/preview`, { audience: { kind: "members", ids: [pat.id] }, rules: [{ kind: "repo-access", effect: "deny", repos: ["payments-skills"] }] })).json();

    // then
    const skill = (c: { repos: { skills: { slug: string; removedBy: unknown }[] }[] }) => c.repos[0]!.skills.find((s) => s.slug === "release-checklist")!.removedBy;
    expect(skill(developer.before)).toBeNull();
    expect(skill(developer.after)).toEqual({ resource: "skill:release-checklist", reason: "Releases go through the release team." });
    const start = (c: { tasks: { repoId: string; refusal: string | null }[] }) => c.tasks.find((t) => t.repoId === "payments-skills")!.refusal;
    expect(start(orchestrator.before)).toBeNull();
    expect(start(orchestrator.after)).toBe('"preview" does not let you start tasks on payments-skills.');
    expect((await (await admin.request("/api/policies")).json()).policies.length).toBe(policiesBefore);
  });

  it("given a draft that holds tasks to Approval required, when it is previewed for a member, then their tasks still start, lowered to it, and one that asks for more is the only refusal", async () => {
    // given
    const { ctx, pat } = await seeded();
    const admin = createApp(ctx, as(OWNER));

    // when
    const careful = await (await send(admin, "POST", `/api/members/${pat.id}/config/preview`, { audience: { kind: "workspace" }, rules: [{ kind: "task-mode", ceiling: "approval-required", repos: ["*"] }] })).json();

    // then
    expect(careful.after.tasks.map((t: { refusal: string | null }) => t.refusal)).toEqual(careful.before.tasks.map(() => null));
  });

  it("given a draft no policy holds, when it is previewed, then it is refused with the policy's own code", async () => {
    // given
    const { ctx, pat } = await seeded();

    // when
    const res = await send(createApp(ctx, as(OWNER)), "POST", `/api/members/${pat.id}/config/preview`, { audience: { kind: "members", ids: [pat.id] }, rules: [block.rules[0]] });

    // then
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("policy-audience");
  });
});
