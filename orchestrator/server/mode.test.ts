import { describe, expect, it } from "vitest";
import { cloudMode, cloudSettingsRefused, orchestratorMode } from "./mode.js";

const CLOUD = {
  ORCHESTRATOR_MODE: "cloud",
  ORCHESTRATOR_DATABASE_URL: "postgres://orchestrator@db/orchestrator",
  ORCHESTRATOR_SECRET_KEY_FILE: "/run/secrets/secret_key",
  ORCHESTRATOR_PUBLIC_URL: "https://orchestrator.example.com",
  ORCHESTRATOR_TASK_ISOLATION: "container",
  ORCHESTRATOR_TASK_NETWORK: "none",
  ORCHESTRATOR_TASK_USER: "1000:1000",
  ORCHESTRATOR_QUOTA_MEMBERS: "25",
  ORCHESTRATOR_QUOTA_TASKS_PER_MONTH: "unlimited",
  ORCHESTRATOR_QUOTA_CONCURRENT_TASKS: "3",
};

describe("the orchestrator's mode", () => {
  it("given no ORCHESTRATOR_MODE, an empty one or self-hosted, when the mode is read, then the orchestrator is not in cloud mode", () => {
    expect(cloudMode({})).toBe(false);
    expect(cloudMode({ ORCHESTRATOR_MODE: "" })).toBe(false);
    expect(cloudMode({ ORCHESTRATOR_MODE: "self-hosted" })).toBe(false);
  });

  it("given nothing set, when the mode is read, then it is one person's orchestrator on this machine", () => {
    expect(orchestratorMode({})).toBe("local");
    expect(orchestratorMode({ ORCHESTRATOR_MODE: "", ORCHESTRATOR_PORT: "8080", ORCHESTRATOR_DATA_DIR: "/srv/data", HOME: "/home/someone" })).toBe("local");
  });

  it("given a way to sign in, a setup code, an address others reach, a shared database or an auth mode, when the mode is read without ORCHESTRATOR_MODE, then it serves a team and asks people to sign in", () => {
    for (const env of [
      { ORCHESTRATOR_SIGN_IN_GITHUB_CLIENT_ID: "id" },
      { ORCHESTRATOR_OIDC_ISSUER: "https://idp.example.invalid" },
      { ORCHESTRATOR_SETUP_TOKEN_FILE: "/run/secrets/setup" },
      { ORCHESTRATOR_PUBLIC_URL: "https://handbook.example.invalid" },
      { ORCHESTRATOR_DATABASE_URL: "postgres://db/orchestrator" },
      { ORCHESTRATOR_AUTH: "local" },
    ]) expect(orchestratorMode(env), JSON.stringify(env)).toBe("self-hosted");
    expect(orchestratorMode({ ORCHESTRATOR_SIGN_IN_GOOGLE_CLIENT_ID: "" })).toBe("local");
  });

  it("given ORCHESTRATOR_MODE named, when the mode is read, then it holds whatever else is set", () => {
    expect([orchestratorMode({ ORCHESTRATOR_MODE: "local", ORCHESTRATOR_PUBLIC_URL: "https://x.example.invalid" }), orchestratorMode({ ORCHESTRATOR_MODE: "self-hosted" }), orchestratorMode({ ORCHESTRATOR_MODE: "cloud" })]).toEqual(["local", "self-hosted", "cloud"]);
  });

  it("given ORCHESTRATOR_MODE=cloud, when the mode is read, then the orchestrator is in cloud mode", () => {
    expect(cloudMode({ ORCHESTRATOR_MODE: "cloud" })).toBe(true);
  });

  it("given a mode the orchestrator does not know, when the mode is read, then it is refused rather than read as either one", () => {
    expect(() => cloudMode({ ORCHESTRATOR_MODE: "Cloud" })).toThrow(/not a mode this orchestrator knows/);
    expect(() => cloudMode({ ORCHESTRATOR_MODE: "saas" })).toThrow(/not a mode this orchestrator knows/);
  });
});

describe("what a cloud orchestrator needs before it starts", () => {
  it("given Postgres, a secret key, an https address and accounts, when the settings are checked, then nothing is refused", () => {
    expect(cloudSettingsRefused(CLOUD)).toBeNull();
    expect(cloudSettingsRefused({ ...CLOUD, ORCHESTRATOR_DATABASE_URL: undefined, ORCHESTRATOR_DATABASE_URL_FILE: "/run/secrets/database_url", ORCHESTRATOR_SECRET_KEY_FILE: undefined, ORCHESTRATOR_SECRET_KEY: "k", ORCHESTRATOR_AUTH: "local" })).toBeNull();
  });

  it("given a cloud orchestrator with none of what it needs, when the settings are checked, then every missing one is named in one refusal", () => {
    const refused = cloudSettingsRefused({ ORCHESTRATOR_MODE: "cloud", ORCHESTRATOR_AUTH: "dev-admin" });
    expect(refused).toMatch(/^ORCHESTRATOR_MODE=cloud needs /);
    expect(refused).toContain("ORCHESTRATOR_DATABASE_URL");
    expect(refused).toContain("ORCHESTRATOR_SECRET_KEY");
    expect(refused).toContain("ORCHESTRATOR_PUBLIC_URL as an https:// address");
    expect(refused).toContain("ORCHESTRATOR_AUTH other than dev-admin");
    expect(refused).toContain("ORCHESTRATOR_TASK_ISOLATION=container");
    expect(refused).toContain("ORCHESTRATOR_TASK_NETWORK=none");
    expect(refused).toContain("ORCHESTRATOR_TASK_USER as uid:gid, both numbers other than 0");
    expect(refused).not.toContain("ORCHESTRATOR_QUOTA");
  });

  it("given a cloud orchestrator whose task containers would join a network or run as root, in root's group or as a name, when the settings are checked, then each is refused", () => {
    expect(cloudSettingsRefused({ ...CLOUD, ORCHESTRATOR_TASK_NETWORK: undefined })).toBe("ORCHESTRATOR_MODE=cloud needs ORCHESTRATOR_TASK_NETWORK=none");
    expect(cloudSettingsRefused({ ...CLOUD, ORCHESTRATOR_TASK_NETWORK: "open" })).toBe("ORCHESTRATOR_MODE=cloud needs ORCHESTRATOR_TASK_NETWORK=none");
    for (const user of [undefined, "", "0", "root", "0:0", "root:1000", "1000:0", "node:root", "1000", "node", "node:node", "00", "000:1000", "1000:00", " 1000:1000"]) expect(cloudSettingsRefused({ ...CLOUD, ORCHESTRATOR_TASK_USER: user })).toBe("ORCHESTRATOR_MODE=cloud needs ORCHESTRATOR_TASK_USER as uid:gid, both numbers other than 0");
    expect(cloudSettingsRefused({ ...CLOUD, ORCHESTRATOR_TASK_USER: "10000:10000" })).toBeNull();
  });

  it("given a cloud orchestrator whose plan limits are zero, not a number or left out, when the settings are checked, then each given one that is no number is named, and left out or unlimited is accepted", () => {
    expect(cloudSettingsRefused({ ...CLOUD, ORCHESTRATOR_QUOTA_MEMBERS: undefined, ORCHESTRATOR_QUOTA_TASKS_PER_MONTH: "0", ORCHESTRATOR_QUOTA_CONCURRENT_TASKS: "two" })).toBe(
      "ORCHESTRATOR_MODE=cloud needs ORCHESTRATOR_QUOTA_TASKS_PER_MONTH (a positive whole number or unlimited), ORCHESTRATOR_QUOTA_CONCURRENT_TASKS (a positive whole number or unlimited)",
    );
    expect(cloudSettingsRefused({ ...CLOUD, ORCHESTRATOR_QUOTA_MEMBERS: undefined, ORCHESTRATOR_QUOTA_TASKS_PER_MONTH: undefined, ORCHESTRATOR_QUOTA_CONCURRENT_TASKS: undefined })).toBeNull();
    expect(cloudSettingsRefused({ ...CLOUD, ORCHESTRATOR_QUOTA_MEMBERS: "unlimited", ORCHESTRATOR_QUOTA_CONCURRENT_TASKS: "unlimited" })).toBeNull();
  });

  it("given a cloud orchestrator whose tasks would run on its own host, when the settings are checked, then process isolation is refused", () => {
    expect(cloudSettingsRefused({ ...CLOUD, ORCHESTRATOR_TASK_ISOLATION: undefined })).toBe("ORCHESTRATOR_MODE=cloud needs ORCHESTRATOR_TASK_ISOLATION=container");
    expect(cloudSettingsRefused({ ...CLOUD, ORCHESTRATOR_TASK_ISOLATION: "process" })).toBe("ORCHESTRATOR_MODE=cloud needs ORCHESTRATOR_TASK_ISOLATION=container");
  });

  it("given a cloud orchestrator with a setting that hands one organization the host's profile, environment, folders or local addresses, when the settings are checked, then each such setting is refused by name", () => {
    const refused = cloudSettingsRefused({ ...CLOUD, ORCHESTRATOR_TASK_PROFILE: "personal", ORCHESTRATOR_TASK_ENV_PASS: "NPM_TOKEN", ORCHESTRATOR_LOCAL_REPOS_ROOT: "/srv/repos", ORCHESTRATOR_MCP_LOCAL: "1" });
    expect(refused).toBe("ORCHESTRATOR_MODE=cloud refuses ORCHESTRATOR_TASK_PROFILE=personal, ORCHESTRATOR_TASK_ENV_PASS, ORCHESTRATOR_LOCAL_REPOS_ROOT, ORCHESTRATOR_MCP_LOCAL=1, which hand one organization this host's profile, environment, folders or local addresses");
    expect(cloudSettingsRefused({ ...CLOUD, ORCHESTRATOR_TASK_PROFILE: "isolated", ORCHESTRATOR_TASK_ENV_PASS: " ", ORCHESTRATOR_MCP_LOCAL: "0" })).toBeNull();
  });

  it("given everything but a plain http address, when the settings are checked, then the address alone is refused", () => {
    expect(cloudSettingsRefused({ ...CLOUD, ORCHESTRATOR_PUBLIC_URL: "http://orchestrator.example.com" })).toBe("ORCHESTRATOR_MODE=cloud needs ORCHESTRATOR_PUBLIC_URL as an https:// address");
  });
});
