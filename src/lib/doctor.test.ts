import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { doctorExitCode, formatDoctor, runCommand, runDoctor } from "./doctor.js";
import type { CommandRunner } from "./doctor.js";
import { bumpCounter } from "./counters.js";
import { saveTeamConfig, skeletonFiles } from "./init.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "handbook-doctor-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** A current Claude Code advertises the flags that isolate the model call; `--help` is
 * how the doctor and the harvest both find out whether it can be restricted. */
const CLAUDE_HELP = [
  "Options:",
  "  --tools <tools...>        Specify the list of available tools",
  "  --strict-mcp-config       Only use MCP servers from --mcp-config",
  "  --restricted              Restricted mode",
  "  --model <model>           Model for this session",
  "",
].join("\n");

const happyRunner: CommandRunner = (cmd, args) => {
  if (cmd === "claude") {
    if (args[0] === "-p") return "OK";
    if (args[0] === "--help") return CLAUDE_HELP;
    return "2.1.225 (Claude Code)";
  }
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
      if (cmd === "claude") {
        if (args[0] === "--help") return CLAUDE_HELP;
        return args[0] === "-p" ? "OK" : "2.1.0 (Claude Code)";
      }
      throw new Error(`unexpected command ${cmd}`);
    };
    const report = runDoctor(home, badModel);
    expect(byName(report, "claude CLI").level).toBe("fail");
    expect(byName(report, "claude CLI").detail).toContain("typo-x");
    expect(doctorExitCode(report)).toBe(1);
  });

  it("given the probe times out on a cold machine, when diagnosed, then it does not blame the model", () => {
    const slowProbe: CommandRunner = (cmd, args) => {
      if (cmd === "claude" && args[0] === "-p") {
        const err = new Error("spawnSync claude ETIMEDOUT") as Error & { code: string };
        err.code = "ETIMEDOUT";
        throw err;
      }
      if (cmd === "claude") return "2.1.0 (Claude Code)";
      throw new Error(`unexpected command ${cmd}`);
    };

    const report = runDoctor(home, slowProbe);

    expect(byName(report, "claude CLI").level).toBe("warn");
    expect(byName(report, "claude CLI").detail).toContain("cold start");
    expect(byName(report, "claude CLI").detail).not.toContain("is that model valid");
    expect(doctorExitCode(report)).toBe(0);
  });

  it("given a claude too old to restrict the child session, when diagnosed, then it says so instead of passing silently", () => {
    // Failing closed would mean no harvest at all on an older CLI. The state is REPORTED
    // instead - a green "claude CLI" line says the call succeeds and says nothing about
    // what the child was allowed to do while it ran.
    const oldClaude: CommandRunner = (cmd, args) => {
      if (cmd === "claude") {
        if (args[0] === "--help") return "Options:\n  --model <model>\n  --print\n";
        return args[0] === "-p" ? "OK" : "2.0.1 (Claude Code)";
      }
      return happyRunner(cmd, args, 0);
    };
    const report = runDoctor(home, oldClaude);
    const check = report.checks.find((c) => c.name === "model call isolation");
    expect(check?.level).toBe("warn");
    expect(check?.detail).toContain("child session tool restriction unsupported by this claude version");
    expect(check?.detail).toContain("the harvest still runs");
  });

  it("given a current claude, when diagnosed, then the isolation of the model call is reported as in place", () => {
    const check = runDoctor(home, happyRunner).checks.find((c) => c.name === "model call isolation");
    expect(check?.level).toBe("ok");
    expect(check?.detail).toContain("no tools");
    expect(check?.detail).toContain("empty working directory");
  });

  it("given a help the option parser cannot read, when diagnosed, then it says the format was unrecognized rather than reporting isolation as fine", () => {
    const proseHelp: CommandRunner = (cmd, args) => {
      if (cmd === "claude") {
        if (args[0] === "--help") return "Claude Code. See --tools, --strict-mcp-config, --restricted.";
        return args[0] === "-p" ? "OK" : "2.1.1 (Claude Code)";
      }
      return happyRunner(cmd, args, 0);
    };
    const check = runDoctor(home, proseHelp).checks.find((c) => c.name === "model call isolation");
    expect(check?.level).toBe("warn");
    expect(check?.detail).toContain("help format unrecognized");
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
    expect(byName(report, "config").detail).toContain("harvesting is OFF");
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

describe("doctor team MCP server checks", () => {
  let marketRoot: string;
  beforeEach(() => {
    marketRoot = mkdtempSync(join(tmpdir(), "handbook-doctor-market-"));
  });
  afterEach(() => {
    rmSync(marketRoot, { recursive: true, force: true });
  });

  function writeMcpJson(marketplaceName: string, content: string): void {
    const dir = join(marketRoot, marketplaceName);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".mcp.json"), content);
  }

  it("is absent in solo mode (no team configured)", () => {
    const report = runDoctor(home, happyRunner, marketRoot);
    expect(report.checks.find((c) => c.name === "team MCP servers")).toBeUndefined();
  });

  it("given the team has not shared a server yet, when checked, then it is green rather than a warning", () => {
    saveTeamConfig({ repoUrl: "git@x:t/s.git", marketplaceName: "acme" }, home);
    // init.ts only creates .mcp.json once the team shares its first server - a fresh
    // team install has no such file, and that must not be reported as a fault.
    const report = runDoctor(home, happyRunner, marketRoot);
    expect(byName(report, "team MCP servers").level).toBe("ok");
    expect(byName(report, "team MCP servers").detail).toContain("has not shared");
  });

  it("treats a declared-but-empty mcpServers map the same as no file (measured on a real install: thedotmack/.mcp.json ships as {\"mcpServers\": {}})", () => {
    saveTeamConfig({ repoUrl: "git@x:t/s.git", marketplaceName: "acme" }, home);
    writeMcpJson("acme", JSON.stringify({ mcpServers: {} }));
    const report = runDoctor(home, happyRunner, marketRoot);
    expect(byName(report, "team MCP servers").level).toBe("ok");
    expect(byName(report, "team MCP servers").detail).toContain("no servers");
  });

  it("reports a plugin-declared server as connected, matching the plugin:<name>:<server> prefix a real install uses", () => {
    saveTeamConfig({ repoUrl: "git@x:t/s.git", marketplaceName: "slack" }, home);
    writeMcpJson("slack", JSON.stringify({ mcpServers: { slack: { url: "https://mcp.slack.com/mcp" } } }));
    // Verbatim line from `claude mcp list` captured on a live, real install (2026-09-19,
    // Claude Code CLI) - not a synthetic fixture.
    const runner: CommandRunner = (cmd, args) => {
      if (cmd === "claude" && args[0] === "mcp") {
        return "Checking MCP server health…\n\nplugin:slack:slack: https://mcp.slack.com/mcp (HTTP) - ✔ Connected\n";
      }
      throw new Error(`unexpected command ${cmd} ${args.join(" ")}`);
    };
    const report = runDoctor(home, runner, marketRoot);
    expect(byName(report, "team MCP servers").level).toBe("ok");
    expect(byName(report, "team MCP servers").detail).toContain("connected");
  });

  // Guards against a bare-name fallback in the matcher (removed after being found to
  // let a personal server that merely SHARES A NAME with a never-installed team server
  // - "notion" is a realistic collision - read as the team's server connecting: a
  // false "connected" for a server that was never even pulled onto this machine).
  // Confirmed against the old fallback line directly: temporarily restoring
  // `?? statuses.get(name)` and running just this test produced
  // {"level":"ok","detail":"notion: connected"}. Matching must require the exact
  // plugin:<marketplaceName>: prefix; a bare-name hit is unknown.
  it("does not mistake an unrelated personal server for the team's never-installed one, even when the names collide", () => {
    saveTeamConfig({ repoUrl: "git@x:t/s.git", marketplaceName: "acme" }, home);
    writeMcpJson("acme", JSON.stringify({ mcpServers: { notion: { url: "https://mcp.notion.com/mcp" } } }));
    // No "plugin:acme:notion" line - the team's copy was never installed on this
    // machine - but the user's own, entirely unrelated "notion" server IS connected.
    const runner: CommandRunner = (cmd, args) =>
      cmd === "claude" && args[0] === "mcp" ? "notion: https://mcp.notion.com/mcp - ✔ Connected\n" : "";
    const report = runDoctor(home, runner, marketRoot);
    expect(byName(report, "team MCP servers").level).not.toBe("ok");
    expect(byName(report, "team MCP servers").detail).not.toContain("connected");
    expect(byName(report, "team MCP servers").detail).toContain("unknown");
  });

  // A server that is installed but not authenticated is a normal, temporary setup
  // step, not a broken install, so this must warn - the same severity checkForge uses
  // for the same class of situation ("installed but not finished authenticating") -
  // rather than fail the whole doctor run.
  it("warns, naming the reason, when a shared server needs authentication - consistent with checkForge's severity for the same situation", () => {
    saveTeamConfig({ repoUrl: "git@x:t/s.git", marketplaceName: "acme" }, home);
    writeMcpJson("acme", JSON.stringify({ mcpServers: { billing: { url: "https://billing.example.com/mcp" } } }));
    // The status text itself ("Needs authentication") is verbatim from a real
    // `claude mcp list` run; the plugin:acme:billing prefix is constructed for this
    // test since no real team-shared server was in that state to capture. Based on
    // happyRunner so every OTHER check stays healthy and only the MCP check's own
    // severity is under test.
    const runner: CommandRunner = (cmd, args) => {
      if (cmd === "claude" && args[0] === "mcp") return "plugin:acme:billing: https://billing.example.com/mcp - ! Needs authentication\n";
      return happyRunner(cmd, args, 0);
    };
    const report = runDoctor(home, runner, marketRoot);
    expect(byName(report, "team MCP servers").level).toBe("warn");
    expect(byName(report, "team MCP servers").detail).toContain("Needs authentication");
    expect(doctorExitCode(report)).toBe(0);
  });

  it("fails and names the reason for a server that failed to connect", () => {
    saveTeamConfig({ repoUrl: "git@x:t/s.git", marketplaceName: "acme" }, home);
    writeMcpJson("acme", JSON.stringify({ mcpServers: { billing: { url: "https://billing.example.com/mcp" } } }));
    const runner: CommandRunner = (cmd, args) =>
      cmd === "claude" && args[0] === "mcp" ? "plugin:acme:billing: https://billing.example.com/mcp - ✘ Failed to connect\n" : "";
    const report = runDoctor(home, runner, marketRoot);
    expect(byName(report, "team MCP servers").level).toBe("fail");
    expect(byName(report, "team MCP servers").detail).toContain("Failed to connect");
  });

  it("never reports a server as connected when `claude mcp list` throws", () => {
    saveTeamConfig({ repoUrl: "git@x:t/s.git", marketplaceName: "acme" }, home);
    writeMcpJson("acme", JSON.stringify({ mcpServers: { billing: {} } }));
    const runner: CommandRunner = (cmd, args) => {
      if (cmd === "claude" && args[0] === "mcp") throw new Error("spawn claude ENOENT");
      return "";
    };
    const report = runDoctor(home, runner, marketRoot);
    expect(byName(report, "team MCP servers").level).toBe("warn");
    expect(byName(report, "team MCP servers").detail).toContain("unknown");
  });

  it("never reports a server as connected when `claude mcp list` returns nothing", () => {
    saveTeamConfig({ repoUrl: "git@x:t/s.git", marketplaceName: "acme" }, home);
    writeMcpJson("acme", JSON.stringify({ mcpServers: { billing: {} } }));
    const runner: CommandRunner = (cmd, args) => (cmd === "claude" && args[0] === "mcp" ? "" : "");
    const report = runDoctor(home, runner, marketRoot);
    expect(byName(report, "team MCP servers").level).toBe("warn");
    expect(byName(report, "team MCP servers").detail).toContain("unknown");
  });

  it("never reports a server as connected when `claude mcp list` returns an unrecognized format", () => {
    saveTeamConfig({ repoUrl: "git@x:t/s.git", marketplaceName: "acme" }, home);
    writeMcpJson("acme", JSON.stringify({ mcpServers: { billing: {} } }));
    // Synthetic - this is what a genuinely reformatted CLI output would look like, not
    // captured from a real run. The point being proven is that a non-matching payload
    // never collapses to "connected".
    const runner: CommandRunner = (cmd, args) =>
      cmd === "claude" && args[0] === "mcp" ? '{"servers":[{"name":"billing","status":"up"}]}' : "";
    const report = runDoctor(home, runner, marketRoot);
    expect(byName(report, "team MCP servers").level).toBe("warn");
    expect(byName(report, "team MCP servers").detail).toContain("unknown");
  });

  it("warns unknown for a declared server absent from an otherwise-parseable listing", () => {
    saveTeamConfig({ repoUrl: "git@x:t/s.git", marketplaceName: "acme" }, home);
    writeMcpJson("acme", JSON.stringify({ mcpServers: { billing: {}, other: {} } }));
    const runner: CommandRunner = (cmd, args) =>
      cmd === "claude" && args[0] === "mcp" ? "plugin:acme:other: https://other.example.com/mcp - ✔ Connected\n" : "";
    const report = runDoctor(home, runner, marketRoot);
    expect(byName(report, "team MCP servers").level).toBe("warn");
    expect(byName(report, "team MCP servers").detail).toContain("unknown");
  });

  it("reads a bare server map correctly even when one entry happens to be named mcpServers", () => {
    saveTeamConfig({ repoUrl: "git@x:t/s.git", marketplaceName: "acme" }, home);
    // A bare map (no wrapper) whose own server is literally called "mcpServers" must not
    // be misread as the {"mcpServers": {...}} wrapper - mcp.ts's reader guards this with
    // a plain-object check, and this check must match it exactly.
    writeMcpJson("acme", JSON.stringify({ mcpServers: "not-a-server-map", billing: { url: "https://billing.example.com/mcp" } }));
    const runner: CommandRunner = (cmd, args) =>
      cmd === "claude" && args[0] === "mcp" ? "plugin:acme:billing: https://billing.example.com/mcp - ✔ Connected\n" : "";
    const report = runDoctor(home, runner, marketRoot);
    // "billing" is read correctly; the pathological "mcpServers" key is itself a bare
    // entry with no matching listing line, so it is correctly unknown rather than
    // silently dropped or mistaken for the wrapper.
    expect(byName(report, "team MCP servers").detail).toContain("billing: connected");
    expect(byName(report, "team MCP servers").level).toBe("warn");
  });

  it("warns on invalid JSON in .mcp.json rather than guessing", () => {
    saveTeamConfig({ repoUrl: "git@x:t/s.git", marketplaceName: "acme" }, home);
    writeMcpJson("acme", "{not json");
    const report = runDoctor(home, happyRunner, marketRoot);
    expect(byName(report, "team MCP servers").level).toBe("warn");
    expect(byName(report, "team MCP servers").detail).toContain("not valid JSON");
  });

  // Root ignores the permission bit entirely, so chmod 0o000 would not reproduce the
  // fault below. Skipped visibly (not a silently-passing no-op assertion) when running
  // as root - vitest reports it as "skipped", not "passed".
  const runningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;

  // An unreadable file (permission denied) is a different fault than invalid JSON, and
  // must be named as such rather than reported as "not valid JSON".
  it.skipIf(runningAsRoot)("distinguishes an unreadable .mcp.json (e.g. permission denied) from invalid JSON", () => {
    saveTeamConfig({ repoUrl: "git@x:t/s.git", marketplaceName: "acme" }, home);
    writeMcpJson("acme", JSON.stringify({ mcpServers: { billing: {} } }));
    const mcpFile = join(marketRoot, "acme", ".mcp.json");
    chmodSync(mcpFile, 0o000);
    try {
      const report = runDoctor(home, happyRunner, marketRoot);
      const detail = byName(report, "team MCP servers").detail;
      expect(byName(report, "team MCP servers").level).toBe("warn");
      expect(detail).toContain("cannot read");
      expect(detail).not.toContain("not valid JSON");
    } finally {
      chmodSync(mcpFile, 0o644);
    }
  });
});

describe("runCommand with input", () => {
  // Closing stdin before the write makes the closed pipe certain here as on any runner,
  // instead of depending on which side of the race the platform lands on.
  const CLOSES_STDIN = "exec 0<&-; sleep 0.3;";

  it("given a child that exits 0 without reading its input, when it is run, then its output is returned", () => {
    // given a child that never reads the prompt it is handed
    const script = `${CLOSES_STDIN} printf OK`;
    // when it is run with input
    const out = runCommand("sh", ["-c", script], 5_000, { input: "x".repeat(200_000) });
    // then the closed pipe does not turn a clean exit into a failure
    expect(out).toBe("OK");
  });

  it("given a child that exits non-zero without reading its input, when it is run, then it still throws", () => {
    // given a child that fails and never reads the prompt
    const script = `${CLOSES_STDIN} exit 3`;
    // when it is run with input, then the failure is reported
    expect(() => runCommand("sh", ["-c", script], 5_000, { input: "x".repeat(200_000) })).toThrow();
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

  /** A `claude -p` that fails the way execFileSync reports it: the message carries only stderr. */
  function failingProbe(fields: { stdout?: string; stderr?: string; code?: string }): CommandRunner {
    return (cmd, args) => {
      if (cmd === "claude" && args[0] === "--version") return "2.1.308 (Claude Code)";
      if (cmd === "claude" && args[0] === "-p") {
        const err = new Error(`Command failed: claude -p --model sonnet\n${fields.stderr ?? ""}`) as Error & typeof fields;
        Object.assign(err, { stdout: fields.stdout ?? "", stderr: fields.stderr ?? "", ...(fields.code ? { code: fields.code } : {}) });
        throw err;
      }
      return "";
    };
  }

  it("given a logged-out CLI that says so on stdout with stderr empty, when diagnosed, then it reports NOT logged in", () => {
    // given the measured shape: exit 1, stdout "Not logged in · Please run /login", stderr empty
    const runner = failingProbe({ stdout: "Not logged in · Please run /login\n" });

    // when
    const check = byName(runDoctor(home, runner), "claude CLI");

    // then
    expect(check.level).toBe("fail");
    expect(check.detail).toContain("installed but NOT logged in");
  });

  it("given an authentication error on stderr, when diagnosed, then it still reports NOT logged in", () => {
    // given
    const runner = failingProbe({ stderr: 'API Error: 401 {"type":"error","error":{"type":"authentication_error"}}' });

    // when
    const check = byName(runDoctor(home, runner), "claude CLI");

    // then
    expect(check.detail).toContain("installed but NOT logged in");
  });

  it("given a failure that only mentions authenticating something else, when diagnosed, then it is not called a missing login and claims no login", () => {
    // given
    const runner = failingProbe({ stderr: "Error: could not authenticate the proxy at 10.0.0.1" });

    // when
    const check = byName(runDoctor(home, runner), "claude CLI");

    // then
    expect(check.level).toBe("fail");
    expect(check.detail).not.toContain("NOT logged in");
    expect(check.detail).toMatch(/^installed, but `claude -p --model /);
    expect(check.detail).not.toContain("logged in");
  });

  it("given a proxy that asks for its own credentials, when diagnosed, then it is not called a missing login and the CLI's own line is the evidence", () => {
    // given a logged-in machine behind a proxy: the CLI reports the 407 on stdout
    const runner = failingProbe({ stdout: "API Error: 407 Proxy Authentication Required\n" });

    // when
    const check = byName(runDoctor(home, runner), "claude CLI");

    // then
    expect(check.detail).not.toContain("NOT logged in");
    expect(check.detail).toContain("API Error: 407 Proxy Authentication Required");
    expect(check.detail).not.toContain("Command failed");
  });

  it("given an error naming a sign-in URL, when diagnosed, then the URL alone does not make it a missing login", () => {
    // given
    const runner = failingProbe({ stderr: "Error: request to https://sso.example.com/login was refused" });

    // when
    const check = byName(runDoctor(home, runner), "claude CLI");

    // then
    expect(check.detail).not.toContain("NOT logged in");
  });

  const azureBrokerLine =
    "Microsoft Foundry authentication failed · The requested account is not available in the native broker. It may have been deleted or logged out. Please sign-in again using an interactive API.";

  it.each([
    ["on the first line", `${azureBrokerLine}\n`],
    ["on the second line", `Error: request failed\n${azureBrokerLine}\n`],
  ])("given Azure saying the account was logged out %s, when diagnosed, then it is not called a missing login", (_where, stdout) => {
    // given a machine logged in to Claude whose Foundry credential chain failed
    const runner = failingProbe({ stdout });

    // when
    const check = byName(runDoctor(home, runner), "claude CLI");

    // then
    expect(check.level).toBe("fail");
    expect(check.detail).not.toContain("NOT logged in");
  });

  it.each([
    ["an expired session", "Failed to authenticate: OAuth session expired and could not be refreshed\n"],
    ["a rejected token", "Failed to authenticate. API Error: 401 OAuth access token is invalid.\n"],
  ])("given the headless call reporting %s on stdout, when diagnosed, then it reports NOT logged in", (_case, stdout) => {
    // given the measured sentences of a login that lapsed
    const runner = failingProbe({ stdout });

    // when
    const check = byName(runDoctor(home, runner), "claude CLI");

    // then
    expect(check.detail).toContain("installed but NOT logged in");
  });

  it("given a failed authentication that does not name OAuth, when diagnosed, then it is not called a missing login", () => {
    // given
    const runner = failingProbe({ stdout: "Failed to authenticate: the gateway refused the configured API key\n" });

    // when
    const check = byName(runDoctor(home, runner), "claude CLI");

    // then
    expect(check.detail).not.toContain("NOT logged in");
    expect(check.detail).toContain("the gateway refused the configured API key");
  });

  it("given a warning on stderr and the failure on stdout, when diagnosed, then the evidence is the stdout line", () => {
    // given
    const runner = failingProbe({
      stdout: "API Error: 407 Proxy Authentication Required\n",
      stderr: "(node:123) [DEP0040] DeprecationWarning: The `punycode` module is deprecated.\n",
    });

    // when
    const check = byName(runDoctor(home, runner), "claude CLI");

    // then
    expect(check.detail).toContain("API Error: 407 Proxy Authentication Required");
    expect(check.detail).not.toContain("DeprecationWarning");
  });

  it("given a probe that times out, when diagnosed, then it says installed and does not claim a login", () => {
    // given --version answering proves nothing about the session
    const runner = failingProbe({ code: "ETIMEDOUT" });

    // when
    const check = byName(runDoctor(home, runner), "claude CLI");

    // then
    expect(check.level).toBe("warn");
    expect(check.detail).toMatch(/^installed, but the probe with model/);
    expect(check.detail).not.toContain("logged in");
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

describe("doctor git identity - where the address came from", () => {
  beforeEach(() => {
    saveTeamConfig({ repoUrl: "git@x:t/s.git", marketplaceName: "t" }, home);
  });

  function identityRunner(effective: string, global: string): CommandRunner {
    return (cmd, args) => {
      if (cmd === "claude") return args[0] === "-p" ? "OK" : "2.1.225";
      if (cmd === "git" && args[0] === "config") {
        if (args.includes("--global")) {
          if (!global) throw new Error("exit 1");
          return global;
        }
        return effective;
      }
      if (cmd === "git") return "abc\trefs/heads/main";
      throw new Error("x");
    };
  }

  it("given one address everywhere, when checked, then the line says only what it is", () => {
    const check = byName(runDoctor(home, identityRunner("me@acme.com", "me@acme.com")), "git identity");

    expect(check.level).toBe("ok");
    expect(check.detail).toBe("user.email = me@acme.com");
  });

  it("given the directory's address outranking the global one, when checked, then both are named", () => {
    const check = byName(runDoctor(home, identityRunner("me@personal.example", "me@acme.com")), "git identity");

    // an information gap, not a fault: the tick stays and the exit code with it
    expect(check.level).toBe("ok");
    expect(check.detail).toContain("me@personal.example");
    expect(check.detail).toContain("me@acme.com");
    expect(check.detail).toContain("rather than from your global");
  });

  it("given no global address at all, when checked, then the missing one is named as unset", () => {
    const check = byName(runDoctor(home, identityRunner("me@personal.example", "")), "git identity");

    expect(check.detail).toContain("unset");
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

  it("given no environment of its own, when the doctor runs a forge CLI or git, then the call carries the CLIs' reporting switched off", () => {
    const seen = mkdtempSync(join(tmpdir(), "handbook-doctor-env-"));
    const bin = mkdtempSync(join(tmpdir(), "handbook-bin-"));
    writeFileSync(join(bin, "glab"), `#!/bin/sh\nenv > "$FORGE_ENV_SEEN/glab"\n`);
    chmodSync(join(bin, "glab"), 0o755);
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
    vi.stubEnv("FORGE_ENV_SEEN", seen);
    try {
      runCommand("glab", ["auth", "status"], 5_000);
    } finally {
      vi.unstubAllEnvs();
    }

    const env = readFileSync(join(seen, "glab"), "utf8").split("\n");
    expect(env).toEqual(expect.arrayContaining(["GLAB_SEND_TELEMETRY=0", "GLAB_CHECK_UPDATE=false", "GH_TELEMETRY=0"]));
    expect(env).toContain("GIT_SSH_COMMAND=ssh -oBatchMode=yes");
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

  it("warns when the team's scaffold is behind the version this copy ships", () => {
    // A repository scaffolded by an older TeamHandbook: the skeleton files it never
    // received are what the check has to notice, and until /handbook:init --upgrade
    // existed the only route forward was leaving the repository behind.
    const bare = mkdtempSync(join(tmpdir(), "handbook-teambare-"));
    execFileSync("git", ["init", "--bare", "-b", "main", bare]);
    const seed = mkdtempSync(join(tmpdir(), "handbook-teamseed-"));
    execFileSync("git", ["init", "-b", "main", seed]);
    mkdirSync(join(seed, ".claude-plugin"), { recursive: true });
    writeFileSync(join(seed, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "t" }));
    writeFileSync(join(seed, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "t", version: "0.3.4" }));
    writeFileSync(join(seed, "README.md"), "# t\n");
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
    expect(check.detail).toContain("scaffold file");
    expect(check.detail).toContain("--upgrade");
    rmSync(bare, { recursive: true, force: true });
  });

  it("stays quiet about a scaffold file whose contents the team changed on purpose", () => {
    // init keeps a README the repository already had, so a team that wrote their own reads
    // as "differs" for good. Warning on that produced a yellow line that could only be
    // cleared by overwriting their README, on every run - which is how a warning stops
    // being read. A file that is merely different is their decision; only a MISSING one is
    // a fault nobody chose.
    const bare = mkdtempSync(join(tmpdir(), "handbook-teambare-"));
    execFileSync("git", ["init", "--bare", "-b", "main", bare]);
    const seed = mkdtempSync(join(tmpdir(), "handbook-teamseed-"));
    execFileSync("git", ["init", "-b", "main", seed]);
    const team = { repoUrl: bare, marketplaceName: "t", initializedAt: "2026-01-01T00:00:00Z" };
    const scaffold = { ...skeletonFiles("t", bare, null, "", false), "README.md": "# the team's own words\n" };
    for (const [path, body] of Object.entries(scaffold)) {
      mkdirSync(join(seed, dirname(path)), { recursive: true });
      writeFileSync(join(seed, path), body);
    }
    execFileSync("git", ["-C", seed, "add", "-A"]);
    execFileSync("git", ["-C", seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "seed"]);
    execFileSync("git", ["-C", seed, "push", bare, "main"]);
    rmSync(seed, { recursive: true, force: true });

    saveTeamConfig(team, home);
    const realGitFakeClaude: CommandRunner = (cmd, args, timeoutMs) => {
      if (cmd === "claude") return args[0] === "-p" ? "OK" : "2.1.0";
      if (cmd === "gh" || cmd === "glab") return "Logged in";
      return execFileSync(cmd, args, { encoding: "utf8", timeout: timeoutMs }).trim();
    };

    const check = byName(runDoctor(home, realGitFakeClaude), "team repo");

    expect(check.level).toBe("ok");
    rmSync(bare, { recursive: true, force: true });
  });
});

describe("doctor team plugin copy check", () => {
  let marketRoot: string;
  let bare: string;
  beforeEach(() => {
    marketRoot = mkdtempSync(join(tmpdir(), "handbook-doctor-market-"));
    bare = mkdtempSync(join(tmpdir(), "handbook-teambare-"));
  });
  afterEach(() => {
    rmSync(marketRoot, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  });

  function teamRepoAt(version: string): void {
    execFileSync("git", ["init", "--bare", "-b", "main", bare]);
    const seed = mkdtempSync(join(tmpdir(), "handbook-teamseed-"));
    execFileSync("git", ["init", "-b", "main", seed]);
    mkdirSync(join(seed, ".claude-plugin"), { recursive: true });
    writeFileSync(join(seed, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "t", version }));
    execFileSync("git", ["-C", seed, "add", "-A"]);
    execFileSync("git", ["-C", seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "seed"]);
    execFileSync("git", ["-C", seed, "push", bare, "main"]);
    rmSync(seed, { recursive: true, force: true });
  }

  function marketplaceCopyAt(version: string): void {
    mkdirSync(join(marketRoot, "t", ".claude-plugin"), { recursive: true });
    writeFileSync(join(marketRoot, "t", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "t", version }));
  }

  /** Real git against the local bare repo, recording every git subcommand that run. */
  function recordingRunner(gitCalls: string[]): CommandRunner {
    return (cmd, args, timeoutMs) => {
      if (cmd === "claude") {
        if (args[0] === "-p") return "OK";
        return args[0] === "--help" ? CLAUDE_HELP : "2.1.225 (Claude Code)";
      }
      if (cmd === "gh" || cmd === "glab") return "Logged in";
      if (cmd === "git") gitCalls.push(args[0]!);
      if (cmd === "git" && args[0] === "config") return "me@example.com";
      return execFileSync(cmd, args, { encoding: "utf8", timeout: timeoutMs }).trim();
    };
  }

  const NETWORK_SUBCOMMANDS = new Set(["ls-remote", "clone", "fetch", "pull"]);

  it("given this machine's marketplace copy is behind the team repo, when diagnosed, then it warns with both versions and the two commands, reusing the team repo's clone", () => {
    // given
    teamRepoAt("0.4.0");
    marketplaceCopyAt("0.3.0");
    saveTeamConfig({ repoUrl: bare, marketplaceName: "t" }, home);
    const gitCalls: string[] = [];

    // when
    const report = runDoctor(home, recordingRunner(gitCalls), marketRoot);

    // then
    const check = byName(report, "team plugin copy");
    expect(check.level).toBe("warn");
    expect(check.detail).toContain("marketplace copy is at v0.3.0");
    expect(check.detail).toContain("v0.4.0");
    expect(check.detail).toContain("`/plugin marketplace update t`");
    expect(check.detail).toContain("`/reload-plugins`");
    expect(check.detail).toContain("auto-update");
    expect(gitCalls.filter((c) => NETWORK_SUBCOMMANDS.has(c))).toEqual(["ls-remote", "clone"]);
  });

  it("given a copy left behind, when diagnosed, then it is a warning and the doctor still exits 0", () => {
    // given a machine whose auto-update may well be on and simply has not run since the merge
    teamRepoAt("0.4.0");
    marketplaceCopyAt("0.3.0");
    saveTeamConfig({ repoUrl: bare, marketplaceName: "t" }, home);
    bumpCounter("postToolUse", home);

    // when
    const report = runDoctor(home, recordingRunner([]), marketRoot);

    // then
    expect(byName(report, "team plugin copy").level).toBe("warn");
    expect(report.checks.filter((c) => c.level === "fail")).toEqual([]);
    expect(doctorExitCode(report)).toBe(0);
  });

  it("given this machine's marketplace copy matches the team repo, when diagnosed, then it passes", () => {
    // given
    teamRepoAt("0.4.0");
    marketplaceCopyAt("0.4.0");
    saveTeamConfig({ repoUrl: bare, marketplaceName: "t" }, home);

    // when
    const check = byName(runDoctor(home, recordingRunner([]), marketRoot), "team plugin copy");

    // then
    expect(check.level).toBe("ok");
    expect(check.detail).toContain("marketplace copy is at v0.4.0");
  });

  it("given solo mode, when diagnosed, then the check is absent and the doctor makes no network call", () => {
    // given
    marketplaceCopyAt("0.3.0");
    const gitCalls: string[] = [];

    // when
    const report = runDoctor(home, recordingRunner(gitCalls), marketRoot);

    // then
    expect(report.checks.find((c) => c.name === "team plugin copy")).toBeUndefined();
    expect(gitCalls.filter((c) => NETWORK_SUBCOMMANDS.has(c))).toEqual([]);
  });

  it("given a team whose marketplace was never installed here, when diagnosed, then the check is absent", () => {
    // given
    teamRepoAt("0.4.0");
    saveTeamConfig({ repoUrl: bare, marketplaceName: "t" }, home);

    // when
    const report = runDoctor(home, recordingRunner([]), marketRoot);

    // then
    expect(report.checks.find((c) => c.name === "team plugin copy")).toBeUndefined();
  });

  /** A team repository whose plugin.json carries no version, written into the bare one
   * by fetching from a seed, plus a function that adds a commit to it the same way. */
  function teamRepoByCommit(files: Record<string, string> = {}): { seed: string; commit: (more: Record<string, string>) => void } {
    execFileSync("git", ["init", "--bare", "-b", "main", bare]);
    const seed = mkdtempSync(join(tmpdir(), "handbook-teamseed-"));
    execFileSync("git", ["init", "-b", "main", seed]);
    const commit = (more: Record<string, string>) => {
      for (const [path, body] of Object.entries(more)) {
        mkdirSync(join(seed, dirname(path)), { recursive: true });
        writeFileSync(join(seed, path), body);
      }
      execFileSync("git", ["-C", seed, "add", "-A"]);
      execFileSync("git", ["-C", seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "change"]);
      execFileSync("git", ["-C", bare, "fetch", seed, "main:main"]);
    };
    commit({ ".claude-plugin/plugin.json": JSON.stringify({ name: "t" }), ...files });
    return { seed, commit };
  }

  /** This machine's marketplace copy, which Claude Code keeps as a clone of the team repo. */
  function subscribed(): string {
    execFileSync("git", ["clone", bare, join(marketRoot, "t")]);
    return execFileSync("git", ["-C", join(marketRoot, "t"), "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  }

  it("given a team repo versioned by commit and a copy on the same commit, when diagnosed, then it passes without a network call of its own", () => {
    // given
    const { seed } = teamRepoByCommit();
    const head = subscribed();
    saveTeamConfig({ repoUrl: bare, marketplaceName: "t" }, home);
    const gitCalls: string[] = [];

    // when
    const check = byName(runDoctor(home, recordingRunner(gitCalls), marketRoot), "team plugin copy");

    // then
    expect(check.level).toBe("ok");
    expect(check.detail).toContain(`at commit ${head.slice(0, 12)}, the same as the team repo`);
    expect(gitCalls.filter((c) => NETWORK_SUBCOMMANDS.has(c))).toEqual(["ls-remote", "clone"]);
    rmSync(seed, { recursive: true, force: true });
  });

  it("given a team repo versioned by commit that moved since this copy updated, when diagnosed, then it warns with both commits and the two commands", () => {
    // given
    const { seed, commit } = teamRepoByCommit();
    const local = subscribed();
    commit({ "skills/fix-thing/SKILL.md": "---\nname: fix-thing\n---\n" });
    const remoteHead = execFileSync("git", ["-C", bare, "rev-parse", "main"], { encoding: "utf8" }).trim();
    saveTeamConfig({ repoUrl: bare, marketplaceName: "t" }, home);
    const gitCalls: string[] = [];

    // when
    const check = byName(runDoctor(home, recordingRunner(gitCalls), marketRoot), "team plugin copy");

    // then
    expect(check.level).toBe("warn");
    expect(check.detail).toContain(`at commit ${local.slice(0, 12)} but the team repo is at ${remoteHead.slice(0, 12)}`);
    expect(check.detail).toContain("`/plugin marketplace update t`");
    expect(check.detail).toContain("`/reload-plugins`");
    expect(check.detail).not.toContain("v0.");
    expect(gitCalls.filter((c) => NETWORK_SUBCOMMANDS.has(c))).toEqual(["ls-remote", "clone"]);
    rmSync(seed, { recursive: true, force: true });
  });

  it("given a copy still at 0.1.5 and a team repo that took the version line out, when diagnosed, then it is compared by commit and warns", () => {
    // given the repository a copy subscribed to while it raised a version
    const { seed, commit } = teamRepoByCommit({ ".claude-plugin/plugin.json": JSON.stringify({ name: "t", version: "0.1.5" }) });
    subscribed();
    commit({ ".claude-plugin/plugin.json": JSON.stringify({ name: "t" }) });
    saveTeamConfig({ repoUrl: bare, marketplaceName: "t" }, home);

    // when
    const check = byName(runDoctor(home, recordingRunner([]), marketRoot), "team plugin copy");

    // then
    expect(check.level).toBe("warn");
    expect(check.detail).toContain("has not reached this machine");
    rmSync(seed, { recursive: true, force: true });
  });

  it("given a team repo versioned by commit with a scaffold file missing, when diagnosed, then the missing-files warning still fires and 0.1.0 is not mentioned", () => {
    // given today's scaffold with merged skills and its README gone
    const scaffold = skeletonFiles("t", bare, null, "", false);
    delete scaffold["README.md"];
    const { seed } = teamRepoByCommit({ ...scaffold, "skills/fix-thing/SKILL.md": "---\nname: fix-thing\n---\n" });
    saveTeamConfig({ repoUrl: bare, marketplaceName: "t", initializedAt: "2026-01-01T00:00:00Z" }, home);

    // when
    const check = byName(runDoctor(home, recordingRunner([]), marketRoot), "team repo");

    // then
    expect(check.level).toBe("warn");
    expect(check.detail).toContain("1 scaffold file(s)");
    expect(check.detail).not.toContain("0.1.0");
    rmSync(seed, { recursive: true, force: true });
  });

  it("given a copy that is not a clone, when its team repo is versioned by commit, then the check is absent rather than guessing", () => {
    // given
    const { seed } = teamRepoByCommit();
    marketplaceCopyAt("0.3.0");
    saveTeamConfig({ repoUrl: bare, marketplaceName: "t" }, home);

    // when
    const report = runDoctor(home, recordingRunner([]), marketRoot);

    // then
    expect(report.checks.find((c) => c.name === "team plugin copy")).toBeUndefined();
    rmSync(seed, { recursive: true, force: true });
  });

  it("given a copy that is not a clone inside some other git repository, when diagnosed, then that repository's commit is not read as the copy's", () => {
    // given a plain-directory copy under a parent directory that is itself a git repository
    const { seed } = teamRepoByCommit();
    execFileSync("git", ["init", "-b", "main", marketRoot]);
    writeFileSync(join(marketRoot, "unrelated.txt"), "x\n");
    execFileSync("git", ["-C", marketRoot, "add", "-A"]);
    execFileSync("git", ["-C", marketRoot, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "dotfiles"]);
    marketplaceCopyAt("0.3.0");
    saveTeamConfig({ repoUrl: bare, marketplaceName: "t" }, home);

    // when
    const report = runDoctor(home, recordingRunner([]), marketRoot);

    // then the parent's HEAD used to produce a warning about a commit the copy never had
    expect(report.checks.find((c) => c.name === "team plugin copy")).toBeUndefined();
    rmSync(seed, { recursive: true, force: true });
  });

  it("given a copy versioned by commit and a team repo that carries a version line again, when diagnosed, then it says so and compares the commits", () => {
    // given the switch, this machine's copy taken after it, and an older copy's share putting the line back
    const { seed, commit } = teamRepoByCommit();
    const local = subscribed();
    commit({ ".claude-plugin/plugin.json": JSON.stringify({ name: "t", version: "0.1.1" }) });
    const remoteHead = execFileSync("git", ["-C", bare, "rev-parse", "main"], { encoding: "utf8" }).trim();
    saveTeamConfig({ repoUrl: bare, marketplaceName: "t" }, home);
    const gitCalls: string[] = [];

    // when
    const check = byName(runDoctor(home, recordingRunner(gitCalls), marketRoot), "team plugin copy");

    // then
    expect(check.level).toBe("warn");
    expect(check.detail).toContain("the team repo carries a version line again (v0.1.1) while this machine's copy is versioned by commit");
    expect(check.detail).toContain("A share from a TeamHandbook older than 0.31.0");
    expect(check.detail).toContain("`/handbook:init --upgrade --commit-versioning`");
    expect(check.detail).toContain(`commit ${local.slice(0, 12)}, the team repo ${remoteHead.slice(0, 12)}`);
    expect(check.detail).toContain("`/plugin marketplace update t`");
    expect(check.detail).toContain("`/reload-plugins`");
    expect(gitCalls.filter((c) => NETWORK_SUBCOMMANDS.has(c))).toEqual(["ls-remote", "clone"]);
    rmSync(seed, { recursive: true, force: true });
  });

  it("given a copy without a version on the same commit as a team repo that carries one, when diagnosed, then it warns about the line and prints no update commands", () => {
    // given a copy on the team repo's own commit whose manifest has no version line
    const { seed, commit } = teamRepoByCommit();
    commit({ ".claude-plugin/plugin.json": JSON.stringify({ name: "t", version: "0.1.1" }) });
    subscribed();
    writeFileSync(join(marketRoot, "t", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "t" }));
    saveTeamConfig({ repoUrl: bare, marketplaceName: "t" }, home);

    // when
    const check = byName(runDoctor(home, recordingRunner([]), marketRoot), "team plugin copy");

    // then nothing is behind, so there is nothing to update
    expect(check.level).toBe("warn");
    expect(check.detail).toContain("the team repo carries a version line again (v0.1.1)");
    expect(check.detail).not.toContain("behind");
    expect(check.detail).not.toContain("/plugin marketplace update");
    expect(check.detail).not.toContain("/reload-plugins");
    rmSync(seed, { recursive: true, force: true });
  });

  it("given the team repo cannot be reached, when diagnosed, then the check is absent rather than guessing", () => {
    // given
    marketplaceCopyAt("0.3.0");
    saveTeamConfig({ repoUrl: join(bare, "missing.git"), marketplaceName: "t" }, home);

    // when
    const report = runDoctor(home, recordingRunner([]), marketRoot);

    // then
    expect(byName(report, "team repo").level).toBe("fail");
    expect(report.checks.find((c) => c.name === "team plugin copy")).toBeUndefined();
  });
});
