import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { OrchestratorContext } from "../app.js";
import type { Principal } from "../auth.js";
import { openSqliteStore } from "../store.js";
import type { PersonalSetup } from "../tasks/personal-setup.js";
import { createVault, storeSecret } from "../vault.js";
import { mcpRows } from "./mcp-rows.js";
import { secretName } from "./personal-mcp.js";

const OWNER: Principal = { id: "u-solo", name: "Solo Person", email: "solo@example.invalid", role: "owner", ownedTeams: [] };

const SETUP: PersonalSetup = {
  commands: [],
  plugins: [],
  claudeMd: false,
  readAt: "2026-11-13T08:00:00.000Z",
  mcpServers: [
    { name: "tickets", kind: "http", scope: "user", asksForValue: false },
    { name: "local-db", kind: "stdio", scope: "project", asksForValue: false },
    { name: "plugin_payments_helper", kind: "unknown", scope: "plugin", asksForValue: null },
  ],
};

function orchestrator_(setup: PersonalSetup | null = SETUP): OrchestratorContext {
  const tasks = { lastPersonalSetup: () => setup, personalSetup: async () => setup } as unknown as NonNullable<OrchestratorContext["tasks"]>;
  return { store: openSqliteStore(":memory:"), dataDir: "unused", tenant: "acme", allowedHosts: null, vault: createVault(randomBytes(32)), tasks };
}

const own = (name: string, over: Record<string, unknown> = {}) => ({ name, description: "", transport: "http", url: "https://ticket-desk.example.invalid/mcp", auth: "oauth", tools: ["get_ticket"], addedAt: "2026-11-01T00:00:00.000Z", ...over });

afterEach(() => {
  delete process.env.ORCHESTRATOR_MODE;
});

describe("the person's MCP servers in one list", () => {
  it("given servers in their Claude Code, one the orchestrator also holds, one only the orchestrator holds, and a connector a task found asking to sign in, when the list is made, then each is one row with its origins, and a name in both places is one row", async () => {
    // given
    process.env.ORCHESTRATOR_MODE = "local";
    const ctx = orchestrator_();
    await ctx.store.setSetting("acme", `mcp.personal.${OWNER.id}`, JSON.stringify([own("tickets"), own("notes", { auth: "token" })]));
    await storeSecret(ctx.store, ctx.vault!, "acme", secretName(OWNER.id, "tickets", "oauth"), JSON.stringify({ accessToken: "a", refreshToken: null, expiresAt: null, tokenEndpoint: "https://t.example.invalid/token", clientId: "c", clientSecret: null, resource: "r" }), OWNER.email);
    await ctx.store.createTask({ tenant: "acme", id: "aaaaaaaaaaaa", repoId: "web", team: "Mine", title: "t", description: "", issueUrl: null, issueKey: null, agent: "fake", status: "needs-review", createdBy: OWNER.email, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, baseSha: null, tests: null, cost: { usd: null, inputTokens: null, outputTokens: null }, requestNumber: null, error: null });
    await ctx.store.updateTask("acme", "aaaaaaaaaaaa", { mcpNeedsSignIn: ["claude.ai Notion", "local-db"] });

    // when
    const rows = await mcpRows(ctx, OWNER);

    // then
    expect(rows!.map((r) => [r.name, r.origins, r.kind, r.needsSignIn, r.signIn?.via ?? null, r.tools])).toEqual([
      ["tickets", ["claude-user", "orchestrator"], "http", false, null, 1],
      ["local-db", ["claude-project"], "stdio", true, "claude", null],
      ["plugin_payments_helper", ["claude-plugin"], "unknown", false, null, null],
      ["claude.ai Notion", ["claude-connector"], null, true, "claude", null],
      ["notes", ["orchestrator"], "http", true, "orchestrator", 1],
    ]);
  });

  it("given a team's orchestrator, an API key, a member, or no read by the probe yet, when the list is asked for, then there is none", async () => {
    // given
    const ctx = orchestrator_();
    process.env.ORCHESTRATOR_MODE = "self-hosted";
    const team = await mcpRows(ctx, OWNER);
    process.env.ORCHESTRATOR_MODE = "local";

    // when
    const byKey = await mcpRows(ctx, { ...OWNER, key: { id: "k", scope: "read" } as unknown as Principal["key"] });
    const member = await mcpRows(ctx, { ...OWNER, role: "member" });
    const unread = await mcpRows(orchestrator_(null), OWNER);

    // then
    expect([team, byKey, member, unread]).toEqual([null, null, null, null]);
  });
});
