// src/lib/join.ts
import { mkdtempSync as mkdtempSync2, readFileSync as readFileSync2, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as join3 } from "node:path";

// src/lib/init.ts
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join as join2 } from "node:path";

// src/lib/session-state.ts
import { homedir } from "node:os";
import { join } from "node:path";
function handbookHome() {
  return process.env.TEAMHANDBOOK_HOME ?? join(homedir(), ".teamhandbook");
}

// src/lib/score.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);

// src/lib/init.ts
function loadTeamConfig(home = handbookHome()) {
  try {
    const parsed = JSON.parse(readFileSync(join2(home, "config.json"), "utf8"));
    const team = parsed?.team;
    if (typeof team?.repoUrl === "string" && typeof team?.marketplaceName === "string") {
      return team;
    }
  } catch {
  }
  return null;
}
function saveTeamConfig(team, home = handbookHome()) {
  let config = {};
  try {
    const parsed = JSON.parse(readFileSync(join2(home, "config.json"), "utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) config = parsed;
  } catch {
  }
  config.team = team;
  mkdirSync(home, { recursive: true });
  writeFileSync(join2(home, "config.json"), JSON.stringify(config, null, 2) + "\n");
}
function runGit(args, cwd) {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
}

// src/lib/join.ts
function readMarketplaceName(repoDir) {
  try {
    const parsed = JSON.parse(
      readFileSync2(join3(repoDir, ".claude-plugin", "marketplace.json"), "utf8")
    );
    return typeof parsed?.name === "string" && parsed.name ? parsed.name : null;
  } catch {
    return null;
  }
}
function joinTeamRepo(url, home = handbookHome(), git = runGit, now = (/* @__PURE__ */ new Date()).toISOString()) {
  if (!url.trim()) return { ok: false, error: "a git URL is required" };
  const existing = loadTeamConfig(home);
  if (existing && existing.repoUrl !== url) {
    return {
      ok: false,
      error: `already joined ${existing.repoUrl}; edit config.json to switch teams`
    };
  }
  const workdir = mkdtempSync2(join3(tmpdir(), "handbook-join-"));
  const repoDir = join3(workdir, "repo");
  try {
    try {
      git(["clone", "--depth", "1", url, repoDir], workdir);
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
    rmSync(workdir, { recursive: true, force: true });
  }
}
function formatJoinSuccess(result) {
  return [
    `Joined the team skill base at ${result.url}.`,
    "",
    "  engine:  approved skills will now target this repository",
    `  config:  team repo saved to ${join3(result.home ?? "", "config.json")}`,
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
