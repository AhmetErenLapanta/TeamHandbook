import { describe, expect, it } from "vitest";
import { noticeSaid } from "./PluginNotices";
import type { HandbookSource } from "./handbook-read";

const plugin = (name: string, hooks: number, mcpServers: number, version?: string): HandbookSource => ({ id: `plugin:${name}@payments-market`, kind: "plugin", name, ...(version ? { version } : {}), enabled: true, skills: [], commands: [], mcpServers: [], hooks: [], notice: { hooks, mcpServers } });

describe("the one line about plugins that run hooks or servers", () => {
  it("given one plugin, when the line is said, then it names its version and counts", () => {
    // when
    const said = noticeSaid([plugin("payments-skills", 2, 1, "1.5.0")]);

    // then
    expect(said).toBe("payments-skills 1.5.0 runs 2 hooks and 1 MCP server.");
  });

  it("given three plugins, when the line is said, then it is one line naming each", () => {
    // when
    const said = noticeSaid([plugin("a-kit", 1, 0), plugin("b-kit", 0, 1), plugin("c-kit", 2, 2)]);

    // then
    expect(said).toBe("3 plugins run hooks or servers: a-kit, b-kit, c-kit.");
  });
});
