import { describe, expect, it } from "vitest";

import { mcpServerNamed, mcpServers, mcpSignInAnswer, mcpSignInRequest, mcpStatusRequest } from "./claude-mcp-sign-in.js";

const ok = (id: string, response: Record<string, unknown>) => JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: id, response } });
const error = (id: string, code?: string) => JSON.stringify({ type: "control_response", response: { subtype: "error", request_id: id, error: "Server docs: something the CLI said", ...(code ? { error_code: code } : {}) } });

describe("signing a person's MCP server in from a short Claude Code session", () => {
  it("given a server's name, when the requests are written, then they are Claude Code's own control requests and the sign-in names no redirect, so Claude Code listens itself", () => {
    expect(JSON.parse(mcpStatusRequest("s1"))).toEqual({ type: "control_request", request_id: "s1", request: { subtype: "mcp_status" } });
    expect(JSON.parse(mcpSignInRequest("a1", "plugin_team_docs"))).toEqual({ type: "control_request", request_id: "a1", request: { subtype: "mcp_authenticate", serverName: "plugin_team_docs" } });
  });

  it("given the session's answer to mcp_status, when it is read, then each server keeps Claude Code's name, reads as a page names it, and a status it does not know or another request's answer is left out", () => {
    // given
    const answer = ok("s1", { mcpServers: [{ name: "plugin_team_docs", status: "needs-auth" }, { name: "jira", status: "connected" }, { name: "slack", status: "failed" }, { name: "old", status: "disabled" }] });

    // when
    const servers = mcpServers(answer, "s1");

    // then
    expect(servers).toEqual([
      { name: "plugin_team_docs", shown: "docs", state: "waiting" },
      { name: "jira", shown: "jira", state: "signed-in" },
      { name: "slack", shown: "slack", state: "failed" },
    ]);
    expect(mcpServers(answer, "s2")).toBeNull();
    expect(mcpServers(JSON.stringify({ type: "assistant" }), "s1")).toBeNull();
  });

  it("given a page's name of a server, when it is matched, then the one server it stands for is named, and none or two give no name", () => {
    const servers = [{ name: "plugin_team_docs", shown: "docs" }, { name: "jira", shown: "jira" }, { name: "plugin_other_jira", shown: "jira" }];
    expect(mcpServerNamed(servers, "docs")).toBe("plugin_team_docs");
    expect(mcpServerNamed(servers, "plugin_team_docs")).toBe("plugin_team_docs");
    expect(mcpServerNamed(servers, "jira")).toBeNull();
    expect(mcpServerNamed(servers, "slack")).toBeNull();
  });

  it("given Claude Code's answers to mcp_authenticate, when they are read, then an https address is the one to open, a server signed in already says so, and an address of another kind or a refusal is said in the orchestrator's words", () => {
    expect(mcpSignInAnswer(ok("a1", { authUrl: "https://auth.example.com/authorize?state=x", requiresUserAction: true, callbackExpected: true, redirectScheme: "localhost", callbackPort: 51234 }), "a1")).toEqual({ authorizeUrl: "https://auth.example.com/authorize?state=x" });
    expect(mcpSignInAnswer(ok("a1", { requiresUserAction: false, callbackExpected: false }), "a1")).toEqual({ signedIn: true });
    expect(mcpSignInAnswer(ok("a1", { authUrl: "javascript:alert(1)", requiresUserAction: true }), "a1")).toEqual({ failed: "Claude Code could not start the sign-in; use the command instead." });
    expect(mcpSignInAnswer(error("a1", "mcp_policy_blocked"), "a1")).toEqual({ failed: "Your organization's policy does not allow this server." });
    expect(mcpSignInAnswer(error("a1"), "a1")).toEqual({ failed: "Claude Code could not start the sign-in; use the command instead." });
    expect(mcpSignInAnswer(ok("a2", { requiresUserAction: false }), "a1")).toBeNull();
  });
});
