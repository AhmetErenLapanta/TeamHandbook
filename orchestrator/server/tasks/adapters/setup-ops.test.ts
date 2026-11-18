import { describe, expect, it } from "vitest";

import { claudeMcpAddArgs, claudeSetupArgs } from "./setup-ops.js";

describe("the commands that change a person's own Claude Code setup", () => {
  it("given each change and its target, when its arguments are made, then they are Claude Code's own command for it, with the scope where one is named and one JSON line asked of a plugin command", () => {
    expect(claudeSetupArgs("plugin.disable", "payments-skills@acme", "user")).toEqual(["plugin", "disable", "payments-skills@acme", "--scope", "user", "--json"]);
    expect(claudeSetupArgs("plugin.enable", "payments-skills")).toEqual(["plugin", "enable", "payments-skills", "--json"]);
    expect(claudeSetupArgs("plugin.update", "payments-skills@acme")).toEqual(["plugin", "update", "payments-skills@acme", "--json"]);
    expect(claudeSetupArgs("plugin.uninstall", "payments-skills@acme", "project")).toEqual(["plugin", "uninstall", "payments-skills@acme", "--scope", "project", "--json"]);
    expect(claudeSetupArgs("plugin.install", "payments-skills@acme")).toEqual(["plugin", "install", "payments-skills@acme", "--json"]);
    expect(claudeSetupArgs("mcp.remove", "jira", "local")).toEqual(["mcp", "remove", "jira", "--scope", "local"]);
  });

  it("given a target that reads as an option, holds a space or a path, or a scope that is none, when its arguments are asked for, then there are none and nothing is confirmed for the person", () => {
    // given
    const refused = [
      claudeSetupArgs("plugin.disable", "--all"),
      claudeSetupArgs("plugin.disable", "-a"),
      claudeSetupArgs("plugin.uninstall", "payments skills"),
      claudeSetupArgs("plugin.install", "../payments"),
      claudeSetupArgs("plugin.install", "payments-skills@acme", "user"),
      claudeSetupArgs("mcp.remove", "jira; rm"),
      claudeSetupArgs("mcp.remove", ""),
      claudeSetupArgs("plugin.enable", "payments-skills", "managed" as "user"),
    ];
    const made = (["plugin.enable", "plugin.disable", "plugin.update", "plugin.uninstall", "plugin.install"] as const).map((op) => claudeSetupArgs(op, "payments-skills@acme")!);

    // then
    expect(refused).toEqual(refused.map(() => null));
    for (const args of made) expect(args.some((arg) => arg === "-y" || arg === "--yes" || arg === "--all" || arg.startsWith("--accept-command"))).toBe(false);
  });

  it("given a server over HTTP with a header and a local command with a variable, when their arguments are made, then each is the form Claude Code's own help shows, the command after a bare -- so nothing of it reads as an option", () => {
    expect(claudeMcpAddArgs({ name: "docs", scope: "user", over: "http", url: "https://docs.example.com/mcp", headers: [["Authorization", "Bearer abc"]] })).toEqual(["mcp", "add", "--scope", "user", "--transport", "http", "docs", "https://docs.example.com/mcp", "--header", "Authorization: Bearer abc"]);
    expect(claudeMcpAddArgs({ name: "lint", scope: "local", over: "stdio", command: "npx", args: ["-y", "lint-server", "--stdio"], env: [["API_KEY", "abc"]] })).toEqual(["mcp", "add", "--scope", "local", "lint", "-e", "API_KEY=abc", "--", "npx", "-y", "lint-server", "--stdio"]);
  });

  it("given a server whose name reads as an option, whose address is no web address, or whose variable name or value holds a line break or an equals sign in the name, when its arguments are asked for, then there are none", () => {
    const refused = [
      claudeMcpAddArgs({ name: "--scope", scope: "user", over: "http", url: "https://docs.example.com/mcp" }),
      claudeMcpAddArgs({ name: "docs", scope: "user", over: "http", url: "file:///etc/passwd" }),
      claudeMcpAddArgs({ name: "docs", scope: "user", over: "http", url: "https://docs.example.com/mcp", headers: [["X-Key", "a\nInjected: 1"]] }),
      claudeMcpAddArgs({ name: "lint", scope: "user", over: "stdio", command: "npx", env: [["A=B", "c"]] }),
      claudeMcpAddArgs({ name: "lint", scope: "user", over: "stdio", command: "" }),
      claudeMcpAddArgs({ name: "lint", scope: "managed" as "user", over: "stdio", command: "npx" }),
    ];
    expect(refused).toEqual(refused.map(() => null));
  });
});
