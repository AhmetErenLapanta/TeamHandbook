import { describe, expect, it } from "vitest";
import { claudeCodeAdapter, opencodeAdapter } from "../server/tasks/agents.js";
import { agentStatus } from "./agent-status.js";
import type { ProbeRun } from "./agent-status.js";

/** Stand-in answers of each CLI, by its arguments; nothing real runs. */
const answers = (table: Record<string, { code: number | null; stdout: string }>): { run: ProbeRun; asked: string[] } => {
  const asked: string[] = [];
  return {
    asked,
    run: async (program, args) => {
      const key = `${program} ${args.join(" ")}`;
      asked.push(key);
      return table[key] ?? { code: null, stdout: "" };
    },
  };
};

describe("what this machine says about its agents", () => {
  it("given Claude Code signed in with an account and OpenCode not installed, when the machine reports, then it says signed in with the version and nothing of the account", async () => {
    const { run } = answers({
      "claude --version": { code: 0, stdout: "2.1.316 (Claude Code)\n" },
      "claude auth status --json": { code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "max@example.invalid", orgName: "Example Org" }) },
    });

    const status = await agentStatus([claudeCodeAdapter("claude"), opencodeAdapter("opencode")], run);

    expect(status).toEqual([
      { id: "claude-code", installed: true, version: "2.1.316", supported: "ok", signIn: "signed-in" },
      { id: "opencode", installed: false, version: null, supported: "update", signIn: "unknown" },
    ]);
    expect(JSON.stringify(status)).not.toMatch(/example|Example/);
  });

  it("given an older Claude Code that is signed out, when the machine reports, then it says to update and that it is signed out", async () => {
    const { run } = answers({
      "claude --version": { code: 0, stdout: "1.0.0 (Claude Code)\n" },
      "claude auth status --json": { code: 1, stdout: JSON.stringify({ loggedIn: false }) },
    });

    expect(await agentStatus([claudeCodeAdapter("claude")], run)).toEqual([{ id: "claude-code", installed: true, version: "1.0.0", supported: "update", signIn: "signed-out" }]);
  });
});
