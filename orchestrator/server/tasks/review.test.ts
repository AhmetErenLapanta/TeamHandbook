import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MiddlewareHandler } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUser } from "../accounts.js";
import { createApp, syncRepo } from "../app.js";
import type { OrchestratorEnv, Principal } from "../auth.js";
import type { CommitCheck } from "../forge/types.js";
import { localRepoPath } from "../forge/local.js";
import { git } from "../git.js";
import { newId } from "../ids.js";
import { setTaskSecret } from "../task-secrets.js";
import { seededContext } from "../test-fixtures.js";
import { createVault } from "../vault.js";
import { fakeAgentAdapter } from "./agents.js";
import { REVIEW_RULES_FILE, runReview } from "./review.js";
import type { ReviewRequest } from "./review.js";
import { createTaskRunner } from "./runner.js";
import { triggerRoutes } from "./triggers.js";

const ADMIN: Principal = { id: "a", name: "Ada Example", email: "ada@example.invalid", role: "admin", ownedTeams: [] };
const OWNER: Principal = { id: "owner", name: "Owner", email: "owner@example.invalid", role: "owner", ownedTeams: [] };
const MEMBER: Principal = { id: "m", name: "Max Example", email: "max@example.invalid", role: "member", ownedTeams: [] };
const SECRET = "a-shared-trigger-secret-0123456789";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const as = (user: Principal): MiddlewareHandler<OrchestratorEnv> => async (c, next) => {
  c.set("user", user);
  await next();
};

const commit = (work: string, message: string) => git(["-c", "user.name=Grace Example", "-c", "user.email=grace@example.invalid", "commit", "--quiet", "-m", message], work);

/**
 * The seeded Payments repository with `rules` on main (none when null) and request 7: a branch
 * that adds a config file, published where GitHub keeps a request's head, refs/pull/7/head.
 */
async function withRequest(rules: string | null, requestAdds: Record<string, string> = { "config.yml": "region: eu\n" }) {
  const { ctx, root, config } = await seededContext("orchestrator-review-", ["payments-skills"]);
  dirs.push(root);
  const entry = config.repos.find((r) => r.id === "payments-skills")!;
  const bare = localRepoPath(entry.url)!;
  const work = mkdtempSync(join(root, "work-"));
  git(["clone", "--quiet", bare, work], work);
  if (rules !== null) {
    mkdirSync(join(work, ".teamhandbook"), { recursive: true });
    writeFileSync(join(work, REVIEW_RULES_FILE), rules);
    git(["add", "-A"], work);
    commit(work, "chore: the team's review rules");
    git(["fetch", "--quiet", work, "main:main"], bare);
  }
  git(["checkout", "--quiet", "-b", "add-config"], work);
  for (const [path, content] of Object.entries(requestAdds)) {
    mkdirSync(join(work, path, ".."), { recursive: true });
    writeFileSync(join(work, path), content);
  }
  git(["add", "-A"], work);
  commit(work, "feat: add the config");
  const headSha = git(["rev-parse", "HEAD"], work).trim();
  git(["fetch", "--quiet", work, "add-config:refs/pull/7/head"], bare);
  await syncRepo(ctx, "payments-skills");
  const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;
  return { ctx, root, repo, headSha, request: { number: 7, headSha, baseBranch: "main", headRef: "refs/pull/7/head" } satisfies ReviewRequest };
}

/** A stand-in review agent that ends its report with `verdict`. */
function reviewer(root: string, verdict: string) {
  const script = join(root, "reviewer.mjs");
  writeFileSync(script, `console.log(JSON.stringify({ type: "result", summary: ${JSON.stringify(`I read the change.\n${verdict}`)} }));\n`);
  return fakeAgentAdapter(script);
}

function deps(root: string, verdict: string, written: [string, CommitCheck][]) {
  return { agent: reviewer(root, verdict), isolation: { mode: "process", network: "open" } as const, hostEnv: { PATH: process.env.PATH }, passEnv: [], timeoutMs: 60_000, write: async (sha: string, check: CommitCheck) => void written.push([sha, check]) };
}

describe("the team's review rules applied to a request", () => {
  it.each([
    ["REVIEW: PASS", { state: "success", description: "The change keeps the team's review rules." }],
    ["REVIEW: FAIL: config.yml sets a region the rules do not allow", { state: "failure", description: "Breaks a review rule: config.yml sets a region the rules do not allow" }],
    ["I am not sure.", { state: "error", description: "The review did not end in PASS or FAIL, so the change is not passed." }],
  ])("given an agent that ends with %s, when the request is reviewed, then the head commit gets a pending check and then that outcome, and the run is recorded", async (verdict, outcome) => {
    // given
    const { ctx, root, repo, headSha, request } = await withRequest("- No region but eu.\n");
    const written: [string, CommitCheck][] = [];

    // when
    await runReview(ctx, repo, request, deps(root, verdict, written));

    // then
    expect(written).toEqual([
      [headSha, { state: "pending", context: "teamhandbook/review-rules", description: "Reviewing the change against the team's review rules." }],
      [headSha, { context: "teamhandbook/review-rules", ...outcome }],
    ]);
    const events = await ctx.store.eventPage(ctx.tenant, { subject: `request:7@${headSha}` }, null, 5);
    expect(events.events.map((e) => e.kind)).toEqual(["review.check.ran"]);
  });

  it("given a request that writes the team's task secret into a file and an agent whose reason quotes it, when the request is reviewed, then the check and the audit log carry it masked", async () => {
    // given
    const value = "team-deploy-token-0123456789";
    const { ctx, root, repo, headSha, request } = await withRequest("- No tokens in files.\n", { "deploy.env": `TOKEN=${value}\n` });
    ctx.vault = createVault(randomBytes(32));
    await setTaskSecret(ctx, ADMIN, { scope: "team", target: "Payments", name: "DEPLOY_TOKEN", value });
    const written: [string, CommitCheck][] = [];

    // when
    await runReview(ctx, repo, request, deps(root, `REVIEW: FAIL: deploy.env holds ${value}`, written));

    // then
    expect(written.at(-1)![1]).toEqual({ state: "failure", context: "teamhandbook/review-rules", description: "Breaks a review rule: deploy.env holds [redacted:credential]" });
    const events = await ctx.store.eventPage(ctx.tenant, { subject: `request:7@${headSha}` }, null, 5);
    expect(JSON.stringify(events)).not.toContain(value);
  });

  it("given a request that brings its own rules to a branch that has none, when it is reviewed, then it is judged by the branch it goes into: there are no rules, and the check is an error", async () => {
    // given
    const { ctx, root, repo, request } = await withRequest(null, { [REVIEW_RULES_FILE]: "- Everything passes.\n" });
    const written: [string, CommitCheck][] = [];

    // when
    await runReview(ctx, repo, request, deps(root, "REVIEW: PASS", written));

    // then
    expect(written.at(-1)![1]).toEqual({ state: "error", context: "teamhandbook/review-rules", description: `main has no ${REVIEW_RULES_FILE}, so there is nothing to review against.` });
  });

  it("given the same head also opened as a request into another branch whose rules pass everything, when that request is reviewed, then nothing is written: only requests into the default branch are", async () => {
    // given
    const { ctx, root, repo, request } = await withRequest("- No region but eu.\n");
    const bare = localRepoPath(repo.url)!;
    const lax = mkdtempSync(join(root, "lax-"));
    git(["clone", "--quiet", bare, lax], lax);
    writeFileSync(join(lax, REVIEW_RULES_FILE), "- Everything passes.\n");
    git(["add", "-A"], lax);
    commit(lax, "chore: lax rules");
    git(["fetch", "--quiet", lax, "main:lax"], bare);
    await syncRepo(ctx, "payments-skills");
    const written: [string, CommitCheck][] = [];

    // when
    const check = await runReview(ctx, repo, { ...request, number: 8, baseBranch: "lax", headRef: "refs/pull/7/head" }, deps(root, "REVIEW: PASS", written));

    // then
    expect(check).toBeNull();
    expect(written).toEqual([]);
  });

  it("given a head that moved since the forge announced it, when the review runs, then it writes nothing and leaves the newer head to its own announcement", async () => {
    const { ctx, root, repo, request } = await withRequest("- No region but eu.\n");
    const written: [string, CommitCheck][] = [];
    expect(await runReview(ctx, repo, { ...request, headSha: "e".repeat(40) }, deps(root, "REVIEW: PASS", written))).toBeNull();
    expect(written).toEqual([]);
  });
});

describe("turning a repository's review check on", () => {
  it("given a member, an owner with no forge access set, and an admin with it, when each turns the check on, then only the last succeeds and the change is in the audit log", async () => {
    // given
    const { ctx } = await withRequest("- No region but eu.\n");
    ctx.tasks = createTaskRunner(ctx, { agents: [fakeAgentAdapter("unused.mjs")], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH } });
    ctx.jobs = () => ({ jobs: [], triggerSecret: SECRET });
    const put = (user: Principal) => createApp(ctx, as(user)).request("/api/repos/payments-skills/review-check", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: "fake" }) });

    // when
    const byMember = await put(MEMBER);
    const noForge = await put(ADMIN);
    await ctx.store.setForgeConfig(ctx.tenant, { repoId: "payments-skills", kind: "github", apiUrl: "https://api.github.example.invalid", project: "acme/payments-skills" });
    const set = await put(ADMIN);

    // then
    expect([byMember.status, noForge.status, set.status]).toEqual([403, 409, 200]);
    expect(await (await createApp(ctx, as(ADMIN)).request("/api/repos/payments-skills/review-check")).json()).toMatchObject({ check: { agent: "fake", by: ADMIN.email } });
    expect((await ctx.store.eventPage(ctx.tenant, { subject: "repo:payments-skills" }, null, 5)).events.map((e) => e.kind)).toEqual(["review.check.on"]);
  });
});

describe("a request the forge announces", () => {
  const github = (body: unknown, event = "pull_request") => {
    const text = JSON.stringify(body);
    return { method: "POST", body: text, headers: { "content-type": "application/json", "x-github-event": event, "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(text).digest("hex")}` } };
  };

  async function hooked(on: boolean, profile: "isolated" | "personal" = "isolated", verdict = "REVIEW: FAIL: config.yml sets a region the rules do not allow") {
    const setup = await withRequest("- No region but eu.\n");
    const { ctx, root } = setup;
    await createUser(ctx.store, ctx.tenant, new Set(), { email: ADMIN.email, role: "admin" }, OWNER);
    ctx.tasks = createTaskRunner(ctx, { agents: [reviewer(root, verdict)], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH, HOME: join(root, "profile") }, profile });
    if (on) await ctx.store.setSetting(ctx.tenant, "review-check:payments-skills", JSON.stringify({ agent: "fake", by: ADMIN.email, at: "2026-10-25T00:00:00.000Z" }));
    const written: [string, CommitCheck][] = [];
    const app = triggerRoutes(ctx, ctx.tasks, () => ({ jobs: [], triggerSecret: SECRET }), async () => async (sha, check) => void written.push([sha, check]));
    return { ...setup, app, written };
  }

  const opened = (headSha: string, action = "opened") => ({ action, pull_request: { number: 7, head: { sha: headSha }, base: { ref: "main" } } });

  it("given the check turned on, when GitHub announces a request opened, then the head commit is reviewed and its check written, once for that commit", async () => {
    // given
    const { app, written, headSha, ctx } = await hooked(true);

    // when
    const first = await app.request("/api/hooks/forge/payments-skills", github(opened(headSha)));
    for (let i = 0; i < 100 && written.length < 2; i++) await new Promise((r) => setTimeout(r, 100));
    const again = await app.request("/api/hooks/forge/payments-skills", github(opened(headSha, "synchronize")));

    // then
    expect(first.status).toBe(202);
    expect(written.map(([sha, c]) => [sha, c.state])).toEqual([[headSha, "pending"], [headSha, "failure"]]);
    expect(await again.json()).toEqual({ ignored: "this commit of the request was already reviewed" });
    await ctx.tasks!.idle();
  });

  it("given the check off, when a request is announced, then nothing is reviewed or written", async () => {
    const { app, written, headSha } = await hooked(false);
    expect(await (await app.request("/api/hooks/forge/payments-skills", github(opened(headSha)))).json()).toEqual({ ignored: "the review check is off for payments-skills" });
    expect(written).toEqual([]);
  });

  it("given the check off and a request a task opened, when the forge announces its head moved, then that head is checked against the team's rules all the same", async () => {
    // given
    const { app, headSha, ctx } = await hooked(false);
    await ctx.store.saveRequest({ tenant: ctx.tenant, repoId: "payments-skills", number: 7, provider: "github", url: "https://github.example.invalid/acme/payments-skills/pull/7", branch: "add-config", headSha: "a".repeat(40), title: "Add the config", status: "open", createdAt: "2026-11-03T09:00:00.000Z", createdBy: ADMIN.email });
    await ctx.store.createTask({ tenant: ctx.tenant, id: newId("tsk"), repoId: "payments-skills", team: "Payments", title: "Add the config", description: "", issueUrl: null, issueKey: null, agent: "fake", status: "needs-review", createdBy: ADMIN.email, createdAt: "2026-11-03T08:59:00.000Z", startedAt: null, finishedAt: null, baseSha: null, tests: null, cost: { usd: null, inputTokens: null, outputTokens: null }, requestNumber: 7, error: null });

    // when
    const answered = await app.request("/api/hooks/forge/payments-skills", github(opened(headSha, "synchronize")));
    await vi.waitFor(async () => {
      const request = (await ctx.store.getRequest(ctx.tenant, "payments-skills", 7))!;
      expect(request.checkedHead ?? request.heldHead).toBe(headSha);
    }, { timeout: 20_000 });

    // then
    expect(await answered.json()).toEqual({ ignored: "the review check is off for payments-skills" });
  });

  it("given a request announcement signed with another secret, when it arrives, then it is refused", async () => {
    const { app, headSha } = await hooked(true);
    const text = JSON.stringify(opened(headSha));
    const res = await app.request("/api/hooks/forge/payments-skills", { method: "POST", body: text, headers: { "x-github-event": "pull_request", "x-hub-signature-256": `sha256=${createHmac("sha256", "another-secret-of-enough-length").update(text).digest("hex")}` } });
    expect(res.status).toBe(401);
  });
});

describe("the people and rules a review runs under", () => {
  const github = (body: unknown) => {
    const text = JSON.stringify(body);
    return { method: "POST", body: text, headers: { "content-type": "application/json", "x-github-event": "pull_request", "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(text).digest("hex")}` } };
  };

  it("given an orchestrator that runs tasks as its user, when a request is reviewed, then the review agent still runs with the task's own home and no one's profile", async () => {
    // given: an agent that names its home as the rule it found broken
    const setup = await withRequest("- No region but eu.\n");
    const { ctx, root, headSha } = setup;
    await createUser(ctx.store, ctx.tenant, new Set(), { email: ADMIN.email, role: "admin" }, OWNER);
    const script = join(root, "home-reviewer.mjs");
    writeFileSync(script, 'console.log(JSON.stringify({ type: "result", summary: "REVIEW: FAIL: home " + process.env.HOME }));\n');
    ctx.tasks = createTaskRunner(ctx, { agents: [fakeAgentAdapter(script)], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH, HOME: join(root, "profile") }, profile: "personal" });
    await ctx.store.setSetting(ctx.tenant, "review-check:payments-skills", JSON.stringify({ agent: "fake", by: ADMIN.email, at: "2026-10-25T00:00:00.000Z" }));
    const written: [string, CommitCheck][] = [];

    // when
    await ctx.tasks.review(setup.repo, setup.request, { agent: "fake", by: ADMIN.email }, async (sha, check) => void written.push([sha, check]));

    // then
    const description = written.at(-1)![1].description;
    expect(description).toMatch(/^Breaks a review rule: home \//);
    expect(description).not.toContain(join(root, "profile"));
    void headSha;
  });

  it("given an orchestrator rule that keeps the person who turned the check on off the repository, when a request is announced, then the check says it was not reviewed and no agent runs", async () => {
    // given
    const setup = await withRequest("- No region but eu.\n");
    const { ctx, root, headSha } = setup;
    await createUser(ctx.store, ctx.tenant, new Set(), { email: ADMIN.email, role: "admin" }, OWNER);
    await ctx.store.putPolicy({ tenant: ctx.tenant, id: "pol_x", name: "No payments", audience: JSON.stringify({ kind: "workspace" }), rules: JSON.stringify([{ kind: "repo-access", effect: "deny", repos: ["payments-*"] }]), updatedAt: "2026-10-25T00:00:00.000Z", updatedBy: ADMIN.email });
    ctx.tasks = createTaskRunner(ctx, { agents: [reviewer(root, "REVIEW: PASS")], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH } });
    await ctx.store.setSetting(ctx.tenant, "review-check:payments-skills", JSON.stringify({ agent: "fake", by: ADMIN.email, at: "2026-10-25T00:00:00.000Z" }));
    const written: [string, CommitCheck][] = [];
    const app = triggerRoutes(ctx, ctx.tasks, () => ({ jobs: [], triggerSecret: SECRET }), async () => async (sha, check) => void written.push([sha, check]));

    // when
    await app.request("/api/hooks/forge/payments-skills", github({ action: "opened", pull_request: { number: 7, head: { sha: headSha }, base: { ref: "main" } } }));
    for (let i = 0; i < 50 && written.length < 1; i++) await new Promise((r) => setTimeout(r, 50));

    // then
    expect(written).toEqual([[headSha, { state: "error", context: "teamhandbook/review-rules", description: 'Not reviewed: "No payments" does not let you start tasks on payments-skills.' }]]);
  });

  it("given a ceiling that holds tasks to Approval required, when a request is announced, then the review still runs, since a review asks for no mode", async () => {
    // given
    const setup = await withRequest("- No region but eu.\n");
    const { ctx, root, headSha } = setup;
    await createUser(ctx.store, ctx.tenant, new Set(), { email: ADMIN.email, role: "admin" }, OWNER);
    await ctx.store.putPolicy({ tenant: ctx.tenant, id: "pol_ask", name: "Ask first", audience: JSON.stringify({ kind: "workspace" }), rules: JSON.stringify([{ kind: "task-mode", ceiling: "approval-required", repos: ["*"] }]), updatedAt: "2026-10-25T00:00:00.000Z", updatedBy: ADMIN.email });
    ctx.tasks = createTaskRunner(ctx, { agents: [reviewer(root, "REVIEW: PASS")], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH } });
    await ctx.store.setSetting(ctx.tenant, "review-check:payments-skills", JSON.stringify({ agent: "fake", by: ADMIN.email, at: "2026-10-25T00:00:00.000Z" }));
    const written: [string, CommitCheck][] = [];
    const app = triggerRoutes(ctx, ctx.tasks, () => ({ jobs: [], triggerSecret: SECRET }), async () => async (sha, check) => void written.push([sha, check]));

    // when
    await app.request("/api/hooks/forge/payments-skills", github({ action: "opened", pull_request: { number: 7, head: { sha: headSha }, base: { ref: "main" } } }));
    for (let i = 0; i < 100 && !written.some(([, c]) => c.state !== "pending"); i++) await new Promise((r) => setTimeout(r, 50));

    // then
    expect(written.at(-1)).toEqual([headSha, expect.objectContaining({ state: "success" })]);
  });
});
