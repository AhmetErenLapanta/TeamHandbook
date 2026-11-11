import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { mirrorDir } from "./app.js";
import type { Principal } from "./auth.js";
import { readInventory } from "./inventory.js";
import { teamProblems, teamShared } from "./team-routes.js";
import { seededContext } from "./test-fixtures.js";
import type { TaskRecord } from "./tasks/types.js";

const OWNER: Principal = { id: "usr_owner", name: "Ada", email: "ada@example.invalid", role: "owner", ownedTeams: [] };
const MEMBER: Principal = { id: "usr_member", name: "Max", email: "max@example.invalid", role: "member", ownedTeams: [] };
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("what the Team page reads of the team's repositories", () => {
  it("given a team repository read cleanly and one whose last sync failed, when the owner and a member read what stops teammates, then the owner is told the failed sync with its address masked and the member, who edits neither, is told nothing", async () => {
    // given
    const { ctx, root } = await seededContext("orchestrator-team-", ["payments-skills"]);
    dirs.push(root);
    await ctx.store.upsertRepo({ tenant: ctx.tenant, id: "broken-skills", team: "Payments", name: "broken-skills", url: "https://git.example.invalid/acme/broken-skills.git" });
    await ctx.store.recordSync(ctx.tenant, "broken-skills", { error: "fatal: unable to access https://someone:stand-in-secret@git.example.invalid/acme/broken-skills.git" });

    // when
    const [owners, members] = [await teamProblems(ctx, OWNER), await teamProblems(ctx, MEMBER)];

    // then
    const failed = owners.find((p) => p.repoId === "broken-skills");
    expect(failed).toMatchObject({ repoName: "broken-skills", team: "Payments", title: "The last sync failed", next: null, fix: null });
    expect(failed!.detail).not.toContain("stand-in-secret");
    expect(owners.filter((p) => p.repoId === "payments-skills").every((p) => p.title && (p.fix === null || p.fix === "refresh"))).toBe(true);
    expect(members).toEqual([]);
  });

  it("given a team repository's skills and MCP servers and tasks started with one of the skills, one of them before the window, when what the team shares is read, then every skill and server is named once with its repository, the skill counts the tasks of the window alone, and a server's count is unknown", async () => {
    // given
    const { ctx, root } = await seededContext("orchestrator-team-", ["payments-skills"]);
    dirs.push(root);
    const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;
    const inventory = await readInventory(mirrorDir(ctx, repo.id), repo.head!);
    const skill = inventory.skills[0]!.slug;
    const now = Date.parse("2026-11-04T12:00:00.000Z");
    const task = (id: string, daysAgo: number): TaskRecord => ({ tenant: ctx.tenant, id, repoId: repo.id, team: repo.team, title: "t", description: "", issueUrl: null, issueKey: null, agent: "fake", status: "needs-review", createdBy: OWNER.email, createdAt: new Date(now - daysAgo * 86_400_000).toISOString(), startedAt: null, finishedAt: null, baseSha: null, tests: null, cost: { usd: null, inputTokens: null, outputTokens: null }, requestNumber: null, error: null, skills: [skill] });
    for (const t of [task("tsk_recent1", 2), task("tsk_recent2", 5), task("tsk_old", 40)]) await ctx.store.createTask(t);

    // when
    const shared = await teamShared(ctx, OWNER, 30, now);

    // then
    expect(shared.skills.map((s) => [s.slug, s.repoId, s.tasks])).toEqual(inventory.skills.map((s) => [s.slug, repo.id, s.slug === skill ? 2 : 0]));
    expect(shared.mcpServers).toEqual(inventory.mcpServers.map((s) => ({ name: s.name, repoId: repo.id, repoName: repo.name, tasks: null })));
    expect(shared.mcpServers.length).toBeGreaterThan(0);
  });
});
