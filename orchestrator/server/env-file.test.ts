import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readEnvFile, startSettings } from "./env-file.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function envFile(text: string, mode = 0o600): string {
  const dir = mkdtempSync(join(tmpdir(), "orchestrator-env-"));
  dirs.push(dir);
  writeFileSync(join(dir, "service.env"), text);
  chmodSync(join(dir, "service.env"), mode);
  return join(dir, "service.env");
}

describe("an env file", () => {
  it("given a file only its owner can read, when it is read, then each KEY=value is a setting and comments are not", () => {
    const file = envFile('# the service\nPATH="/opt/tools/bin:/usr/bin"\nORCHESTRATOR_PORT=18740\n');

    expect(readEnvFile(file)).toEqual({ env: { PATH: "/opt/tools/bin:/usr/bin", ORCHESTRATOR_PORT: "18740" } });
  });

  it("given a file others can read, one of another user, or none, when it is read, then it is refused with what to do", () => {
    const open = envFile("TOKEN=x\n", 0o644);
    const theirs = envFile("TOKEN=x\n");

    expect(readEnvFile(open)).toEqual({ refused: `others on this machine can reach ${open}; close it with: chmod 600 ${JSON.stringify(open)}` });
    expect(readEnvFile(theirs, (process.getuid?.() ?? 0) + 1)).toEqual({ refused: `${theirs} belongs to another user; it is read only from your own file` });
    expect(readEnvFile(join(tmpdir(), "no-such-orchestrator-dir", "service.env"))).toEqual({ refused: `${join(tmpdir(), "no-such-orchestrator-dir", "service.env")} does not exist (handbook-orchestrator service install writes the service's own)` });
  });
});

describe("the settings a start runs with", () => {
  it("given an env file and flags that both set a setting, when they are put together, then the flag's value stands", () => {
    const file = envFile("ORCHESTRATOR_NO_BROWSER=0\nORCHESTRATOR_PORT=18740\n");

    expect(startSettings({ env: { ORCHESTRATOR_NO_BROWSER: "1" }, envFile: file })).toEqual({ env: { ORCHESTRATOR_NO_BROWSER: "1", ORCHESTRATOR_PORT: "18740" } });
  });

  it("given an env file that is refused, or no env file, when they are put together, then the refusal is passed on and without one the flags are all", () => {
    const open = envFile("TOKEN=x\n", 0o640);

    expect(startSettings({ env: {}, envFile: open })).toHaveProperty("refused");
    expect(startSettings({ env: { ORCHESTRATOR_PORT: "1" } })).toEqual({ env: { ORCHESTRATOR_PORT: "1" } });
  });
});
