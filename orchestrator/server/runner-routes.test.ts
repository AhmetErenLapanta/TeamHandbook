import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createUser, principalOf, setupFirstOwner, startSession } from "./accounts.js";
import { createApp } from "./app.js";
import type { OrchestratorContext } from "./app.js";
import { CSRF_HEADER, sessionCookie } from "./auth.js";
import { ROUTE_SCOPES } from "./route-scopes.js";
import { createRunnerService } from "./runner-service.js";
import { openSqliteStore } from "./store.js";
import { setTaskSecret } from "./task-secrets.js";
import { createVault } from "./vault.js";
import type { Store } from "./store.js";
import type { TaskRecord } from "./tasks/types.js";
import type { CheckoutWork } from "../runner/link.js";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ATTACHMENT_LIMITS, attachmentPath } from "./attachments.js";
import { ON_A_MACHINE, syncRepo } from "./app.js";
import { eventOf, organizationRunners } from "./runner-routes.js";
import { checksOnMachine, pushOnMachine } from "./machine-folders.js";
import { TODOS_MAX } from "../shared/runner-wire.js";
import { refreshRequest } from "./propose.js";
import { newId } from "./ids.js";
import { addedCodeTarget } from "./connect.js";
import { localRepoPath } from "./forge/local.js";
import { editRefusal } from "./tasks/task-policy.js";
import { seed } from "../demo/seed.js";
import { fakeAgentAdapter } from "./tasks/agents.js";
import { createTaskRunner } from "./tasks/runner.js";
import { CALL_BYTES, PROTOCOL_HEADER, RUNNER_PATHS, RUNNER_PROTOCOL, SIGNATURE_HEADER } from "../shared/runner-wire.js";
import { signRunnerRequest } from "./runner-auth.js";

const TENANT = "acme";
const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const MEMBER_URL = "https://git.example.invalid/acme/payments-skills.git";
const FAKE_AGENT = join(import.meta.dirname, "..", "demo", "fake-agent.mjs");
const PASSWORD = "correct horse battery";

function task(id: string, createdBy: string, createdAt: string): TaskRecord {
  return {
    tenant: TENANT,
    id,
    repoId: "payments-skills",
    team: "Payments",
    title: "Add a note",
    description: "",
    issueUrl: null,
    issueKey: null,
    agent: "fake",
    status: "queued",
    createdBy,
    createdAt,
    startedAt: null,
    finishedAt: null,
    baseSha: null,
    tests: null,
    cost: { usd: null, inputTokens: null, outputTokens: null },
    requestNumber: null,
    error: null,
    runner: "local",
  };
}

/**
 * A team's orchestrator with Max and Lee, each with a paired machine that signs its calls with its
 * own key. `wired` gives it the task runner and runner service the orchestrator's start gives every
 * organization; left out, a machine is handed one fixed piece of work.
 */
async function organization(options: { dataDir?: string; wired?: boolean; tenant?: string; store?: Store } = {}) {
  const tenant = options.tenant ?? TENANT;
  const store = options.store ?? openSqliteStore(":memory:");
  const owner = await principalOf(store, await setupFirstOwner(store, tenant, "code", { code: "code", email: "ada@example.invalid", password: PASSWORD }));
  const max = await createUser(store, tenant, new Set(["Payments"]), { email: "max@example.invalid", role: "member", password: PASSWORD }, owner);
  const lee = await createUser(store, tenant, new Set(["Payments"]), { email: "lee@example.invalid", role: "member", password: PASSWORD }, owner);
  const work: CheckoutWork = { prompt: "Add a note", mode: "auto-accept-edits", choices: null, repo: { url: "https://gitlab.example.invalid/acme/payments-skills.git", baseBranch: "main", baseSha: "b".repeat(40) }, branch: "task/tsk_max", rules: [], setup: { plugin: null, mcpTools: [], deniedTools: [] }, limits: { timeoutMs: 1_800_000, testCommand: null } };
  // A wired runner takes the data directory's lock, so even a test that names none gets one of its own, never one in the repository.
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), "runner-routes-"));
  if (!options.dataDir) dirs.push(dataDir);
  const ctx: OrchestratorContext = { store, mode: "self-hosted", dataDir, tenant, allowedHosts: null };
  if (options.wired) {
    ctx.tasks = createTaskRunner(ctx, { agents: [fakeAgentAdapter(FAKE_AGENT)], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH }, timeoutMs: 600_000, codeTarget: (repo) => addedCodeTarget(ctx, repo.id) });
    await ctx.tasks.ready();
    ctx.runnerService = organizationRunners(ctx);
  } else ctx.runnerService = createRunnerService({ tenant, store, describeWork: async () => work });
  const app = createApp(ctx);
  const cookieOf = async (userId: string) => `${sessionCookie(tenant)}=${(await startSession(store, tenant, userId)).token}`;
  const machineOf = async (userId: string) => {
    const cookie = await cookieOf(userId);
    const { csrf } = await (await app.request("/api/me", { headers: { cookie } })).json();
    const { code } = await (await app.request("/api/machines/pair", { method: "POST", headers: { cookie, [CSRF_HEADER]: csrf, "content-type": "application/json" }, body: "{}" })).json();
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const sent = (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32).toString("base64url");
    const { token } = await (await app.request(RUNNER_PATHS.claim, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: "laptop", platform: "darwin-arm64", publicKey: sent }) })).json();
    return (path: string, payload: unknown, options: { protocol?: string | null; signal?: AbortSignal } = {}) => {
      const body = JSON.stringify(payload);
      const protocol = options.protocol === undefined ? String(RUNNER_PROTOCOL) : options.protocol;
      const headers: Record<string, string> = { authorization: `Bearer ${token}`, [SIGNATURE_HEADER]: signRunnerRequest(privateKey, { method: "POST", path, body }), "content-type": "application/json", ...(protocol === null ? {} : { [PROTOCOL_HEADER]: protocol }) };
      return app.request(path, { method: "POST", headers, body, ...(options.signal ? { signal: options.signal } : {}) });
    };
  };
  /** A signed-in person's GET, as their browser makes it. */
  const browse = async (userId: string, path: string) => app.request(path, { headers: { cookie: await cookieOf(userId) } });
  /** A signed-in person's POST, with the CSRF token their page holds. */
  const send = async (userId: string, path: string, payload: unknown) => {
    const cookie = await cookieOf(userId);
    const { csrf } = await (await app.request("/api/me", { headers: { cookie } })).json();
    return app.request(path, { method: "POST", headers: { cookie, [CSRF_HEADER]: csrf, "content-type": "application/json" }, body: JSON.stringify(payload) });
  };
  return { store, ctx, app, owner, ids: { owner: owner.id, max: max.id, lee: lee.id }, browse, send, maxs: await machineOf(max.id), lees: await machineOf(lee.id) };
}

describe("a machine's calls to a team's orchestrator", () => {
  it("given a machine on another protocol and a call with no signature, when they call in, then the older side is named, nothing unsigned reaches any runner route, and a body past the limit is refused before its signature is read", async () => {
    // given
    const { app, maxs } = await organization();
    const runnerRoutes = Object.keys(ROUTE_SCOPES).filter((key) => key.startsWith("POST /api/runner/") && key !== "POST /api/runner/claim");

    // when
    const older = await maxs(RUNNER_PATHS.poll, { waitMs: 0, canTake: true }, { protocol: null });
    const newer = await maxs(RUNNER_PATHS.poll, { waitMs: 0, canTake: true }, { protocol: String(RUNNER_PROTOCOL + 1) });
    const oversized = await app.request(RUNNER_PATHS.poll, { method: "POST", headers: { [PROTOCOL_HEADER]: String(RUNNER_PROTOCOL), "content-type": "application/json" }, body: JSON.stringify({ pad: "x".repeat(CALL_BYTES) }) });
    const oversizedClaim = await app.request(RUNNER_PATHS.claim, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pad: "x".repeat(CALL_BYTES) }) });
    const unsigned = await Promise.all(runnerRoutes.map((key) => app.request(key.slice("POST ".length).replace(":id", "tsk_x"), { method: "POST", headers: { [PROTOCOL_HEADER]: String(RUNNER_PROTOCOL), "content-type": "application/json" }, body: "{}" })));

    // then
    expect([older.status, (await older.json()).update]).toEqual([426, "runner"]);
    expect([newer.status, (await newer.json()).update]).toEqual([426, "orchestrator"]);
    expect(runnerRoutes.length).toBeGreaterThan(6);
    expect(unsigned.map((r) => r.status)).toEqual(runnerRoutes.map(() => 401));
    expect([oversized.status, oversizedClaim.status]).toEqual([413, 413]);
  });

  it("given queued tasks of Max and Lee, when Max's machine polls, renews, sends events twice, a badly numbered batch and an event of no kind it knows, Lee's machine writes to Max's task, and Max's finishes, then Max's machine leases only his task, each event is kept once, the badly numbered batch is refused, the unknown event is left out, and a lease not held answers 404", async () => {
    // given
    const { store, maxs, lees } = await organization();
    await store.createTask(task("tsk_lee", "lee@example.invalid", "2026-11-03T09:00:00.000Z"));
    await store.createTask(task("tsk_max", "max@example.invalid", "2026-11-03T09:01:00.000Z"));
    const id = "tsk_max";
    const events = [{ n: 1, event: { type: "message", text: "reading the task" } }, { n: 2, event: { type: "output", text: "wrote a note" } }];

    // when
    const polled = await (await maxs(RUNNER_PATHS.poll, { waitMs: 0, canTake: true })).json();
    const leaseId = polled.lease.leaseId;
    const renewed = await (await maxs(RUNNER_PATHS.renew(id), { leaseId })).json();
    const sent = await maxs(RUNNER_PATHS.events(id), { leaseId, events });
    const resent = await maxs(RUNNER_PATHS.events(id), { leaseId, events });
    const bad = await maxs(RUNNER_PATHS.events(id), { leaseId, events: [{ n: 0, event: { type: "message", text: "x" } }] });
    const unknownKind = await maxs(RUNNER_PATHS.events(id), { leaseId, events: [{ n: 3, event: { type: "telepathy" } }] });
    const otherMachine = await lees(RUNNER_PATHS.events(id), { leaseId, events: [{ n: 9, event: { type: "message", text: "not mine" } }] });
    const staleLease = await maxs(RUNNER_PATHS.renew(id), { leaseId: "lease_gone" });
    const finished = await maxs(RUNNER_PATHS.finish(id), { leaseId, outcome: { status: "failed", error: "the agent gave up", nativeSessionId: null, branch: null, position: null, request: null } });
    const afterFinish = await maxs(RUNNER_PATHS.renew(id), { leaseId });

    // then
    expect(polled.lease.task).toMatchObject({ id, title: "Add a note", work: { branch: "task/tsk_max", prompt: "Add a note" } });
    expect(renewed).toEqual({ held: true });
    expect([sent.status, resent.status, bad.status, unknownKind.status, otherMachine.status, staleLease.status, finished.status, afterFinish.status]).toEqual([204, 204, 400, 204, 404, 404, 204, 404]);
    expect((await store.taskLog(TENANT, id, 0)).map((l) => l.text)).toEqual(["reading the task", "wrote a note"]);
    expect(await store.getTask(TENANT, id)).toMatchObject({ status: "failed", error: "the agent gave up" });
    expect((await store.getTask(TENANT, "tsk_lee"))?.status).toBe("queued");
  });

  it("given Max's machine reporting his agent's starting context, when the event arrives, then his task records it, its log gets no line, and a count that is not one is left out", async () => {
    // given
    const { store, maxs } = await organization();
    await store.createTask(task("tsk_max", "max@example.invalid", "2026-11-03T09:01:00.000Z"));
    const { lease } = await (await maxs(RUNNER_PATHS.poll, { waitMs: 0, canTake: true })).json();

    // when
    const sent = await maxs(RUNNER_PATHS.events("tsk_max"), { leaseId: lease.leaseId, events: [{ n: 1, event: { type: "context", tokens: -5 } }, { n: 2, event: { type: "context", tokens: 18_400 } }] });

    // then
    expect(sent.status).toBe(204);
    expect((await store.getTask(TENANT, "tsk_max"))?.context).toEqual({ tokens: 18_400 });
    expect(await store.taskLog(TENANT, "tsk_max", 0)).toEqual([]);
  });

  it("given Max's machine saying which of his MCP servers wait for a sign-in, when the event arrives, then his task keeps their names, its log gets no line, and a list that is not one is left out", async () => {
    // given
    const { store, maxs } = await organization();
    await store.createTask(task("tsk_max", "max@example.invalid", "2026-11-03T09:01:00.000Z"));
    const { lease } = await (await maxs(RUNNER_PATHS.poll, { waitMs: 0, canTake: true })).json();

    // when
    const sent = await maxs(RUNNER_PATHS.events("tsk_max"), { leaseId: lease.leaseId, events: [{ n: 1, event: { type: "mcp_status", needsSignIn: "gitlab" } }, { n: 2, event: { type: "mcp_status", needsSignIn: ["gitlab", "notion"] } }] });

    // then
    expect(sent.status).toBe(204);
    expect((await store.getTask(TENANT, "tsk_max"))?.mcpNeedsSignIn).toEqual(["gitlab", "notion"]);
    expect(await store.taskLog(TENANT, "tsk_max", 0)).toEqual([]);
  });

  it("given a machine's running estimate of a turn's cost, when it arrives, then a finite amount of zero or more is taken and any other is left out", () => {
    // when
    const read = [0.42, 0, -0.01, Number.POSITIVE_INFINITY, "0.42", null].map((usd) => eventOf({ type: "spend", usd }, (text) => text));

    // then
    expect(read).toEqual([{ type: "spend", usd: 0.42 }, { type: "spend", usd: 0 }, null, null, null, null]);
  });

  it("given Max's agent putting its plan to him, when his machine asks, then the plan is kept on the request, and a plan on a request of another kind is refused", async () => {
    // given
    const { store, maxs } = await organization();
    await store.createTask(task("tsk_max", "max@example.invalid", "2026-11-03T09:01:00.000Z"));
    const { lease } = await (await maxs(RUNNER_PATHS.poll, { waitMs: 0, canTake: true })).json();

    // when
    const planned = await maxs(RUNNER_PATHS.agentRequest("tsk_max"), { leaseId: lease.leaseId, request: { id: "plan_1", kind: "plan", tool: "ExitPlanMode", summary: "1. Read the tiers", plan: "1. Read the tiers\n2. Fix the limit" } });
    const misplaced = await maxs(RUNNER_PATHS.agentRequest("tsk_max"), { leaseId: lease.leaseId, request: { id: "q2", kind: "command", tool: "Bash", summary: "npm test", plan: "1. Run it" } });

    // then
    expect([planned.status, misplaced.status]).toEqual([204, 400]);
    expect((await store.taskRequests(TENANT, "tsk_max")).map((r) => [r.kind, r.payload])).toEqual([["plan", { tool: "ExitPlanMode", summary: "1. Read the tiers", plan: "1. Read the tiers\n2. Fix the limit" }]]);
  });

  it("given a poll the machine gave up on before a task was queued, when the task is queued, then the poll took no lease and the task waits for the next one", async () => {
    // given
    const { store, maxs } = await organization();
    const gaveUp = new AbortController();
    const waiting = Promise.resolve(maxs(RUNNER_PATHS.poll, { waitMs: 2_000, canTake: true }, { signal: gaveUp.signal })).catch(() => null);

    // when
    gaveUp.abort();
    await waiting;
    await store.createTask(task("tsk_max", "max@example.invalid", "2026-11-03T09:01:00.000Z"));
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    // then
    expect((await store.getTask(TENANT, "tsk_max"))?.status).toBe("queued");
  });

  it("given a leased task with no branch yet and one whose starter has no forge login, when the machine reports a request for each, then both are refused with why and nothing is recorded", async () => {
    // given
    const { store, maxs } = await organization();
    await store.createTask(task("tsk_max", "max@example.invalid", "2026-11-03T09:01:00.000Z"));
    await store.upsertRepo({ id: "payments-skills", tenant: TENANT, team: "Payments", name: "payments-skills", url: "https://gitlab.example.invalid/acme/payments-skills.git" });
    const { lease } = await (await maxs(RUNNER_PATHS.poll, { waitMs: 0, canTake: true })).json();
    const report = { leaseId: lease.leaseId, number: 7, url: "https://gitlab.example.invalid/acme/payments-skills/-/merge_requests/7", headSha: "a".repeat(40) };

    // when
    const noBranch = await maxs(RUNNER_PATHS.forgeRequest("tsk_max"), report);
    await store.updateLeasedTask(TENANT, "tsk_max", lease.leaseId, { branch: "task/tsk_max" });
    const noLogin = await maxs(RUNNER_PATHS.forgeRequest("tsk_max"), report);

    // then
    expect([noBranch.status, (await noBranch.json()).reason]).toEqual([409, "the task has no branch yet; report the request after the push"]);
    expect(noLogin.status).toBe(409);
    expect((await noLogin.json()).reason).toMatch(/has no forge login/);
    expect((await store.getTask(TENANT, "tsk_max"))?.requestNumber).toBeNull();
  });

  it("given a machine that reports its agents, one report carrying an account's email and one past the limit, when they arrive, then only the first is kept on the machine's row", async () => {
    // given
    const { store, maxs } = await organization();
    const agents = [{ id: "claude-code", installed: true, version: "2.1.316", supported: "ok", signIn: "signed-in" }, { id: "opencode", installed: false, version: null, supported: "ok", signIn: "unknown" }];

    // when
    const kept = await maxs(RUNNER_PATHS.status, { agents });
    const withEmail = await maxs(RUNNER_PATHS.status, { agents: [{ ...agents[0], email: "max@example.invalid" }] });
    const tooMany = await maxs(RUNNER_PATHS.status, { agents: Array.from({ length: 9 }, () => agents[0]) });

    // then
    expect([kept.status, withEmail.status, tooMany.status]).toEqual([204, 400, 400]);
    expect((await store.listMachines(TENANT, null)).find((m) => m.agents.length)?.agents).toEqual(agents);
  });

  /** Max's machine takes the task and the work the orchestrator hands it, clones its base, pushes the branch it names with a note holding `note`, and finishes it for review. */
  async function pushedForReview(root: string, note: string) {
    const { store, ctx, maxs } = await organization({ dataDir: join(root, "data"), wired: true });
    const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd, encoding: "utf8" }).trim();
    const bare = join(root, "payments-skills.git");
    const seed = join(root, "seed");
    const clone = join(root, "clone");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
    execFileSync("git", ["init", "-q", "-b", "main", seed]);
    writeFileSync(join(seed, "README.md"), "skills\n");
    git(seed, "add", ".");
    git(seed, "commit", "-qm", "first");
    git(bare, "fetch", "-q", seed, "main:main");
    await store.upsertRepo({ tenant: TENANT, id: "payments-skills", team: "Payments", name: "payments-skills", url: bare });
    ctx.memberUrls = new Map([["payments-skills", MEMBER_URL]]);
    await syncRepo(ctx, "payments-skills");
    await store.createTask(task("tsk_max", "max@example.invalid", "2026-11-03T09:01:00.000Z"));
    const { lease } = await (await maxs(RUNNER_PATHS.poll, { waitMs: 0, canTake: true })).json();
    const work = lease.task.work as CheckoutWork;
    await maxs(RUNNER_PATHS.progress("tsk_max"), { leaseId: lease.leaseId, progress: { baseSha: work.repo.baseSha, branch: work.branch } });
    // The forge the address names is the bare repository here.
    execFileSync("git", ["clone", "-q", "-b", work.repo.baseBranch, bare, clone]);
    git(clone, "checkout", "-qb", work.branch);
    writeFileSync(join(clone, "note.md"), note);
    git(clone, "add", ".");
    git(clone, "commit", "-qm", "add a note");
    git(bare, "fetch", "-q", clone, `${work.branch}:${work.branch}`);
    const finished = await maxs(RUNNER_PATHS.finish("tsk_max"), { leaseId: lease.leaseId, outcome: { status: "needs-review", error: null, nativeSessionId: null, branch: work.branch, position: null, request: { title: "Add a note", body: "The note the task asked for." } } });
    return { store, ctx, finished, work, git, clone, bare };
  }

  it("given a team's orchestrator wired as its start wires every organization and a paired machine, when the machine takes the task, pushes the branch it was handed and the branch passes the checks, then the work names the clone address and base, and the orchestrator opens the request from that branch", async () => {
    // given
    const root = mkdtempSync(join(tmpdir(), "runner-request-"));
    try {
      // when
      const { store, finished, work } = await pushedForReview(root, "a note\n");

      // then
      expect(work.repo).toMatchObject({ url: MEMBER_URL, baseBranch: "main" });
      expect(work.prompt).toContain("Add a note");
      expect(finished.status).toBe(204);
      expect(await store.getTask(TENANT, "tsk_max")).toMatchObject({ status: "needs-review", requestNumber: 1, baseSha: work.repo.baseSha });
      expect(await store.getRequest(TENANT, "payments-skills", 1)).toMatchObject({ branch: work.branch, status: "open", title: "Add a note", createdBy: "max@example.invalid" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("given a request a machine's branch opened, when a token is pushed to its branch afterwards and the request is refreshed, then the new head is held with the reason and the task's log says so", async () => {
    // given
    const root = mkdtempSync(join(tmpdir(), "runner-request-"));
    try {
      const { store, ctx, work, git, clone, bare } = await pushedForReview(root, "a note\n");
      writeFileSync(join(clone, "later.md"), `token: ghp_${"a1B2".repeat(9)}\n`);
      git(clone, "add", ".");
      git(clone, "commit", "-qm", "a later change");
      git(bare, "fetch", "-q", clone, `+${work.branch}:${work.branch}`);
      const head = git(clone, "rev-parse", "HEAD");

      // when
      await refreshRequest(ctx, (await store.getRepo(TENANT, "payments-skills"))!, 1);
      // The check runs after the refresh answers: a sync and the pushed branch's checks, past waitFor's one second under load.
      await vi.waitFor(async () => expect((await store.getRequest(TENANT, "payments-skills", 1))?.heldHead).toBe(head), { timeout: 20_000 });

      // then
      expect((await store.getRequest(TENANT, "payments-skills", 1))?.heldReason).toMatch(/secret/);
      expect((await store.taskLog(TENANT, "tsk_max", 0)).map((l) => l.text).join("\n")).toContain(`${head.slice(0, 7)} is held`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("given a team's orchestrator wired as its start wires every organization and a paired machine that pushed a commit holding a token, when the machine finishes the task for review, then no request is opened and the task fails with the reason", async () => {
    // given
    const root = mkdtempSync(join(tmpdir(), "runner-request-"));
    try {
      // when
      const { store, finished } = await pushedForReview(root, `token: ghp_${"a1B2".repeat(9)}\n`);

      // then
      expect(finished.status).toBe(204);
      const after = await store.getTask(TENANT, "tsk_max");
      expect(after).toMatchObject({ status: "failed", requestNumber: null });
      expect(after?.error).toMatch(/^The request was not opened: commit [0-9a-f]{7}: .*secret/);
      expect(await store.getRequest(TENANT, "payments-skills", 1)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("what a machine says of a task it holds, kept as this orchestrator rebuilds it", () => {
  it("given a team secret and a machine that reports it in an event with a field of its own, in a question, in a branch and in its finish, when each arrives, then every word is masked, the extra field is not kept, and the branch is refused", async () => {
    // given
    const { store, ctx, owner, maxs } = await organization();
    ctx.vault = createVault(randomBytes(32));
    await store.upsertRepo({ tenant: TENANT, id: "payments-skills", team: "Payments", name: "payments-skills", url: "https://gitlab.example.invalid/acme/payments-skills.git" });
    const value = "team-registry-token-0123456789";
    await setTaskSecret(ctx, owner, { scope: "team", target: "Payments", name: "NPM_TOKEN", value });
    await store.createTask(task("tsk_max", "max@example.invalid", "2026-11-03T09:01:00.000Z"));
    const { lease } = await (await maxs(RUNNER_PATHS.poll, { waitMs: 0, canTake: true })).json();
    const leaseId = lease.leaseId;

    // when
    const events = await maxs(RUNNER_PATHS.events("tsk_max"), { leaseId, events: [{ n: 1, event: { type: "message", text: `using ${value} and ghp_${"a1B2".repeat(9)}`, extra: value } }, { n: 2, event: { type: "tool_call", tool: "Bash", target: `echo ${value}`, status: "started" } }] });
    const asked = await maxs(RUNNER_PATHS.agentRequest("tsk_max"), { leaseId, request: { id: "q1", kind: "command", tool: "Bash", summary: `curl -H ${value}` } });
    const branch = await maxs(RUNNER_PATHS.progress("tsk_max"), { leaseId, progress: { branch: `task/${value}` } });
    const finished = await maxs(RUNNER_PATHS.finish("tsk_max"), { leaseId, outcome: { status: "failed", error: `the registry refused ${value}`, nativeSessionId: null, branch: null, position: null, request: null } });

    // then
    expect([events.status, asked.status, branch.status, finished.status]).toEqual([204, 204, 400, 204]);
    const log = await store.taskLog(TENANT, "tsk_max", 0);
    const kept = JSON.stringify([log, await store.taskRequests(TENANT, "tsk_max"), await store.getTask(TENANT, "tsk_max")]);
    expect(kept).not.toContain(value);
    expect(kept).not.toContain(`ghp_${"a1B2".repeat(9)}`);
    expect(log.find((l) => l.kind === "message")?.data).toEqual({ type: "message", text: expect.any(String) });
  });
});

describe("a task's attachment, fetched by the machine that holds the task", () => {
  it("given Max's machine holding his task with an attachment, when machines ask for it, then only his, under his lease and for that task's own attachment, gets its bytes", async () => {
    // given
    const { store, ctx, maxs, lees } = await organization();
    await store.createTask(task("tsk_att_1", "max@example.invalid", "2026-11-05T09:01:00.000Z"));
    await store.createTask(task("tsk_att_2", "max@example.invalid", "2026-11-05T09:02:00.000Z"));
    const { lease } = await (await maxs(RUNNER_PATHS.poll, { waitMs: 0, canTake: true })).json();
    const held = lease.task.id as string;
    const other = held === "tsk_att_1" ? "tsk_att_2" : "tsk_att_1";
    const keep = async (id: string, taskId: string, text: string) => {
      const bytes = Buffer.from(text);
      const file = attachmentPath(ctx.dataDir, TENANT, id);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, bytes);
      await store.insertAttachment({ tenant: TENANT, id, taskId, name: "notes.txt", mime: "text/plain", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), createdBy: "max@example.invalid", createdAt: new Date().toISOString() }, ATTACHMENT_LIMITS);
    };
    await keep("att_held", held, "the held task's note\n");
    await keep("att_other", other, "another task's note\n");

    // when
    const got = await maxs(RUNNER_PATHS.attachment(held, "att_held"), { leaseId: lease.leaseId });
    const fromLee = await lees(RUNNER_PATHS.attachment(held, "att_held"), { leaseId: lease.leaseId });
    const stale = await maxs(RUNNER_PATHS.attachment(held, "att_held"), { leaseId: "lease-of-another" });
    const crossed = await maxs(RUNNER_PATHS.attachment(held, "att_other"), { leaseId: lease.leaseId });

    // then
    expect(got.status).toBe(200);
    expect(await got.text()).toBe("the held task's note\n");
    expect([got.headers.get("content-type"), got.headers.get("x-content-type-options"), got.headers.get("content-disposition")?.startsWith("attachment;")]).toEqual(["text/plain", "nosniff", true]);
    expect([fromLee.status, stale.status, crossed.status]).toEqual([404, 404, 404]);
  });
});

describe("a question a machine's agent asks its person", () => {
  it("given a question with a team secret in its words, when the machine reports it, then it is kept masked with its keys and values as asked, and a card asking more than the most questions is refused", async () => {
    // given
    const { store, ctx, owner, maxs } = await organization();
    ctx.vault = createVault(randomBytes(32));
    await store.upsertRepo({ tenant: TENANT, id: "payments-skills", team: "Payments", name: "payments-skills", url: "https://gitlab.example.invalid/acme/payments-skills.git" });
    const value = "team-registry-token-0123456789";
    await setTaskSecret(ctx, owner, { scope: "team", target: "Payments", name: "NPM_TOKEN", value });
    await store.createTask(task("tsk_max", "max@example.invalid", "2026-11-03T09:01:00.000Z"));
    const { lease } = await (await maxs(RUNNER_PATHS.poll, { waitMs: 0, canTake: true })).json();
    const question = (key: string) => ({ key, title: `Use ${value}?`, choice: "one", options: [{ value: "yes", label: `yes, ${value}` }] });

    // when
    const asked = await maxs(RUNNER_PATHS.agentRequest("tsk_max"), { leaseId: lease.leaseId, request: { id: "q1", kind: "question", tool: "question", summary: "a question", questions: [question("q1")] } });
    const tooMany = await maxs(RUNNER_PATHS.agentRequest("tsk_max"), { leaseId: lease.leaseId, request: { id: "q2", kind: "question", tool: "question", summary: "five questions", questions: ["a", "b", "c", "d", "e"].map(question) } });

    // then
    expect([asked.status, tooMany.status]).toEqual([204, 400]);
    const [kept] = await store.taskRequests(TENANT, "tsk_max");
    expect(kept!.payload.questions).toEqual([{ key: "q1", title: expect.not.stringContaining(value), choice: "one", options: [{ value: "yes", label: expect.not.stringContaining(value) }] }]);
  });
});

describe("the live task's events from a machine", () => {
  it("given a team secret and a machine reporting a command, its output, an edit, a to-do list longer than the screen shows and the team's tests on a team's orchestrator, and then an edit outside the folder beside a message and an edit of a credential file, two follow-ups that reached the agent and three tool calls, an MCP tool's with its server, a refused one with its reason and one with a reason of no kind it knows, when they arrive, then each is kept in its own fields and masked, the agent's own output keeps no line, the tests' does, the list keeps its first items, the edit outside the folder is left out while the message beside it is kept, a credential file's edit keeps no patch, and a follow-up that reached the agent is kept masked with its sender while one with no sender's address is left out", async () => {
    // given
    vi.stubEnv("ORCHESTRATOR_MODE", "self-hosted");
    const { store, ctx, owner, maxs } = await organization();
    ctx.vault = createVault(randomBytes(32));
    await store.upsertRepo({ tenant: TENANT, id: "payments-skills", team: "Payments", name: "payments-skills", url: "https://gitlab.example.invalid/acme/payments-skills.git" });
    const value = "team-registry-token-0123456789";
    await setTaskSecret(ctx, owner, { scope: "team", target: "Payments", name: "NPM_TOKEN", value });
    await store.createTask(task("tsk_max", "max@example.invalid", "2026-11-03T09:01:00.000Z"));
    const { lease } = await (await maxs(RUNNER_PATHS.poll, { waitMs: 0, canTake: true })).json();
    const events = [
      { type: "tool_call", id: "c1", tool: "Bash", target: null, status: "done", command: `npm publish --token ${value}`, extra: "x" },
      { type: "tool_output", id: "c1", lines: [`using ${value}`, "published"] },
      { type: "tool_output", id: "tests", lines: ["12 passed", `token ${value}`] },
      { type: "edit", id: "c2", path: "docs/runbook.md", additions: 3, deletions: 1, patch: `+NPM_TOKEN=${value}\n+line` },
      { type: "todos", items: [{ text: `rotate ${value}`, state: "doing" }, ...Array.from({ length: TODOS_MAX }, (_, i) => ({ text: `step ${i}`, state: "todo" }))] },
    ];

    // when
    const sent = await maxs(RUNNER_PATHS.events("tsk_max"), { leaseId: lease.leaseId, events: events.map((event, i) => ({ n: i + 1, event })) });
    const outside = await maxs(RUNNER_PATHS.events("tsk_max"), { leaseId: lease.leaseId, events: [{ n: 6, event: { type: "edit", id: "c3", path: "../elsewhere/x.md", additions: 1, deletions: 0 } }, { n: 7, event: { type: "message", text: "edited the runbook" } }, { n: 8, event: { type: "edit", id: "c4", path: "config/.env", additions: 1, deletions: 0, patch: "+REGISTRY_URL=https://registry.example.invalid" } }, { n: 9, event: { type: "steer", text: `publish with ${value}`, by: "ada@example.invalid" } }, { n: 10, event: { type: "steer", text: "too long a name", by: "x".repeat(321) } }, { n: 11, event: { type: "tool_call", id: "c5", tool: "mcp__docs__search", target: null, status: "done", mcp: { server: `docs-${value}`, tool: "search" } } }, { n: 12, event: { type: "tool_call", id: "c6", tool: "mcp__tracker__comment", target: null, status: "refused", mcp: { server: "tracker" }, refusal: { kind: "tracker-write", reason: `the team's tracker is written by people, not ${value}` } } }, { n: 13, event: { type: "tool_call", id: "c7", tool: "Bash", target: null, status: "refused", refusal: { kind: "no-such-kind", reason: "x" } } }] });

    // then
    expect([sent.status, outside.status]).toEqual([204, 204]);
    const kept = (await store.taskLog(TENANT, "tsk_max", 0)).filter((l) => l.kind).map((l) => l.data);
    expect(JSON.stringify(kept)).not.toContain(value);
    expect(kept[0]).toEqual({ type: "tool_call", id: "c1", tool: "Bash", target: null, status: "done", command: expect.any(String) });
    expect(kept[1]).toEqual({ type: "tool_output", id: "c1", lines: [] });
    expect(kept[2]).toMatchObject({ type: "tool_output", id: "tests", lines: ["12 passed", expect.any(String)] });
    expect(kept[3]).toMatchObject({ type: "edit", id: "c2", path: "docs/runbook.md", additions: 3, deletions: 1 });
    const todos = (kept[4] as { type: string; items: { text: string; state: string }[] });
    expect([todos.type, todos.items.length, todos.items[0]!.state, todos.items[1]]).toEqual(["todos", TODOS_MAX, "doing", { text: "step 0", state: "todo" }]);
    expect(kept.map((k) => (k as { type: string }).type)).toEqual(["tool_call", "tool_output", "tool_output", "edit", "todos", "message", "edit", "steer", "tool_call", "tool_call", "tool_call"]);
    expect(kept[6]).toEqual({ type: "edit", id: "c4", path: "config/.env", additions: 1, deletions: 0 });
    expect(kept[7]).toEqual({ type: "steer", text: expect.any(String), by: "ada@example.invalid" });
    expect(kept[8]).toEqual({ type: "tool_call", id: "c5", tool: "mcp__docs__search", target: null, status: "done", mcp: { server: expect.not.stringContaining(value), tool: "search" } });
    expect(kept[9]).toEqual({ type: "tool_call", id: "c6", tool: "mcp__tracker__comment", target: null, status: "refused", refusal: { kind: "tracker-write", reason: expect.not.stringContaining(value) } });
    expect(kept[10]).toEqual({ type: "tool_call", id: "c7", tool: "Bash", target: null, status: "refused" });
  });
});

describe("a machine's folders, listed for its own person", { timeout: 120_000 }, () => {
  const LIST = { under: "~/code", parent: "~", folders: [{ name: "shop", path: "~/code/shop", git: "repo", markers: [".git", "package.json"] }, { name: "services", path: "~/code/services", git: "none", markers: [], repos: 3 }], suggestions: [], truncated: false };

  it("given two organizations on one store, each with a person's machine, when the machine's person, its organization's owner, a teammate and the other organization's people ask for its folders, then only its person is answered, the ask reaches no other machine, and nothing of it is written down", async () => {
    // given
    const store = openSqliteStore(":memory:");
    const a = await organization({ store, tenant: "acme" });
    const b = await organization({ store, tenant: "globex" });
    const [machine] = await store.listMachines("acme", a.ids.max);
    const eventsBefore = (await store.eventPage("acme", {}, null, 50)).events.length;

    await a.maxs(RUNNER_PATHS.poll, { waitMs: 0, canTake: false });

    // when
    const polled = a.maxs(RUNNER_PATHS.poll, { waitMs: 20_000, canTake: false });
    const asked = a.browse(a.ids.max, `/api/machines/${machine!.id}/folders?under=${encodeURIComponent("~/code")}`);
    const { folders } = await (await polled).json();
    const other = await (await b.maxs(RUNNER_PATHS.poll, { waitMs: 0, canTake: false })).json();
    const fromB = await b.maxs(RUNNER_PATHS.folders(folders[0].nonce), { answer: LIST });
    const answered = await a.maxs(RUNNER_PATHS.folders(folders[0].nonce), { answer: LIST });
    const listed = await asked;
    const refusedTo = await Promise.all([a.browse(a.ids.owner, `/api/machines/${machine!.id}/folders`), a.browse(a.ids.lee, `/api/machines/${machine!.id}/folders`), b.browse(b.ids.max, `/api/machines/${machine!.id}/folders`), b.browse(b.ids.owner, `/api/machines/${machine!.id}/folders`)]);

    // then
    expect(folders).toEqual([{ nonce: expect.any(String), under: "~/code", q: null }]);
    expect(other.folders).toBeUndefined();
    expect([fromB.status, answered.status, listed.status]).toEqual([404, 204, 200]);
    expect(await listed.json()).toEqual(LIST);
    expect(refusedTo.map((r) => r.status)).toEqual([404, 404, 404, 404]);
    expect((await store.eventPage("acme", {}, null, 50)).events.length).toBe(eventsBefore);
  });

  it("given a machine that answers with a full home path and one that is not polling, when each is asked and an answer comes after its ask settled, then the screen is told the answer was no folder list and that the machine is not connected, and the late answer finds no ask", async () => {
    // given
    const { store, ids, browse, maxs } = await organization();
    const [mine] = await store.listMachines(TENANT, ids.max);
    const [older] = await store.listMachines(TENANT, ids.lee);
    await maxs(RUNNER_PATHS.poll, { waitMs: 0, canTake: false });

    // when
    const polled = maxs(RUNNER_PATHS.poll, { waitMs: 20_000, canTake: false });
    const asked = browse(ids.max, `/api/machines/${mine!.id}/folders`);
    const { folders } = await (await polled).json();
    const bare = await maxs(RUNNER_PATHS.folders(folders[0].nonce), { answer: { ...LIST, folders: [{ ...LIST.folders[0], path: "/home/someone/code/shop" }] } });
    const shown = await asked;
    const late = await maxs(RUNNER_PATHS.folders(folders[0].nonce), { answer: LIST });
    const offline = await browse(ids.lee, `/api/machines/${older!.id}/folders`);

    // then
    expect([bare.status, shown.status, (await shown.json()).code]).toEqual([400, 502, "machine-answer-invalid"]);
    expect(late.status).toBe(404);
    expect([offline.status, (await offline.json()).code]).toEqual([409, "machine-offline"]);
  });

  it("given a team's orchestrator and Max's machine polling, when Max opens one of its folders as a project, opens it again, and Lee and Max try a folder that is not theirs or the home itself, then the machine lists the folder's parent once, the project names the machine and the path from its home, nothing syncs it, and the others are refused by code", async () => {
    // given
    vi.stubEnv("ORCHESTRATOR_MODE", "self-hosted");
    const { store, ctx, ids, browse, send, maxs } = await organization();
    const [machine] = await store.listMachines(TENANT, ids.max);
    await maxs(RUNNER_PATHS.poll, { waitMs: 0, canTake: false });

    // when
    const polled = maxs(RUNNER_PATHS.poll, { waitMs: 20_000, canTake: false });
    const opening = send(ids.max, "/api/projects", { machineId: machine!.id, path: "~/code/shop" });
    const { folders } = await (await polled).json();
    await maxs(RUNNER_PATHS.folders(folders[0].nonce), { answer: LIST });
    const opened = await (await opening).json();
    const again = await (await send(ids.max, "/api/projects", { machineId: machine!.id, path: "~/code/shop" })).json();
    const listed = await (await browse(ids.max, "/api/projects")).json();
    const leeLast = (await (await browse(ids.lee, "/api/projects")).json()).last;
    const notLees = await send(ids.lee, "/api/projects", { machineId: machine!.id, path: "~/code/shop" });
    const home = await send(ids.max, "/api/projects", { machineId: machine!.id, path: "~" });
    const synced = await syncRepo(ctx, "shop");

    // then
    expect(folders).toEqual([{ nonce: expect.any(String), under: "~/code", q: null }]);
    expect(opened).toMatchObject({ existing: false, project: { id: "shop", name: "shop", url: `machine:${machine!.id}:~/code/shop`, machine: { id: machine!.id, path: "~/code/shop" }, facts: { git: "repo", origin: null, name: "shop", kind: "code" } } });
    expect([again.existing, again.project.id]).toEqual([true, "shop"]);
    expect([listed.last, listed.home, listed.projects.map((p: { id: string }) => p.id)]).toEqual(["shop", null, ["shop"]]);
    expect(leeLast).toBeNull();
    expect([notLees.status, (await notLees.json()).code]).toEqual([404, "unknown-machine"]);
    expect([home.status, (await home.json()).code]).toEqual([400, "home-itself"]);
    expect(synced).toEqual({ error: ON_A_MACHINE });
    expect((await store.getRepo(TENANT, "shop"))!.error).toBeNull();
  });

  it("given a project on a folder of Max's machine, when Lee starts a task in it and Max does, then Lee is told whose machine it is and nothing waits in line, and Max is not refused for it", async () => {
    // given
    vi.stubEnv("ORCHESTRATOR_MODE", "self-hosted");
    const root = mkdtempSync(join(tmpdir(), "runner-start-"));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    const { store, ids, send } = await organization({ dataDir: join(root, "data"), wired: true });
    const [machine] = await store.listMachines(TENANT, ids.max);
    await store.upsertRepo({ tenant: TENANT, id: "notes", team: "Payments", name: "notes", url: `machine:${machine!.id}:~/notes` });
    const start = { repoId: "notes", title: "Add a note", agent: "fake" };

    // when
    const lees = await send(ids.lee, "/api/tasks", start);
    const maxs = await send(ids.max, "/api/tasks", start);

    // then
    expect([lees.status, await lees.json()]).toEqual([403, { error: "this project is on max@example.invalid's machine; only they start tasks in it", code: "on-another-machine" }]);
    expect((await maxs.json()).code).not.toBe("on-another-machine");
    expect((await store.taskPage(TENANT, {}, null, 10)).tasks.filter((t) => t.createdBy === "lee@example.invalid")).toEqual([]);
  });

  /**
   * Max's machine holding a task in a folder of its own, a code project whose skills repository's
   * team keeps env files from being edited, and the machine's report of what the run changed.
   */
  it("given a folder project on Max's machine, when its checks screen asks, then the machine is handed the ask, its reading comes back as the folder's checks, and an answer that is not one, or one from another machine, is not taken", async () => {
    // given
    const { ctx, store, ids, maxs, lees } = await organization();
    const [machine] = await store.listMachines(TENANT, ids.max);
    const project = { id: "notes", name: "notes", url: `machine:${machine!.id}:~/notes` };
    await maxs(RUNNER_PATHS.poll, { waitMs: 0, canTake: false });
    const detected = { setup: null, checks: [{ kind: "test", command: "npm test", runs: "vitest run", source: "package.json", network: false, long: false, digest: "c".repeat(64) }] };

    // when
    const reading = checksOnMachine(ctx, project);
    const { checks } = await (await maxs(RUNNER_PATHS.poll, { waitMs: 5_000, canTake: false })).json();
    const fromLee = await lees(RUNNER_PATHS.checks(checks[0].nonce), { answer: { detected } });
    const answered = await maxs(RUNNER_PATHS.checks(checks[0].nonce), { answer: { detected } });
    const second = checksOnMachine(ctx, project);
    const { checks: again } = await (await maxs(RUNNER_PATHS.poll, { waitMs: 5_000, canTake: false })).json();
    const malformed = await maxs(RUNNER_PATHS.checks(again[0].nonce), { answer: { detected: { ...detected, checks: [{ ...detected.checks[0], digest: "not-a-digest" }] } } });

    // then
    expect(checks).toEqual([{ nonce: expect.any(String), projectId: "notes", path: "~/notes" }]);
    expect(fromLee.status).toBe(404);
    expect(answered.status).toBe(204);
    expect(await reading).toEqual({ detected });
    expect(malformed.status).toBe(400);
    expect(await second).toEqual({ unread: expect.stringMatching(/answered with something other than this folder's checks/) });
  });

  it("given a task's branch in a repository of Max's folder, when he presses to push it, then his machine is handed the push, its answer comes back, and one from another machine or one that is not an answer is not taken", async () => {
    // given
    const { ctx, store, ids, maxs, lees } = await organization();
    const [machine] = await store.listMachines(TENANT, ids.max);
    const project = { id: "code", name: "code", url: `machine:${machine!.id}:~/code` };
    const entry = { path: "payments-api", branch: "task/tsk_max", head: "a".repeat(40) };
    await maxs(RUNNER_PATHS.poll, { waitMs: 0, canTake: false });

    // when
    const pushing = pushOnMachine(ctx, project, entry);
    const { pushes } = await (await maxs(RUNNER_PATHS.poll, { waitMs: 5_000, canTake: false })).json();
    const fromLee = await lees(RUNNER_PATHS.pushes(pushes[0].nonce), { answer: { pushed: true } });
    const answered = await maxs(RUNNER_PATHS.pushes(pushes[0].nonce), { answer: { pushed: true } });
    const second = pushOnMachine(ctx, project, entry);
    const { pushes: again } = await (await maxs(RUNNER_PATHS.poll, { waitMs: 5_000, canTake: false })).json();
    const malformed = await maxs(RUNNER_PATHS.pushes(again[0].nonce), { answer: { pushed: "yes" } });

    // then
    expect(pushes).toEqual([{ nonce: expect.any(String), projectId: "code", path: "~/code", repo: "payments-api", branch: "task/tsk_max", head: "a".repeat(40) }]);
    expect(fromLee.status).toBe(404);
    expect(answered.status).toBe(204);
    expect(await pushing).toEqual({ pushed: true });
    expect(malformed.status).toBe(400);
    expect(await second).toEqual({ unread: expect.stringMatching(/answered with something other than a push/) });
  });

  async function inPlaceOnMachine(root: string, changed: string, outcome: Record<string, unknown> = {}) {
    vi.stubEnv("ORCHESTRATOR_MODE", "self-hosted");
    const org = await organization({ dataDir: join(root, "data"), wired: true });
    const { store, ctx, ids, maxs } = org;
    const { configFile } = seed(join(root, "demo"));
    const entry = JSON.parse(readFileSync(configFile, "utf8")).repos.find((r: { id: string }) => r.id === "payments-skills");
    await store.upsertRepo({ ...entry, tenant: TENANT });
    const bare = localRepoPath(entry.url)!;
    const work = join(root, "work");
    execFileSync("git", ["clone", "-q", bare, work]);
    const file = join(work, ".teamhandbook.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), policies: [{ id: "pol_env", name: "Keep env files", rules: [{ action: "tool.use", resource: "tool:Edit:*.env", effect: "deny", reason: "env files are set by the platform team" }] }] }, null, 2) + "\n");
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qam", "policies"], { cwd: work });
    execFileSync("git", ["fetch", "-q", work, "main:main"], { cwd: bare });
    await syncRepo(ctx, "payments-skills");
    const [machine] = await store.listMachines(TENANT, ids.max);
    ctx.addedRepos = new Map([["notes", { id: "notes", forge: "machine", kind: "code", skillsFrom: "payments-skills", gitOrigin: null, memberUrl: null, machine: { id: machine!.id, path: "~/notes", name: "notes", git: "none" }, addedBy: "max@example.invalid", addedAt: "2026-11-03T09:00:00.000Z" }]]);
    await store.upsertRepo({ tenant: TENANT, id: "notes", team: "Payments", name: "notes", url: `machine:${machine!.id}:~/notes` });
    const taskId = newId("tsk");
    await store.createTask({ ...task(taskId, "max@example.invalid", "2026-11-03T09:01:00.000Z"), repoId: "notes" });
    await store.claimLocalTask(TENANT, "max@example.invalid", machine!.id, "lease_notes", new Date(Date.now() + 60_000).toISOString(), new Date().toISOString());
    const changes = { before: "a".repeat(40), after: "b".repeat(40), files: [{ path: changed, status: "added", previousPath: null, additions: 1, deletions: 0, binary: false, test: false }], ...outcome };
    await maxs(RUNNER_PATHS.poll, { waitMs: 0, canTake: false });
    const finished = await maxs(RUNNER_PATHS.finish(taskId), { leaseId: "lease_notes", outcome: { status: "needs-review", error: null, nativeSessionId: null, branch: null, position: null, request: null, changes } });
    return { ...org, machine: machine!, changes, finished, taskId };
  }

  it("given a task that worked in a folder of Max's machine and wrote an env file the team's policy keeps from being edited, when the machine finishes it, then the task fails with the team's reason, the same a run on the orchestrator gives, and the machine is asked to undo it", async () => {
    // given
    const root = mkdtempSync(join(tmpdir(), "runner-in-place-"));
    try {
      const { store, maxs, changes, finished, taskId } = await inPlaceOnMachine(root, "deploy.env");

      // when
      const { undos } = await (await maxs(RUNNER_PATHS.poll, { waitMs: 5_000, canTake: false })).json();
      const answered = await maxs(RUNNER_PATHS.undo(undos[0].nonce), { answer: { undone: ["deploy.env"], kept: [] } });
      await vi.waitFor(async () => expect((await store.getTask(TENANT, taskId))?.changes?.undone).not.toBeNull(), { timeout: 20_000 });

      // then
      expect(finished.status).toBe(204);
      expect(await store.getTask(TENANT, taskId)).toMatchObject({ status: "failed", error: `${editRefusal([{ action: "tool.use", resource: "tool:Edit:*.env", effect: "deny", reason: "env files are set by the platform team" }], ["deploy.env"], "/home/someone/notes")!.replace(/ No request was opened\.$/, "")} Its change is being undone on the machine.`, changes: { files: changes.files, undone: { by: "orchestrator", kept: [] } } });
      expect(undos).toEqual([{ nonce: expect.any(String), projectId: "notes", path: "~/notes", before: changes.before, after: changes.after }]);
      expect(answered.status).toBe(204);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("given a task that worked in a folder of Max's machine within the team's policy, when Max undoes it from the task page and the machine answers, then the change is kept for review until then and recorded undone after, and its files are said to be read on the machine", async () => {
    // given
    const root = mkdtempSync(join(tmpdir(), "runner-in-place-"));
    try {
      const { store, ids, send, browse, maxs, finished, taskId } = await inPlaceOnMachine(root, "notes.md");
      const kept = await store.getTask(TENANT, taskId);

      // when
      const undoing = send(ids.max, `/api/tasks/${taskId}/undo`, { commandId: "cmd-undo-0001" });
      const { undos } = await (await maxs(RUNNER_PATHS.poll, { waitMs: 5_000, canTake: false })).json();
      await maxs(RUNNER_PATHS.undo(undos[0].nonce), { answer: { undone: ["notes.md"], kept: [] } });
      const undone = await undoing;
      const read = await browse(ids.max, `/api/tasks/${taskId}/changes`);

      // then
      expect(finished.status).toBe(204);
      expect(kept).toMatchObject({ status: "needs-review", changes: { undone: null } });
      expect([undone.status, (await undone.json()).undone]).toEqual([200, ["notes.md"]]);
      expect((await store.getTask(TENANT, taskId))?.changes?.undone).toMatchObject({ by: "max@example.invalid", kept: [] });
      expect([read.status, (await read.json()).code]).toEqual([409, "changes-on-machine"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("given a machine whose own policy check refused the change and took it back, and one that names a kept path outside the folder, when each finishes, then the first is recorded undone with nothing asked of the machine again, and the second is refused", async () => {
    // given
    const root = mkdtempSync(join(tmpdir(), "runner-in-place-"));
    const other = mkdtempSync(join(tmpdir(), "runner-in-place-"));
    try {
      const { store, maxs, finished, taskId } = await inPlaceOnMachine(root, "deploy.env", { undone: { kept: [] } });
      const outside = await inPlaceOnMachine(other, "deploy.env", { undone: { kept: ["../elsewhere"] } });

      // when
      const polled = await (await maxs(RUNNER_PATHS.poll, { waitMs: 0, canTake: false })).json();

      // then
      expect(finished.status).toBe(204);
      expect((await store.getTask(TENANT, taskId))?.changes?.undone).toMatchObject({ by: "orchestrator", kept: [] });
      expect(polled.undos).toBeUndefined();
      expect(outside.finished.status).toBe(400);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });
});
