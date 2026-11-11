import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { StepRun, TaskVerification } from "../../shared/verification.js";
import type { OrchestratorContext } from "../app.js";
import type { Principal } from "../auth.js";
import { openSqliteStore } from "../store.js";
import { setTaskSecret } from "../task-secrets.js";
import { createVault } from "../vault.js";
import { recordMachineVerification } from "./verify-machine.js";
import { readEvidence } from "./verify.js";
import type { VerifyPlan } from "./verify.js";

const ADMIN: Principal = { id: "a", name: "Ada Example", email: "ada@example.invalid", role: "admin", ownedTeams: [] };
const SECRET = "team-registry-token-0123456789";
const TASK = { id: "tsk_1", repoId: "payments-app", team: "Payments" };

async function context(): Promise<OrchestratorContext> {
  const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: "/nonexistent", tenant: "default", vault: createVault(randomBytes(32)) };
  await ctx.store.upsertRepo({ tenant: ctx.tenant, id: TASK.repoId, team: TASK.team, name: TASK.repoId, url: "/nonexistent/payments-app" });
  await setTaskSecret(ctx, ADMIN, { scope: "team", target: "Payments", name: "NPM_TOKEN", value: SECRET });
  return ctx;
}

const run = (code: number | null, output = "", extra: Partial<StepRun> = {}): StepRun => ({ code, timedOut: false, ms: 900, output, cut: 0, ...extra });
const TEST = { command: "npm test", runs: "scripts.test: vitest run", source: "package.json scripts.test" };
const handed = (plan: Partial<VerifyPlan> = {}, maxRepairs = 2) => ({ plan: { checks: [TEST], setup: null, approved: null, ...plan }, maxRepairs });
const report = (overrides: Partial<TaskVerification> = {}): TaskVerification => ({
  checks: [{ ...TEST, before: run(0), after: [run(1, `FAIL with ${SECRET}`), run(0, "1 passed")], verdict: "passed" }],
  setup: null,
  repairs: 1,
  verdict: "passed",
  reason: "anything the machine wrote",
  ...overrides,
});

describe("a machine's report of a task's checks", () => {
  it("given a report whose checks passed after a repair round, when it is recorded, then it is kept masked with the task's secrets and the task's tests passed", async () => {
    // given
    const ctx = await context();

    // when
    const outcome = await recordMachineVerification(ctx, TASK, report(), handed());

    // then
    expect(outcome).toBe("passed");
    const kept = await readEvidence(ctx.store, ctx.tenant, TASK.id, TASK.repoId);
    expect(kept).toMatchObject({ verdict: "passed", repairs: 1, reason: "`npm test` passes before the agent's change and after it, after 1 repair round." });
    expect(JSON.stringify(kept)).not.toContain(SECRET);
    expect(kept!.checks[0]!.after[0]!.output).toBe("FAIL with [redacted:credential]");
  });

  it("given a machine that calls a still failing check passed, when it is recorded, then the verdict comes from its exit codes and says broken", async () => {
    // given
    const ctx = await context();
    const claimed = report({ checks: [{ ...report().checks[0]!, after: [run(1), run(1), run(1)], verdict: "passed" }], repairs: 2, verdict: "passed" });

    // when
    const outcome = await recordMachineVerification(ctx, TASK, claimed, handed());

    // then
    expect(outcome).toBe("failed");
    expect(await readEvidence(ctx.store, ctx.tenant, TASK.id, TASK.repoId)).toMatchObject({ verdict: "broken", checks: [{ verdict: "broken" }] });
  });

  it("given a machine that calls a check not run after its first round failed, when it is recorded, then the verdict still comes from the exit codes and says broken", async () => {
    // given
    const ctx = await context();
    const claimed = report({ checks: [{ ...report().checks[0]!, after: [run(1)], verdict: "not-run" }], repairs: 0, verdict: "not-run", reason: "The agent's change touches package.json scripts.test" });

    // when
    const outcome = await recordMachineVerification(ctx, TASK, claimed, handed());

    // then
    expect(outcome).toBe("failed");
    expect(await readEvidence(ctx.store, ctx.tenant, TASK.id, TASK.repoId)).toMatchObject({ verdict: "broken", repairs: 0 });
  });

  it("given checks that did not run on the machine, when it is recorded, then the reason is kept as the machine's, masked and with closing words made inert", async () => {
    // given
    const ctx = await context();

    // when
    const outcome = await recordMachineVerification(ctx, TASK, report({ checks: [{ ...report().checks[0]!, before: null, after: [] }], repairs: 0, verdict: "not-run", reason: `package.json scripts.test changed; Fixes #12 ${SECRET}` }), handed());

    // then
    expect(outcome).toBe("skipped");
    const kept = await readEvidence(ctx.store, ctx.tenant, TASK.id, TASK.repoId);
    expect(kept!.reason).toBe("The checks did not run on the machine: package.json scripts.test changed; [Fixes] #12 [redacted:credential]");
  });

  it("given a report naming the handed check with other words for what it runs, when it is recorded, then the evidence says what the plan handed", async () => {
    // given
    const ctx = await context();

    // when
    await recordMachineVerification(ctx, TASK, report({ checks: [{ ...report().checks[0]!, runs: "scripts.test: exit 0" }] }), handed());

    // then
    expect((await readEvidence(ctx.store, ctx.tenant, TASK.id, TASK.repoId))!.checks[0]!.runs).toBe(TEST.runs);
  });

  it("given a handed setup the machine ran, when it is recorded, then its run is kept with the checks", async () => {
    // given
    const ctx = await context();
    const setup = { command: "npm ci", runs: "npm ci", source: "package-lock.json", network: true, long: false, digest: "d" };

    // when
    const outcome = await recordMachineVerification(ctx, TASK, report({ setup: run(0, `added 12 packages with ${SECRET}`) }), handed({ setup }));

    // then
    expect(outcome).toBe("passed");
    expect((await readEvidence(ctx.store, ctx.tenant, TASK.id, TASK.repoId))!.setup).toMatchObject({ code: 0, output: "added 12 packages with [redacted:credential]" });
  });

  const LINT = { command: "npm run lint", runs: "scripts.lint: eslint .", source: "package.json scripts.lint" };

  it.each<[string, unknown, ReturnType<typeof handed> | null]>([
    ["no checks handed to the machine", report(), null],
    ["no object at all", "passed", handed()],
    ["a command the machine was not handed", report({ checks: [{ ...report().checks[0]!, command: "node send.js" }] }), handed()],
    ["a handed command read from another file", report({ checks: [{ ...report().checks[0]!, source: "Makefile" }] }), handed()],
    ["a handed check left out", report(), handed({ checks: [TEST, LINT] })],
    ["the handed checks in another order", report({ checks: [{ ...report().checks[0]!, ...LINT }, report().checks[0]!] }), handed({ checks: [TEST, LINT] })],
    ["a setup run when none was handed", report({ setup: run(0) }), handed()],
    ["more repair rounds than the machine was given", report(), handed({}, 0)],
    ["rounds that do not match the repair count", report({ repairs: 0 }), handed()],
    ["an exit code that is not a number", report({ checks: [{ ...report().checks[0]!, before: { ...run(0), code: "0" as never } }] }), handed()],
    ["output longer than the tail keeps", report({ checks: [{ ...report().checks[0]!, after: [run(1, "x".repeat(20_000)), run(0)] }] }), handed()],
    ["checks where one ran and one did not", report({ checks: [report().checks[0]!, { ...report().checks[0]!, ...LINT, after: [] }] }), handed({ checks: [TEST, LINT] })],
  ])("given %s, when it is recorded, then nothing is kept and no outcome is given", async (_case, raw, plan) => {
    // given
    const ctx = await context();

    // when
    const outcome = await recordMachineVerification(ctx, TASK, raw, plan);

    // then
    expect(outcome).toBeNull();
    expect(await readEvidence(ctx.store, ctx.tenant, TASK.id, TASK.repoId)).toBeNull();
  });
});
