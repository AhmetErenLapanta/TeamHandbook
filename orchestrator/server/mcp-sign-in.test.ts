import { describe, expect, it } from "vitest";
import { signInServers } from "../shared/mcp-sign-in.js";

describe("the MCP servers that ask to sign in, as a person reads them", () => {
  it("given a server a plugin brought, when it is listed, then it is the service with the plugin named, not the raw name", () => {
    // given
    const names = ["plugin:acme-skills:atlassian"];

    // when
    const listed = signInServers(names);

    // then
    expect(listed).toEqual([{ name: "plugin:acme-skills:atlassian", label: "Atlassian (from acme-skills)" }]);
  });

  it("given one service reached as a claude.ai connector and as the person's own server, when they are listed, then it shows once and signs in under the server that is not the connector", () => {
    // given
    const names = ["claude.ai Notion", "notion"];

    // when
    const listed = signInServers(names);

    // then
    expect(listed).toEqual([{ name: "notion", label: "Notion" }]);
  });

  it("given the same service from two plugins, when they are listed, then each plugin's own server stays", () => {
    // given
    const names = ["plugin:first-pack:gitlab", "plugin:second-pack:gitlab", "plugin:first-pack:gitlab"];

    // when
    const listed = signInServers(names);

    // then
    expect(listed.map((s) => s.label)).toEqual(["GitLab (from first-pack)", "GitLab (from second-pack)"]);
  });

  it("given a server of no known service, when it is listed, then its own name is read in words and nothing is lost", () => {
    // given
    const names = ["ticket-desk", "claude_ai_Calendar_Pro"];

    // when
    const listed = signInServers(names);

    // then
    expect(listed).toEqual([{ name: "ticket-desk", label: "Ticket Desk" }, { name: "claude_ai_Calendar_Pro", label: "Calendar Pro" }]);
  });
});
