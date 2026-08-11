// src/lib/doctor.ts
import { execFileSync } from "node:child_process";
import { existsSync as existsSync2, mkdirSync as mkdirSync2, mkdtempSync, readdirSync as readdirSync2, readFileSync as readFileSync4, rmSync, writeFileSync as writeFileSync2 } from "node:fs";
import { tmpdir } from "node:os";
import { join as join6 } from "node:path";

// src/lib/session-state.ts
import { homedir } from "node:os";
import { join } from "node:path";
var EDIT_ATTACH_WINDOW_MS = 15 * 60 * 1e3;
function handbookHome() {
  return process.env.TEAMHANDBOOK_HOME ?? join(homedir(), ".teamhandbook");
}
var SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1e3;
var SESSION_ORPHAN_MS = 3 * 60 * 60 * 1e3;

// src/lib/counters.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join as join2 } from "node:path";
var FIELDS = [
  "redactionBlocked",
  "postToolUse",
  "bashFailuresCaptured",
  "pairsResolved",
  "gateErrors",
  "gateAbandoned"
];
function countersFile(home = handbookHome()) {
  return join2(home, "counters.json");
}
function readCounters(home = handbookHome()) {
  const base = {
    redactionBlocked: 0,
    postToolUse: 0,
    bashFailuresCaptured: 0,
    pairsResolved: 0,
    gateErrors: 0,
    gateAbandoned: 0
  };
  try {
    const parsed = JSON.parse(readFileSync(countersFile(home), "utf8"));
    for (const f of FIELDS) base[f] = Number(parsed?.[f]) || 0;
  } catch {
  }
  return base;
}

// src/lib/config.ts
import { existsSync, readFileSync as readFileSync2 } from "node:fs";
import { join as join3 } from "node:path";
function configFile(home = handbookHome()) {
  return join3(home, "config.json");
}
function readConfigFile(home = handbookHome()) {
  try {
    const parsed = JSON.parse(readFileSync2(configFile(home), "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function configIsBroken(home = handbookHome()) {
  const file = configFile(home);
  if (!existsSync(file)) return false;
  try {
    const parsed = JSON.parse(readFileSync2(file, "utf8"));
    return !(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed));
  } catch {
    return true;
  }
}

// src/lib/score.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);
var defaultScoreConfig = {
  model: "haiku",
  threshold: 7,
  timeoutMs: 6e4
};
function loadScoreConfig(home = handbookHome()) {
  const gate = readConfigFile(home).gate;
  return {
    model: typeof gate?.model === "string" ? gate.model : defaultScoreConfig.model,
    threshold: typeof gate?.threshold === "number" && gate.threshold >= 0 && gate.threshold <= 10 ? gate.threshold : defaultScoreConfig.threshold,
    timeoutMs: typeof gate?.timeoutMs === "number" && gate.timeoutMs > 0 ? gate.timeoutMs : defaultScoreConfig.timeoutMs
  };
}

// src/lib/distill.ts
var defaultDistillConfig = {
  model: "",
  timeoutMs: 12e4
};
function loadDistillConfig(home = handbookHome()) {
  const distill = readConfigFile(home).distill;
  return {
    model: typeof distill?.model === "string" ? distill.model : defaultDistillConfig.model,
    timeoutMs: typeof distill?.timeoutMs === "number" && distill.timeoutMs > 0 ? distill.timeoutMs : defaultDistillConfig.timeoutMs
  };
}
function normalizeRemoteUrl(raw) {
  let s = raw.trim();
  if (!s) return null;
  if (/[\x00-\x1f\x7f]/.test(s)) return null;
  const hadProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  s = s.replace(/^[^@/]+@/, "");
  if (!hadProtocol) {
    const colon = s.indexOf(":");
    const slash2 = s.indexOf("/");
    if (colon > 0 && (slash2 === -1 || colon < slash2)) {
      s = s.slice(0, colon) + "/" + s.slice(colon + 1);
    }
  }
  s = s.replace(/\.git$/i, "").replace(/\/+$/, "");
  const slash = s.indexOf("/");
  if (slash <= 0 || slash === s.length - 1) return null;
  return s.slice(0, slash).toLowerCase() + s.slice(slash);
}

// src/lib/init.ts
function loadTeamConfig(home = handbookHome()) {
  const team = readConfigFile(home).team;
  if (team && typeof team.repoUrl === "string" && typeof team.marketplaceName === "string") {
    return team;
  }
  return null;
}
function hostFromUrl(url) {
  const normalized = normalizeRemoteUrl(url);
  if (!normalized) return null;
  return normalized.slice(0, normalized.indexOf("/"));
}
var CONSUMER_NOTICE_HOOKS = JSON.stringify(
  {
    hooks: {
      SessionStart: [
        { hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/notice.mjs"' }] }
      ]
    }
  },
  null,
  2
);

// src/lib/harvest.ts
var defaultHarvestConfig = {
  enabled: true,
  // Measured, not assumed: on an identical prompt from a real session, haiku
  // proposed the developer's stated rule 1 time in 3 and sonnet 3 in 3. The whole
  // product is "every session teaches it something"; a default that stays silent
  // two thirds of the time fails that. One call per session, and
  // {"harvest": {"model": "haiku"}} is still there for whoever wants it cheaper.
  model: "sonnet",
  maxPerSession: 3,
  minScore: 4,
  transcriptCharCap: 4e4,
  // Latency is dominated by how much the model writes, not by the slice: a 31k-char
  // prompt returning nothing took 9s, a 6k one returning a full skill took 25s. Three
  // items is the cap, so ~75s is the realistic ceiling — and a timeout here does not
  // degrade to a smaller answer, it burns an attempt and can park the session in
  // abandoned.jsonl. This is the value the yield measurement was run at.
  timeoutMs: 18e4
};
function loadHarvestConfig(home = handbookHome()) {
  const harvest = readConfigFile(home).harvest;
  const num = (v, fallback) => typeof v === "number" && v > 0 ? v : fallback;
  return {
    // fail closed on a broken config — see configIsBroken
    enabled: !configIsBroken(home) && harvest?.enabled !== false,
    model: typeof harvest?.model === "string" ? harvest.model : defaultHarvestConfig.model,
    maxPerSession: num(harvest?.maxPerSession, defaultHarvestConfig.maxPerSession),
    minScore: typeof harvest?.minScore === "number" && harvest.minScore >= 0 && harvest.minScore <= 10 ? harvest.minScore : defaultHarvestConfig.minScore,
    transcriptCharCap: num(harvest?.transcriptCharCap, defaultHarvestConfig.transcriptCharCap),
    timeoutMs: num(harvest?.timeoutMs, defaultHarvestConfig.timeoutMs)
  };
}

// src/lib/status.ts
import { readFileSync as readFileSync3 } from "node:fs";
import { dirname, join as join5 } from "node:path";
import { fileURLToPath } from "node:url";

// src/lib/notify.ts
var DIGEST_INTERVAL_MS = 7 * 24 * 60 * 60 * 1e3;

// src/lib/pipeline.ts
import { basename, join as join4 } from "node:path";
var STALE_CLAIM_MS = 10 * 60 * 1e3;
function pipelineLogFile(home = handbookHome()) {
  return join4(home, "pipeline.log");
}
var LOG_ROTATE_BYTES = 512 * 1024;

// src/lib/status.ts
function pluginVersion() {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const up of ["..", "../.."]) {
    try {
      const parsed = JSON.parse(
        readFileSync3(join5(here, up, ".claude-plugin", "plugin.json"), "utf8")
      );
      if (typeof parsed?.version === "string") return parsed.version;
    } catch {
    }
  }
  return "unknown";
}
function lastPipelineRun(home = handbookHome()) {
  let raw;
  try {
    raw = readFileSync3(pipelineLogFile(home), "utf8");
  } catch {
    return null;
  }
  const lines = raw.split("\n").filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (typeof parsed?.ts === "string") return parsed;
    } catch {
    }
  }
  return null;
}

// src/lib/doctor.ts
var runCommand = (cmd, args, timeoutMs) => execFileSync(cmd, args, {
  encoding: "utf8",
  timeout: timeoutMs,
  stdio: ["ignore", "pipe", "pipe"],
  // never let git/ssh block on an interactive prompt; stdin is closed anyway
  env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -oBatchMode=yes" }
}).trim();
function ok(name, detail) {
  return { name, level: "ok", detail };
}
function warn(name, detail) {
  return { name, level: "warn", detail };
}
function fail(name, detail) {
  return { name, level: "fail", detail };
}
function checkNode() {
  const major = Number(process.versions.node.split(".")[0]);
  return major >= 18 ? ok("node", `${process.version} (\u2265 18 required)`) : fail("node", `${process.version} \u2014 TeamHandbook needs Node \u2265 18`);
}
function checkClaudeCli(run, home) {
  try {
    run("claude", ["--version"], 15e3);
  } catch (err) {
    if (err?.code === "ENOENT") {
      return fail(
        "claude CLI",
        "not found on PATH \u2014 the gate and distiller need it; install Claude Code CLI or fix PATH"
      );
    }
    const message = String(err instanceof Error ? err.message : err).split("\n")[0];
    return fail("claude CLI", `found, but \`claude --version\` failed or timed out: ${message}`);
  }
  const harvestModel = loadHarvestConfig(home).model;
  const gateModel = loadScoreConfig(home).model;
  const distillModel = loadDistillConfig(home).model;
  const models = [...new Set([harvestModel, gateModel, distillModel].filter(Boolean))];
  for (const model of models) {
    try {
      const reply = run("claude", ["-p", "Reply with exactly: OK", ...model ? ["--model", model] : []], 3e4);
      if (!/\bok\b/i.test(reply)) {
        return warn("claude CLI", `installed, but a probe with model "${model}" returned an unexpected reply: ${reply.slice(0, 60)}`);
      }
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err);
      const lower = message.toLowerCase();
      if (lower.includes("login") || lower.includes("auth") || lower.includes("logged")) {
        return fail("claude CLI", "installed but NOT logged in \u2014 run `claude` and /login; the gate cannot score until then");
      }
      return fail(
        "claude CLI",
        `logged in, but \`claude -p --model ${model}\` failed \u2014 is that model valid? (config.json harvest.model/gate.model/distill.model): ${(message.split("\n")[0] ?? "").slice(0, 80)}`
      );
    }
  }
  return ok(
    "claude CLI",
    models.length > 1 ? `installed and authenticated (${models.length} configured models reachable)` : "installed and authenticated"
  );
}
function checkGitIdentity(home, run) {
  if (!loadTeamConfig(home)) return null;
  try {
    const email = run("git", ["config", "user.email"], 5e3);
    return email ? ok("git identity", `user.email = ${email}`) : fail("git identity", "git user.email is empty \u2014 team PRs would ship with a junk author; run `git config --global user.email you@example.com`");
  } catch {
    return fail("git identity", "git user.email is not set \u2014 team PRs would ship with a junk author; run `git config --global user.email you@example.com`");
  }
}
function checkHomeWritable(home) {
  const probe = join6(home, `.doctor-probe-${process.pid}`);
  try {
    mkdirSync2(home, { recursive: true });
    writeFileSync2(probe, "ok");
    rmSync(probe, { force: true });
    return ok("state dir", `${home} writable`);
  } catch (err) {
    return fail("state dir", `cannot write ${home}: ${String(err instanceof Error ? err.message : err)}`);
  }
}
function checkConfig(home) {
  const file = join6(home, "config.json");
  if (!existsSync2(file)) return ok("config", "no config.json (defaults apply)");
  try {
    const parsed = JSON.parse(readFileSync4(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return fail(
        "config",
        "config.json is not a JSON object \u2014 automatic harvesting is OFF until it is (the privacy switches fail closed); every other setting falls back to its default"
      );
    }
    return ok("config", "config.json valid");
  } catch {
    return fail(
      "config",
      "config.json is not valid JSON \u2014 automatic harvesting is OFF until it parses (the privacy switches fail closed); every other setting falls back to its default"
    );
  }
}
function checkHooks(home) {
  const counters = readCounters(home);
  if (counters.postToolUse === 0) {
    return warn(
      "hooks",
      "no hook events recorded yet \u2014 run any command in a Claude Code session and re-check; if this stays 0 the hooks are not firing (was the plugin installed and the session restarted?)"
    );
  }
  return ok(
    "hooks",
    `firing \u2014 ${counters.postToolUse} tool calls seen, ${counters.bashFailuresCaptured} failures captured, ${counters.pairsResolved} pairs resolved`
  );
}
function remoteDistributionState(url, run) {
  const dir = mkdtempSync(join6(tmpdir(), "handbook-doctor-"));
  try {
    run("git", ["clone", "--depth", "1", "--single-branch", "--", url, dir], 25e3);
    const version = JSON.parse(readFileSync4(join6(dir, ".claude-plugin", "plugin.json"), "utf8")).version;
    let skillCount = 0;
    try {
      skillCount = readdirSync2(join6(dir, "skills"), { withFileTypes: true }).filter((e) => e.isDirectory()).length;
    } catch {
    }
    return typeof version === "string" ? { version, skillCount } : null;
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function checkTeamRepo(home, run) {
  const team = loadTeamConfig(home);
  if (!team) return ok("team repo", "not configured (solo mode \u2014 that's fine)");
  try {
    run("git", ["ls-remote", "--heads", "--", team.repoUrl], 2e4);
  } catch (err) {
    const message = String(err instanceof Error ? err.message : err).split("\n").slice(-2).join(" | ");
    return fail("team repo", `${team.repoUrl} NOT reachable \u2014 approvals cannot publish (${message})`);
  }
  const dist = remoteDistributionState(team.repoUrl, run);
  if (dist && dist.skillCount > 0 && dist.version === "0.1.0") {
    return warn(
      "team repo",
      `${team.repoUrl} reachable, but ${dist.skillCount} merged skill(s) sit at plugin version 0.1.0 \u2014 the version-bump CI has not run, so teammates are NOT receiving updates (check the TEAMHANDBOOK_CI_TOKEN variable / Actions write permission)`
    );
  }
  return ok("team repo", `${team.repoUrl} reachable`);
}
function checkForge(home, run) {
  const team = loadTeamConfig(home);
  if (!team) return null;
  const tool = (hostFromUrl(team.repoUrl) ?? "").includes("github") ? "gh" : "glab";
  try {
    run(tool, ["auth", "status"], 1e4);
    return ok("forge CLI", `${tool} authenticated \u2014 approvals can auto-open PRs`);
  } catch (err) {
    if (err?.code === "ENOENT") {
      return warn(
        "forge CLI",
        `${tool} not installed \u2014 approvals still push a branch and print a manual PR link; install ${tool} to auto-open PRs`
      );
    }
    return warn(
      "forge CLI",
      `${tool} installed but not authenticated \u2014 run \`${tool} auth login\` (approvals still print a manual link)`
    );
  }
}
function checkLastRun(home) {
  const last = lastPipelineRun(home);
  if (!last) return ok("gate pipeline", "no runs yet (nothing recurred or was captured manually)");
  if (last.errored > 0) {
    const reason = last.outcomes?.filter((o) => o.outcome === "error").at(-1)?.error;
    const why = reason ? ` \u2014 ${reason}` : "";
    return warn(
      "gate pipeline",
      `last run had ${last.errored} error(s)${why} (see the claude CLI check above; full log: ${join6(home, "pipeline.log")})`
    );
  }
  return ok("gate pipeline", `last run ${last.ts}: ${last.written.length} written, ${last.rejected} rejected`);
}
function checkAbandoned(home) {
  const abandoned = readCounters(home).gateAbandoned;
  if (abandoned === 0) return null;
  return warn(
    "abandoned pairs",
    `${abandoned} captured pair(s) were given up after repeated gate failures \u2014 recoverable in ${join6(home, "abandoned.jsonl")} once claude works again`
  );
}
function runDoctor(home = handbookHome(), run = runCommand) {
  const checks = [
    checkNode(),
    checkClaudeCli(run, home),
    checkHomeWritable(home),
    checkConfig(home),
    checkHooks(home),
    checkTeamRepo(home, run)
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
var MARKS = { ok: "\u2714", warn: "\u26A0", fail: "\u2718" };
function formatDoctor(report2) {
  const lines = [`TeamHandbook doctor  (v${report2.version})`, ""];
  for (const check of report2.checks) {
    lines.push(` ${MARKS[check.level]} ${check.name}: ${check.detail}`);
  }
  const counts = { ok: 0, warn: 0, fail: 0 };
  for (const check of report2.checks) counts[check.level] += 1;
  lines.push("", `${counts.ok} ok, ${counts.warn} warning(s), ${counts.fail} problem(s)`);
  if (counts.fail === 0 && counts.warn === 0) lines.push("Everything looks healthy.");
  return lines.join("\n");
}
function doctorExitCode(report2) {
  return report2.checks.some((c) => c.level === "fail") ? 1 : 0;
}

// src/cli/doctor.ts
var report = runDoctor();
console.log(formatDoctor(report));
process.exitCode = doctorExitCode(report);
