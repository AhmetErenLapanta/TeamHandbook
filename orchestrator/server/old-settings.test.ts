import { describe, expect, it } from "vitest";
import { oldSettings, oldSettingsRefused } from "./old-settings.js";

describe("settings under their old CONSOLE_ name", () => {
  it("given old names among the new, when a start reads them, then it stops and names each old one with its new name", () => {
    const env = { CONSOLE_TASK_NETWORK: "none", ORCHESTRATOR_PORT: "8080", CONSOLE_SECRET_KEY: "x", PATH: "/usr/bin" };

    expect(oldSettings(env)).toEqual([
      { old: "CONSOLE_SECRET_KEY", now: "ORCHESTRATOR_SECRET_KEY" },
      { old: "CONSOLE_TASK_NETWORK", now: "ORCHESTRATOR_TASK_NETWORK" },
    ]);
    expect(oldSettingsRefused(env)).toBe("CONSOLE_SECRET_KEY is now ORCHESTRATOR_SECRET_KEY; CONSOLE_TASK_NETWORK is now ORCHESTRATOR_TASK_NETWORK; rename them where they are set, and this orchestrator stops until then");
  });

  it("given one old name, or none, when a start reads them, then one is named alone and none lets it start", () => {
    expect(oldSettingsRefused({ CONSOLE_DATABASE_URL: "postgres://db" })).toBe("CONSOLE_DATABASE_URL is now ORCHESTRATOR_DATABASE_URL; rename it where it is set, and this orchestrator stops until then");
    expect(oldSettingsRefused({ ORCHESTRATOR_DATABASE_URL: "postgres://db", HOME: "/home/someone" })).toBeNull();
  });

  it("given another tool's CONSOLE_ setting, and a sign-in provider's built name, when a start reads them, then only the orchestrator's own old name stops it", () => {
    expect(oldSettingsRefused({ CONSOLE_THEME: "dark", CONSOLE_API_TOKEN: "x" })).toBeNull();
    expect(oldSettings({ CONSOLE_BESIDE_CONSOLE: "1" })).toEqual([{ old: "CONSOLE_BESIDE_CONSOLE", now: "ORCHESTRATOR_BESIDE_ORCHESTRATOR" }]);
    expect(oldSettings({ CONSOLE_THEME: "dark", CONSOLE_SIGN_IN_GITLAB_CLIENT_ID: "id" })).toEqual([{ old: "CONSOLE_SIGN_IN_GITLAB_CLIENT_ID", now: "ORCHESTRATOR_SIGN_IN_GITLAB_CLIENT_ID" }]);
  });
});
