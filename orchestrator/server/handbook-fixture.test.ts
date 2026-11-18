import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildHandbookHome, DOCS, MARKET, PAYMENTS, PLANTED, standInCalls } from "../browser-tests/handbook-home.js";
import type { HandbookHome } from "../browser-tests/handbook-home.js";
import { probePersonalSetup } from "./tasks/personal-setup.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const built = (): HandbookHome => {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-handbook-"));
  roots.push(root);
  return buildHandbookHome(root);
};
const env = (h: HandbookHome) => ({ HOME: h.home, PATH: process.env.PATH ?? "" });
const claude = (h: HandbookHome, ...args: string[]) => spawnSync(h.claude, args, { env: env(h), encoding: "utf8" });

/** A task's session the way the orchestrator starts one, its first turn on stdin, and the launch the stand-in wrote down. */
function launch(h: HandbookHome, extra: string[], prompt = "Do the thing"): { skills: { name: string; call: string; source: string }[]; servers: { name: string; source: string }[]; plugins: string[] } {
  const frame = JSON.stringify({ type: "user", message: { role: "user", content: prompt } });
  spawnSync(h.claude, ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", ...extra], { env: env(h), cwd: h.folder, input: `${frame}\n`, encoding: "utf8" });
  const launches = standInCalls(h).filter((c) => c.call === "launch");
  return launches.at(-1)!.loaded as never;
}

describe("the handbook suite's stand-in home", () => {
  it("given the home, when the orchestrator's own reader asks the stand-in CLI what the person has, then it names both plugins, the servers of every scope, the commands and CLAUDE.md, and none of the planted values leaves the home", async () => {
    // given
    const h = built();

    // when
    const setup = await probePersonalSetup(h.claude, env(h), h.folder, [h.folder]);

    // then
    expect(setup).not.toBeNull();
    expect(setup!.plugins).toEqual([
      expect.objectContaining({ name: "payments-skills", marketplace: MARKET, version: "1.4.0", enabled: true }),
      expect.objectContaining({ name: "docs-kit", marketplace: MARKET, version: "2.0.0", enabled: true }),
    ]);
    expect(setup!.mcpServers.map((s) => `${s.scope}:${s.name}`).sort()).toEqual(["plugin:docs-search", "plugin:ledger-sandbox", "project:ledger", "user:jira", "user:postgres"]);
    expect(setup!.commands.map((c) => c.name)).toEqual(expect.arrayContaining(["standup", "payments-skills:payments-check", "docs-kit:docs-lint"]));
    expect(setup!.claudeMd).toBe(true);
    const said = JSON.stringify(setup);
    for (const value of Object.values(PLANTED)) expect(said).not.toContain(value);
  });

  it("given the plugin installed at 1.4.0 and the marketplace copy at 1.5.0, when it is updated and updated again, then the first moves it and writes Claude Code's record, the second is refused as already latest, and every call is written down", () => {
    // given
    const h = built();
    const record = () => JSON.parse(readFileSync(join(h.home, ".claude", "plugins", "installed_plugins.json"), "utf8")).plugins[PAYMENTS][0] as { version: string; installPath: string };

    // when
    const before = record().version;
    const refreshed = claude(h, "plugin", "marketplace", "update");
    const updated = claude(h, "plugin", "update", PAYMENTS);
    const again = claude(h, "plugin", "update", PAYMENTS);
    const listed = JSON.parse(claude(h, "plugin", "list", "--json").stdout) as { id: string; version: string }[];

    // then
    expect(before).toBe("1.4.0");
    expect([refreshed.status, updated.status, again.status]).toEqual([0, 0, 1]);
    expect(again.stderr).toContain("already at the latest");
    expect(record().version).toBe("1.5.0");
    expect(listed.find((p) => p.id === PAYMENTS)!.version).toBe("1.5.0");
    expect(listed.find((p) => p.id === DOCS)!.version).toBe("2.0.0");
    expect(existsSync(join(record().installPath, "skills", "rate-limits", "SKILL.md"))).toBe(true);
    expect(readFileSync(join(record().installPath, "skills", "add-endpoint", "SKILL.md"), "utf8")).toContain("rate limits (1.5.0)");
    expect(standInCalls(h).map((c) => c.call)).toEqual(["plugin marketplace update", "plugin update", "plugin update", "plugin list"]);
  });

  it("given a session started with all setting sources, when it is started again with docs-kit switched off and with names denied, then each load drops exactly what was closed: a plain name closes the person's and the folder's skill, and a plugin's skill only by its <plugin>:<name>", () => {
    // given
    const h = built();
    const names = (l: ReturnType<typeof launch>) => l.skills.map((s) => `${s.source.split(":")[0]}/${s.name}`).sort();
    const denying = (...rules: string[]) => ["--settings", JSON.stringify({ permissions: { deny: rules } })];

    // when
    const all = launch(h, []);
    const noDocs = launch(h, ["--settings", JSON.stringify({ enabledPlugins: { [DOCS]: false } })]);
    const plain = launch(h, denying("Skill(add-endpoint)"));
    const qualified = launch(h, denying("Skill(payments-skills:add-endpoint)"));
    const strict = launch(h, ["--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: {} })]);

    // then
    expect(names(all)).toEqual(["folder/folder-checklist", "plugin/add-endpoint", "plugin/changelog", "plugin/review-notes", "plugin/write-docs", "yours/add-endpoint", "yours/release-notes", "yours/review-checklist"]);
    expect(names(noDocs)).not.toContain("plugin/write-docs");
    expect(noDocs.servers.map((s) => s.name)).not.toContain("docs-search");
    expect(noDocs.servers.map((s) => s.name)).toContain("ledger-sandbox");
    expect(names(plain).filter((n) => n.endsWith("add-endpoint"))).toEqual(["plugin/add-endpoint"]);
    expect(names(qualified).filter((n) => n.endsWith("add-endpoint"))).toEqual(["yours/add-endpoint"]);
    expect(strict.servers).toEqual([]);
  });

  it("given skills asked for by name, when the session loaded one, when the plain name is only a plugin's and when a name was not loaded at all, then only the one loaded under that name is called", () => {
    // given
    const h = built();
    const frame = JSON.stringify({ type: "user", message: { role: "user", content: "stand-in: use-skill docs-kit:write-docs\nstand-in: use-skill write-docs\nstand-in: use-skill payments-skills:rate-limits" } });

    // when
    const out = spawnSync(h.claude, ["-p", "--input-format", "stream-json", "--output-format", "stream-json"], { env: env(h), cwd: h.folder, input: `${frame}\n`, encoding: "utf8" }).stdout;

    // then
    const called = out.split("\n").filter(Boolean).map((l) => JSON.parse(l)).flatMap((f) => f.message?.content ?? []).filter((c: { name?: string }) => c.name === "Skill").map((c: { input: { skill: string } }) => c.input.skill);
    expect(called).toEqual(["docs-kit:write-docs"]);
    expect(existsSync(join(h.folder, "handbook-note.md"))).toBe(true);
  });

  it("given the user-scope servers, when one is removed and one added through the stand-in's mcp commands, then the global config and its list follow and each call is written down", () => {
    // given
    const h = built();

    // when
    const removed = claude(h, "mcp", "remove", "jira");
    const added = claude(h, "mcp", "add", "notes", "-e", "NOTES_KEY=typed-by-the-person-0123", "--", "node", "notes-mcp.js");
    const missing = claude(h, "mcp", "remove", "jira");
    const listed = claude(h, "mcp", "list").stdout.trim().split("\n").map((l) => l.split(":")[0]);

    // then
    expect([removed.status, added.status, missing.status]).toEqual([0, 0, 1]);
    expect(listed).toEqual(["postgres", "notes"]);
    expect(standInCalls(h).map((c) => c.call)).toEqual(["mcp remove", "mcp add", "mcp remove", "mcp list"]);
  });

  it("given options before the server's name and a task's own off list, when mcp remove runs and a session starts with skillOverrides and deniedMcpServers, then the name is found wherever the options stand and each closed item is left out", () => {
    // given
    const h = built();

    // when
    const removed = claude(h, "mcp", "remove", "--scope", "user", "jira");
    const closed = launch(h, ["--settings", JSON.stringify({ skillOverrides: { "release-notes": "off" }, deniedMcpServers: [{ serverName: "postgres" }] })]);
    const disallowed = launch(h, ["--disallowedTools", "mcp__postgres__*,Skill(payments-skills:changelog)"]);

    // then
    expect(removed.status).toBe(0);
    expect(standInCalls(h).filter((c) => c.call === "mcp remove").map((c) => c.args)).toEqual([["mcp", "remove", "--scope", "user", "jira"]]);
    expect(closed.skills.map((s) => s.call)).not.toContain("release-notes");
    expect(closed.skills.map((s) => s.call)).toContain("review-checklist");
    expect(closed.servers.map((s) => s.name)).not.toContain("postgres");
    expect(disallowed.servers.map((s) => s.name)).not.toContain("postgres");
    expect(disallowed.skills.map((s) => s.call)).not.toContain("payments-skills:changelog");
    expect(disallowed.skills.map((s) => s.call)).toContain("payments-skills:add-endpoint");
  });

  it("given a plugin the marketplace holds and one installed, when it is installed, switched off and uninstalled, then the list follows each step and a second install is refused", () => {
    // given
    const h = built();
    claude(h, "plugin", "uninstall", PAYMENTS);
    const ids = () => (JSON.parse(claude(h, "plugin", "list", "--json").stdout) as { id: string; enabled: boolean }[]).map((p) => `${p.id}:${p.enabled}`);

    // when
    const gone = ids();
    const installed = claude(h, "plugin", "install", PAYMENTS);
    const again = claude(h, "plugin", "install", PAYMENTS);
    claude(h, "plugin", "disable", DOCS);

    // then
    expect(gone).toEqual([`${DOCS}:true`]);
    expect([installed.status, again.status]).toEqual([0, 1]);
    expect(ids()).toEqual([`${DOCS}:false`, `${PAYMENTS}:true`]);
  });

  it("given a directory that is the real home or outside every temporary one, when the home is built there, then it is refused", () => {
    expect(() => buildHandbookHome(join(homedir(), "handbook-fixture-must-not-exist"))).toThrow(/temporary directory/);
    expect(() => buildHandbookHome(execFileSync("pwd", { encoding: "utf8" }).trim())).toThrow(/temporary directory/);
  });
});
