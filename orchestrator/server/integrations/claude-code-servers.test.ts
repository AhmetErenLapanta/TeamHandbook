import { afterEach, describe, expect, it } from "vitest";
import type { OrchestratorContext } from "../app.js";
import type { Principal } from "../auth.js";
import type { PersonalSetup } from "../tasks/personal-setup.js";
import { claudeCodeServers } from "./claude-code-servers.js";

const OWNER: Principal = { id: "u-solo", name: "Solo Person", email: "solo@example.invalid", role: "owner", ownedTeams: [] };

/** The runner's probe standing in: what it last read, and how many reads were begun. */
function probe(setup: PersonalSetup | null) {
  const asked = { reads: 0 };
  const tasks = { lastPersonalSetup: () => setup, personalSetup: async () => (asked.reads++, setup) } as unknown as NonNullable<OrchestratorContext["tasks"]>;
  return { ctx: { tasks }, asked };
}

const SETUP: PersonalSetup = {
  commands: [],
  plugins: [],
  claudeMd: false,
  readAt: "2026-11-04T08:00:00.000Z",
  mcpServers: [
    { name: "atlassian", kind: "http", scope: "user", asksForValue: false },
    { name: "linear-server", kind: "http", scope: "project", asksForValue: true },
    { name: "local-db", kind: "stdio", scope: "user", asksForValue: false },
    { name: "helper", kind: "unknown", scope: "plugin", asksForValue: null },
  ],
};

afterEach(() => {
  delete process.env.ORCHESTRATOR_MODE;
});

describe("the MCP servers of one person's own Claude Code, as Integrations counts them", () => {
  it("given the probe's read on a local orchestrator, when its owner opens Integrations, then the page is told how many servers their tasks use, nothing of what they are, and a fresh read is begun", () => {
    // given
    process.env.ORCHESTRATOR_MODE = "local";
    const { ctx, asked } = probe(SETUP);

    // when
    const counted = claudeCodeServers(ctx, OWNER);

    // then
    expect(counted).toBe(4);
    expect(asked.reads).toBe(1);
  });

  it("given a team's orchestrator, an API key or a member, when Integrations is read, then no count is given", () => {
    // given
    const { ctx } = probe(SETUP);
    const member: Principal = { ...OWNER, role: "member" };

    // when
    process.env.ORCHESTRATOR_MODE = "self-hosted";
    const team = claudeCodeServers(ctx, OWNER);
    process.env.ORCHESTRATOR_MODE = "local";
    const byKey = claudeCodeServers(ctx, { ...OWNER, key: { id: "k", scope: "read" } as unknown as Principal["key"] });
    const byMember = claudeCodeServers(ctx, member);

    // then
    expect([team, byKey, byMember]).toEqual([null, null, null]);
  });
});
