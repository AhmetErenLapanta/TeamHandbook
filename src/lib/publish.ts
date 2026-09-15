import { handbookWorkdir } from "./session-state.js";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeRemoteUrl, renameSkillMd, uniqueSlug } from "./distill.js";
import { copySkillPayload } from "./skill-files.js";
import type { GroundedCase } from "./distill.js";
import { assertSafeGitUrl, pushFailureReason, runGit, teamBranchPrefix, teamCommitPrefix } from "./init.js";
import { hostFromUrl, manualPrUrl, openPr, runForge } from "./forge.js";
import type { ForgeRunner } from "./forge.js";
export { manualPrUrl, runForge } from "./forge.js";
export type { ForgeRunner } from "./forge.js";
import type { GitRunner, TeamConfig } from "./init.js";
import type { CandidateMeta } from "./queue.js";

export function buildPrTitle(slug: string): string {
  return `feat(skill): add ${slug}`;
}

export function buildPrBody(meta: CandidateMeta, grounded: GroundedCase | null): string {
  const lines = [
    meta.description,
    "",
    `- scope: \`${meta.scope}\``,
    `- gate score: ${meta.gate ? `${meta.gate.total}/10` : "n/a"}`,
  ];
  if (meta.gate) {
    const scores = Object.entries(meta.gate.scores)
      .map(([criterion, score]) => `${criterion} ${score}`)
      .join(", ");
    if (scores) lines.push(`- criteria: ${scores}`);
  }
  if (grounded && grounded.task) {
    lines.push(
      "",
      "## Grounded case",
      "",
      "This skill was distilled from a real completed task. The case below ships with it as",
      "the evidence to review it against — nothing re-runs it automatically.",
      "",
      `- goal: ${grounded.task.goal}`,
      ...grounded.task.steps.map((s, i) => `- step ${i + 1}: ${s}`),
      `- verified by: ${grounded.task.verification ?? "(not recorded)"}`,
      `- files touched: ${grounded.edits.join(", ") || "(none)"}`,
      `- expect: ${grounded.expect}`,
    );
  } else if (grounded) {
    lines.push(
      "",
      "## Grounded case",
      "",
      "This skill was distilled from a real error-to-fix session. The case below ships with",
      "it as the evidence to review it against — nothing re-runs it automatically.",
      "",
      `- failed command: \`${grounded.command}\``,
      `- error (normalized): \`${grounded.error}\``,
      `- resolving command: ${grounded.resolvedCommand ? `\`${grounded.resolvedCommand}\`` : "(none recorded)"}`,
      `- files edited for the fix: ${grounded.edits.join(", ") || "(none)"}`,
      `- expect: ${grounded.expect}`,
    );
  }
  lines.push("", "---", "Opened by TeamHandbook after human approval of the candidate.");
  return lines.join("\n");
}

function readGroundedCase(candidateDir: string): GroundedCase | null {
  try {
    const parsed = JSON.parse(readFileSync(join(candidateDir, "grounded-case.json"), "utf8"));
    if (
      typeof parsed?.command === "string" &&
      typeof parsed?.error === "string" &&
      typeof parsed?.expect === "string" &&
      Array.isArray(parsed?.edits)
    ) {
      return parsed;
    }
  } catch {
    // fall through
  }
  return null;
}

export interface PublishOutcome {
  ok: boolean;
  branch?: string;
  skillDir?: string;
  // the version this request raises the plugin to, which is what makes teammates fetch
  version?: string;
  prUrl?: string;
  manualUrl?: string;
  // the branch prefix this push had to discover because the forge refused the default
  // one; the caller persists it so no later skill pays the same round trip
  learnedBranchPrefix?: string;
  error?: string;
  // why the forge CLI couldn't auto-open the PR (branch is pushed; link is manual)
  prError?: string;
}

/**
 * Raise the plugin version in the same request as the skill.
 *
 * The version string is Claude Code's only signal that a plugin moved: without a new
 * one, a merged skill sits in the repository and no teammate's copy ever fetches it.
 * That used to be CI's job, which meant a token with write access, permission to push
 * to a protected default branch, and a commit made on the server under whatever rules
 * the organisation enforces — three things to get right before anyone receives
 * anything, and nothing to warn you when they were not. Bumping it here costs nothing,
 * arrives atomically with the skill it belongs to, and gets reviewed alongside it.
 *
 * Best-effort by design: a repository whose scaffold has not been merged yet has no
 * plugin.json, and a skill is still worth publishing.
 */
export function bumpPluginVersion(repoDir: string): string | null {
  const file = join(repoDir, ".claude-plugin", "plugin.json");
  try {
    const plugin = JSON.parse(readFileSync(file, "utf8"));
    const parts = String(plugin.version ?? "0.1.0").split(".").map(Number);
    if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
    parts[2] = (parts[2] ?? 0) + 1;
    plugin.version = parts.join(".");
    writeFileSync(file, JSON.stringify(plugin, null, 2) + "\n");
    return plugin.version;
  } catch {
    return null;
  }
}

// A forge that polices branch names quotes its rule when it refuses one. Patterns are
// short; anything longer is not a naming rule we can reason about, and building a
// RegExp out of it is not worth the risk.
const MAX_BRANCH_PATTERN_CHARS = 200;

/**
 * The branch to retry with after a forge rejected the branch NAME, or null when there
 * is nothing to derive one from.
 *
 * This is not a guess. A group that polices branch names almost always polices commit
 * messages too, so the team already answered this question during /handbook:init and
 * had the answer accepted by the same server — it is sitting in the config as
 * commitPrefix. And the rejection quotes the pattern, so the derived name is checked
 * against it before anything is pushed: if it does not match, we do not push it and the
 * developer gets the rule instead. The alternative was sending them to hand-edit
 * ~/.teamhandbook/config.json, which is a file a sandboxed session may not be allowed
 * to touch at all.
 */
export function retryBranchAfterNameRejection(
  err: unknown,
  team: TeamConfig,
  slug: string,
): { branch: string; prefix: string } | null {
  const raw = String(err instanceof Error ? err.message : err);
  if (/commit message/i.test(raw)) return null; // a different rule, a different knob
  const pattern = raw.match(/does not follow the pattern\s*'([^']+)'/)?.[1];
  if (!pattern || pattern.length > MAX_BRANCH_PATTERN_CHARS) return null;
  const commitPrefix = team.commitPrefix?.trim().replace(/-+$/, "");
  if (!commitPrefix) return null;
  const prefix = `${commitPrefix}-`;
  const branch = `${prefix}${slug}`;
  try {
    if (!new RegExp(pattern).test(branch)) return null;
  } catch {
    return null; // not a regex we can evaluate; report the rule instead of guessing
  }
  return { branch, prefix };
}

export function publishCandidate(
  candidateDir: string,
  meta: CandidateMeta,
  team: TeamConfig,
  git: GitRunner = runGit,
  forge: ForgeRunner = runForge,
): PublishOutcome {
  const prefix = teamBranchPrefix(team);
  const commitPrefix = teamCommitPrefix(team);
  try {
    assertSafeGitUrl(team.repoUrl);
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err) };
  }
  // read the artifact before any git work: a corrupted candidate must surface as
  // its own error, not masquerade as "git push failed"
  let candidateSkillMd: string;
  try {
    candidateSkillMd = readFileSync(join(candidateDir, "SKILL.md"), "utf8");
  } catch {
    return { ok: false, error: `candidate SKILL.md is missing or unreadable in ${candidateDir}` };
  }
  // Preflight the git identity. The PR commit runs inside the freshly cloned team
  // repo, which inherits neither the user's per-repo local identity nor (if unset)
  // any global one, so validating the current repo's identity is not enough — we
  // capture the ambient name+email here and pin them onto the commit with -c. Git
  // needs BOTH, so an unset name is as fatal as an unset email. `git config` exits
  // non-zero when a key is unset (→ throw); a runner that doesn't capture stdout
  // returns undefined, in which case we can't tell and proceed without pinning.
  const readIdentity = (key: string): string | void => {
    try {
      return git(["config", key], process.cwd());
    } catch {
      return "";
    }
  };
  const email = readIdentity("user.email");
  const name = readIdentity("user.name");
  const unset = (v: string | void): boolean => typeof v === "string" && v.trim() === "";
  if (unset(email) || unset(name)) {
    return {
      ok: false,
      error:
        "git user.name/user.email is not set — the PR would have a junk author. Run " +
        "`git config --global user.name \"Your Name\"` and `git config --global user.email you@example.com`, then approve again.",
    };
  }
  const identityArgs =
    typeof name === "string" && name.trim() !== "" && typeof email === "string" && email.trim() !== ""
      ? ["-c", `user.name=${name.trim()}`, "-c", `user.email=${email.trim()}`]
      : [];
  const workdir = handbookWorkdir("handbook-publish-");
  const repoDir = join(workdir, "repo");
  try {
    try {
      git(["clone", "--depth", "1", "--", team.repoUrl, repoDir], workdir);
    } catch (err) {
      return { ok: false, error: `git clone failed (is the team repo reachable?): ${String(err)}` };
    }
    // A previous approve may have pushed handbook/<slug> whose PR is still open
    // (or was abandoned): the skills/ dir check alone would reuse that branch name
    // and the push would be rejected non-fast-forward, locking the slug forever.
    // Suffix past remote branches too.
    let remoteBranches = new Set<string>();
    try {
      const out = git(["ls-remote", "--heads", "origin"], repoDir);
      remoteBranches = new Set(
        String(out ?? "")
          .split("\n")
          .map((line) => line.split("\t")[1] ?? "")
          .filter(Boolean)
          .map((ref) => ref.replace("refs/heads/", "")),
      );
    } catch {
      // offline check is best-effort; the push itself still reports failures
    }
    const slug = uniqueSlug(
      meta.slug,
      (s) => existsSync(join(repoDir, "skills", s)) || remoteBranches.has(`${prefix}${s}`),
    );
    let branch = `${prefix}${slug}`;
    let learnedBranchPrefix: string | undefined;
    let version: string | null = null;
    const skillDir = `skills/${slug}`;
    const title = buildPrTitle(slug);
    try {
      git(["checkout", "-b", branch], repoDir);
      // Keep the SKILL.md name in sync with a suffixed slug so it doesn't shadow
      // the skill it collided with. Everything else the candidate carries goes with
      // it: a skill whose scripts and references were left behind is a skill the
      // reviewer approves and the teammate cannot run.
      copySkillPayload(
        candidateDir,
        join(repoDir, skillDir),
        slug === meta.slug ? candidateSkillMd : renameSkillMd(candidateSkillMd, slug),
      );
      version = bumpPluginVersion(repoDir);
      git(["add", "-A"], repoDir);
      git([...identityArgs, "commit", "-m", `${commitPrefix}${title}`], repoDir);
      try {
        git(["push", "-u", "origin", branch], repoDir);
      } catch (err) {
        // The default branch name is the one thing here the team never chose. If the
        // forge refuses it, recover from what they did choose rather than failing and
        // asking them to configure something first.
        const retry = retryBranchAfterNameRejection(err, team, slug);
        // uniqueSlug picked this slug against the DEFAULT prefix, so it cannot have
        // ruled out a collision under the derived one. Refusing to push is the safe
        // half; the other half is that the message the developer then gets — set
        // branchPrefix and approve again — is also the fix, because the next run picks
        // the slug against the right names and suffixes past it.
        if (!retry || remoteBranches.has(retry.branch)) throw err;
        git(["branch", "-m", retry.branch], repoDir);
        git(["push", "-u", "origin", retry.branch], repoDir);
        branch = retry.branch;
        learnedBranchPrefix = retry.prefix;
      }
    } catch (err) {
      return {
        ok: false,
        error: pushFailureReason(
          team.repoUrl,
          branch,
          err,
          'Set "branchPrefix" under "team" in ~/.teamhandbook/config.json to a prefix that fits ' +
            '(for example "TEAM-1-"), then approve again; it is remembered for every skill after that.',
        ),
      };
    }
    const body = buildPrBody(meta, readGroundedCase(candidateDir));
    const learned = learnedBranchPrefix ? { learnedBranchPrefix } : {};
    const pr = openPr(team.repoUrl, branch, title, body, repoDir, forge);
    if (pr.url) {
      return { ok: true, branch, skillDir, prUrl: pr.url, ...(version ? { version } : {}), ...learned };
    }
    return {
      ok: true,
      branch,
      skillDir,
      manualUrl: manualPrUrl(team.repoUrl, branch) ?? undefined,
      ...(version ? { version } : {}),
      ...(pr.error ? { prError: pr.error } : {}),
      ...learned,
    };
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}
