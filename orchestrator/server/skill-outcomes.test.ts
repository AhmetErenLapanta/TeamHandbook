import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createUser, principalOf, setupFirstOwner } from "./accounts.js";
import { syncRepo } from "./app.js";
import type { OrchestratorContext } from "./app.js";
import { skillOutcomes } from "./skill-outcomes.js";
import { openSqliteStore } from "./store.js";
import type { TaskRecord } from "./tasks/types.js";

const TENANT = "acme";
const NOW = Date.parse("2026-11-03T12:00:00.000Z");
const at = (daysAgo: number) => new Date(NOW - daysAgo * 86_400_000).toISOString();
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function task(id: string, fields: Partial<TaskRecord>): TaskRecord {
  return { tenant: TENANT, id, repoId: "shop", team: "Shop", title: `Task ${id}`, description: "", issueUrl: null, issueKey: null, agent: "fake", status: "needs-review", createdBy: "max@example.invalid", createdAt: at(10), startedAt: null, finishedAt: at(10), baseSha: null, tests: null, cost: { usd: null, inputTokens: null, outputTokens: null }, requestNumber: null, error: null, ...fields };
}

const kept = { result: "changes" as const, changes: { files: [], undone: null, kept: { at: at(9), by: "max@example.invalid" } } };
const undone = { result: "changes" as const, changes: { files: [], undone: { at: at(9), by: "max@example.invalid", kept: [] }, kept: null } };

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "th-outcomes-"));
  dirs.push(root);
  const store = openSqliteStore(":memory:");
  const owner = await principalOf(store, await setupFirstOwner(store, TENANT, "code", { code: "code", email: "ada@example.invalid", password: "correct horse battery" }));
  const max = await principalOf(store, await createUser(store, TENANT, new Set(["Shop"]), { email: "max@example.invalid", role: "member", password: "correct horse battery" }, owner));
  const ctx: OrchestratorContext = { store, mode: "self-hosted", dataDir: join(root, "data"), tenant: TENANT, allowedHosts: null };
  return { root, store, ctx, owner, max };
}

async function seed(store: OrchestratorContext["store"], tasks: TaskRecord[]) {
  for (const t of tasks) {
    await store.createTask(t);
    if (t.changes) await store.setTaskChanges(TENANT, t.id, { ...t.changes, before: "tree-before", after: "tree-after" });
    if (t.result === "request") await store.updateTask(TENANT, t.id, { result: "request" });
  }
}

async function requests(store: OrchestratorContext["store"]) {
  await store.saveRequest({ tenant: TENANT, repoId: "shop", number: 1, provider: "local", url: "local://requests/shop/1", branch: "task/one", headSha: "a".repeat(40), title: "One", status: "merged", createdAt: at(10), createdBy: "max@example.invalid" });
  await store.saveRequest({ tenant: TENANT, repoId: "shop", number: 2, provider: "local", url: "local://requests/shop/2", branch: "task/two", headSha: "b".repeat(40), title: "Two", status: "closed", createdAt: at(10), createdBy: "max@example.invalid" });
}

/** A team repository the orchestrator mirrors, with the skill added to it at this time. */
async function teamRepoWith(root: string, ctx: OrchestratorContext, skill: string, addedAt: string) {
  const bare = join(root, "team.git");
  const work = join(root, "work");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  mkdirSync(join(work, "skills", skill), { recursive: true });
  writeFileSync(join(work, "skills", skill, "SKILL.md"), `---\nname: ${skill}\ndescription: Write the release notes\n---\n`);
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: work, env: { ...process.env, GIT_COMMITTER_DATE: addedAt, GIT_AUTHOR_DATE: addedAt } });
  git("add", ".");
  git("commit", "-qm", `add ${skill}`);
  execFileSync("git", ["fetch", "-q", work, "main:main"], { cwd: bare });
  await ctx.store.upsertRepo({ tenant: TENANT, id: "team", team: "Shop", name: "Team", url: bare });
  await syncRepo(ctx, "team");
}

const bucket = (tasks: number, accepted: number, acceptedWithoutRevision: number, rejected: number, rates: { withoutRevision: number | null; rejected: number | null } = { withoutRevision: null, rejected: null }) => ({ tasks, accepted, acceptedWithoutRevision, revisionRoundsMedian: tasks ? 0 : null, rejected, rates });

describe("a skill's tasks before and after it, with it and without it", () => {
  it("given a team skill added to a mirrored team repository, tasks started with it or whose agent called it, and without it on its project, around it and elsewhere, when its outcomes are read, then the pivot is the commit that added it, each bucket counts only decided tasks started by a person on that project, revisions are the follow-ups from a person or a watch, and a bucket under five tasks has no rates", async () => {
    // given
    const { root, store, ctx, max } = await setup();
    await teamRepoWith(root, ctx, "release-notes", at(20));
    await requests(store);
    const skill = { skills: ["release-notes"] };
    await seed(store, [
      task("tsk_with1", { ...skill, ...kept }),
      task("tsk_with2", { ...skill, ...kept }),
      task("tsk_with3", kept),
      task("tsk_with4", { tools: { skills: [{ source: "src_1", name: "release-notes", head: null }], mcpServers: [] }, result: "request", requestNumber: 1 }),
      task("tsk_with5", { ...skill, ...undone }),
      task("tsk_waiting", { ...skill, result: "changes", changes: { files: [], undone: null, kept: null } }),
      task("tsk_child", { ...skill, ...kept, parentId: "tsk_with1" }),
      task("tsk_plain1", kept),
      task("tsk_plain2", { result: "request", requestNumber: 2 }),
      task("tsk_elsewhere", { ...kept, repoId: "docs" }),
      task("tsk_lees", { ...skill, ...kept, team: "Other", createdBy: "lee@example.invalid" }),
      task("tsk_earlier", { ...kept, createdAt: at(30) }),
      task("tsk_long_ago", { ...kept, createdAt: at(55) }),
    ]);
    await store.noteUsedSkill(TENANT, "tsk_with3", "release-notes");
    const followUp = (id: string, taskId: string, source: "person" | "watch" | "child") => store.addFollowUp({ tenant: TENANT, id, taskId, source, key: id, text: "also cover the summary", quotes: null, createdAt: at(10), createdBy: max.email });
    for (const [id, taskId, source] of [["fup_1", "tsk_with1", "person"], ["fup_2", "tsk_with1", "person"], ["fup_3", "tsk_with2", "watch"], ["fup_4", "tsk_with2", "child"]] as const) await followUp(id, taskId, source);
    await store.markFollowUpsDelivered(TENANT, ["fup_1", "fup_2", "fup_3", "fup_4"], at(10));

    // when
    const outcomes = await skillOutcomes(ctx, max, "release-notes", 30, NOW);

    // then
    expect(outcomes).toEqual({
      skill: "release-notes",
      pivot: at(20),
      minimum: 5,
      before: bucket(1, 1, 1, 0),
      with: bucket(5, 4, 2, 1, { withoutRevision: 0.4, rejected: 0.2 }),
      without: bucket(2, 1, 1, 1),
    });
    expect(JSON.stringify(outcomes)).not.toMatch(/shop|tsk_|task\//);
  });

  it("given a skill kept from a lesson candidate, a later candidate of it still waiting, and tasks on the lesson's project by the person who kept it and by a teammate, when the owner reads its outcomes, then the pivot is when it was kept, the keeper's tasks after it are with it, the teammate's are without it, and the commit in the team repository does not move the pivot", async () => {
    // given
    const { root, store, ctx, owner } = await setup();
    await teamRepoWith(root, ctx, "release-notes", at(5));
    await requests(store);
    await store.setSetting(TENANT, "task.lessons.tsk_source", JSON.stringify({ at: at(25), signals: ["sig_1"], outcome: "kept", candidates: [{ slug: "changelog", keptAt: at(40) }, { slug: "release-notes", keptAt: at(20) }] }));
    await store.setSetting(TENANT, "task.lessons.tsk_broken", "not json");
    await store.setSetting(TENANT, "task.lessons.tsk_pending", JSON.stringify({ at: at(15), signals: [], outcome: "pending", candidates: [{ slug: "release-notes", keptAt: null }] }));
    const lee = { createdBy: "lee@example.invalid" };
    await seed(store, [
      task("tsk_source", { ...kept, createdAt: at(25) }),
      task("tsk_mine1", kept),
      task("tsk_mine2", kept),
      task("tsk_mine3", undone),
      task("tsk_lee1", { ...lee, ...kept }),
      task("tsk_lee2", { ...lee, result: "request", requestNumber: 2 }),
      task("tsk_elsewhere", { ...kept, repoId: "docs" }),
    ]);

    // when
    const outcomes = await skillOutcomes(ctx, owner, "release-notes", 30, NOW);

    // then
    expect(outcomes).toEqual({ skill: "release-notes", pivot: at(20), minimum: 5, before: bucket(1, 1, 1, 0), with: bucket(3, 2, 2, 1), without: bucket(2, 1, 1, 1) });
  });
});
