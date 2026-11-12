import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUser, principalOf, setupFirstOwner } from "./accounts.js";
import { syncRepo } from "./app.js";
import type { OrchestratorContext } from "./app.js";
import { openSqliteStore } from "./store.js";
import { search, taskBoard } from "./task-board.js";
import type { TaskRecord } from "./tasks/types.js";

const TENANT = "acme";
const NOW = Date.parse("2026-11-03T12:00:00.000Z");
const at = (daysAgo: number) => new Date(NOW - daysAgo * 86_400_000).toISOString();
const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function task(id: string, fields: Partial<TaskRecord>): TaskRecord {
  return { tenant: TENANT, id, repoId: "shop", team: "Shop", title: `Task ${id}`, description: "", issueUrl: null, issueKey: null, agent: "fake", status: "queued", createdBy: "max@example.invalid", createdAt: at(1), startedAt: null, finishedAt: null, baseSha: null, tests: null, cost: { usd: null, inputTokens: null, outputTokens: null }, requestNumber: null, error: null, ...fields };
}

describe("the Tasks board, by whose turn it is", () => {
  it("given a person's tasks in every state, one with a request on its repository, one a teammate suggested a follow-up on, and a teammate's, when the board is read by its person, for its repository and for another, and by the owner, and a search is read, then each is in its turn with what it waits for and counted under its repository, the request's change is sized from the mirror, last month's is gone, the teammate's is not shown, and the owner reading the same tasks finds none of them in their own turn", async () => {
    // given
    const root = mkdtempSync(join(tmpdir(), "th-board-"));
    dirs.push(root);
    const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd, encoding: "utf8" }).trim();
    const bare = join(root, "shop.git");
    const work = join(root, "work");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
    execFileSync("git", ["init", "-q", "-b", "main", work]);
    writeFileSync(join(work, "a.md"), "one\ntwo\n");
    git(work, "add", ".");
    git(work, "commit", "-qm", "base");
    const base = git(work, "rev-parse", "HEAD");
    git(work, "checkout", "-qb", "task/review");
    writeFileSync(join(work, "a.md"), "one\nthree\nfour\n");
    writeFileSync(join(work, "b.md"), "new\n");
    git(work, "add", ".");
    git(work, "commit", "-qm", "change");
    const head = git(work, "rev-parse", "HEAD");
    git(bare, "fetch", "-q", work, "main:main", "task/review:task/review");
    const store = openSqliteStore(":memory:");
    const owner = await principalOf(store, await setupFirstOwner(store, TENANT, "code", { code: "code", email: "ada@example.invalid", password: "correct horse battery" }));
    const max = await principalOf(store, await createUser(store, TENANT, new Set(["Shop"]), { email: "max@example.invalid", role: "member", password: "correct horse battery" }, owner));
    const ctx: OrchestratorContext = { store, mode: "self-hosted", dataDir: join(root, "data"), tenant: TENANT, allowedHosts: null };
    await store.upsertRepo({ tenant: TENANT, id: "shop", team: "Shop", name: "Shop", url: bare });
    await syncRepo(ctx, "shop");
    await store.saveRequest({ tenant: TENANT, repoId: "shop", number: 1, provider: "local", url: "local://requests/shop/1", branch: "task/review", headSha: head, title: "Review me", status: "open", createdAt: at(1), createdBy: max.email });
    await store.saveRequest({ tenant: TENANT, repoId: "shop", number: 3, provider: "local", url: "local://requests/shop/3", branch: "task/suggested", headSha: head, title: "Suggested", status: "open", createdAt: at(1), createdBy: max.email });
    await store.saveRequest({ tenant: TENANT, repoId: "shop", number: 2, provider: "local", url: "local://requests/shop/2", branch: "task/merged", headSha: head, title: "Merged", status: "merged", createdAt: at(2), createdBy: max.email });
    const tasks = [
      task("tsk_review", { status: "needs-review", baseSha: base, requestNumber: 1, finishedAt: at(1), title: "Add the Retry note" }),
      task("tsk_kept", { status: "needs-review", baseSha: base, requestNumber: 2, finishedAt: at(2) }),
      task("tsk_suggested", { status: "needs-review", baseSha: base, requestNumber: 3, finishedAt: at(1) }),
      task("tsk_old", { status: "needs-review", baseSha: base, requestNumber: 2, finishedAt: at(30), createdAt: at(30) }),
      task("tsk_asking", { status: "running", startedAt: at(0), issueKey: "SHOP-12" }),
      task("tsk_working", { status: "running", startedAt: at(0) }),
      task("tsk_stopped", { status: "interrupted" }),
      task("tsk_failed", { status: "failed", finishedAt: at(3), error: "The plan waited 30 minutes for an answer.\nat step 4" }),
      task("tsk_asked", { status: "failed", finishedAt: at(3) }),
      task("tsk_queued", { status: "queued" }),
      task("tsk_machine", { status: "queued", runner: "local" }),
      task("tsk_lees", { status: "needs-review", team: "Other", createdBy: "lee@example.invalid", finishedAt: at(1) }),
    ];
    for (const t of tasks) await store.createTask(t);
    // A run that stopped to ask its starter one question waits on their answer, not on a retry.
    await store.updateTask(TENANT, "tsk_asked", { question: { text: "Can you paste the issue's text?", options: ["Paste it here", "Skip the issue"] } });
    // A check that broke on the request is queued for the agent, and its starter is the one to send it on.
    await store.addFollowUp({ tenant: TENANT, id: "fup_2", taskId: "tsk_review", source: "watch", key: "watch:f1", text: "Request #1 changed: the check unit failed", quotes: null, createdAt: at(0), createdBy: "watch" });
    await store.addFollowUp({ tenant: TENANT, id: "fup_1", taskId: "tsk_suggested", source: "reviewer", key: "k1", text: "also cover the retry note", quotes: null, createdAt: at(0), createdBy: "lee@example.invalid" });
    await store.recordTaskRequest({ tenant: TENANT, id: "req_1", taskId: "tsk_asking", targetPosition: null, sourceKey: "k1", kind: "command", payload: { tool: "Bash", summary: "npm test" }, createdAt: at(0), expiresAt: null });

    // when
    const board = await taskBoard(ctx, max, NOW);
    const [shop, docs] = [await taskBoard(ctx, max, NOW, "shop"), await taskBoard(ctx, max, NOW, "docs")];
    const owners = await taskBoard(ctx, owner, NOW);
    const found = await search(ctx, max, "retry");

    // then
    const ids = (turn: keyof typeof board.sections) => board.sections[turn].map((c) => [c.id, c.next]);
    expect(ids("yours").sort()).toEqual([["tsk_asked", "answer"], ["tsk_asking", "answer"], ["tsk_failed", "retry"], ["tsk_review", "follow-up"], ["tsk_stopped", "continue"], ["tsk_suggested", "follow-up"]]);
    expect(ids("agents").map(([id]) => id).sort()).toEqual(["tsk_queued", "tsk_working"]);
    expect(board.sections.waiting.map((c) => [c.id, c.waitingFor])).toEqual([["tsk_machine", "connect"]]);
    expect(ids("done").map(([id]) => id)).toEqual(["tsk_kept"]);
    expect(board.counts).toEqual({ yours: 6, agents: 2, waiting: 1, done: 1 });
    expect([shop.counts, docs.counts]).toEqual([board.counts, { yours: 0, agents: 0, waiting: 0, done: 0 }]);
    expect([board.byRepo, docs.byRepo]).toEqual([{ shop: { yours: 6, agents: 2 } }, {}]);
    expect(board.sections.yours.find((c) => c.id === "tsk_review")?.changes).toEqual({ files: 2, additions: 3, deletions: 1 });
    expect([owners.sections.yours, owners.sections.agents.map((c) => c.id).sort()]).toEqual([[], ["tsk_queued", "tsk_working"]]);
    expect(board.sections.yours.find((c) => c.id === "tsk_asking")).toMatchObject({ agent: "fake", startedAt: at(0), issueKey: "SHOP-12", reason: null });
    expect(board.sections.yours.find((c) => c.id === "tsk_failed")?.reason).toBe("The plan waited 30 minutes for an answer.");
    expect(found).toEqual({ tasks: [{ id: "tsk_review", title: "Add the Retry note", repoId: "shop", status: "needs-review" }], inLog: [], projects: [], folders: [] });
    expect((await search(ctx, max, "shop-12")).tasks.map((t) => t.id)).toEqual(["tsk_asking"]);

    // when the agent's words are searched
    await store.appendTaskLog(TENANT, "tsk_kept", ["The agent ran the Migration script."]);
    const logged = await search(ctx, max, "migration", undefined, NOW);
    const short = await search(ctx, max, "mi", undefined, NOW);

    // then they find the task, and only for words of three letters or more
    expect(logged.inLog.map((t) => t.id)).toEqual(["tsk_kept"]);
    expect(short.inLog).toEqual([]);
  });

  it("given a local orchestrator whose home holds a project named like the search, when its owner and a member of it search, then only the owner is shown the folder", async () => {
    // given
    vi.stubEnv("ORCHESTRATOR_MODE", "local");
    const root = mkdtempSync(join(tmpdir(), "th-search-"));
    dirs.push(root);
    const home = join(root, "home");
    mkdirSync(join(home, "code", "retry-tool"), { recursive: true });
    execFileSync("git", ["init", "-q", join(home, "code", "retry-tool")]);
    const store = openSqliteStore(":memory:");
    const owner = await principalOf(store, await setupFirstOwner(store, TENANT, "code", { code: "code", email: "ada@example.invalid", password: "correct horse battery" }));
    const max = await principalOf(store, await createUser(store, TENANT, new Set(["Shop"]), { email: "max@example.invalid", role: "member", password: "correct horse battery" }, owner));
    const ctx: OrchestratorContext = { store, mode: "local", dataDir: join(root, "data"), tenant: TENANT, allowedHosts: null };

    // when
    const [owners, members] = [await search(ctx, owner, "retry", home), await search(ctx, max, "retry", home)];

    // then
    expect(owners.folders.map((f) => f.name)).toEqual(["retry-tool"]);
    expect(members.folders).toEqual([]);
  });
});
