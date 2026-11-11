import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { orgQuota, quotaSettings } from "./quotas.js";
import { openSqliteStore } from "./store.js";
import type { Store } from "./store.js";

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "th-quotas-"));
  store = openSqliteStore(join(dir, "orchestrator.db"));
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("an organization's plan limits", () => {
  it("given every limit set, one of them unlimited, when the settings are read, then a new organization starts with them", () => {
    // when
    const quotas = quotaSettings({ ORCHESTRATOR_QUOTA_MEMBERS: "25", ORCHESTRATOR_QUOTA_TASKS_PER_MONTH: " unlimited ", ORCHESTRATOR_QUOTA_CONCURRENT_TASKS: "3" });

    // then
    expect(quotas).toEqual({ members: 25, tasksPerMonth: null, concurrentTasks: 3 });
  });

  it("given no limit set and one that is no number, when the settings are read, then a new organization has no limit, and the one that is no number is refused by name", () => {
    expect(quotaSettings({})).toEqual({ members: null, tasksPerMonth: null, concurrentTasks: null });
    expect(() => quotaSettings({ ORCHESTRATOR_QUOTA_CONCURRENT_TASKS: "three" })).toThrow("ORCHESTRATOR_MODE=cloud needs ORCHESTRATOR_QUOTA_CONCURRENT_TASKS to be a positive whole number or unlimited");
  });

  it("given an organization created with limits and one the configuration serves, when each one's limits are read, then the first reads what it was given and the second has none", async () => {
    // given
    await store.insertOrg({ tenant: "acme", name: "Acme", createdBy: "idn_a", createdAt: "2026-11-02T10:00:00.000Z", quotas: { members: 5, tasksPerMonth: 100, concurrentTasks: null }, deletedAt: null });

    // when
    const created = await orgQuota({ store, tenant: "acme" });
    const configured = await orgQuota({ store, tenant: "default" });

    // then
    expect(created).toEqual({ members: 5, tasksPerMonth: 100, concurrentTasks: null });
    expect(configured).toEqual({ members: null, tasksPerMonth: null, concurrentTasks: null });
  });
});
