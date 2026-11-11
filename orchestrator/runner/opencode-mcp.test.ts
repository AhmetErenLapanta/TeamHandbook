import { describe, expect, it } from "vitest";
import type { AgentCodec, AgentEvent } from "../server/tasks/adapters/contract.js";
import { FORGE_REASON, TRACKER_REASON } from "../server/tasks/profile.js";
import { signInEvents } from "../server/tasks/adapters/frames.js";
import { mcpDecidingCodec, mcpDecision, waitingForSignIn } from "./opencode-mcp.js";

describe("an MCP call of an OpenCode session run as its person", () => {
  const servers = ["atlassian", "slack", "jira_get", "notes.local"];

  it("given the tracker's and the person's servers, when the agent reads through them, then each call goes ahead without asking anyone", () => {
    // when
    const decided = ["atlassian_getJiraIssue", "atlassian_searchJiraIssuesUsingJql", "slack_slack_search_public_and_private", "notes_local_list_pages"].map((id) => mcpDecision(id, servers));

    // then
    expect(decided).toEqual([{ decision: "allow-once" }, { decision: "allow-once" }, { decision: "allow-once" }, { decision: "allow-once" }]);
  });

  it("given the tracker's server, when the agent would change an issue, then the call is refused with the reason and no card is asked for", () => {
    // when
    const decided = ["atlassian_createJiraIssue", "atlassian_editJiraIssue"].map((id) => mcpDecision(id, servers));

    // then
    expect(decided).toEqual([{ decision: "deny", note: TRACKER_REASON }, { decision: "deny", note: TRACKER_REASON }]);
  });

  it("given a server whose name another one begins with, when a tracker call could split two ways, then it is refused, since its tool cannot be named", () => {
    // when
    const decided = mcpDecision("jira_get_delete_issue", [...servers, "jira"]);

    // then
    expect(decided).toEqual({ decision: "deny", note: TRACKER_REASON });
  });

  it("given a tracker's or a forge's call on a server the session does not know, when it arrives, then it is refused", () => {
    // when
    const decided = [mcpDecision("jira_get_issue", ["atlassian"]), mcpDecision("github_list_pulls", [])];

    // then
    expect(decided).toEqual([{ decision: "deny", note: TRACKER_REASON }, { decision: "deny", note: FORGE_REASON }]);
  });

  it("given a call of the person's own server that does not read, when it arrives, then the person is asked as before", () => {
    // when
    const decided = [mcpDecision("slack_slack_send_message", servers), mcpDecision("unknown_send", servers)];

    // then
    expect(decided).toEqual([null, null]);
  });

  it("given a session's codec, when it decodes calls of each kind, then the reading one is answered yes, the writing tracker one no, and only the one left asks", () => {
    // given
    const written: string[] = [];
    const requests: Record<string, string> = { r1: "atlassian_getJiraIssue", r2: "atlassian_editJiraIssue", r3: "slack_slack_send_message" };
    const codec = { decode: (line: string): AgentEvent[] => [{ type: "request", request: { id: line, kind: "mcp", tool: requests[line]!, summary: "" } }], answer: (id: string, decision: string) => `${id}:${decision}`, pending: () => [] } as unknown as AgentCodec;
    const deciding = mcpDecidingCodec(codec, servers);

    // when
    const events = ["r1", "r2", "r3"].flatMap((line) => deciding.decode(line));
    written.push(...deciding.pending());

    // then
    expect(events).toEqual([{ type: "tool_call", tool: "atlassian_editJiraIssue", target: null, status: "refused", refusal: { kind: "tracker-write", reason: TRACKER_REASON } }, { type: "request", request: { id: "r3", kind: "mcp", tool: "slack_slack_send_message", summary: "" } }]);
    expect(written).toEqual(["r1:allow-once", "r2:deny"]);
  });

  it("given OpenCode's servers in each state, when the session starts, then only the ones waiting for a sign-in are named, once, before the agent's first words", () => {
    // given
    const status = { gitlab: { status: "needs_auth" }, notion: { status: "needs_auth" }, broken: { status: "failed", error: "spawn" }, oauth: { status: "needs_client_registration", error: "none" }, docs: { status: "connected" } };
    const codec = { decode: (line: string): AgentEvent[] => [{ type: "message", text: line }], answer: () => null, pending: () => [] } as unknown as AgentCodec;
    const deciding = mcpDecidingCodec(codec, Object.keys(status), signInEvents(waitingForSignIn(status)));

    // when
    const events = ["hello", "again"].flatMap((line) => deciding.decode(line));

    // then
    expect(events).toEqual([
      { type: "mcp_status", needsSignIn: ["gitlab", "notion"] },
      { type: "notice", text: "gitlab and notion need a sign-in, so their tools are not in this task. Sign them in on this machine, then start the task again." },
      { type: "message", text: "hello" },
      { type: "message", text: "again" },
    ]);
    expect(waitingForSignIn({ docs: { status: "connected" } })).toEqual([]);
  });
});
