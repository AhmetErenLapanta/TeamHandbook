import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Principal } from "../auth.js";
import { seededContext, storePrincipals } from "../test-fixtures.js";
import { fakeAgentAdapter } from "./agents.js";
import { saveWrites } from "../work/writes.js";
import { FORGE_REASON, PERSONAL_READ_REASON, refusedTool, releasePersonalGuard, TRACKER_REASON, writePersonalGuard, writesTracker } from "./profile.js";
import { createTaskRunner } from "./runner.js";

const ADMIN: Principal = { id: "a", name: "Ada Example", email: "ada@example.invalid", role: "admin", ownedTeams: [] };

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await releasePersonalGuard(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("a tracker's tools that write", () => {
  it.each([
    ["atlassian", "createJiraIssue", true],
    ["atlassian", "editJiraIssue", true],
    ["atlassian", "transitionJiraIssue", true],
    ["atlassian", "addCommentToJiraIssue", true],
    ["atlassian", "addWorklogToJiraIssue", true],
    ["atlassian", "createIssueLink", true],
    ["atlassian", "updateConfluencePage", true],
    ["corp-tools", "jira_delete_issue", true],
    ["corp-tools", "confluence_create_page", true],
    ["atlassian", "getJiraIssue", false],
    ["atlassian", "searchJiraIssuesUsingJql", false],
    ["corp-tools", "jira_get_issue", false],
    ["corp-tools", "jira_search", false],
    ["docs", "search", false],
    ["deploy", "start_rollout", false],
  ])("given %s's %s, when it is read, then it writes to the tracker: %s", (server, tool, writes) => {
    expect(writesTracker(server, tool)).toBe(writes);
  });
});

describe("a forge's tools that write", () => {
  it.each([
    ["github", "merge_pull_request", FORGE_REASON],
    ["github", "create_pull_request_review", FORGE_REASON],
    ["gitlab", "approve_merge_request", FORGE_REASON],
    ["corp-tools", "gitea_close_pull_request", FORGE_REASON],
    ["review-bot", "submit_review", FORGE_REASON],
    ["github", "get_pull_request", null],
    ["gitlab", "list_merge_requests", null],
    ["corp-tools", "github_search_code", null],
    ["deploy", "start_rollout", null],
  ])("given %s's %s, when it is read, then a task is refused it with %s", (server, tool, reason) => {
    expect(refusedTool(server, tool)).toBe(reason);
  });
});

describe("a task given a tracker's tools", { timeout: 120_000 }, () => {
  /** A task on the seeded Payments repository whose operator named a tracker's writing and reading tools for tasks. */
  async function ran(allowed: boolean) {
    const { ctx, root } = await seededContext("orchestrator-tracker-writes-", ["payments-skills"]);
    await storePrincipals(ctx, ADMIN);
    dirs.push(root);
    if (allowed) await saveWrites(ctx, true);
    const script = join(root, "agent.mjs");
    writeFileSync(script, 'import { writeFileSync } from "node:fs";\nwriteFileSync("note.md", "x\\n");\nconsole.log(JSON.stringify({ type: "result", summary: "Done." }));\n');
    const tools = [{ server: "docs", tool: "createJiraIssue" }, { server: "docs", tool: "getJiraIssue" }, { server: "github", tool: "merge_pull_request" }];
    const tasks = createTaskRunner(ctx, { agents: [fakeAgentAdapter(script)], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH }, mcpTools: () => tools });
    const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;
    const started = await tasks.start({ repo, title: "Note the incident", description: "", agent: "fake", user: ADMIN });
    await tasks.idle();
    return (await ctx.store.taskLog(ctx.tenant, started.id, 0)).map((l) => l.text);
  }

  it.each([
    ["off", false],
    ["on", true],
  ])("given an operator who named a tracker's and a forge's writing tools for tasks, when a task starts with the tracker switch %s, then both are left out of what the agent is given and the log says so, since the switch moves issues for the orchestrator alone", async (_case, switched) => {
    // when
    const log = await ran(switched);

    // then
    expect(log).toContainEqual(expect.stringContaining("Left out, as this organization keeps tasks from writing to its tracker, MCP tools: docs/createJiraIssue."));
    expect(log).toContainEqual(expect.stringContaining("Left out, as a task's change reaches people only as a request a person reviews, MCP tools: github/merge_pull_request."));
  });
});

describe("the guard's hook and a tracker's tools", { timeout: 120_000 }, () => {
  /** The guard's hook for a run as you, and its answer to one call. */
  async function guarded() {
    const root = mkdtempSync(join(tmpdir(), "orchestrator-tracker-guard-"));
    dirs.push(root);
    const paths = { root, work: join(root, "work") };
    mkdirSync(paths.work);
    const settings = JSON.parse(readFileSync(await writePersonalGuard(paths), "utf8"));
    const command = settings.hooks.PreToolUse[0].hooks[0].command as string;
    return (tool_name: string) => spawnSync("/bin/sh", ["-c", command], { input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name, tool_input: {}, cwd: paths.work }), encoding: "utf8" }).stdout;
  }

  it("given a run as you, when the agent calls a tracker's tools, then each that writes is denied with the tracker's reason, the orchestrator's own server's included, and those that read run, Auto's refusal of an unnamed tool aside", async () => {
    // given
    const decide = await guarded();

    // then
    for (const tool of ["mcp__atlassian__createJiraIssue", "mcp__corp__jira_transition_issue", "mcp__wiki__confluence_update_page", "mcp__th-orchestrator__createJiraIssue"]) {
      expect(JSON.parse(decide(tool)).hookSpecificOutput).toEqual({ hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: TRACKER_REASON });
    }
    for (const tool of ["mcp__atlassian__getJiraIssue", "mcp__corp__jira_search", "mcp__github__get_pull_request", "mcp__claude_ai_Atlassian__getJiraIssue", "mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql", "mcp__claude_ai_Atlassian__getAccessibleAtlassianResources", "mcp__claude_ai_Slack__slack_search_public_and_private", "mcp__plugin_team-skills_atlassian__getJiraIssue"]) {
      expect(JSON.parse(decide(tool)).hookSpecificOutput).toEqual({ hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: PERSONAL_READ_REASON });
    }
    expect(JSON.parse(decide("mcp__github__merge_pull_request")).hookSpecificOutput.permissionDecisionReason).toBe(FORGE_REASON);
    // A tool that writes and is no tracker's or forge's is left to the person's own rules and the task's mode.
    expect(decide("mcp__claude_ai_Slack__slack_send_message")).toBe("");
    expect(decide("mcp__notes__send_list")).toBe("");
  });
});
