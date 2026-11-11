import { generateKeyPairSync, randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUser, principalOf, setupFirstOwner } from "../accounts.js";
import type { OrchestratorContext } from "../app.js";
import { openSqliteStore } from "../store.js";
import type { RepoRecord } from "../store.js";
import { createVault } from "../vault.js";
import { forgetMintedTokens } from "./oauth-github.js";
import { sealGitLabTokens, writeConnection } from "./oauth.js";
import { matchRunnerRequest, taskOfDeliveredRequest } from "./runner-request.js";
import { UNKNOWN_COST } from "../tasks/types.js";
import type { TaskRecord } from "../tasks/types.js";
import { startStandInForge } from "./stand-in-forge.js";
import type { StandInForge } from "./stand-in-forge.js";

const TENANT = "acme";
const CODE = "setup-code-for-tests";
const BRANCH = "handbook/add-retry-skill-a1b2c3";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });

const forges: StandInForge[] = [];
beforeEach(() => forgetMintedTokens());
afterEach(async () => {
  await Promise.all(forges.splice(0).map((f) => f.close()));
});

/**
 * An org connected to a stand-in forge, with `account/skills` reached through the connection and Pat, whose forge login is pat-forge, to start tasks;
 * `alone`, Ada's orchestrator with no other account, where she starts them as ada-forge.
 */
async function org(kind: "gitlab" | "github", alone = false) {
  const forge = await startStandInForge(kind);
  forges.push(forge);
  const account = kind === "gitlab" ? "ada-gl" : "acme-org";
  const apiUrl = kind === "gitlab" ? `${forge.webUrl}/api/v4` : `${forge.webUrl}/api`;
  const store = openSqliteStore(":memory:");
  const ctx: OrchestratorContext = {
    store,
    dataDir: join(mkdtempSync(join(tmpdir(), "runner-request-")), "data"),
    tenant: TENANT,
    vault: createVault(randomBytes(32)),
    addedRepos: new Map(),
    forgeApps: kind === "gitlab" ? { gitlab: { kind, webUrl: forge.webUrl, apiUrl, clientId: "stand-in", clientSecret: "stand-in-secret" } } : { github: { kind, webUrl: forge.webUrl, apiUrl, appId: "1", slug: "teamhandbook-orchestrator", clientId: "Iv1.stand-in", clientSecret: "stand-in-secret", privateKey } },
  };
  const owner = await principalOf(store, await setupFirstOwner(store, TENANT, CODE, { code: CODE, email: "ada@example.invalid", password: "correct horse battery" }));
  const starter = alone ? owner : await createUser(store, TENANT, new Set(["Payments"]), { email: "pat@example.invalid", role: "member", teams: ["Payments"] }, owner);
  await store.updateUser(TENANT, starter.id, { forgeLogin: alone ? "Ada-Forge" : "Pat-Forge" });
  const at = new Date().toISOString();
  if (kind === "gitlab") {
    await sealGitLabTokens(ctx, { accessToken: forge.token, refreshToken: "stand-in-refresh", expiresAt: new Date(Date.now() + 7_200_000).toISOString() }, owner.email);
    await writeConnection(ctx, "gitlab", { via: "oauth", account, apiUrl, by: owner.name, byEmail: owner.email, at, problem: null });
  } else {
    await writeConnection(ctx, "github", { via: "app", account, organization: true, installationId: 5, apiUrl, by: owner.name, byEmail: owner.email, at, problem: null });
  }
  forge.addRepo(`${account}/skills`, { withCommit: true });
  const repo: RepoRecord = await store.upsertRepo({ tenant: TENANT, id: "skills", team: "Payments", name: "skills", url: `${forge.webUrl}/${account}/skills.git` });
  await store.setForgeConfig(TENANT, { repoId: "skills", kind, apiUrl, project: `${account}/skills` });
  ctx.addedRepos!.set("skills", { id: "skills", forge: kind, kind: "skills", skillsFrom: null, gitOrigin: forge.webUrl, memberUrl: null, addedBy: owner.email, addedAt: at, connection: kind });
  const expected = { repo, branch: BRANCH, starterEmail: starter.email, held: async () => true };
  return { forge, ctx, store, pat: starter, account, expected };
}

describe("recognising the request a person's machine opened for a task", () => {
  it("given a request from the task's branch opened by its starter, when the runner names it, then the orchestrator takes it as the task's, with the address and commit the forge gives", async () => {
    const { forge, ctx, account, expected } = await org("gitlab");
    const number = forge.openRequest(`${account}/skills`, { branch: BRANCH, author: "pat-forge" });

    const match = await matchRunnerRequest(ctx, expected, number);

    expect(match).toEqual({ ok: true, request: { number, url: `${forge.webUrl}/${account}/skills/-/merge_requests/${number}`, headSha: expect.stringMatching(/^[0-9a-f]{40}$/) } });
    const reported = match.ok ? match.request.headSha : "";
    expect((await matchRunnerRequest(ctx, { ...expected, headSha: reported }, number)).ok).toBe(true);
  });

  it("given a runner that no longer holds the task's lease, when it names its request, then it is refused and the forge is never asked", async () => {
    const { forge, ctx, account, expected } = await org("gitlab");
    const number = forge.openRequest(`${account}/skills`, { branch: BRANCH, author: "pat-forge" });
    const asked = forge.calls.length;

    expect(await matchRunnerRequest(ctx, { ...expected, held: async () => false }, number)).toEqual({ ok: false, reason: "the runner no longer holds the task, so its request is not taken" });
    expect(forge.calls.slice(asked).some((c) => c.path.includes("merge_requests"))).toBe(false);
  });

  it("given a runner whose lease ends while the forge is read, when it names its request, then the request is refused all the same", async () => {
    const { forge, ctx, account, expected } = await org("gitlab");
    const number = forge.openRequest(`${account}/skills`, { branch: BRANCH, author: "pat-forge" });
    const answers = [true, false];

    expect(await matchRunnerRequest(ctx, { ...expected, held: async () => answers.shift()! }, number)).toEqual({ ok: false, reason: "the runner no longer holds the task, so its request is not taken" });
  });

  it("given a request from another branch, when the runner names it, then it is not the task's", async () => {
    const { forge, ctx, account, expected } = await org("gitlab");
    const number = forge.openRequest(`${account}/skills`, { branch: "handbook/someone-else", author: "pat-forge" });
    expect(await matchRunnerRequest(ctx, expected, number)).toEqual({ ok: false, reason: `request ${number} is from handbook/someone-else, not the task's branch ${BRANCH}` });
  });

  it("given the task's branch opened by someone else, when the runner names it, then it is not the task's", async () => {
    const { forge, ctx, account, expected } = await org("gitlab");
    const number = forge.openRequest(`${account}/skills`, { branch: BRANCH, author: "mallory" });
    expect(await matchRunnerRequest(ctx, expected, number)).toMatchObject({ ok: false, reason: expect.stringContaining("opened by mallory") });
  });

  it("given the task's branch name pushed from a fork, when a delivery names it, then it is not the task's", async () => {
    const { forge, ctx, account, expected } = await org("gitlab");
    const number = forge.openRequest(`${account}/skills`, { branch: BRANCH, author: "pat-forge", fromFork: true });
    expect(await matchRunnerRequest(ctx, expected, number)).toMatchObject({ ok: false, reason: expect.stringContaining("from a fork") });
  });

  it("given the runner reports another commit than the request is at, when it names the request, then it is not the task's", async () => {
    const { forge, ctx, account, expected } = await org("gitlab");
    const number = forge.openRequest(`${account}/skills`, { branch: BRANCH, author: "pat-forge" });
    expect(await matchRunnerRequest(ctx, { ...expected, headSha: "f".repeat(40) }, number)).toMatchObject({ ok: false, reason: expect.stringContaining("another commit") });
  });

  it("given a starter with no forge login, or a login two accounts share, when a request is named, then nobody's request is taken and the forge is not asked", async () => {
    const { forge, ctx, store, account, expected, pat } = await org("gitlab");
    const number = forge.openRequest(`${account}/skills`, { branch: BRANCH, author: "pat-forge" });
    const other = await createUser(store, TENANT, new Set(["Payments"]), { email: "max@example.invalid", role: "member", teams: [] }, await principalOf(store, (await store.listUsers(TENANT)).find((u) => u.role === "owner")!));
    await store.updateUser(TENANT, other.id, { forgeLogin: "pat-forge" });
    const before = forge.calls.length;

    expect(await matchRunnerRequest(ctx, expected, number)).toMatchObject({ ok: false, reason: expect.stringContaining("more than one orchestrator user") });
    await store.updateUser(TENANT, other.id, { forgeLogin: null });
    await store.updateUser(TENANT, pat.id, { forgeLogin: null });
    expect(await matchRunnerRequest(ctx, expected, number)).toMatchObject({ ok: false, reason: expect.stringContaining("has no forge login") });
    expect(forge.calls.length).toBe(before);
  });

  it("given a repository the orchestrator has no forge access to, when a request is named, then it cannot be recognised and is marked not verified", async () => {
    const { ctx, store, expected } = await org("gitlab");
    await store.deleteForgeConfig(TENANT, "skills");
    expect(await matchRunnerRequest(ctx, expected, 1)).toEqual({ ok: false, reason: "the orchestrator has no access to this repository's forge to recognize the request", unverified: true });
  });

  it("given GitHub, when the task's pull request and one from a fork are named, then only the first is the task's", async () => {
    const { forge, ctx, account, expected } = await org("github");
    const own = forge.openRequest(`${account}/skills`, { branch: BRANCH, author: "pat-forge" });
    const fork = forge.openRequest(`${account}/skills`, { branch: BRANCH, author: "pat-forge", fromFork: true });

    expect(await matchRunnerRequest(ctx, expected, own)).toMatchObject({ ok: true, request: { number: own, url: `${forge.webUrl}/${account}/skills/pull/${own}` } });
    expect(await matchRunnerRequest(ctx, expected, fork)).toMatchObject({ ok: false, reason: expect.stringContaining("from a fork") });
  });
});

describe("recognising a request a webhook delivers", () => {
  const task = (over: Partial<TaskRecord>): TaskRecord => ({
    tenant: TENANT, id: "tsk_local0001", repoId: "skills", team: "Payments", title: "Add the retry skill", description: "", issueUrl: null, issueKey: null, agent: "fake", status: "running",
    createdBy: "pat@example.invalid", createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, baseSha: null, tests: null, cost: UNKNOWN_COST, requestNumber: null, error: null, ...over,
  });

  it("given a running task with its branch, when a delivery names a request from that branch by its starter, then it is that task's", async () => {
    const { forge, ctx, store, account } = await org("gitlab");
    await store.createTask(task({}));
    await store.setTaskBranch(TENANT, "tsk_local0001", BRANCH);
    const number = forge.openRequest(`${account}/skills`, { branch: BRANCH, author: "pat-forge" });

    expect(await taskOfDeliveredRequest(ctx, (await store.getRepo(TENANT, "skills"))!, number)).toMatchObject({ taskId: "tsk_local0001", request: { number } });
  });

  it("given a task running on the person's machine with its branch, when a delivery names a request from that branch by its starter, then it is that task's as well", async () => {
    const { forge, ctx, store, account } = await org("github");
    await store.createTask(task({ id: "tsk_machine01", runner: "local" }));
    await store.setTaskBranch(TENANT, "tsk_machine01", BRANCH);
    const number = forge.openRequest(`${account}/skills`, { branch: BRANCH, author: "pat-forge" });

    expect(await taskOfDeliveredRequest(ctx, (await store.getRepo(TENANT, "skills"))!, number)).toMatchObject({ taskId: "tsk_machine01", request: { number } });
  });

  it("given a delivery from a branch no unfinished task named, or the task's branch opened by someone else, when it arrives, then it is nobody's and says why", async () => {
    const { forge, ctx, store, account } = await org("gitlab");
    await store.createTask(task({}));
    await store.setTaskBranch(TENANT, "tsk_local0001", BRANCH);
    const repo = (await store.getRepo(TENANT, "skills"))!;
    const stray = forge.openRequest(`${account}/skills`, { branch: "handbook/stray", author: "pat-forge" });
    const other = forge.openRequest(`${account}/skills`, { branch: BRANCH, author: "mallory" });

    expect(await taskOfDeliveredRequest(ctx, repo, stray)).toEqual({ reason: `request ${stray} is from handbook/stray, which no unfinished task named` });
    expect(await taskOfDeliveredRequest(ctx, repo, other)).toMatchObject({ reason: expect.stringContaining("opened by mallory") });
  });

  it("given the task already finished, when a delivery names a request from its branch, then it is nobody's", async () => {
    const { forge, ctx, store, account } = await org("gitlab");
    await store.createTask(task({ status: "needs-review" }));
    await store.setTaskBranch(TENANT, "tsk_local0001", BRANCH);
    const number = forge.openRequest(`${account}/skills`, { branch: BRANCH, author: "pat-forge" });

    expect(await taskOfDeliveredRequest(ctx, (await store.getRepo(TENANT, "skills"))!, number)).toMatchObject({ reason: expect.stringContaining("no unfinished task") });
  });
});

describe("recognising a request in local mode, with no token here", () => {
  afterEach(() => vi.unstubAllEnvs());

  const SHA = "a".repeat(40);

  /** A stand-in gh on PATH: signed in or not, answering `gh api` with `answer` and noting each call. */
  function ownGh(signedIn: boolean, answer: { status: number; body?: unknown }): () => string[] {
    const dir = mkdtempSync(join(tmpdir(), "own-gh-"));
    const calls = join(dir, "calls");
    writeFileSync(calls, "");
    writeFileSync(join(dir, "answer.json"), JSON.stringify(answer.body ?? {}));
    const script = [
      "#!/bin/sh",
      `echo "$*" >> '${calls}'`,
      'case "$1" in',
      `  auth) exit ${signedIn ? 0 : 1} ;;`,
      answer.status === 200 ? `  api) cat '${join(dir, "answer.json")}' ;;` : `  api) echo 'gh: Not Found (HTTP ${answer.status})' >&2; exit 1 ;;`,
      "  *) exit 1 ;;",
      "esac",
    ].join("\n");
    writeFileSync(join(dir, "gh"), `${script}\n`);
    chmodSync(join(dir, "gh"), 0o755);
    vi.stubEnv("PATH", `${dir}${delimiter}${process.env.PATH}`);
    return () => readFileSync(calls, "utf8").trim().split("\n").filter(Boolean);
  }

  /** The repository connected with no token: neither the org's connection nor a token of its own reaches it. Ada's alone, as the person's own CLI is used only on an orchestrator one person reaches. */
  async function local(ownForgeCli: boolean) {
    const made = await org("github", true);
    made.ctx.addedRepos!.set("skills", { ...made.ctx.addedRepos!.get("skills")!, connection: undefined, viaOwnCli: true });
    made.ctx.ownForgeCli = ownForgeCli;
    return made;
  }

  const pull = (account: string, login: string) => ({ head: { ref: BRANCH, sha: SHA, repo: { full_name: `${account}/skills` } }, base: { repo: { full_name: `${account}/skills` } }, user: { login }, html_url: `https://github.example.invalid/${account}/skills/pull/7`, state: "open" });

  it("given gh signed in on this machine, when the runner names its request, then the orchestrator reads it through gh alone and takes it as the task's", async () => {
    const { ctx, forge, account, expected } = await local(true);
    const calls = ownGh(true, { status: 200, body: pull(account, "ada-forge") });

    const match = await matchRunnerRequest(ctx, expected, 7);

    expect(match).toEqual({ ok: true, request: { number: 7, url: `https://github.example.invalid/${account}/skills/pull/7`, headSha: SHA } });
    expect(calls().filter((c) => c.startsWith("api"))).toEqual([`api --hostname 127.0.0.1 repos/${account}/skills/pulls/7`]);
    expect(forge.calls).toEqual([]);
  });

  it("given gh reading a request someone else opened, when the runner names it, then it is refused as not the task's, not as unverified", async () => {
    const { ctx, account, expected } = await local(true);
    ownGh(true, { status: 200, body: pull(account, "someone-else") });

    const match = await matchRunnerRequest(ctx, expected, 7);

    expect(match).toMatchObject({ ok: false, reason: expect.stringContaining("opened by someone-else") });
    expect(match).not.toHaveProperty("unverified");
  });

  it("given gh answering that the forge has no such request, when the runner names it, then it says so", async () => {
    const { ctx, expected } = await local(true);
    ownGh(true, { status: 404 });

    expect(await matchRunnerRequest(ctx, expected, 7)).toEqual({ ok: false, reason: "the forge has no request 7 in skills" });
  });

  it("given gh not signed in, when the runner names its request, then it is opened but not verified, with the command that signs in", async () => {
    const { ctx, expected } = await local(true);
    ownGh(false, { status: 200 });

    expect(await matchRunnerRequest(ctx, expected, 7)).toEqual({ ok: false, reason: expect.stringContaining("gh auth login --hostname 127.0.0.1"), unverified: true });
  });

  it("given an orchestrator others reach with no token for the repository, when the runner names its request, then it is not verified and gh is never asked", async () => {
    const { ctx, expected } = await local(false);
    const calls = ownGh(true, { status: 200 });

    expect(await matchRunnerRequest(ctx, expected, 7)).toEqual({ ok: false, reason: "the orchestrator has no access to this repository's forge to recognize the request", unverified: true });
    expect(calls()).toEqual([]);
  });
});
