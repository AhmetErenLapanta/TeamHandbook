import { describe, expect, it } from "vitest";
import { lastWindow, withContext, withUsed } from "./handbook-measures.js";

const yours = { id: "yours", kind: "yours", name: "Yours", skills: [{ name: "add-endpoint" }, { name: "never-measured" }], mcpServers: [{ name: "jira" }] };
const plugin = { id: "plugin:docs-kit@payments-market", kind: "plugin", name: "docs-kit", skills: [{ name: "write-docs" }], mcpServers: [{ name: "docs-search" }] };
const measured = { at: "2026-01-02T00:00:00.000Z", skills: [{ name: "add-endpoint", tokens: 800 }, { name: "docs-kit:write-docs", tokens: 120 }], mcpServers: [{ name: "jira", tokens: 4000 }, { name: "plugin_docs-kit_docs-search", tokens: 1500 }] };

describe("what the person's tasks say of each item: the context it takes and how often it was used", () => {
  it("given a measure naming a skill and a server of the person's own and a plugin's by the names the agent calls them, when it is put on the sources with a 200k window, then each named item carries its tokens and share and an unnamed one stays as it was", () => {
    // when
    const [own, docs] = withContext([yours, plugin], measured, 200_000);

    // then
    expect(own!.skills).toEqual([{ name: "add-endpoint", context: { tokens: 800, percent: 0.4 } }, { name: "never-measured" }]);
    expect(own!.mcpServers).toEqual([{ name: "jira", context: { tokens: 4000, percent: 2 } }]);
    expect(docs!.skills).toEqual([{ name: "write-docs", context: { tokens: 120, percent: 0.1 } }]);
    expect(docs!.mcpServers).toEqual([{ name: "docs-search", context: { tokens: 1500, percent: 0.8 } }]);
  });

  it("given a measure but no task that said its window, and no measure at all, when each is put on the sources, then the first carries tokens alone and the second changes nothing", () => {
    // when
    const [noWindow] = withContext([yours], measured, null);
    const [none] = withContext([yours], null, 200_000);

    // then
    expect(noWindow!.skills[0]).toEqual({ name: "add-endpoint", context: { tokens: 800 } });
    expect(none).toEqual(yours);
  });

  it("given three of a person's tasks, the newest without a window, when the window is read, then it is the newest one that said it", () => {
    // given
    const tasks = [
      { createdAt: "2026-01-01T00:00:00.000Z", contextUsed: { window: 200_000 } },
      { createdAt: "2026-01-02T00:00:00.000Z", startedAt: "2026-01-02T00:01:00.000Z", contextUsed: { window: 1_000_000 } },
      { createdAt: "2026-01-03T00:00:00.000Z", contextUsed: { window: null } },
    ];

    // when
    const window = lastWindow(tasks);

    // then
    expect([window, lastWindow([])]).toEqual([1_000_000, null]);
  });

  it("given uses of a skill of the person's own, a plugin's skill and server by the names the agent called them, one of the same name from another source and one whose source was not read, when they are put on the sources, then each row carries its own count and last use alone", () => {
    // given
    const usage = {
      days: 30,
      skills: [
        { source: "yours", name: "add-endpoint", tasks: 3, lastAt: "2026-01-05T00:00:00.000Z" },
        { source: "plugin:docs-kit@payments-market", name: "write-docs", tasks: 1, lastAt: "2026-01-04T00:00:00.000Z" },
        { source: "folder:/work/payments-api", name: "never-measured", tasks: 2, lastAt: "2026-01-03T00:00:00.000Z" },
        { source: "unknown", name: "never-measured", tasks: 4, lastAt: "2026-01-02T00:00:00.000Z" },
      ],
      mcpServers: [{ source: "plugin:docs-kit@payments-market", name: "plugin_docs-kit_docs-search", tasks: 2, lastAt: "2026-01-05T00:00:00.000Z" }],
    };

    // when
    const [own, docs] = withUsed([yours, plugin], usage);

    // then
    expect(own!.skills).toEqual([{ name: "add-endpoint", used: { tasks: 3, lastAt: "2026-01-05T00:00:00.000Z" } }, { name: "never-measured" }]);
    expect(own!.mcpServers).toEqual([{ name: "jira" }]);
    expect(docs!.skills).toEqual([{ name: "write-docs", used: { tasks: 1, lastAt: "2026-01-04T00:00:00.000Z" } }]);
    expect(docs!.mcpServers).toEqual([{ name: "docs-search", used: { tasks: 2, lastAt: "2026-01-05T00:00:00.000Z" } }]);
  });
});
