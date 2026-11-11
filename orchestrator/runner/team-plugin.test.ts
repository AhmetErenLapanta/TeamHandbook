import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installedTeamPlugin } from "./team-plugin.js";

describe("the team's plugin as the person's Claude Code installed it", () => {
  let home: string;
  const plugins = () => join(home, ".claude", "plugins");
  const install = (name: string, version: string, scope = "user", manifestName = name) => {
    const dir = join(plugins(), "cache", "stand-in-market", name, version);
    mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
    writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: manifestName, version }));
    return { scope, installPath: dir, version, installedAt: "2026-11-01T00:00:00.000Z" };
  };
  const record = (entries: Record<string, unknown[]>) => {
    mkdirSync(plugins(), { recursive: true });
    writeFileSync(join(plugins(), "installed_plugins.json"), JSON.stringify({ version: 2, plugins: entries }));
  };
  beforeEach(() => void (home = mkdtempSync(join(tmpdir(), "team-plugin-"))));
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("given the team's plugin installed for the person at the commit's version, when the machine looks it up, then it gets the installed folder", () => {
    // given
    const at = install("payments-handbook", "1.4.0");
    record({ "payments-handbook@stand-in-market": [at], "other-plugin@stand-in-market": [install("other-plugin", "2.0.0")] });

    // when
    const found = installedTeamPlugin({ HOME: home }, { name: "payments-handbook", version: "1.4.0" });

    // then
    expect(found).toEqual({ dir: at.installPath });
  });

  it("given CLAUDE_CONFIG_DIR, when the machine looks the plugin up, then it reads the record there", () => {
    // given
    const config = join(home, "elsewhere");
    const dir = join(config, "plugins", "cache", "stand-in-market", "payments-handbook", "1.4.0");
    mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
    writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "payments-handbook" }));
    writeFileSync(join(config, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "payments-handbook@stand-in-market": [{ scope: "user", installPath: dir, version: "1.4.0" }] } }));

    // when
    const found = installedTeamPlugin({ HOME: home, CLAUDE_CONFIG_DIR: config }, { name: "payments-handbook", version: "1.4.0" });

    // then
    expect(found).toEqual({ dir });
  });

  it.each([
    ["no record at all", () => {}, /is not installed in your Claude Code/],
    ["another version only", () => record({ "payments-handbook@stand-in-market": [install("payments-handbook", "1.3.0")] }), /has payments-handbook 1\.3\.0, and this task's commit is on 1\.4\.0; update the plugin/],
    ["an install for one project only", () => record({ "payments-handbook@stand-in-market": [{ ...install("payments-handbook", "1.4.0", "project"), projectPath: "/stand-in/project" }] }), /is not installed in your Claude Code/],
    ["a folder that holds another plugin", () => record({ "payments-handbook@stand-in-market": [install("payments-handbook", "1.4.0", "user", "something-else")] }), /holds another plugin/],
    ["a record of an older form", () => (mkdirSync(plugins(), { recursive: true }), writeFileSync(join(plugins(), "installed_plugins.json"), JSON.stringify({ "payments-handbook@stand-in-market": {} }))), /a form this runner does not read/],
  ])("given %s, when the machine looks the plugin up, then it says why there is none to load", (_case, given, why) => {
    // given
    given();

    // when
    const found = installedTeamPlugin({ HOME: home }, { name: "payments-handbook", version: "1.4.0" });

    // then
    expect(found).toMatchObject({ missing: expect.stringMatching(why) });
  });
});
