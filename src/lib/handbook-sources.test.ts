import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installedPluginDirs, marketplacePluginRoot, pluginLabel, pluginFreshness, readFolderSource, readHandbookSources, sourceLabel } from "./handbook-sources.js";

const put = (file: string, content: string) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
};

const plugin = (dir: string, version: string | null, skills: Record<string, string>, extra: Record<string, string> = {}) => {
  put(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "payments-skills", ...(version ? { version } : {}) }));
  for (const [name, body] of Object.entries(skills)) put(join(dir, "skills", name, "SKILL.md"), body);
  for (const [file, content] of Object.entries(extra)) put(join(dir, file), content);
};

describe("where a person's skills come from", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "handbook-sources-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("given a config folder with its own skill and a team plugin installed behind its marketplace copy, when the sources are read, then each is a row with its contents, the plugin's MCP servers are named and nothing else of them is read, and the plugin says what changed", () => {
    // given
    const config = join(root, "claude");
    const installed = join(config, "plugins", "cache", "payments-skills", "1.4.0");
    const market = join(config, "plugins", "marketplaces", "payments-marketplace");
    put(join(config, "skills", "review-checklist", "SKILL.md"), "---\nname: review-checklist\n---\n");
    put(join(config, "commands", "ship.md"), "x");
    put(join(config, "settings.json"), JSON.stringify({ enabledPlugins: { "payments-skills@payments-marketplace": false }, env: { TOKEN: "do-not-read-this" } }));
    plugin(installed, "1.4.0", { "add-endpoint": "v1", "old-skill": "x" }, { ".mcp.json": JSON.stringify({ mcpServers: { jira: { command: "x", env: { JIRA_TOKEN: "do-not-read-this" } } } }), "hooks/hooks.json": JSON.stringify({ hooks: { SessionStart: [{}, {}], Stop: [{}] } }) });
    plugin(market, "1.5.0", { "add-endpoint": "v2", "release-notes": "new" });
    put(join(config, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "payments-skills@payments-marketplace": [{ scope: "user", version: "1.4.0", installPath: installed }] } }));

    // when
    const sources = readHandbookSources(config);

    // then
    expect(sources.map((s) => sourceLabel(s, "payments-marketplace"))).toEqual(["yours", "the team's payments-skills"]);
    expect(sources[0]).toMatchObject({ skills: ["review-checklist"], commands: ["ship"], enabled: true });
    expect(sources[1]).toMatchObject({ version: "1.4.0", enabled: false, skills: ["add-endpoint", "old-skill"], mcpServers: ["jira"], hooks: 3 });
    expect(sources[1]!.freshness).toEqual({ installed: "1.4.0", available: "1.5.0", behind: true, added: ["release-notes"], changed: ["add-endpoint"], removed: ["old-skill"] });
    expect(JSON.stringify(sources)).not.toContain("do-not-read-this");
  });

  it("given plugins versioned by commit and a folder of the person's, when the freshness and the folder source are read, then a changed skill alone makes it behind, an equal copy does not, and the folder source names its MCP servers", () => {
    // given
    plugin(join(root, "a"), null, { x: "one" });
    plugin(join(root, "b"), null, { x: "two" });
    plugin(join(root, "c"), null, { x: "one" });
    put(join(root, "repo", ".claude", "skills", "local-rule", "SKILL.md"), "x");
    put(join(root, "repo", ".mcp.json"), JSON.stringify({ mcpServers: { postgres: { command: "x" } } }));

    // when
    const changed = pluginFreshness(join(root, "a"), join(root, "b"));
    const same = pluginFreshness(join(root, "a"), join(root, "c"));
    const folder = readFolderSource(join(root, "repo"), "shop-api");

    // then
    expect([changed!.behind, changed!.changed]).toEqual([true, ["x"]]);
    expect(same!.behind).toBe(false);
    expect(folder).toMatchObject({ skills: ["local-rule"], mcpServers: ["postgres"] });
    expect(sourceLabel(folder)).toBe("this folder (shop-api)");
    expect([pluginLabel({ name: "p", marketplace: "m", version: "1.0.0" }), pluginLabel({ name: "p", marketplace: "m", version: null }, "m")]).toEqual(["p 1.0.0", "the team's p"]);
    expect(pluginFreshness(join(root, "nowhere"), join(root, "b"))).toBeNull();
  });

  it("given no config folder at all, when the sources are read, then there is the person's own row and nothing else", () => {
    // when
    const sources = readHandbookSources(join(root, "missing"));

    // then
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ skills: [], commands: [] });
  });

  it("given one plugin installed for the person, one for a folder and one whose install folder is gone, when each id is resolved, then only the person's existing install resolves, with its marketplace folder", () => {
    // given
    const config = join(root, "claude");
    const installed = join(config, "plugins", "cache", "payments-skills", "1.4.0");
    plugin(installed, "1.4.0", { x: "1" });
    plugin(join(config, "plugins", "marketplaces", "payments-marketplace"), "1.5.0", { x: "2" });
    put(join(config, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: {
      "payments-skills@payments-marketplace": [{ scope: "user", version: "1.4.0", installPath: installed }],
      "folder-only@payments-marketplace": [{ scope: "project", version: "1.0.0", installPath: installed }],
      "gone@payments-marketplace": [{ scope: "user", version: "1.0.0", installPath: join(root, "gone") }],
    } }));

    // when
    const found = ["payments-skills@payments-marketplace", "folder-only@payments-marketplace", "gone@payments-marketplace", "unknown@x"].map((id) => installedPluginDirs(join(config, "plugins"), id));

    // then
    expect(found).toEqual([{ installPath: installed, version: "1.4.0", marketplaceDir: join(config, "plugins", "marketplaces", "payments-marketplace") }, null, null, null]);
  });

  it("given a marketplace that names its plugin's source, when the plugin's folder is looked for, then the named folder is used, one that leaves the marketplace is not, and the marketplace itself is the fallback", () => {
    // given
    plugin(join(root, "m", "plugins", "x"), "1.0.0", { a: "1" });
    put(join(root, "m", ".claude-plugin", "marketplace.json"), JSON.stringify({ plugins: [{ name: "x", source: "./plugins/x" }, { name: "escape", source: "./../outside" }] }));
    plugin(join(root, "own"), "2.0.0", { b: "1" });
    put(join(root, "own", ".claude-plugin", "marketplace.json"), JSON.stringify({ plugins: [{ name: "payments-skills", source: "./" }] }));

    // when
    const named = marketplacePluginRoot(join(root, "m"), "x");
    const leaving = marketplacePluginRoot(join(root, "m"), "escape");
    const itself = marketplacePluginRoot(join(root, "own"), "payments-skills");

    // then
    expect([named, leaving, itself]).toEqual([join(root, "m", "plugins", "x"), null, join(root, "own")]);
  });
});

