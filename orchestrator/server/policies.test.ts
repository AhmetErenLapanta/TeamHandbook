import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MiddlewareHandler } from "hono";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { seed } from "../demo/seed.js";
import { createApp, mirrorDir, syncRepo } from "./app.js";
import type { OrchestratorContext } from "./app.js";
import type { OrchestratorEnv, Principal } from "./auth.js";
import { localRepoPath } from "./forge/local.js";
import { git } from "./git.js";
import { teamPolicy } from "../../src/lib/policy.js";
import { createUser, principalOf } from "./accounts.js";
import { fakeAgentAdapter } from "./tasks/agents.js";
import { createTaskRunner } from "./tasks/runner.js";
import { ceilingFor, checkPolicy, inAudience, policyChange, PolicyRefused, ownSetupFor, taskStartRefusal, teamFilePolicy, unnamedMode, withoutTask } from "./policies.js";
import type { BudgetLedger } from "./policies.js";
import type { RepoRecord } from "./store.js";
import { openSqliteStore } from "./store.js";
import { startTask } from "./tasks/routes.js";
import type { TaskRunner } from "./tasks/runner.js";
import type { TaskRecord, TaskSpendRow } from "./tasks/types.js";

const ADMIN: Principal = { id: "a", name: "Ada Example", email: "ada@example.invalid", role: "admin", ownedTeams: [] };
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

async function seeded(): Promise<{ ctx: OrchestratorContext; root: string }> {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-policies-"));
  dirs.push(root);
  const { configFile } = seed(join(root, "demo"));
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: join(root, "data"), tenant: config.tenant };
  for (const repo of config.repos) {
    await ctx.store.upsertRepo({ ...repo, tenant: config.tenant });
    await syncRepo(ctx, repo.id);
  }
  return { ctx, root };
}

const retire = { name: "Retire the warehouse", audience: { kind: "teams", ids: ["Payments"] }, rules: [{ kind: "mcp-access", effect: "deny", resources: ["mcp:warehouse"], reason: "the warehouse moved to the data team's server" }] };

const send = (app: ReturnType<typeof createApp>, method: string, path: string, body: unknown) =>
  app.request(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("a policy as the orchestrator checks it", () => {
  it.each([
    ["a rule that reaches sessions beside an orchestrator rule", { ...retire, rules: [...retire.rules, { kind: "task-budget", monthlyUsd: 50, per: "member" }] }, "policy-mixed"],
    ["a rule that reaches sessions for named members", { ...retire, audience: { kind: "members", ids: ["m"] } }, "policy-audience"],
    ["an allow in a rule that reaches sessions", { ...retire, rules: [{ ...retire.rules[0], effect: "allow" }] }, "policy-invalid"],
    ["a kind the orchestrator does not know", { ...retire, rules: [{ kind: "provider-access", effect: "deny", resources: ["x"] }] }, "policy-invalid"],
    ["a resource of the wrong form", { ...retire, rules: [{ ...retire.rules[0], resources: ["warehouse"] }] }, "policy-invalid"],
  ])("given %s, when it is checked, then it is refused with its code", (_case, draft, code) => {
    expect(() => checkPolicy(draft)).toThrow(expect.objectContaining({ code }));
  });
});

describe("a developer policy saved from the orchestrator", () => {
  it("given an admin's policy for one team, when it is saved and merged, then that team's file carries it in the form the plugin reads and the orchestrator lists it for that team", async () => {
    // given
    const { ctx } = await seeded();
    const app = createApp(ctx, as(ADMIN));
    const proposal = await (await send(app, "POST", "/api/policies/proposal", { policy: retire })).json();
    expect(proposal.repos).toEqual([expect.objectContaining({ repoId: "payments-skills", change: "add", proposal: expect.stringContaining("add the team policy Retire the warehouse") })]);

    // when
    const saved = await send(app, "POST", "/api/policies", { policy: retire, message: "chore: retire the warehouse server", baseShas: { "payments-skills": proposal.repos[0].head } });
    const answer = await saved.json();
    expect(saved.status).toBe(200);
    expect(answer).toMatchObject({ saved: "request", requests: [expect.objectContaining({ repoId: "payments-skills" })], failed: [] });
    await send(app, "POST", `/api/repos/payments-skills/requests/${answer.requests[0].number}/merge`, {});
    await syncRepo(ctx, "payments-skills");

    // then
    const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;
    const teamFile = JSON.parse(git(["show", `${repo.head}:.teamhandbook.json`], localRepoPath(repo.url)!));
    expect(teamFile.policies).toEqual([{ id: answer.id, name: "Retire the warehouse", rules: [{ action: "mcp.use", resource: "mcp:warehouse", effect: "deny", reason: "the warehouse moved to the data team's server" }] }]);
    const listed = await (await app.request("/api/policies")).json();
    expect(listed.policies).toEqual([expect.objectContaining({ id: answer.id, audience: { kind: "teams", ids: ["Payments"] }, rules: retire.rules, repos: ["payments-skills"] })]);
  });

  it("given a merged policy, when it is read as a teammate's machine reads its copy, then the plugin holds its rule", async () => {
    // given
    const { ctx, root } = await seeded();
    const app = createApp(ctx, as(ADMIN));
    const head = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!.head;
    const { requests } = await (await send(app, "POST", "/api/policies", { policy: retire, message: "chore: retire the warehouse server", baseShas: { "payments-skills": head } })).json();
    await send(app, "POST", `/api/repos/payments-skills/requests/${requests[0].number}/merge`, {});
    const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;
    const machine = join(root, "machine");
    const copy = join(machine, "marketplaces", "payments-skills");
    git(["clone", "--quiet", localRepoPath(repo.url)!, copy], root);
    const home = join(machine, "th");
    mkdirSync(home);
    writeFileSync(join(home, "config.json"), JSON.stringify({ team: { repoUrl: repo.url, marketplaceName: "payments-skills" } }));

    // when
    const policy = teamPolicy(home, join(machine, "marketplaces"));

    // then
    expect([policy.source, policy.rules.map((r) => r.resource)]).toEqual(["team", ["mcp:warehouse"]]);
  });

  it("given a member, when they save a developer policy, then it is refused and no request opens", async () => {
    // given
    const { ctx } = await seeded();
    const head = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!.head;

    // when
    const res = await send(createApp(ctx, as(MEMBER)), "POST", "/api/policies", { policy: retire, message: "chore: retire", baseShas: { "payments-skills": head } });

    // then
    expect(res.status).toBe(403);
    expect(await ctx.store.listRequests(ctx.tenant)).toEqual([]);
  });
});

describe("a policy id the team file would not hold", () => {
  it("given an id with a space and one past 64 characters, when each is saved over PUT, then neither is written and no request opens", async () => {
    // given
    const { ctx } = await seeded();
    const app = createApp(ctx, as(ADMIN));
    const head = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!.head;

    // when
    const spaced = await send(app, "PUT", `/api/policies/${encodeURIComponent("a b")}`, { policy: retire, message: "chore: retire", baseShas: { "payments-skills": head } });
    const long = await send(app, "PUT", `/api/policies/${"p".repeat(65)}`, { policy: retire, message: "chore: retire", baseShas: { "payments-skills": head } });

    // then
    expect([spaced.status, long.status]).toEqual([404, 404]);
    expect(await ctx.store.listRequests(ctx.tenant)).toEqual([]);
  });

  it("given a merged team policy, when it is saved over PUT with a body naming another policy, then it is refused and no request opens", async () => {
    // given
    const { ctx } = await seeded();
    const app = createApp(ctx, as(ADMIN));
    const head = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!.head;
    const saved = await (await send(app, "POST", "/api/policies", { policy: retire, message: "chore: retire", baseShas: { "payments-skills": head } })).json();
    await send(app, "POST", `/api/repos/payments-skills/requests/${saved.requests[0].number}/merge`, {});
    await syncRepo(ctx, "payments-skills");
    const opened = (await ctx.store.listRequests(ctx.tenant)).length;
    const now = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!.head;

    // when
    const res = await send(app, "PUT", `/api/policies/${saved.id}`, { policy: { ...retire, id: "pol_someone_else" }, message: "chore: change", baseShas: { "payments-skills": now } });
    const plan = await send(app, "POST", "/api/policies/proposal", { id: saved.id, policy: { ...retire, id: "pol_someone_else" } });

    // then
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "policy-invalid", error: `the policy in the body is "pol_someone_else", but the address names "${saved.id}"` });
    expect(plan.status).toBe(400);
    expect((await ctx.store.listRequests(ctx.tenant)).length).toBe(opened);
  });

  it("given a merged team policy, when it is saved over PUT with a body carrying its own id, then the change opens as usual", async () => {
    // given
    const { ctx } = await seeded();
    const app = createApp(ctx, as(ADMIN));
    const head = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!.head;
    const saved = await (await send(app, "POST", "/api/policies", { policy: retire, message: "chore: retire", baseShas: { "payments-skills": head } })).json();
    await send(app, "POST", `/api/repos/payments-skills/requests/${saved.requests[0].number}/merge`, {});
    await syncRepo(ctx, "payments-skills");
    const now = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!.head;

    // when
    const res = await send(app, "PUT", `/api/policies/${saved.id}`, { policy: { ...retire, id: saved.id, name: "Retire the old warehouse" }, message: "chore: rename", baseShas: { "payments-skills": now } });

    // then
    expect(res.status).toBe(200);
    expect((await res.json()).requests).toHaveLength(1);
  });

  it("given a team file change that would hold a policy id the plugin does not read, when it is built, then it is refused before any request", async () => {
    // given
    const { ctx } = await seeded();
    const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;

    // when
    const built = policyChange(mirrorDir(ctx, repo.id), repo.head!, "a b", teamFilePolicy("a b", checkPolicy(retire)));

    // then
    await expect(built).rejects.toThrow(/would leave the policies in .* not valid/);
  });
});

describe("the orchestrator's own rules at a task's start", () => {
  const repo = { id: "payments-skills", name: "payments-skills", team: "Payments" } as RepoRecord;
  const spent = (createdBy: string, usd: number, tasks = 1, unknownCost = 0, largestUsd = 0): TaskSpendRow => ({ createdBy, repoId: "payments-skills", team: "Payments", usd, tasks, unknownCost, largestUsd });
  const ledger = (month: TaskSpendRow[], held: TaskSpendRow[] = [], largest: TaskSpendRow[] = []): BudgetLedger => ({ spent: month, held, largest });
  const budget = [{ name: "Monthly task budget", audience: { kind: "workspace" as const }, rules: [{ kind: "task-budget", monthlyUsd: 5, per: "member" }] }];

  it("given access rules, when one person starts a task, then the last matching rule decides and a repository no rule names stays open", () => {
    const policies = [{ name: "Payments only", audience: { kind: "workspace" as const }, rules: [{ kind: "repo-access", effect: "deny", repos: ["*"] }, { kind: "repo-access", effect: "allow", repos: ["payments-*"] }] }];
    expect(taskStartRefusal(policies, ADMIN, [], repo, ledger([]), [repo], new Map())).toBeNull();
    expect(taskStartRefusal(policies, ADMIN, [], { ...repo, id: "platform-skills", name: "platform-skills" }, ledger([]), [repo], new Map())).toMatchObject({ code: "repo-access", status: 403 });
  });

  it("given a monthly budget per member, when this month's reported cost reaches it, then the start is refused and another member's and unknown costs do not count", () => {
    const month = [spent(ADMIN.email, 3, 2, 1), spent(MEMBER.email, 9)];
    expect(taskStartRefusal(budget, ADMIN, [], repo, ledger(month), [repo], new Map())).toBeNull();
    expect(taskStartRefusal(budget, ADMIN, [], repo, ledger([...month, { ...spent(ADMIN.email, 2), repoId: "platform-skills" }]), [repo], new Map())).toEqual(new PolicyRefused("task-budget", 'The task budget in "Monthly task budget" is spent: $5.00 of $5.00 this month for you.', 409, { id: null, name: "Monthly task budget" }));
  });

  it("given a budget under which no task has reported a cost, when one task still waits, then the next start is refused, saying what the waiting task holds", () => {
    // when
    const refused = taskStartRefusal(budget, ADMIN, [], repo, ledger([], [spent(ADMIN.email, 0)]), [repo], new Map());

    // then
    expect(refused).toEqual(new PolicyRefused("task-budget", 'The task budget in "Monthly task budget" is spent: $0.00 of $5.00 this month for you, and $5.00 is held for 1 task still waiting or running.', 409, { id: null, name: "Monthly task budget" }));
  });

  it("given a task under the budget that reported $2, when tasks still wait, then each holds $2: one more fits beside one waiting task and none beside two", () => {
    // given
    const lately = [spent(ADMIN.email, 3, 2, 0, 2)];
    const month = [spent(ADMIN.email, 1)];

    // when
    const besideOne = taskStartRefusal(budget, ADMIN, [], repo, ledger(month, [spent(ADMIN.email, 0)], lately), [repo], new Map());
    const besideTwo = taskStartRefusal(budget, ADMIN, [], repo, ledger(month, [spent(ADMIN.email, 0, 2)], lately), [repo], new Map());

    // then
    expect(besideOne).toBeNull();
    expect(besideTwo?.message).toBe('The task budget in "Monthly task budget" is spent: $1.00 of $5.00 this month for you, and $4.00 is held for 2 tasks still waiting or running.');
  });

  it("given a running task over several repositories, when it reads the budget before its next repository, then the share it holds itself does not refuse it", () => {
    // given
    const held = ledger([], [spent(ADMIN.email, 0)]);

    // when
    const own = taskStartRefusal(budget, ADMIN, [], repo, withoutTask(held, { repoId: "payments-skills", team: "Payments", createdBy: ADMIN.email }), [repo], new Map());

    // then
    expect(own).toBeNull();
  });

  it("given a stored rule of a kind this orchestrator does not know, when a task starts, then it is refused rather than let through", () => {
    const policies = [{ name: "From a newer orchestrator", audience: { kind: "workspace" as const }, rules: [{ kind: "model-access" }] }];
    expect(taskStartRefusal(policies, ADMIN, [], repo, ledger([]), [repo], new Map())).toMatchObject({ code: "policy-unknown" });
  });
});

describe("the permission mode a task runs in", () => {
  const repo = { id: "payments-skills", name: "payments-skills", team: "Payments" } as RepoRecord;
  const none: BudgetLedger = { spent: [], held: [], largest: [] };
  const PAYMENTS: Principal = { ...MEMBER, ownedTeams: ["Payments"] };
  const ceilings = [
    { name: "Edits on their own", audience: { kind: "workspace" as const }, rules: [{ kind: "task-mode", ceiling: "full-access", repos: ["*"] }] },
    { name: "Payments stays careful", audience: { kind: "teams" as const, ids: ["Payments"] }, rules: [{ kind: "task-mode", ceiling: "auto", repos: ["payments-*"] }] },
  ];

  it("given a full-access ceiling for everyone and an Auto one for Payments' repositories, when a Payments member's ceiling is read, then the lower one that names the repository holds", () => {
    // when
    const onPayments = ceilingFor(ceilings, PAYMENTS, [], repo);
    const elsewhere = ceilingFor(ceilings, PAYMENTS, [], { id: "platform-skills" });

    // then
    expect(onPayments).toEqual({ mode: "auto", policy: { id: null, name: "Payments stays careful" } });
    expect(elsewhere).toEqual({ mode: "full-access", policy: { id: null, name: "Edits on their own" } });
    expect(ceilingFor([], ADMIN, [], repo)).toBeNull();
  });

  it("given an Auto ceiling, when a task asks for full access, then it is refused naming the policy, while Auto, a lower mode, or no mode at all starts", () => {
    // when
    const above = taskStartRefusal(ceilings, PAYMENTS, [], repo, none, [repo], new Map(), "full-access");

    // then
    expect(above).toEqual(new PolicyRefused("task-mode", '"Payments stays careful" lets tasks on payments-skills run up to Auto; this task asked for Full access. Start it in Auto or below.', 403, { id: null, name: "Payments stays careful" }));
    expect(taskStartRefusal(ceilings, PAYMENTS, [], repo, none, [repo], new Map(), "auto")).toBeNull();
    expect(taskStartRefusal(ceilings, PAYMENTS, [], repo, none, [repo], new Map(), "approval-required")).toBeNull();
    expect(taskStartRefusal(ceilings, PAYMENTS, [], repo, none, [repo], new Map())).toBeNull();
  });

  it("given a ceiling below Auto, when a task starts naming no mode, then it is refused for the Auto it runs in, so a saved ceiling holds for every start", () => {
    // given
    const careful = [{ name: "Ask first", audience: { kind: "workspace" as const }, rules: [{ kind: "task-mode", ceiling: "approval-required", repos: ["*"] }] }];

    // when
    const refused = taskStartRefusal(careful, ADMIN, [], repo, none, [repo], new Map());

    // then
    expect(refused).toEqual(new PolicyRefused("task-mode", '"Ask first" lets tasks on payments-skills run up to Approval required; this task runs in Auto. Start it in Approval required or below.', 403, { id: null, name: "Ask first" }));
  });

  it("given a ceiling below Auto and none at all, when the mode a start naming none runs in is read, then it is the ceiling under it and Auto without one, and that mode passes the ceiling", () => {
    // given
    const careful = [{ name: "Ask first", audience: { kind: "workspace" as const }, rules: [{ kind: "task-mode", ceiling: "approval-required", repos: ["*"] }] }];

    // when
    const lowered = unnamedMode(careful, ADMIN, [], repo);

    // then
    expect(lowered).toBe("approval-required");
    expect(unnamedMode(ceilings, PAYMENTS, [], repo)).toBe("auto");
    expect(unnamedMode([], ADMIN, [], repo)).toBe("auto");
    expect(taskStartRefusal(careful, ADMIN, [], repo, none, [repo], new Map(), lowered)).toBeNull();
  });

  it("given a ceiling below Auto, when a task asks for Auto, then the refusal names the mode to start it in instead", () => {
    // given
    const careful = [{ name: "Ask first", audience: { kind: "workspace" as const }, rules: [{ kind: "task-mode", ceiling: "approval-required", repos: ["*"] }] }];

    // when
    const refused = taskStartRefusal(careful, ADMIN, [], repo, none, [repo], new Map(), "auto");

    // then
    expect(refused?.message).toBe('"Ask first" lets tasks on payments-skills run up to Approval required; this task asked for Auto. Start it in Approval required or below.');
  });

  it("given a ceiling that is no mode or names no repository, when the policy is checked, then it is refused with the modes it takes", () => {
    // when
    const tries = [
      () => checkPolicy({ name: "Odd", audience: { kind: "workspace" }, rules: [{ kind: "task-mode", ceiling: "yolo", repos: ["*"] }] }),
      () => checkPolicy({ name: "Odd", audience: { kind: "workspace" }, rules: [{ kind: "task-mode", ceiling: "auto", repos: [] }] }),
    ];

    // then
    expect(tries.map((t) => { try { t(); return null; } catch (e) { return (e as Error).message; } })).toEqual([
      "rule 1: the ceiling is one of approval-required, auto-accept-edits, auto, full-access",
      "rule 1: its repositories is a list of at least one",
    ]);
    expect(checkPolicy({ name: "Fine", audience: { kind: "workspace" }, rules: [{ kind: "task-mode", ceiling: "auto-accept-edits", repos: ["payments-*"] }] }).rules).toEqual([{ kind: "task-mode", ceiling: "auto-accept-edits", repos: ["payments-*"] }]);
  });
});

describe("whether a task brings its starter's own Claude Code setup", () => {
  const repo = { id: "payments-skills", name: "payments-skills", team: "Payments" } as RepoRecord;
  const none: BudgetLedger = { spent: [], held: [], largest: [] };
  const PAYMENTS: Principal = { ...MEMBER, ownedTeams: ["Payments"] };
  const rules = [
    { name: "Own setup for everyone", audience: { kind: "workspace" as const }, rules: [{ kind: "own-setup", allowed: true, repos: ["*"] }] },
    { name: "Payments keeps to the team's", audience: { kind: "teams" as const, ids: ["Payments"] }, rules: [{ kind: "own-setup", allowed: false, repos: ["payments-*"] }] },
  ];

  it("given no rule, when it is read, then the starter's own setup is allowed", () => {
    // when
    const read = ownSetupFor([], ADMIN, [], repo);

    // then
    expect(read).toEqual({ allowed: true, policy: null });
  });

  it("given an allowing rule for everyone and a refusing one for Payments' repositories, when each is read, then the refusal holds where it names the person and the repository, and the rule starts no refusal of its own", () => {
    // when
    const payments = ownSetupFor(rules, PAYMENTS, [], repo);
    const elsewhere = ownSetupFor(rules, PAYMENTS, [], { id: "platform-skills" });
    const others = ownSetupFor(rules, ADMIN, [], repo);

    // then
    expect(payments).toEqual({ allowed: false, policy: { id: null, name: "Payments keeps to the team's" } });
    expect(elsewhere.allowed).toBe(true);
    expect(others.allowed).toBe(true);
    expect(taskStartRefusal(rules, PAYMENTS, [], repo, none, [repo], new Map())).toBeNull();
  });

  it("given a rule that says neither yes nor no or names no repository, when the policy is checked, then it is refused, and a good one is kept as written", () => {
    // when
    const tries = [
      () => checkPolicy({ name: "Odd", audience: { kind: "workspace" }, rules: [{ kind: "own-setup", allowed: "no", repos: ["*"] }] }),
      () => checkPolicy({ name: "Odd", audience: { kind: "workspace" }, rules: [{ kind: "own-setup", allowed: false, repos: [] }] }),
    ];

    // then
    expect(tries.map((t) => { try { t(); return null; } catch (e) { return (e as Error).message; } })).toEqual([
      "rule 1: the starter's own setup is allowed or not",
      "rule 1: its repositories is a list of at least one",
    ]);
    expect(checkPolicy({ name: "Fine", audience: { kind: "workspace" }, rules: [{ kind: "own-setup", allowed: false, repos: ["payments-*"] }] }).rules).toEqual([{ kind: "own-setup", allowed: false, repos: ["payments-*"] }]);
  });
});

describe("the team's policies as Claude Code managed settings", () => {
  it("given a merged policy for one team, when an admin exports that team's repository and the workspace, then the first carries Claude Code's deny entries and the second does not", async () => {
    // given
    const { ctx } = await seeded();
    const app = createApp(ctx, as(ADMIN));
    const head = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!.head;
    const { requests, id } = await (await send(app, "POST", "/api/policies", { policy: retire, message: "chore: retire the warehouse server", baseShas: { "payments-skills": head } })).json();
    await send(app, "POST", `/api/repos/payments-skills/requests/${requests[0].number}/merge`, {});
    await syncRepo(ctx, "payments-skills");

    // when
    const team = await (await app.request("/api/policies/export?repo=payments-skills")).json();
    const workspace = await (await app.request("/api/policies/export")).json();
    const file = await app.request("/api/policies/export?repo=payments-skills&download=1");

    // then
    expect(team).toMatchObject({ settings: { permissions: { deny: ["mcp__warehouse", "mcp__plugin_*_warehouse__*"] } }, policies: [id], approximate: [], notMapped: [], paths: { linux: "/etc/claude-code/managed-settings.json" } });
    expect(workspace.settings).toEqual({ permissions: { deny: [] } });
    expect(file.headers.get("content-disposition")).toBe('attachment; filename="managed-settings.json"');
    expect(JSON.parse(await file.text())).toEqual(team.settings);
  });

  it("given a member, when they ask for the export, then it is refused", async () => {
    const { ctx } = await seeded();
    expect((await createApp(ctx, as(MEMBER)).request("/api/policies/export")).status).toBe(403);
  });
});

describe("what the event log says about the orchestrator's own policies", () => {
  it("given an admin who adds, changes and removes an orchestrator policy and a team owner refused a task by it, when the log is read, then each is there with who, which policy and why, and the start never reached the runner", async () => {
    // given
    const { ctx } = await seeded();
    const app = createApp(ctx, as(ADMIN));
    const owner: Principal = { id: "o", name: "Olu Example", email: "olu@example.invalid", role: "member", ownedTeams: ["Payments"] };
    const started: unknown[] = [];
    const runner = { agents: () => [{ id: "fake", label: "Stand-in agent", options: [], modes: ["auto"] }], codeTarget: () => null, keptForMachine: () => false, personal: async () => null, runsHere: () => true, start: async (input: unknown) => started.push(input) } as unknown as TaskRunner;
    const policy = { name: "No tasks on payments", audience: { kind: "workspace" }, rules: [{ kind: "repo-access", effect: "deny", repos: ["payments-skills"] }] };

    // when
    const { policy: saved } = await (await send(app, "POST", "/api/policies", { policy })).json();
    await send(app, "PUT", `/api/policies/${saved.id}`, { policy: { ...policy, rules: [...policy.rules, { kind: "task-budget", monthlyUsd: 25, per: "member" }] } });
    const refused = await startTask(ctx, runner, owner, { repoId: "payments-skills", title: "Tidy the checklist", agent: "fake" });
    await send(app, "DELETE", `/api/policies/${saved.id}`, {});
    const { events } = await ctx.store.eventPage(ctx.tenant, {}, null, 10);

    // then
    expect(refused).toMatchObject({ status: 403, code: "repo-access" });
    expect(started).toEqual([]);
    expect(events.reverse().map((e) => [e.kind, e.actor.email, e.subject])).toEqual([
      ["policy.saved", ADMIN.email, `policy:${saved.id}`],
      ["policy.saved", ADMIN.email, `policy:${saved.id}`],
      ["task.refused", owner.email, `policy:${saved.id}`],
      ["policy.deleted", ADMIN.email, `policy:${saved.id}`],
    ]);
    expect(events.map((e) => e.detail)).toEqual([
      'added the orchestrator policy "No tasks on payments" for the whole organization: denies tasks on payments-skills',
      'changed the orchestrator policy "No tasks on payments" for the whole organization: denies tasks on payments-skills; a task budget of $25.00 a month for each member',
      'repo-access: a task on payments-skills was refused by the orchestrator policy "No tasks on payments"',
      'removed the orchestrator policy "No tasks on payments"',
    ]);
    expect(events[2]!.repoId).toBe("payments-skills");
  });
});

describe("an audience of members by their tags", () => {
  const contractors = { kind: "tags" as const, ids: ["contractors"] };
  const allButContractors = { kind: "except-tags" as const, ids: ["contractors"] };

  it("given a member tagged contractors and one with no tag, when each is matched, then a tags audience holds the first only and an except-tags audience the second only", () => {
    expect([inAudience(contractors, MEMBER, ["contractors", "backend"]), inAudience(contractors, ADMIN, [])]).toEqual([true, false]);
    expect([inAudience(allButContractors, MEMBER, ["contractors"]), inAudience(allButContractors, ADMIN, ["backend"])]).toEqual([false, true]);
  });

  it("given a rule that keeps tagged members off every repository, when a tagged member and an untagged one start a task, then only the tagged one is refused", async () => {
    // given
    const { ctx } = await seeded();
    const owner: Principal = { id: "owner", name: "Owner", email: "owner@example.invalid", role: "owner", ownedTeams: [] };
    const tagged = await createUser(ctx.store, ctx.tenant, new Set(), { email: "cara@example.invalid", role: "admin" }, owner);
    const untagged = await createUser(ctx.store, ctx.tenant, new Set(), { email: "dev@example.invalid", role: "admin" }, owner);
    await ctx.store.setManualTags(ctx.tenant, tagged.id, ["contractors"]);
    const saved = await send(createApp(ctx, as(ADMIN)), "POST", "/api/policies", { policy: { name: "No tasks for contractors", audience: contractors, rules: [{ kind: "repo-access", effect: "deny", repos: ["*"] }] } });
    expect((await saved.json()).saved).toBe("applied");
    ctx.tasks = createTaskRunner(ctx, { agents: [fakeAgentAdapter(join(import.meta.dirname, "..", "demo", "fake-agent.mjs"))], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH } });
    const start = async (user: Principal) => send(createApp(ctx, as(user)), "POST", "/api/tasks", { title: "Add a note", description: "", repoId: "payments-skills", agent: "fake" });

    // when
    const byTagged = await start(await principalOf(ctx.store, tagged));
    const byUntagged = await start(await principalOf(ctx.store, untagged));
    await ctx.tasks.idle();

    // then
    expect(byTagged.status).toBe(403);
    expect((await byTagged.json()).error).toBe('"No tasks for contractors" does not let you start tasks on payments-skills.');
    expect(byUntagged.status).toBe(201);
  });

  it("given a tags audience, when it is previewed, then it lists the tagged members only", async () => {
    // given
    const { ctx } = await seeded();
    const owner: Principal = { id: "owner", name: "Owner", email: "owner@example.invalid", role: "owner", ownedTeams: [] };
    const tagged = await createUser(ctx.store, ctx.tenant, new Set(), { email: "cara@example.invalid", name: "Cara Example", role: "member" }, owner);
    await createUser(ctx.store, ctx.tenant, new Set(), { email: "dev@example.invalid", name: "Dev Example", role: "member" }, owner);
    await ctx.store.setManualTags(ctx.tenant, tagged.id, ["contractors"]);

    // when
    const preview = await (await send(createApp(ctx, as(ADMIN)), "POST", "/api/policies/preview", { audience: contractors, rules: [{ kind: "repo-access", effect: "deny", repos: ["*"] }] })).json();

    // then
    expect(preview.members).toEqual([{ id: tagged.id, name: "Cara Example" }]);
  });
});

describe("a person's remaining task budget", () => {
  const stored = (createdBy: string, usd: number | null, createdAt: string, id: string): TaskRecord =>
    ({ tenant: "", id, repoId: "payments-skills", team: "Payments", title: "t", description: "", issueUrl: null, issueKey: null, agent: "fake", status: "needs-review", createdBy, createdAt, startedAt: null, finishedAt: null, baseSha: null, tests: null, cost: { usd, inputTokens: null, outputTokens: null }, requestNumber: null, error: null }) as TaskRecord;

  it("given a monthly budget per member and this month's and last month's tasks, when the person asks, then they see this month's spend, what is left and which policy it is", async () => {
    // given
    const { ctx } = await seeded();
    const month = new Date().toISOString().slice(0, 7);
    const lastMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 15)).toISOString();
    for (const [i, t] of [[ADMIN.email, 1.25, `${month}-01T10:00:00.000Z`], [ADMIN.email, null, `${month}-01T11:00:00.000Z`], [ADMIN.email, 9, lastMonth], [MEMBER.email, 9, `${month}-01T10:00:00.000Z`]].entries()) {
      await ctx.store.createTask({ ...stored(t[0] as string, t[1] as number | null, t[2] as string, `00000000000${i}`), tenant: ctx.tenant });
    }
    const app = createApp(ctx, as(ADMIN));
    const { policy } = await (await send(app, "POST", "/api/policies", { policy: { name: "Monthly task budget", audience: { kind: "workspace" }, rules: [{ kind: "task-budget", monthlyUsd: 5, per: "member" }] } })).json();

    // when
    const answer = await (await app.request("/api/policies/current-budgets")).json();

    // then
    expect(answer).toEqual({ month, budgets: [{ policyId: policy.id, policy: "Monthly task budget", per: "member", monthlyUsd: 5, spentUsd: 1.25, reservedUsd: 0, heldTasks: 0, leftUsd: 3.75, reached: false, unknownCost: 1 }] });
  });

  it("given tasks from earlier this month and from the end of last month, when a draft is previewed, then the last 30 days and this month are counted apart", async () => {
    // given: the fifth of a month, so the last 30 days reach into the month before
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-05T12:00:00.000Z"));
    onTestFinished(() => void vi.useRealTimers());
    const { ctx } = await seeded();
    const thisMonth = "2026-10-01T00:30:00.000Z";
    const lastMonth = "2026-09-30T23:30:00.000Z";
    const owner: Principal = { id: "owner", name: "Owner", email: "owner@example.invalid", role: "owner", ownedTeams: [] };
    const ada = await createUser(ctx.store, ctx.tenant, new Set(), { email: "cara@example.invalid", role: "member" }, owner);
    await ctx.store.createTask({ ...stored(ada.email, 2, thisMonth, "aaaaaaaaaaa1"), tenant: ctx.tenant });
    await ctx.store.createTask({ ...stored(ada.email, 3, lastMonth, "aaaaaaaaaaa2"), tenant: ctx.tenant });

    // when
    const preview = await (await send(createApp(ctx, as(ADMIN)), "POST", "/api/policies/preview", { audience: { kind: "workspace" }, rules: [{ kind: "task-budget", monthlyUsd: 10, per: "member" }] })).json();

    // then
    expect(preview.usage30d).toEqual({ tasks: 2, usd: 5, unknownCost: 0 });
    expect(preview.usageThisMonth).toEqual({ tasks: 1, usd: 2, unknownCost: 0 });
  });
});

describe("a monthly budget for an audience named by tags or by member", () => {
  const stored = (createdBy: string, usd: number, id: string): TaskRecord =>
    ({ tenant: "", id, repoId: "payments-skills", team: "Payments", title: "t", description: "", issueUrl: null, issueKey: null, agent: "fake", status: "needs-review", createdBy, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, baseSha: null, tests: null, cost: { usd, inputTokens: null, outputTokens: null }, requestNumber: null, error: null }) as TaskRecord;

  it.each([
    ["tags", () => ({ kind: "tags" as const, ids: ["contractors"] })],
    ["members by id", (taggedId: string) => ({ kind: "members" as const, ids: [taggedId] })],
  ])("given a budget for the whole audience of %s and a costly task by someone in it and one by someone outside, when it is read, then only the first counts and the budget is reached", async (_case, audienceFor) => {
    // given
    const { ctx } = await seeded();
    const owner: Principal = { id: "owner", name: "Owner", email: "owner@example.invalid", role: "owner", ownedTeams: [] };
    const tagged = await createUser(ctx.store, ctx.tenant, new Set(), { email: "cara@example.invalid", role: "admin" }, owner);
    const other = await createUser(ctx.store, ctx.tenant, new Set(), { email: "dev@example.invalid", role: "admin" }, owner);
    await ctx.store.setManualTags(ctx.tenant, tagged.id, ["contractors"]);
    await ctx.store.createTask({ ...stored(tagged.email, 6, "bbbbbbbbbbb1"), tenant: ctx.tenant });
    await ctx.store.createTask({ ...stored(other.email, 40, "bbbbbbbbbbb2"), tenant: ctx.tenant });
    const app = createApp(ctx, as(ADMIN));
    const saved = await (await send(app, "POST", "/api/policies", { policy: { name: "Contractor budget", audience: audienceFor(tagged.id), rules: [{ kind: "task-budget", monthlyUsd: 5, per: "audience" }] } })).json();
    expect(saved.saved).toBe("applied");

    // when
    const { budgets } = await (await createApp(ctx, as(await principalOf(ctx.store, tagged))).request("/api/policies/current-budgets")).json();

    // then
    expect(budgets).toEqual([expect.objectContaining({ policy: "Contractor budget", per: "audience", spentUsd: 6, leftUsd: 0, reached: true })]);
  });
});
