import { describe, expect, it } from "vitest";
import { firstPicks, loadedSentence, serverLabel } from "./TaskToolsPick";

describe("firstPicks", () => {
  it("given a project's skills from two sources, a server reached by address and one that runs a command, when a new task first takes them, then every skill and the address server are picked and the command server is not", () => {
    // when
    const picked = firstPicks(
      [{ source: "ssrc_1", name: "release-notes", description: "" }, { source: "ssrc_2", name: "release-notes", description: "" }],
      [{ id: "mcp_1", name: "docs", transport: "stdio", command: "npx", args: [], env: [] }, { id: "mcp_2", name: "tracker", transport: "http", url: "https://mcp.example.com", headers: [] }],
    );

    // then
    expect(picked).toEqual({ projectSkills: [{ source: "ssrc_1", name: "release-notes" }, { source: "ssrc_2", name: "release-notes" }], mcpServers: ["mcp_2"], commands: [] });
  });
});

describe("serverLabel", () => {
  it("given a command server and an address server, when their chips are named, then the command one says the command it runs on the person's machine", () => {
    // then
    expect(serverLabel({ id: "m1", name: "docs", transport: "stdio", command: "npx", args: ["-y", "docs-server"], env: [] })).toBe("docs runs npx -y docs-server");
    expect(serverLabel({ id: "m2", name: "tracker", transport: "http", url: "https://mcp.example.com", headers: [] })).toBe("tracker");
  });
});

describe("loadedSentence", () => {
  it("given the person's own commands, plugins turned on and off, servers and a CLAUDE.md, when counted for the form, then one sentence names each kind, a turned-off plugin left out", () => {
    // given
    const personal = { plugins: [{ name: "review-kit", enabled: true }, { name: "old-kit", enabled: false }], commands: [{ name: "refunds", description: "" }, { name: "deploy", description: "" }], mcpServers: [{ name: "docs" }], claudeMd: true };

    // when
    const said = loadedSentence("Claude Code", personal);

    // then
    expect(said).toBe("Claude Code loads 2 skills or commands, 1 plugin, 1 MCP server and CLAUDE.md");
  });

  it("given no probe yet, or one that found nothing on, when counted, then the form says nothing", () => {
    // when
    const said = [loadedSentence("Claude Code", null), loadedSentence("Claude Code", { plugins: [{ name: "old-kit", enabled: false }], commands: [] })];

    // then
    expect(said).toEqual([null, null]);
  });
});
