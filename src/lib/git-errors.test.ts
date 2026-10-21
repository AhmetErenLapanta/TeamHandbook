import { describe, it, expect, afterEach, vi } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeCredentials } from "./git-errors.js";

describe("probeCredentials", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("given a clone that failed, when gh is asked about sign-in, then the call carries gh's reporting switched off", () => {
    const seen = mkdtempSync(join(tmpdir(), "handbook-gh-env-"));
    const bin = mkdtempSync(join(tmpdir(), "handbook-bin-"));
    writeFileSync(join(bin, "gh"), `#!/bin/sh\nenv >> "$FORGE_ENV_SEEN/gh"\n`);
    chmodSync(join(bin, "gh"), 0o755);
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
    vi.stubEnv("FORGE_ENV_SEEN", seen);

    const creds = probeCredentials();

    expect(creds).toEqual({ ghInstalled: true, ghAuthenticated: true });
    const calls = readFileSync(join(seen, "gh"), "utf8").split("\n").filter((line) => line.startsWith("GH_TELEMETRY="));
    expect(calls).toEqual(["GH_TELEMETRY=0", "GH_TELEMETRY=0"]);
  });
});
