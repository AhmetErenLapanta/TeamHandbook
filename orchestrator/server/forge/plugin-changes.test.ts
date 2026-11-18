import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pluginCopies, pluginExtraChanges, pluginSkillPatch } from "./plugin-changes.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

/** The payments-skills plugin as installed at 1.0.0 and as its marketplace copy holds it at 1.1.0. */
function twoCopies() {
  const root = mkdtempSync(join(tmpdir(), "plugin-changes-"));
  roots.push(root);
  const write = (dir: string, path: string, text: string) => {
    mkdirSync(join(root, dir, path, ".."), { recursive: true });
    writeFileSync(join(root, dir, path), text);
  };
  write("installed", "skills/add-endpoint/SKILL.md", "# Add an endpoint\n");
  write("installed", "skills/old-review/SKILL.md", "# Review\n");
  write("installed", "commands/release.md", "Release it.\n");
  write("installed", "commands/deploy.md", "Deploy it.\n");
  write("installed", ".mcp.json", `${JSON.stringify({ mcpServers: { jira: { url: "https://jira.example.invalid/mcp" }, postgres: { command: "pg-mcp" } } })}\n`);
  write("available", "skills/add-endpoint/SKILL.md", `# Add an endpoint\nWith its gateway entry.\nexport GH_TOKEN=${["ghp", "0123456789abcdefghijklmnopqrstuvwxyzAB"].join("_")}\n`);
  write("available", "skills/review-checklist/SKILL.md", "# Review checklist\n");
  write("available", "commands/release.md", "Release it, then tag it.\n");
  write("available", "commands/standup.md", "Say what moved.\n");
  write("available", ".mcp.json", `${JSON.stringify({ mcpServers: { jira: { url: "https://jira.example.invalid/mcp/v2" }, sentry: { url: "https://sentry.example.invalid/mcp" } } })}\n`);
  return { installed: join(root, "installed"), available: join(root, "available") };
}

describe("what updating an installed plugin brings beyond its skills", () => {
  it("given the installed copy and the marketplace's, when they are compared, then the commands and MCP servers that came, changed and went are named, and no server's definition is said", () => {
    // given
    const { installed, available } = twoCopies();

    // when
    const changes = pluginExtraChanges(installed, available);

    // then
    expect(changes).toEqual({ commands: { added: ["standup"], changed: ["release"], removed: ["deploy"] }, mcpServers: { added: ["sentry"], changed: ["jira"], removed: ["postgres"] } });
    expect(JSON.stringify(changes)).not.toContain("example.invalid");
  });

  it("given a changed skill, a new one and one that did not change, when each is read before updating, then the changed one is its diff with no path of the machine and a secret-looking line held back, the new one reads whole, and the unchanged one is none", async () => {
    // given
    const { installed, available } = twoCopies();

    // when
    const changed = await pluginSkillPatch(installed, available, "add-endpoint");
    const added = await pluginSkillPatch(installed, available, "review-checklist");
    const same = await pluginSkillPatch(installed, installed, "add-endpoint");

    // then
    expect(changed?.patch).toContain("+With its gateway entry.");
    expect(changed?.patch).toContain("[withheld: a line that looks like it holds a");
    expect(changed?.patch).not.toContain("0123456789abcdefghij");
    expect(changed?.patch).not.toContain(installed);
    expect(changed?.patch).toMatch(/installed\/SKILL\.md/);
    expect(added?.patch).toContain("+# Review checklist");
    expect(same).toBeNull();
  });

  it("given a plugin installed in the person's Claude Code folder, one whose install folder points outside it, and names that are not one folder, when its two copies are looked up, then only the first is compared", () => {
    // given
    const claude = mkdtempSync(join(tmpdir(), "claude-dir-"));
    const outside = mkdtempSync(join(tmpdir(), "elsewhere-"));
    roots.push(claude, outside);
    const plugins = join(claude, "plugins");
    const make = (dir: string) => {
      mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
      writeFileSync(join(dir, ".claude-plugin", "plugin.json"), `${JSON.stringify({ name: "payments-skills", version: "1.0.0" })}\n`);
    };
    const installed = join(plugins, "cache", "acme-handbook", "payments-skills", "1.0.0");
    make(installed);
    make(join(plugins, "marketplaces", "acme-handbook"));
    make(join(plugins, "marketplaces", "rogue"));
    make(outside);
    writeFileSync(join(plugins, "installed_plugins.json"), `${JSON.stringify({ version: 2, plugins: { "payments-skills@acme-handbook": [{ scope: "user", installPath: installed, version: "1.0.0" }], "payments-skills@rogue": [{ scope: "user", installPath: outside, version: "1.0.0" }] } })}\n`);

    // when
    const found = pluginCopies(claude, "acme-handbook", "payments-skills");
    const escaping = pluginCopies(claude, "rogue", "payments-skills");
    const climbing = pluginCopies(claude, "..", "payments-skills");

    // then
    expect(found).toEqual({ installed, available: join(plugins, "marketplaces", "acme-handbook") });
    expect([escaping, climbing]).toEqual([null, null]);
  });
});

