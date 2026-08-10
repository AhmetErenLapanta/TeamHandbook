import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctorExitCode, formatDoctor, runDoctor } from "./doctor.js";
import type { CommandRunner } from "./doctor.js";
import { bumpCounter } from "./counters.js";
import { saveTeamConfig } from "./init.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "handbook-doctor-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const happyRunner: CommandRunner = (cmd, args) => {
  if (cmd === "claude") return args[0] === "-p" ? "OK" : "2.1.225 (Claude Code)";
  if (cmd === "git") return args[0] === "config" ? "me@example.com" : "abc\trefs/heads/main";
  throw new Error(`unexpected command ${cmd}`);
};

function byName(report: ReturnType<typeof runDoctor>, name: string) {
  return report.checks.find((c) => c.name === name)!;
}

describe("runDoctor", () => {
  it("reports a healthy solo install (hooks not fired yet → warning, not failure)", () => {
    const report = runDoctor(home, happyRunner);
    expect(byName(report, "node").level).toBe("ok");
    expect(byName(report, "claude CLI").level).toBe("ok");
    expect(byName(report, "claude CLI").detail).toContain("authenticated");
    expect(byName(report, "state dir").level).toBe("ok");
    expect(byName(report, "config").detail).toContain("defaults apply");
    expect(byName(report, "hooks").level).toBe("warn");
    expect(byName(report, "team repo").detail).toContain("solo mode");
    expect(byName(report, "gate pipeline").level).toBe("ok");
    expect(doctorExitCode(report)).toBe(0);
  });

  it("fails when the claude CLI is missing, with a fix hint", () => {
    const noClaude: CommandRunner = () => {
      const err = new Error("spawn claude ENOENT") as Error & { code: string };
      err.code = "ENOENT";
      throw err;
    };
    const report = runDoctor(home, noClaude);
    expect(byName(report, "claude CLI").level).toBe("fail");
    expect(byName(report, "claude CLI").detail).toContain("PATH");
    expect(doctorExitCode(report)).toBe(1);
  });

  it("distinguishes an installed-but-broken claude from a missing one", () => {
    const hung: CommandRunner = () => {
      const err = new Error("spawnSync claude ETIMEDOUT") as Error & { code: string };
      err.code = "ETIMEDOUT";
      throw err;
    };
    const report = runDoctor(home, hung);
    expect(byName(report, "claude CLI").detail).toContain("failed or timed out");
    expect(byName(report, "claude CLI").detail).not.toContain("install Claude Code");
  });

  it("probes the configured gate model and fails naming it when rejected", () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ gate: { model: "typo-x" } }));
    const badModel: CommandRunner = (cmd, args) => {
      if (cmd === "claude" && args.includes("typo-x")) throw new Error("API error: unknown model 'typo-x'");
      if (cmd === "claude") return args[0] === "-p" ? "OK" : "2.1.0 (Claude Code)";
      throw new Error(`unexpected command ${cmd}`);
    };
    const report = runDoctor(home, badModel);
    expect(byName(report, "claude CLI").level).toBe("fail");
    expect(byName(report, "claude CLI").detail).toContain("typo-x");
    expect(doctorExitCode(report)).toBe(1);
  });

  it("warns about abandoned pairs so the loss is visible", () => {
    bumpCounter("gateAbandoned", home, 2);
    const report = runDoctor(home, happyRunner);
    expect(byName(report, "abandoned pairs").level).toBe("warn");
    expect(byName(report, "abandoned pairs").detail).toContain("recoverable");
  });

  it("treats a not-yet-created home as normal, creating it like the writers do", () => {
    const fresh = join(home, "never-created", "nested");
    const report = runDoctor(fresh, happyRunner);
    expect(byName(report, "state dir").level).toBe("ok");
    expect(doctorExitCode(report)).toBe(0);
  });

  it("reports hook activity once counters move", () => {
    bumpCounter("postToolUse", home, 42);
    bumpCounter("bashFailuresCaptured", home, 3);
    const report = runDoctor(home, happyRunner);
    expect(byName(report, "hooks").level).toBe("ok");
    expect(byName(report, "hooks").detail).toContain("42 tool calls seen");
  });

  it("fails on corrupt config.json and says defaults apply", () => {
    writeFileSync(join(home, "config.json"), "{not json");
    const report = runDoctor(home, happyRunner);
    expect(byName(report, "config").level).toBe("fail");
    expect(byName(report, "config").detail).toContain("IGNORED");
  });

  it("checks a configured team repo and fails loudly when unreachable", () => {
    saveTeamConfig({ repoUrl: "git@x:t/skills.git", marketplaceName: "t" }, home);
    const ok = runDoctor(home, happyRunner);
    expect(byName(ok, "team repo").detail).toContain("reachable");

    const gitDown: CommandRunner = (cmd) => {
      if (cmd === "claude") return "2.1.225";
      throw new Error("Permission denied (publickey)");
    };
    const bad = runDoctor(home, gitDown);
    expect(byName(bad, "team repo").level).toBe("fail");
    expect(byName(bad, "team repo").detail).toContain("publickey");
    expect(doctorExitCode(bad)).toBe(1);
  });
});

describe("formatDoctor", () => {
  it("renders marks, a tally, and the healthy line only when all-clear", () => {
    bumpCounter("postToolUse", home);
    const healthy = formatDoctor(runDoctor(home, happyRunner));
    expect(healthy).toContain("✔ node:");
    expect(healthy).toContain("0 problem(s)");
    expect(healthy).toContain("Everything looks healthy.");

    const broken = formatDoctor(
      runDoctor(home, () => {
        throw new Error("down");
      }),
    );
    expect(broken).toContain("✘ claude CLI:");
    expect(broken).not.toContain("Everything looks healthy.");
  });
});

describe("doctor auth + git identity checks", () => {
  it("fails when claude is installed but logged out", () => {
    const loggedOut: CommandRunner = (cmd, args) => {
      if (cmd === "claude" && args[0] === "--version") return "2.1.225";
      if (cmd === "claude" && args[0] === "-p") throw new Error("Not logged in · Please run /login");
      return "";
    };
    const report = runDoctor(home, loggedOut);
    expect(byName(report, "claude CLI").level).toBe("fail");
    expect(byName(report, "claude CLI").detail).toContain("logged in");
    expect(doctorExitCode(report)).toBe(1);
  });

  it("adds a git-identity check only in team mode and flags a missing email", () => {
    expect(runDoctor(home, happyRunner).checks.find((c) => c.name === "git identity")).toBeUndefined();
    saveTeamConfig({ repoUrl: "git@x:t/s.git", marketplaceName: "t" }, home);
    const noEmail: CommandRunner = (cmd, args) => {
      if (cmd === "claude") return args[0] === "-p" ? "OK" : "2.1.225";
      if (cmd === "git" && args[0] === "config") return "";
      if (cmd === "git") return "abc\trefs/heads/main";
      throw new Error("x");
    };
    const report = runDoctor(home, noEmail);
    expect(byName(report, "git identity").level).toBe("fail");
  });
});

describe("doctor team-distribution checks", () => {
  function forgeRunner(forge: "ok" | "enoent" | "unauth"): CommandRunner {
    return (cmd, args) => {
      if (cmd === "claude") return args[0] === "-p" ? "OK" : "2.1.0";
      if (cmd === "git") return args[0] === "config" ? "me@example.com" : "abc\trefs/heads/main";
      if (cmd === "gh" || cmd === "glab") {
        if (forge === "ok") return "Logged in to github.com";
        if (forge === "enoent") {
          const e = new Error(`spawn ${cmd} ENOENT`) as Error & { code: string };
          e.code = "ENOENT";
          throw e;
        }
        throw new Error("not logged in");
      }
      throw new Error(`unexpected command ${cmd}`);
    };
  }

  it("checks the forge CLI only in team mode and reports install/auth state", () => {
    expect(runDoctor(home, forgeRunner("ok")).checks.find((c) => c.name === "forge CLI")).toBeUndefined();
    saveTeamConfig({ repoUrl: "git@github.com:t/s.git", marketplaceName: "t" }, home);
    expect(byName(runDoctor(home, forgeRunner("ok")), "forge CLI").level).toBe("ok");
    const missing = byName(runDoctor(home, forgeRunner("enoent")), "forge CLI");
    expect(missing.level).toBe("warn");
    expect(missing.detail).toContain("not installed");
    expect(byName(runDoctor(home, forgeRunner("unauth")), "forge CLI").detail).toContain("auth login");
  });

  it("warns when merged skills sit at plugin version 0.1.0 (the bump CI never ran)", () => {
    // a real bare remote with a merged skill dir but the scaffold's 0.1.0 version
    const bare = mkdtempSync(join(tmpdir(), "handbook-teambare-"));
    execFileSync("git", ["init", "--bare", "-b", "main", bare]);
    const seed = mkdtempSync(join(tmpdir(), "handbook-teamseed-"));
    execFileSync("git", ["init", "-b", "main", seed]);
    mkdirSync(join(seed, ".claude-plugin"), { recursive: true });
    writeFileSync(join(seed, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "t", version: "0.1.0" }));
    mkdirSync(join(seed, "skills", "fix-thing"), { recursive: true });
    writeFileSync(join(seed, "skills", "fix-thing", "SKILL.md"), "---\nname: fix-thing\n---\n");
    execFileSync("git", ["-C", seed, "add", "-A"]);
    execFileSync("git", ["-C", seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "seed"]);
    execFileSync("git", ["-C", seed, "push", bare, "main"]);
    rmSync(seed, { recursive: true, force: true });

    saveTeamConfig({ repoUrl: bare, marketplaceName: "t" }, home);
    const realGitFakeClaude: CommandRunner = (cmd, args, timeoutMs) => {
      if (cmd === "claude") return args[0] === "-p" ? "OK" : "2.1.0";
      if (cmd === "gh" || cmd === "glab") return "Logged in";
      return execFileSync(cmd, args, { encoding: "utf8", timeout: timeoutMs }).trim();
    };
    const check = byName(runDoctor(home, realGitFakeClaude), "team repo");
    expect(check.level).toBe("warn");
    expect(check.detail).toContain("0.1.0");
    expect(check.detail).toContain("receiving updates");
    rmSync(bare, { recursive: true, force: true });
  });
});
