import { describe, expect, it } from "vitest";
import type { Principal } from "./auth.js";
import type { OrchestratorContext } from "./app.js";
import { handbookUsage, withNoUse } from "./handbook-usage.js";
import { openSqliteStore } from "./store.js";
import type { TaskRecord } from "./tasks/types.js";

const TENANT = "acme";
const NOW = Date.parse("2026-11-12T12:00:00.000Z");
const at = (daysAgo: number) => new Date(NOW - daysAgo * 86_400_000).toISOString();
const ADA: Principal = { id: "usr_ada", name: "Ada", email: "ada@example.invalid", role: "member", ownedTeams: [] };
const PLUGIN = { source: "plugin:payments-skills@acme-market", sourceLabel: "payments-skills 1.4.0", version: "1.4.0" };
const YOURS = { source: "yours", sourceLabel: "Yours" };

function task(id: string, daysAgo: number, createdBy = ADA.email): TaskRecord {
  return { tenant: TENANT, id, repoId: "shop", team: "Shop", title: id, description: "", issueUrl: null, issueKey: null, agent: "fake", status: "needs-review", createdBy, createdAt: at(daysAgo), startedAt: null, finishedAt: null, baseSha: null, tests: null, cost: { usd: null, inputTokens: null, outputTokens: null }, requestNumber: null, error: null };
}

describe("what a person's own tasks used of their handbooks", () => {
  it("given tasks of hers that called skills and MCP servers, an older task that kept only skill names, one before the window and a teammate's, when she reads her usage, then each skill and server is counted once per task with its source and the newest use, and nothing outside her window or of another person counts", async () => {
    // given
    const store = openSqliteStore(":memory:");
    const ctx = { store, tenant: TENANT } as OrchestratorContext;
    for (const t of [task("tsk_one", 2), task("tsk_two", 5), task("tsk_old_shape", 9), task("tsk_long_ago", 40), task("tsk_lees", 1, "lee@example.invalid")]) await store.createTask(t);
    for (const id of ["tsk_one", "tsk_two", "tsk_long_ago", "tsk_lees"]) await store.noteTaskUse(TENANT, id, "skills", "add-endpoint", PLUGIN);
    await store.noteTaskUse(TENANT, "tsk_one", "skills", "add-endpoint", PLUGIN);
    await store.noteTaskUse(TENANT, "tsk_two", "skills", "review-checklist", YOURS);
    await store.noteTaskUse(TENANT, "tsk_one", "mcpServers", "tracker", YOURS);
    await store.noteUsedSkill(TENANT, "tsk_old_shape", "review-checklist");

    // when
    const usage = await handbookUsage(ctx, ADA, 30, NOW);

    // then
    expect(usage).toEqual({
      days: 30,
      skills: [
        { source: PLUGIN.source, name: "add-endpoint", tasks: 2, lastAt: at(2) },
        { source: "yours", name: "review-checklist", tasks: 1, lastAt: at(5) },
        { source: "unknown", name: "review-checklist", tasks: 1, lastAt: at(9) },
      ],
      mcpServers: [{ source: "yours", name: "tracker", tasks: 1, lastAt: at(2) }],
    });
  });
});

describe("the usage a person's handbook list carries", () => {
  it("given a skill a task used and a skill and a server nobody used, when the sources are read for their use, then the used one keeps its count and the others say zero", () => {
    // given
    const sources = [{ id: "yours", skills: [{ name: "review-checklist", used: { tasks: 2, lastAt: at(5) } }, { name: "idle-skill" }], mcpServers: [{ name: "tracker" }] }];

    // when
    const [yours] = withNoUse(sources);

    // then
    expect(yours!.skills).toEqual([{ name: "review-checklist", used: { tasks: 2, lastAt: at(5) } }, { name: "idle-skill", used: { tasks: 0, lastAt: null } }]);
    expect(yours!.mcpServers).toEqual([{ name: "tracker", used: { tasks: 0, lastAt: null } }]);
  });
});
