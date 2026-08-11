import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSafeGitUrl, BrokenConfigError, loadTeamConfig, runGit, saveTeamConfig } from "./init.js";
import { configIsBroken } from "./config.js";
import type { GitRunner } from "./init.js";
import { handbookHome } from "./session-state.js";

export interface JoinResult {
  ok: boolean;
  name?: string;
  url?: string;
  home?: string;
  error?: string;
}

function readMarketplaceName(repoDir: string): string | null {
  try {
    const parsed = JSON.parse(
      readFileSync(join(repoDir, ".claude-plugin", "marketplace.json"), "utf8"),
    );
    return typeof parsed?.name === "string" && parsed.name ? parsed.name : null;
  } catch {
    return null;
  }
}

export function joinTeamRepo(
  url: string,
  home: string = handbookHome(),
  git: GitRunner = runGit,
  now: string = new Date().toISOString(),
): JoinResult {
  if (!url.trim()) return { ok: false, error: "a git URL is required" };
  try {
    assertSafeGitUrl(url);
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err) };
  }
  if (configIsBroken(home)) {
    return { ok: false, error: new BrokenConfigError(home).message };
  }
  const existing = loadTeamConfig(home);
  if (existing && existing.repoUrl !== url) {
    return {
      ok: false,
      error: `already joined ${existing.repoUrl}; run /handbook:leave (or edit ${join(home, "config.json")}) to switch teams`,
    };
  }
  const workdir = mkdtempSync(join(tmpdir(), "handbook-join-"));
  const repoDir = join(workdir, "repo");
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
        error: "the repository has no .claude-plugin/marketplace.json — is it a TeamHandbook team repo?",
      };
    }
    saveTeamConfig(
      {
        ...(existing ?? {}),
        repoUrl: url,
        marketplaceName: name,
        joinedAt: now,
      },
      home,
    );
    return { ok: true, name, url, home };
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

export function formatJoinSuccess(result: JoinResult): string {
  return [
    `Joined the team skill base at ${result.url}.`,
    "",
    "  engine:  approved skills will now target this repository",
    `  config:  team repo saved to ${join(result.home ?? "", "config.json")}`,
    "",
    "To finish, connect Claude Code to the team marketplace (built-in commands):",
    "",
    `  /plugin marketplace add ${result.url}`,
    `  /plugin install ${result.name}@${result.name}`,
  ].join("\n");
}
