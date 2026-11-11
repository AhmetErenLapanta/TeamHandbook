import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hookSettingsState, managedSettingsDir } from "./hook-settings.js";
import type { HookSettingsPaths } from "./hook-settings.js";
import { checkHookSettings } from "./doctor.js";

let root: string;
let paths: HookSettingsPaths;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "th-hook-settings-"));
  paths = { managedDir: join(root, "managed"), userDir: join(root, "user"), projectDir: join(root, "project") };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function put(file: string, content: unknown): string {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  return file;
}

const managed = (name = "managed-settings.json") => join(paths.managedDir, name);
const user = () => join(paths.userDir, "settings.json");
const shared = () => join(paths.projectDir, ".claude", "settings.json");
const local = () => join(paths.projectDir, ".claude", "settings.local.json");

describe("whether settings let this plugin's hooks run", () => {
  it("given no settings file anywhere, when it is checked, then the hooks run and the doctor says what it did not read", () => {
    // when
    const state = hookSettingsState("handbook", paths);
    const check = checkHookSettings(paths);

    // then
    expect(state).toEqual({ state: "on" });
    expect(check.level).toBe("ok");
    expect(check.detail).toContain("a policy delivered by MDM or the claude.ai console is not read here");
  });

  it("given allowManagedHooksOnly in the managed settings file, when it is checked, then the hooks are off and the doctor points at the orchestrator's managed-settings export", () => {
    // given
    const file = put(managed(), { allowManagedHooksOnly: true });

    // when
    const state = hookSettingsState("handbook", paths);
    const check = checkHookSettings(paths);

    // then
    expect(state).toEqual({ state: "off", setting: "allowManagedHooksOnly", file });
    expect(check.level).toBe("warn");
    expect(check.detail).toContain("the rules that reach teammates' sessions through the TeamHandbook hook (skills, MCP servers and tool patterns) are not enforced on this machine");
    expect(check.detail).toContain("the orchestrator's managed-settings export is the way to enforce them");
  });

  it("given allowManagedHooksOnly with this plugin force-enabled in managed enabledPlugins, when it is checked, then its hooks still run, and another plugin's force-enabling does not count", () => {
    // given
    put(managed(), { allowManagedHooksOnly: true, enabledPlugins: { "other@market": true } });
    put(managed("managed-settings.d/10-plugins.json"), { enabledPlugins: { "handbook@teamhandbook": true } });

    // when
    const kept = hookSettingsState("handbook", paths);
    put(managed("managed-settings.d/20-off.json"), { enabledPlugins: { "handbook@teamhandbook": false } });
    const unforced = hookSettingsState("handbook", paths);

    // then
    expect(kept).toEqual({ state: "on" });
    expect(unforced).toMatchObject({ state: "off", setting: "allowManagedHooksOnly" });
  });

  it("given allowManagedHooksOnly turned back off by a later drop-in and turned on by a hidden one, when it is checked, then the later drop-in wins and the hidden file is skipped", () => {
    // given
    put(managed(), { allowManagedHooksOnly: true });
    put(managed("managed-settings.d/20-hooks.json"), { allowManagedHooksOnly: false });
    put(managed("managed-settings.d/.30-draft.json"), { allowManagedHooksOnly: true });

    // when
    const state = hookSettingsState("handbook", paths);

    // then
    expect(state).toEqual({ state: "on" });
  });

  it("given disableAllHooks at user, shared and local level, when each is checked, then the highest level that sets it decides, and a managed false beats a user true", () => {
    // given
    const userFile = put(user(), { disableAllHooks: true });

    // then the user's value holds alone
    expect(hookSettingsState("handbook", paths)).toEqual({ state: "off", setting: "disableAllHooks", file: userFile });

    // when the shared project turns it back on
    put(shared(), { disableAllHooks: false });
    expect(hookSettingsState("handbook", paths)).toEqual({ state: "on" });

    // when the local file turns it off again
    const localFile = put(local(), { disableAllHooks: true });
    expect(hookSettingsState("handbook", paths)).toEqual({ state: "off", setting: "disableAllHooks", file: localFile });

    // when the managed settings say false
    put(managed(), { disableAllHooks: false });
    expect(hookSettingsState("handbook", paths)).toEqual({ state: "on" });
  });

  it("given a managed settings file that is not JSON or a user file that is not an object, when it is checked, then the answer is that it was not checked, never that the hooks run", () => {
    // given
    const broken = put(managed(), "{ allowManagedHooksOnly: true");

    // when
    const state = hookSettingsState("handbook", paths);
    const check = checkHookSettings(paths);

    // then
    expect(state).toMatchObject({ state: "unknown", file: broken });
    expect(check.level).toBe("warn");
    expect(check.detail).toContain("exists but cannot be read (not valid JSON), so its hook settings are not checked");

    // when the managed file is fixed and the user file is a list
    put(managed(), {});
    const listed = put(user(), "[]");
    expect(hookSettingsState("handbook", paths)).toEqual({ state: "unknown", file: listed, reason: "not a JSON object" });
  });

  it("given each system, when the managed settings directory is named, then it is the one Claude Code documents", () => {
    expect([managedSettingsDir("darwin"), managedSettingsDir("linux"), managedSettingsDir("win32")]).toEqual([
      "/Library/Application Support/ClaudeCode",
      "/etc/claude-code",
      "C:\\Program Files\\ClaudeCode",
    ]);
  });
});
