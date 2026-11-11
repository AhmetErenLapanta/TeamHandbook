import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OrchestratorError } from "./errors.js";
import { orgPlan, requirePlan, shownPlan } from "./plans.js";
import { openSqliteStore } from "./store.js";
import type { Store } from "./store.js";

let dir: string;
let store: Store;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "th-plans-"));
  store = openSqliteStore(join(dir, "orchestrator.db"));
  await store.insertOrg({ tenant: "acme", name: "Acme", createdBy: "idn_a", createdAt: "2026-11-02T10:00:00.000Z", quotas: { members: null, tasksPerMonth: null, concurrentTasks: null }, deletedAt: null });
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("what an organization's plan opens", () => {
  it("given a new cloud organization, when a Pro feature is asked for, then it is refused with a 402 naming the feature and both plans, and once the plan is Pro it opens", async () => {
    // given
    const ctx = { store, tenant: "acme", mode: "cloud" as const };

    // when
    const refused = await requirePlan(ctx, "pro", "Single sign-on").catch((err: unknown) => err);
    await store.setOrgPlan("acme", "pro");
    const opened = await requirePlan(ctx, "pro", "Single sign-on");

    // then
    expect(refused).toBeInstanceOf(OrchestratorError);
    expect(refused).toMatchObject({ status: 402, code: "plan-required", message: "Single sign-on is part of the Pro plan; this organization is on Free" });
    expect(opened).toBeUndefined();
    expect(await orgPlan(ctx)).toBe("pro");
  });

  it("given a self-hosted orchestrator, when a Pro feature is asked for by an organization on Free or with no record, then it opens", async () => {
    await expect(requirePlan({ store, tenant: "acme", mode: "self-hosted" }, "pro", "Single sign-on")).resolves.toBeUndefined();
    await expect(requirePlan({ store, tenant: "default" }, "pro", "Single sign-on")).resolves.toBeUndefined();
  });

  it("given a cloud organization with no record, when its plan is read and a Free feature is asked for, then it is on Free and the feature opens", async () => {
    const ctx = { store, tenant: "missing", mode: "cloud" as const };
    expect(await orgPlan(ctx)).toBe("free");
    await expect(requirePlan(ctx, "free", "Tasks")).resolves.toBeUndefined();
    await expect(requirePlan(ctx, "pro", "Tasks")).rejects.toMatchObject({ status: 402 });
  });

  it("given a cloud organization on Pro and a self-hosted orchestrator, when the plan a screen shows is read, then the cloud's is its plan and the self-hosted one shows none, every feature being open there", async () => {
    // given
    await store.setOrgPlan("acme", "pro");

    // when
    const cloud = await shownPlan({ store, tenant: "acme", mode: "cloud" });
    const selfHosted = await shownPlan({ store, tenant: "acme", mode: "self-hosted" });
    const opened = await requirePlan({ store, tenant: "acme", mode: "self-hosted" }, "pro", "Single sign-on");

    // then
    expect([cloud, selfHosted, opened]).toEqual(["pro", null, undefined]);
  });
});
