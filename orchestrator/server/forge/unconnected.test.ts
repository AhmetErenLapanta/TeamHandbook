import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createUser, principalOf, setupFirstOwner } from "../accounts.js";
import type { OrchestratorContext } from "../app.js";
import { TEAM_PREFIX_FILE } from "../plugin.js";
import { openSqliteStore } from "../store.js";
import type { TaskTarget } from "../tasks/types.js";
import { createVault, storeSecret } from "../vault.js";
import { DEVICE_ENDPOINTS, personTokenName, signedInKey } from "./device-sign-in.js";
import { plainGitServer } from "./stand-in-git.js";
import { openOnUnconnectedRemote } from "./unconnected.js";

const IDENTITY = ["-c", "user.name=Stand In", "-c", "user.email=stand-in@example.invalid"];
const git = (cwd: string, ...args: string[]) => execFileSync("git", [...IDENTITY, ...args], { cwd, encoding: "utf8" }).trim();

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))));
});

/**
 * A remote no organization connected, served over plain http as the stand-in for gitlab.com: its
 * default branch main keeps the team file, and the branch handbook/fix the machine pushed adds one
 * commit on main. `aside` is a commit only on that branch, deleting the team file, before its tip.
 */
async function unconnectedRemote() {
  const root = mkdtempSync(join(tmpdir(), "unconnected-"));
  const seed = join(root, "seed");
  mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, TEAM_PREFIX_FILE), `${JSON.stringify({ policies: [] })}\n`);
  writeFileSync(join(seed, "README.md"), "service\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "main");
  const base = git(seed, "rev-parse", "HEAD");
  git(seed, "switch", "-q", "-c", "handbook/fix");
  git(seed, "rm", "-q", TEAM_PREFIX_FILE);
  git(seed, "commit", "-q", "-m", "drop the team file");
  const aside = git(seed, "rev-parse", "HEAD");
  writeFileSync(join(seed, "README.md"), "service, fixed\n");
  git(seed, "commit", "-q", "-am", "fix");
  const head = git(seed, "rev-parse", "HEAD");
  git(seed, "switch", "-q", "main");
  const served = join(root, "served");
  mkdirSync(join(served, "acme"), { recursive: true });
  execFileSync("git", ["clone", "-q", "--bare", seed, join(served, "acme", "service.git")]);
  const web = await plainGitServer(served, servers);
  const endpoints = { ...DEVICE_ENDPOINTS, gitlab: { host: new URL(web).host, code: `${web}/oauth/authorize_device`, token: `${web}/oauth/token`, user: `${web}/api/v4/user` } };
  return { root, web, base, aside, head, endpoints };
}

/** Ada's machine-folder task with one change her machine pushed to that remote, and her sign-in to it with a code; the forge's REST is a stand-in that notes each call. */
async function adasTask(remote: Awaited<ReturnType<typeof unconnectedRemote>>, change: Partial<TaskTarget> = {}, branchHead = remote.head) {
  const store = openSqliteStore(":memory:");
  const ctx = { store, tenant: "acme", dataDir: join(remote.root, "data"), vault: createVault(randomBytes(32)), allowedHosts: null, privateNetworkForges: true, resolveHost: async () => ["127.0.0.1"], addedRepos: new Map() } as unknown as OrchestratorContext;
  const ada = await principalOf(store, await setupFirstOwner(store, "acme", "setup-code", { code: "setup-code", email: "ada@example.invalid", password: "correct horse battery" }));
  const machineOwner = change.reason === "not-mine" ? (await createUser(store, "acme", new Set(), { email: "bob@example.invalid", role: "member", teams: [] }, ada)).id : ada.id;
  await store.insertMachine({ tenant: "acme", id: "mch_1", userId: machineOwner, name: "ada-laptop", platform: "darwin", publicKey: "k", agents: [], createdAt: "2026-11-01T00:00:00.000Z", lastSeenAt: null, revokedAt: null, tokenHash: "h" }, null);
  const project = await store.upsertRepo({ tenant: "acme", id: "code", team: "Payments", name: "code", url: "machine:mch_1:~/code" });
  const at = new Date().toISOString();
  await store.createTask({ tenant: "acme", id: "tsk_a", repoId: "code", team: "Payments", title: "Fix the service", description: "", issueUrl: null, issueKey: null, agent: "fake", status: "needs-review", createdBy: ada.email, createdAt: at, startedAt: at, finishedAt: at, baseSha: null, tests: null, cost: { usd: null, inputTokens: null, outputTokens: null }, requestNumber: null, error: null, stage: "tests", skills: [], targetMode: "pinned" });
  const kept: TaskTarget = { repoId: "code", status: "local", reason: "not-connected", path: "service", head: remote.head, baseSha: remote.base, origin: `${remote.web}/acme/service.git`, targetBranch: "main", description: { title: "Fix the service", body: "Fixed." }, branch: "handbook/fix", tests: null, requestNumber: null, error: null, cost: { usd: null, inputTokens: null, outputTokens: null }, ...change, ...(change.reason === "not-mine" ? { reason: "not-connected" } : {}) };
  await store.setTaskTargets("acme", "tsk_a", [kept]);
  await storeSecret(store, ctx.vault ?? null, "acme", personTokenName("gitlab", ada.id), "stand-in-person-token", ada.email);
  await store.setSetting("acme", signedInKey("gitlab", ada.id), JSON.stringify({ account: "ada", host: remote.endpoints.gitlab.host }));
  const calls: { method: string; url: string; auth: string | null; body: unknown }[] = [];
  const send = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url: String(url), auth: new Headers(init?.headers).get("authorization"), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const path = new URL(String(url)).pathname;
    const answer = path.endsWith("/merge_requests") ? { iid: 5, web_url: `${remote.web}/acme/service/-/merge_requests/5`, state: "opened" } : path.includes("/repository/branches/") ? { name: "handbook/fix", commit: { id: branchHead } } : { id: 7, default_branch: "main" };
    return new Response(JSON.stringify(answer), { status: method === "POST" ? 201 : 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const task = (await store.getTask("acme", "tsk_a"))!;
  return { ctx, ada, project, task, kept, calls, send };
}

const scratchLeft = (dataDir: string) => (existsSync(join(dataDir, "work")) ? readdirSync(join(dataDir, "work")).filter((n) => n.startsWith("read-")) : []);

describe("a change a person's machine pushed to a remote no organization connected, opened with their own sign-in", () => {
  it("given the task's starter signed in with a code and their machine's branch on the remote, when they press, then the orchestrator reads and checks it, the merge request opens with their token, and nothing it read is left", async () => {
    // given
    const remote = await unconnectedRemote();
    const { ctx, ada, project, task, kept, calls, send } = await adasTask(remote);

    // when
    const answer = await openOnUnconnectedRemote(ctx, ada, task, project, kept, send, remote.endpoints);

    // then
    expect(answer).toEqual({ opened: { forge: "GitLab", account: "ada", number: 5, url: `${remote.web}/acme/service/-/merge_requests/5` } });
    expect(calls.find((c) => c.method === "POST")).toMatchObject({ auth: "Bearer stand-in-person-token", body: expect.objectContaining({ source_branch: "handbook/fix", target_branch: "main" }) });
    expect(scratchLeft(ctx.dataDir)).toEqual([]);
    rmSync(remote.root, { recursive: true, force: true });
  });

  it("given a base the machine reported that exists only on the branch and deletes the team file, when they press, then it is refused before any rule is read and nothing opens", async () => {
    // given
    const remote = await unconnectedRemote();
    const { ctx, ada, project, task, kept, calls, send } = await adasTask(remote, { baseSha: remote.aside });

    // when
    const answer = await openOnUnconnectedRemote(ctx, ada, task, project, kept, send, remote.endpoints);

    // then
    expect(answer).toEqual({ refused: `the task started from ${remote.aside.slice(0, 7)}, which is not in main on GitLab` });
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(scratchLeft(ctx.dataDir)).toEqual([]);
  });

  it("given the branch moving on the forge while the request opens, when they press, then the request is closed again with a note and they are told to read the task again", async () => {
    // given
    const remote = await unconnectedRemote();
    const { ctx, ada, project, task, kept, calls, send } = await adasTask(remote, {}, "e".repeat(40));

    // when
    const answer = await openOnUnconnectedRemote(ctx, ada, task, project, kept, send, remote.endpoints);

    // then
    expect(answer).toEqual({ refused: "handbook/fix moved on GitLab while the request opened, so it was closed again; read the task again" });
    expect(calls.filter((c) => c.method !== "GET").map((c) => [c.method, new URL(c.url).pathname])).toEqual([
      ["POST", "/api/v4/projects/acme%2Fservice/merge_requests"],
      ["POST", "/api/v4/projects/acme%2Fservice/merge_requests/5/notes"],
      ["PUT", "/api/v4/projects/acme%2Fservice/merge_requests/5"],
    ]);
  });

  it("given a task run on someone else's machine, or a remote on another host, when the starter presses, then it is refused and the forge is not asked", async () => {
    // given
    const remote = await unconnectedRemote();
    const notMine = await adasTask(remote, { reason: "not-mine" as TaskTarget["reason"] });
    const elsewhere = await adasTask(remote, { origin: "https://git.example.invalid/acme/service.git" });

    // when
    const onTheirs = await openOnUnconnectedRemote(notMine.ctx, notMine.ada, notMine.task, notMine.project, notMine.kept, notMine.send, remote.endpoints);
    const onOther = await openOnUnconnectedRemote(elsewhere.ctx, elsewhere.ada, elsewhere.task, elsewhere.project, elsewhere.kept, elsewhere.send, remote.endpoints);

    // then
    expect(onTheirs).toEqual({ refused: "the task ran on a machine that is not yours" });
    expect(onOther).toEqual({ refused: "its remote is not on github.com or gitlab.com, where a sign-in with a code opens a request" });
    expect([...notMine.calls, ...elsewhere.calls]).toEqual([]);
  });
});
