import { describe, expect, it } from "vitest";
import { personalRules } from "./opencode-rules.js";
import type { OpencodeRule } from "./opencode-rules.js";

/** What OpenCode decides for a call, as 1.19.4 does: the last rule whose permission and pattern match, by case; `*` matches anything, `?` one character. */
function decides(rules: readonly OpencodeRule[], permission: string, target: string): OpencodeRule["action"] {
  const matches = (pattern: string, value: string) => new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\?/g, ".")).join(".*")}$`).test(value);
  return [...rules].reverse().find((rule) => matches(rule.permission, permission) && matches(rule.pattern, target))?.action ?? "ask";
}

describe("the rules an OpenCode session run as its person holds the agent to", () => {
  it.each([
    ["approval-required", "ask"],
    ["auto-accept-edits", "allow"],
    ["auto", "allow"],
    ["full-access", "allow"],
  ] as const)("given %s, when the agent edits a file, runs a command or fetches a page, then the edit is %s, as in Claude Code's run as you, and the command and the fetch are denied in every mode", (mode, edit) => {
    // when
    const rules = personalRules(mode, [], []);

    // then
    expect([decides(rules, "edit", "src/a.ts"), decides(rules, "bash", "npm test"), decides(rules, "webfetch", "https://example.invalid"), decides(rules, "read", "src/a.ts")]).toEqual([edit, "deny", "deny", "allow"]);
  });

  it("given a mode that asks for every edit, when the agent writes or reads its own to-do list, then it does so without a card, as in Claude Code's run as you", () => {
    // when
    const rules = personalRules("approval-required", [], []);

    // then
    expect([decides(rules, "todowrite", "*"), decides(rules, "todoread", "*")]).toEqual(["allow", "allow"]);
  });

  it("given any mode, when the agent calls an MCP tool, the tracker's or a forge's included, then the rules ask, so the session decides the call by its server before any person is asked", () => {
    // when
    const rules = personalRules("full-access", [], []);

    // then
    for (const tool of ["atlassian_createJiraIssue", "atlassian_getJiraIssue", "github_merge_pull_request", "notebook_search_pages"]) expect([tool, decides(rules, tool, "*")]).toEqual([tool, "ask"]);
  });

  it("given the task's attachments in a folder of their own outside the work folder, when the agent reads one or writes there, then it reads it, never writes there, and every other folder outside stays closed", () => {
    // given
    const attachments = "/data/tasks/t1/attachments";

    // when
    const rules = personalRules("full-access", [], [], [attachments]);

    // then
    expect(decides(rules, "external_directory", `${attachments}/screenshot.png`)).toBe("allow");
    expect(decides(rules, "external_directory", attachments)).toBe("allow");
    expect(decides(rules, "read", `${attachments}/screenshot.png`)).toBe("allow");
    expect(decides(rules, "edit", `${attachments}/screenshot.png`)).toBe("deny");
    expect(decides(rules, "external_directory", "/data/tasks/t1/home/.ssh/id_rsa")).toBe("deny");
    expect(decides(rules, "edit", "src/index.ts")).toBe("allow");
  });

  it("given any mode, when the agent writes into a .git of the folder, reaches outside the folder or asks its own question, then each is denied", () => {
    // when
    const rules = personalRules("full-access", [], []);

    // then
    for (const path of [".git/config", "sub/.git/hooks/pre-commit", "/work/repo/.git/config", ".git"]) expect([path, decides(rules, "edit", path)]).toEqual([path, "deny"]);
    expect(decides(rules, "edit", "src/git-notes.md")).toBe("allow");
    expect(decides(rules, "external_directory", "/etc/hosts")).toBe("deny");
    expect(decides(rules, "question", "*")).toBe("deny");
  });

  it("given the team's policies keep env files from edits and a secrets folder from reads, and a denied tool, when the agent reaches them, then each is denied in a mode that allows the rest", () => {
    // given
    const policies = [
      { action: "tool.use" as const, resource: "tool:Edit:*.env", effect: "deny" as const, reason: "env files are set by the platform team" },
      { action: "tool.use" as const, resource: "tool:Read:secrets/*", effect: "deny" as const, reason: "secrets are not read" },
      { action: "mcp.use" as const, resource: "mcp:deploy:*", effect: "deny" as const, reason: "not a path rule" },
    ];

    // when
    const rules = personalRules("full-access", ["Grep"], policies);

    // then
    expect(decides(rules, "edit", "prod.env")).toBe("deny");
    expect(decides(rules, "edit", "src/a.ts")).toBe("allow");
    expect(decides(rules, "read", "secrets/key")).toBe("deny");
    expect(decides(rules, "grep", "anything")).toBe("deny");
    expect(rules.some((rule) => rule.pattern.includes("deploy"))).toBe(false);
  });
});
