import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handbookHome, handbookWorkdir } from "./session-state.js";
import { readCounters } from "./counters.js";
import { hostFromUrl, loadTeamConfig } from "./init.js";
import { loadScoreConfig } from "./score.js";
import { loadDistillConfig } from "./distill.js";
import { loadHarvestConfig } from "./harvest.js";
import { lastPipelineRun, pluginVersion } from "./status.js";

export type CheckLevel = "ok" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  level: CheckLevel;
  detail: string;
}

export interface DoctorReport {
  version: string;
  checks: DoctorCheck[];
}

/** Runs an external command, returning trimmed stdout or throwing. Injectable for tests. */
export type CommandRunner = (cmd: string, args: string[], timeoutMs: number) => string;

export const runCommand: CommandRunner = (cmd, args, timeoutMs) =>
  execFileSync(cmd, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
    // never let git/ssh block on an interactive prompt; stdin is closed anyway
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -oBatchMode=yes" },
  }).trim();

function ok(name: string, detail: string): DoctorCheck {
  return { name, level: "ok", detail };
}
function warn(name: string, detail: string): DoctorCheck {
  return { name, level: "warn", detail };
}
function fail(name: string, detail: string): DoctorCheck {
  return { name, level: "fail", detail };
}

function checkNode(): DoctorCheck {
  const major = Number(process.versions.node.split(".")[0]);
  return major >= 18
    ? ok("node", `${process.version} (≥ 18 required)`)
    : fail("node", `${process.version} — TeamHandbook needs Node ≥ 18`);
}

// The harvest itself allows 180s. This probe only asks for "OK", but it is often the
// first headless call on a cold machine, and 30s was short enough to fail on a healthy
// install.
const PROBE_TIMEOUT_MS = 60_000;

function checkClaudeCli(run: CommandRunner, home: string): DoctorCheck {
  try {
    run("claude", ["--version"], 15_000);
  } catch (err) {
    if ((err as { code?: string })?.code === "ENOENT") {
      return fail(
        "claude CLI",
        "not found on PATH — the gate and distiller need it; install Claude Code CLI or fix PATH",
      );
    }
    const message = String(err instanceof Error ? err.message : err).split("\n")[0];
    return fail("claude CLI", `found, but \`claude --version\` failed or timed out: ${message}`);
  }
  // `--version` succeeds while logged OUT, so probe an actual prompt — this is the
  // exact failure (auth expired) that silently breaks the gate. Probe with the
  // CONFIGURED gate/distill model, not the default: a typo'd or retired gate.model
  // makes every real gate run fail while a default-model probe stays green.
  // Probe every model a real run can use: the harvest model drives the AUTOMATIC
  // path, so a typo there breaks everything while a gate-only probe stays green.
  const harvestModel = loadHarvestConfig(home).model;
  const gateModel = loadScoreConfig(home).model;
  const distillModel = loadDistillConfig(home).model;
  const models = [...new Set([harvestModel, gateModel, distillModel].filter(Boolean))];
  for (const model of models) {
    try {
      const reply = run("claude", ["-p", "Reply with exactly: OK", ...(model ? ["--model", model] : [])], PROBE_TIMEOUT_MS);
      if (!/\bok\b/i.test(reply)) {
        return warn("claude CLI", `installed, but a probe with model "${model}" returned an unexpected reply: ${reply.slice(0, 60)}`);
      }
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err);
      const lower = message.toLowerCase();
      if (lower.includes("login") || lower.includes("auth") || lower.includes("logged")) {
        return fail("claude CLI", "installed but NOT logged in — run `claude` and /login; the gate cannot score until then");
      }
      // A timeout says nothing about the model, and the first headless call after an
      // install is the slowest one a machine ever makes. Reporting it as a failure sent
      // the first-run reader to edit config.json over a model that was fine.
      if ((err as { code?: string })?.code === "ETIMEDOUT" || lower.includes("etimedout")) {
        return warn(
          "claude CLI",
          `installed and logged in, but the probe with model "${model}" did not answer within ${PROBE_TIMEOUT_MS / 1000}s — usually a cold start; re-run this check`,
        );
      }
      return fail(
        "claude CLI",
        `logged in, but \`claude -p --model ${model}\` failed — is that model valid? (config.json harvest.model/gate.model/distill.model): ${(message.split("\n")[0] ?? "").slice(0, 80)}`,
      );
    }
  }
  return ok(
    "claude CLI",
    models.length > 1 ? `installed and authenticated (${models.length} configured models reachable)` : "installed and authenticated",
  );
}

function checkGitIdentity(home: string, run: CommandRunner): DoctorCheck | null {
  if (!loadTeamConfig(home)) return null; // only matters for team publishing
  try {
    const email = run("git", ["config", "user.email"], 5_000);
    return email
      ? ok("git identity", `user.email = ${email}`)
      : fail("git identity", "git user.email is empty — team PRs would ship with a junk author; run `git config --global user.email you@example.com`");
  } catch {
    return fail("git identity", "git user.email is not set — team PRs would ship with a junk author; run `git config --global user.email you@example.com`");
  }
}

function checkHomeWritable(home: string): DoctorCheck {
  const probe = join(home, `.doctor-probe-${process.pid}`);
  try {
    // a missing home dir is the NORMAL fresh state (all writers create it
    // lazily) — create it like they would, then probe writability
    mkdirSync(home, { recursive: true });
    writeFileSync(probe, "ok");
    rmSync(probe, { force: true });
    return ok("state dir", `${home} writable`);
  } catch (err) {
    return fail("state dir", `cannot write ${home}: ${String(err instanceof Error ? err.message : err)}`);
  }
}

function checkConfig(home: string): DoctorCheck {
  const file = join(home, "config.json");
  if (!existsSync(file)) return ok("config", "no config.json (defaults apply)");
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return fail(
        "config",
        "config.json is not a JSON object — automatic harvesting is OFF until it is " +
          "(the privacy switches fail closed); every other setting falls back to its default",
      );
    }
    return ok("config", "config.json valid");
  } catch {
    return fail(
      "config",
      "config.json is not valid JSON — automatic harvesting is OFF until it parses " +
        "(the privacy switches fail closed); every other setting falls back to its default",
    );
  }
}

function checkHooks(home: string): DoctorCheck {
  const counters = readCounters(home);
  if (counters.postToolUse === 0) {
    return warn(
      "hooks",
      "no hook events recorded yet — run any command in a Claude Code session and re-check; " +
        "if this stays 0 the hooks are not firing (was the plugin installed and the session restarted?)",
    );
  }
  return ok(
    "hooks",
    `firing — ${counters.postToolUse} tool calls seen, ${counters.bashFailuresCaptured} failures captured, ${counters.pairsResolved} pairs resolved`,
  );
}

// Reachability alone is not health: the version-bump CI (the one thing that pushes
// merged skills to teammates) is easy to leave unconfigured, and nothing else warns.
// Shallow-clone the remote and read plugin.json — merged skills present while the
// version is still the scaffold's 0.1.0 means the bump CI never ran. Best-effort: any
// error falls back to plain reachability (which was already confirmed).
function remoteDistributionState(url: string, run: CommandRunner): { version: string; skillCount: number } | null {
  const dir = handbookWorkdir("handbook-doctor-");
  try {
    run("git", ["clone", "--depth", "1", "--single-branch", "--", url, dir], 25_000);
    const version = JSON.parse(readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf8")).version;
    let skillCount = 0;
    try {
      skillCount = readdirSync(join(dir, "skills"), { withFileTypes: true }).filter((e) => e.isDirectory()).length;
    } catch {
      // no skills/ dir yet
    }
    return typeof version === "string" ? { version, skillCount } : null;
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function checkTeamRepo(home: string, run: CommandRunner): DoctorCheck {
  const team = loadTeamConfig(home);
  if (!team) return ok("team repo", "not configured (solo mode — that's fine)");
  try {
    run("git", ["ls-remote", "--heads", "--", team.repoUrl], 20_000);
  } catch (err) {
    const message = String(err instanceof Error ? err.message : err)
      .split("\n")
      .slice(-2)
      .join(" | ");
    return fail("team repo", `${team.repoUrl} NOT reachable — approvals cannot publish (${message})`);
  }
  const dist = remoteDistributionState(team.repoUrl, run);
  if (dist && dist.skillCount > 0 && dist.version === "0.1.0") {
    return warn(
      "team repo",
      `${team.repoUrl} reachable, but ${dist.skillCount} merged skill(s) sit at plugin version 0.1.0 — the ` +
        "version-bump CI has not run, so teammates are NOT receiving updates (check the TEAMHANDBOOK_CI_TOKEN " +
        "variable / Actions write permission)",
    );
  }
  return ok("team repo", `${team.repoUrl} reachable`);
}

function checkForge(home: string, run: CommandRunner): DoctorCheck | null {
  const team = loadTeamConfig(home);
  if (!team) return null; // solo mode never opens PRs
  const tool = (hostFromUrl(team.repoUrl) ?? "").includes("github") ? "gh" : "glab";
  try {
    run(tool, ["auth", "status"], 10_000);
    return ok("forge CLI", `${tool} authenticated — approvals can auto-open PRs`);
  } catch (err) {
    if ((err as { code?: string })?.code === "ENOENT") {
      return warn(
        "forge CLI",
        `${tool} not installed — approvals still push a branch and print a manual PR link; install ${tool} to auto-open PRs`,
      );
    }
    return warn(
      "forge CLI",
      `${tool} installed but not authenticated — run \`${tool} auth login\` (approvals still print a manual link)`,
    );
  }
}

function checkLastRun(home: string): DoctorCheck {
  const last = lastPipelineRun(home);
  if (!last) return ok("gate pipeline", "no runs yet (nothing recurred or was captured manually)");
  if (last.errored > 0) {
    const reason = last.outcomes?.filter((o) => o.outcome === "error").at(-1)?.error;
    const why = reason ? ` — ${reason}` : "";
    return warn(
      "gate pipeline",
      `last run had ${last.errored} error(s)${why} (see the claude CLI check above; full log: ${join(home, "pipeline.log")})`,
    );
  }
  return ok("gate pipeline", `last run ${last.ts}: ${last.written.length} written, ${last.rejected} rejected`);
}

function checkAbandoned(home: string): DoctorCheck | null {
  const abandoned = readCounters(home).gateAbandoned;
  if (abandoned === 0) return null;
  return warn(
    "abandoned pairs",
    `${abandoned} captured pair(s) were given up after repeated gate failures — recoverable in ${join(home, "abandoned.jsonl")} once claude works again`,
  );
}

export function runDoctor(
  home: string = handbookHome(),
  run: CommandRunner = runCommand,
): DoctorReport {
  const checks: DoctorCheck[] = [
    checkNode(),
    checkClaudeCli(run, home),
    checkHomeWritable(home),
    checkConfig(home),
    checkHooks(home),
    checkTeamRepo(home, run),
  ];
  const identity = checkGitIdentity(home, run);
  if (identity) checks.push(identity);
  const forge = checkForge(home, run);
  if (forge) checks.push(forge);
  checks.push(checkLastRun(home));
  const abandoned = checkAbandoned(home);
  if (abandoned) checks.push(abandoned);
  return { version: pluginVersion(), checks };
}

const MARKS: Record<CheckLevel, string> = { ok: "✔", warn: "⚠", fail: "✘" };

export function formatDoctor(report: DoctorReport): string {
  const lines = [`TeamHandbook doctor  (v${report.version})`, ""];
  for (const check of report.checks) {
    lines.push(` ${MARKS[check.level]} ${check.name}: ${check.detail}`);
  }
  const counts = { ok: 0, warn: 0, fail: 0 };
  for (const check of report.checks) counts[check.level] += 1;
  lines.push("", `${counts.ok} ok, ${counts.warn} warning(s), ${counts.fail} problem(s)`);
  if (counts.fail === 0 && counts.warn === 0) lines.push("Everything looks healthy.");
  return lines.join("\n");
}

export function doctorExitCode(report: DoctorReport): number {
  return report.checks.some((c) => c.level === "fail") ? 1 : 0;
}
