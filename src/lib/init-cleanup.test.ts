import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatInitSuccess, initTeamRepo, loadTeamConfig } from "./init.js";

// Only the clone init makes refuses to go: every other removal, the test's own cleanup
// included, is the real one. Mocked in a file of its own because vi.mock applies to the
// whole file.
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    rmSync: (path: Parameters<typeof fs.rmSync>[0], options?: Parameters<typeof fs.rmSync>[1]) => {
      if (String(path).includes("handbook-init-")) {
        throw Object.assign(new Error(`ENOTEMPTY: directory not empty, rmdir '${String(path)}'`), { code: "ENOTEMPTY" });
      }
      return fs.rmSync(path, options);
    },
  };
});

const APPROVED = { message: "chore: the case under test" } as const;

// no gh/glab on a test machine: the branch is pushed and the link is manual
const noForge = () => {
  const err = new Error("spawn gh ENOENT") as Error & { code: string };
  err.code = "ENOENT";
  throw err;
};

function seededRepo(): string {
  const remote = mkdtempSync(join(tmpdir(), "handbook-team-"));
  execFileSync("git", ["init", "--bare", "-b", "master", remote]);
  const seed = mkdtempSync(join(tmpdir(), "handbook-seed-"));
  try {
    execFileSync("git", ["-C", seed, "init", "-b", "master"]);
    writeFileSync(join(seed, "README.md"), "# our repo\n");
    execFileSync("git", ["-C", seed, "add", "-A"]);
    execFileSync("git", ["-C", seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "seed"]);
    execFileSync("git", ["-C", seed, "push", remote, "master"]);
  } finally {
    rmSync(seed, { recursive: true, force: true });
  }
  return remote;
}

let home: string;
let remote: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "handbook-test-"));
  remote = seededRepo();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(remote, { recursive: true, force: true });
});

describe("initTeamRepo when its clone cannot be removed", () => {
  it("given a scaffold that reached the remote, when the clone refuses to go, then the result and the link to open the request are still returned", () => {
    const result = initTeamRepo(remote, "acme-skills", home, undefined, undefined, noForge, undefined, "", false, APPROVED);

    expect(result).toMatchObject({ ok: true, branch: "handbook/scaffold", merged: false });
    expect(formatInitSuccess(result)).toContain("push handbook/scaffold and open a request against master");
    expect(loadTeamConfig(home)).toMatchObject({ repoUrl: remote, marketplaceName: "acme-skills" });
    expect(execFileSync("git", ["-C", remote, "branch", "--list", "handbook/scaffold"], { encoding: "utf8" })).toContain("handbook/scaffold");
  });

  it("given a push the remote refuses, when the clone refuses to go as well, then the refusal is what comes back", () => {
    const hook = join(remote, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\necho 'pushes are closed' >&2\nexit 1\n");
    chmodSync(hook, 0o755);

    const result = initTeamRepo(remote, "acme-skills", home, undefined, undefined, noForge, undefined, "", false, APPROVED);

    expect(result.ok).toBe(false);
    expect(result.error).not.toContain("ENOTEMPTY");
    expect(loadTeamConfig(home)).toBeNull();
  });
});
