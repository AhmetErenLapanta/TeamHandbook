// src/lib/join.ts
import { mkdtempSync, readFileSync as readFileSync2, rmSync as rmSync2 } from "node:fs";
import { tmpdir } from "node:os";
import { join as join4 } from "node:path";

// src/lib/init.ts
import { execFileSync } from "node:child_process";
import { dirname as dirname2, join as join3 } from "node:path";

// src/lib/session-state.ts
import { homedir } from "node:os";
import { join } from "node:path";

// src/lib/fs-atomic.ts
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
var seq = 0;
function writeFileAtomic(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${seq++}-${process.hrtime.bigint().toString(36)}`;
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

// src/lib/session-state.ts
var EDIT_ATTACH_WINDOW_MS = 15 * 60 * 1e3;
function handbookHome() {
  return process.env.TEAMHANDBOOK_HOME ?? join(homedir(), ".teamhandbook");
}
var SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1e3;

// src/lib/config.ts
import { readFileSync } from "node:fs";
import { join as join2 } from "node:path";
function readConfigFile(home = handbookHome()) {
  try {
    const parsed = JSON.parse(readFileSync(join2(home, "config.json"), "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// src/lib/score.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);

// src/lib/init.ts
var REMOTE_HELPER = /^[A-Za-z][A-Za-z0-9+.-]*::/;
function assertSafeGitUrl(url) {
  const u = url.trim();
  if (!u || u.startsWith("-") || REMOTE_HELPER.test(u) || /[\r\n\0]/.test(u)) {
    throw new Error(`unsafe or unsupported git URL: ${url}`);
  }
}
function loadTeamConfig(home = handbookHome()) {
  const team = readConfigFile(home).team;
  if (team && typeof team.repoUrl === "string" && typeof team.marketplaceName === "string") {
    return team;
  }
  return null;
}
function saveTeamConfig(team, home = handbookHome()) {
  const config = readConfigFile(home);
  config.team = team;
  writeFileAtomic(join3(home, "config.json"), JSON.stringify(config, null, 2) + "\n");
}
function runGit(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  } catch (err) {
    const stderr = err?.stderr;
    if (typeof stderr === "string" && stderr.trim()) {
      const tail = stderr.trim().split("\n").slice(-3).join(" | ");
      throw new Error(`git ${args[0]} failed: ${tail}`);
    }
    throw err;
  }
}

// src/lib/join.ts
function readMarketplaceName(repoDir) {
  try {
    const parsed = JSON.parse(
      readFileSync2(join4(repoDir, ".claude-plugin", "marketplace.json"), "utf8")
    );
    return typeof parsed?.name === "string" && parsed.name ? parsed.name : null;
  } catch {
    return null;
  }
}
function joinTeamRepo(url, home = handbookHome(), git = runGit, now = (/* @__PURE__ */ new Date()).toISOString()) {
  if (!url.trim()) return { ok: false, error: "a git URL is required" };
  try {
    assertSafeGitUrl(url);
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err) };
  }
  const existing = loadTeamConfig(home);
  if (existing && existing.repoUrl !== url) {
    return {
      ok: false,
      error: `already joined ${existing.repoUrl}; edit config.json to switch teams`
    };
  }
  const workdir = mkdtempSync(join4(tmpdir(), "handbook-join-"));
  const repoDir = join4(workdir, "repo");
  try {
    try {
      git(["clone", "--depth", "1", "--single-branch", "--", url, repoDir], workdir);
    } catch (err) {
      return { ok: false, error: `git clone failed (is the URL correct and reachable?): ${String(err)}` };
    }
    const name = readMarketplaceName(repoDir);
    if (!name) {
      return {
        ok: false,
        error: "the repository has no .claude-plugin/marketplace.json \u2014 is it a TeamHandbook team repo?"
      };
    }
    saveTeamConfig(
      {
        ...existing ?? {},
        repoUrl: url,
        marketplaceName: name,
        joinedAt: now
      },
      home
    );
    return { ok: true, name, url, home };
  } finally {
    rmSync2(workdir, { recursive: true, force: true });
  }
}
function formatJoinSuccess(result) {
  return [
    `Joined the team skill base at ${result.url}.`,
    "",
    "  engine:  approved skills will now target this repository",
    `  config:  team repo saved to ${join4(result.home ?? "", "config.json")}`,
    "",
    "To finish, connect Claude Code to the team marketplace (built-in commands):",
    "",
    `  /plugin marketplace add ${result.url}`,
    `  /plugin install ${result.name}`
  ].join("\n");
}

// src/cli/join.ts
function usage() {
  console.error("usage: join.js <git-url>");
  process.exit(2);
}
function main() {
  const [url, extra] = process.argv.slice(2);
  if (!url || extra) usage();
  const result = joinTeamRepo(url);
  if (!result.ok) {
    console.error(`error: ${result.error}`);
    process.exit(1);
  }
  console.log(formatJoinSuccess(result));
}
main();
