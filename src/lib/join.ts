import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  assertSafeGitUrl,
  BrokenConfigError,
  loadTeamConfig,
  readTeamCommitPrefix,
  runGit,
  saveTeamConfig,
  TEAM_PREFIX_FILE,
} from "./init.js";
import { isSafeSlug } from "./queue.js";
import { configIsBroken } from "./config.js";
import { cloneFailureReason } from "./git-errors.js";
import type { GitRunner } from "./init.js";
import { handbookHome, handbookWorkdir } from "./session-state.js";
import { displayPath } from "./display-path.js";

export interface JoinResult {
  ok: boolean;
  name?: string;
  url?: string;
  home?: string;
  error?: string;
  /** the commit-message prefix the repository records, absent when it records none */
  commitPrefix?: string;
  /** why this machine ends the join without a prefix, when the repository had one to give
   * and it could not be taken. Never empty for a join that learned nothing: a prefix that
   * goes missing silently is the failure this whole path exists to end. */
  prefixNote?: string;
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

// The cap slugifySkillName already truncates to, so nothing /handbook:init can produce
// is refused by the length rule below.
const MARKETPLACE_NAME_MAX = 64;

/**
 * Why this name cannot be the marketplace name, or null when it can.
 *
 * A joined repository belongs to somebody else, and this is one of the two values read
 * out of it (the other is the commit-message prefix, screened by commitPrefixProblem). It goes on to be a path segment (`teamSkillsDir`, and the team `.mcp.json` doctor
 * looks for), a plugin key, and a line of the `/plugin install` instruction join prints
 * for the user to run - so `../` walks out of the marketplace root and a newline writes
 * fabricated instructions into that block, both measured before this guard existed.
 *
 * Refused rather than slugified. `/handbook:init` derives the name with
 * `slugifySkillName`, so a repository scaffolded by it already carries a slug; rewriting
 * one that does not would leave this config naming a marketplace directory that Claude
 * Code never creates, and the breakage would surface later as skills that silently never
 * arrive rather than here, where it can be explained.
 */
export function marketplaceNameProblem(name: string): string | null {
  if (name.length > MARKETPLACE_NAME_MAX) {
    return `longer than ${MARKETPLACE_NAME_MAX} characters`;
  }
  if (!isSafeSlug(name)) {
    return "not a plain name (lowercase letters, digits and dashes, starting with a letter or a digit)";
  }
  return null;
}

/** The rejected name, quoted with JSON escaping so the newlines and ESC that make a name
 * dangerous here cannot survive into the printed refusal. */
function renderRejectedName(name: string): string {
  const shown = name.slice(0, 60);
  return JSON.stringify(shown) + (shown.length < name.length ? " (truncated)" : "");
}

/**
 * Why the clone failed, in the words of someone who can act on it. git already says
 * which of these it is; the first person to hit this got "git clone failed (is the URL
 * correct and reachable?)" with git's own line appended, and had to work the rest out
 * themselves - the URL was right and reachable, they simply had no credentials for a
 * private repository. A handbook repo is private more often than not, so this is the
 * common path, not the edge case.
 */
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
      error: `already joined ${existing.repoUrl}; run /handbook:leave (or edit ${displayPath(join(home, "config.json"))}) to switch teams`,
    };
  }
  const workdir = handbookWorkdir("handbook-join-", home);
  const repoDir = join(workdir, "repo");
  try {
    try {
      git(["clone", "--depth", "1", "--single-branch", "--", url, repoDir], workdir);
    } catch (err) {
      return { ok: false, error: cloneFailureReason(url, err) };
    }
    const name = readMarketplaceName(repoDir);
    if (!name) {
      return {
        ok: false,
        error: "the repository has no .claude-plugin/marketplace.json - is it a TeamHandbook team repo?",
      };
    }
    const problem = marketplaceNameProblem(name);
    if (problem) {
      return {
        ok: false,
        error:
          `the repository's .claude-plugin/marketplace.json names the marketplace ` +
          `${renderRejectedName(name)}, which is ${problem}. That name becomes a directory ` +
          `under ~/.claude/plugins/marketplaces and part of the commands printed here, so ` +
          `TeamHandbook will not join with it. Fix the name in the repository and re-run.`,
      };
    }
    // The second value read out of somebody else's repository, and the reason it is read
    // at all: the commit-message prefix belongs to the forge's push rule, not to the person
    // who ran /handbook:init, so every member needs it and only that one machine was told.
    const recorded = readTeamCommitPrefix(repoDir);
    // An absent prefix is written as an ABSENT key, never as "". commitPrefixIsKnown reads
    // a string - any string - as "this machine knows the answer", so writing "" here would
    // tell a later `/handbook:init --upgrade` on this machine that the team has no prefix
    // and let it offer to regenerate the CI job without one.
    saveTeamConfig(
      {
        ...(existing ?? {}),
        repoUrl: url,
        marketplaceName: name,
        joinedAt: now,
        ...(recorded.prefix !== undefined ? { commitPrefix: recorded.prefix } : {}),
      },
      home,
    );
    return {
      ok: true,
      name,
      url,
      home,
      ...(recorded.prefix ? { commitPrefix: recorded.prefix } : {}),
      ...(recorded.prefix === undefined ? { prefixNote: prefixNote(recorded.problem) } : {}),
    };
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

/**
 * What to say when this join ends without a prefix.
 *
 * Both cases are said rather than passed over, because the cost of saying nothing is paid
 * later by somebody who cannot connect the two events: a teammate whose FIRST share is
 * refused by a commit-message rule this machine could have satisfied. A repository that
 * records no prefix is the ordinary case for a handbook scaffolded before the record
 * existed, so this is a note about what happens next, not a warning about a fault.
 */
function prefixNote(problem: string | undefined): string {
  if (problem) {
    return (
      `The repository's ${TEAM_PREFIX_FILE} names a commit-message prefix TeamHandbook will not ` +
      `use: it is ${problem}. Nothing was taken from it. If your project enforces a commit-message ` +
      "rule, fix that file in the repository; until then a share refused by the rule will say so."
    );
  }
  return (
    `This repository does not record a commit-message prefix (no ${TEAM_PREFIX_FILE}), which is ` +
    "what a handbook scaffolded by an older TeamHandbook looks like. If your project enforces a " +
    "commit-message rule, your first share will be refused by it and the message will name the " +
    "two ways out; whoever ran /handbook:init can record the prefix for everyone with " +
    "`/handbook:init --upgrade`."
  );
}

export function formatJoinSuccess(result: JoinResult): string {
  return [
    `Joined the team skill base at ${result.url}.`,
    "",
    "  engine:  approved skills will now target this repository",
    ...(result.commitPrefix ? [`  commits: titled "${result.commitPrefix} ...", the prefix this repository records`] : []),
    `  config:  team repo saved to ${displayPath(join(result.home ?? "", "config.json"))}`,
    "",
    ...(result.prefixNote ? [result.prefixNote, ""] : []),
    "To finish, connect Claude Code to the team marketplace (built-in commands):",
    "",
    `  /plugin marketplace add ${result.url}`,
    `  /plugin install ${result.name}@${result.name}`,
  ].join("\n");
}
