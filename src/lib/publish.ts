import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeRemoteUrl, renameSkillMd, uniqueSlug } from "./distill.js";
import type { GroundedCase } from "./distill.js";
import { assertSafeGitUrl, hostFromUrl, runGit } from "./init.js";
import type { GitRunner, TeamConfig } from "./init.js";
import type { CandidateMeta } from "./queue.js";

export type ForgeRunner = (tool: "gh" | "glab", args: string[], cwd: string) => string;

export function runForge(tool: "gh" | "glab", args: string[], cwd: string): string {
  return execFileSync(tool, args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
}

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
  if (grounded) {
    lines.push(
      "",
      "## Grounded case",
      "",
      "This skill was distilled from a real error-to-fix session; the case below ships with it",
      "as its regression gate.",
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

export function manualPrUrl(repoUrl: string, branch: string): string | null {
  const normalized = normalizeRemoteUrl(repoUrl);
  if (!normalized) return null;
  const host = hostFromUrl(repoUrl);
  if (host && host.includes("github")) {
    return `https://${normalized}/pull/new/${branch}`;
  }
  return `https://${normalized}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encodeURIComponent(branch)}`;
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

function extractUrl(output: string): string | null {
  return output.match(/https?:\/\/\S+/)?.[0] ?? null;
}

function openPr(
  repoUrl: string,
  branch: string,
  title: string,
  body: string,
  repoDir: string,
  forge: ForgeRunner,
): string | null {
  const host = hostFromUrl(repoUrl);
  try {
    if (host && host.includes("github")) {
      return extractUrl(forge("gh", ["pr", "create", "--head", branch, "--title", title, "--body", body], repoDir));
    }
    return extractUrl(
      forge(
        "glab",
        ["mr", "create", "--source-branch", branch, "--title", title, "--description", body, "--yes"],
        repoDir,
      ),
    );
  } catch {
    return null;
  }
}

export interface PublishOutcome {
  ok: boolean;
  branch?: string;
  skillDir?: string;
  prUrl?: string;
  manualUrl?: string;
  error?: string;
}

export function publishCandidate(
  candidateDir: string,
  meta: CandidateMeta,
  team: TeamConfig,
  git: GitRunner = runGit,
  forge: ForgeRunner = runForge,
): PublishOutcome {
  try {
    assertSafeGitUrl(team.repoUrl);
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err) };
  }
  const workdir = mkdtempSync(join(tmpdir(), "handbook-publish-"));
  const repoDir = join(workdir, "repo");
  try {
    try {
      git(["clone", "--depth", "1", "--", team.repoUrl, repoDir], workdir);
    } catch (err) {
      return { ok: false, error: `git clone failed (is the team repo reachable?): ${String(err)}` };
    }
    const slug = uniqueSlug(meta.slug, (s) => existsSync(join(repoDir, "skills", s)));
    const branch = `handbook/${slug}`;
    const skillDir = `skills/${slug}`;
    const title = buildPrTitle(slug);
    try {
      git(["checkout", "-b", branch], repoDir);
      mkdirSync(join(repoDir, skillDir), { recursive: true });
      // Keep the SKILL.md name in sync with a suffixed slug so it doesn't shadow
      // the skill it collided with.
      const skillMd = readFileSync(join(candidateDir, "SKILL.md"), "utf8");
      writeFileSync(
        join(repoDir, skillDir, "SKILL.md"),
        slug === meta.slug ? skillMd : renameSkillMd(skillMd, slug),
      );
      if (existsSync(join(candidateDir, "grounded-case.json"))) {
        copyFileSync(
          join(candidateDir, "grounded-case.json"),
          join(repoDir, skillDir, "grounded-case.json"),
        );
      }
      git(["add", "-A"], repoDir);
      git(["commit", "-m", title], repoDir);
      git(["push", "-u", "origin", branch], repoDir);
    } catch (err) {
      return { ok: false, error: `git push failed (branch ${branch}): ${String(err)}` };
    }
    const body = buildPrBody(meta, readGroundedCase(candidateDir));
    const prUrl = openPr(team.repoUrl, branch, title, body, repoDir, forge);
    if (prUrl) return { ok: true, branch, skillDir, prUrl };
    return {
      ok: true,
      branch,
      skillDir,
      manualUrl: manualPrUrl(team.repoUrl, branch) ?? undefined,
    };
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}
