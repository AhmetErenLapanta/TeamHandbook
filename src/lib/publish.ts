import { handbookWorkdir } from "./session-state.js";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeRemoteUrl, renameSkillMd, uniqueSlug } from "./distill.js";
import type { GroundedCase } from "./distill.js";
import { assertSafeGitUrl, hostFromUrl, nonInteractiveEnv, runGit } from "./init.js";
import type { GitRunner, TeamConfig } from "./init.js";
import type { CandidateMeta } from "./queue.js";

export type ForgeRunner = (tool: "gh" | "glab", args: string[], cwd: string) => string;

export const FORGE_TIMEOUT_MS = 60_000;

export function runForge(tool: "gh" | "glab", args: string[], cwd: string): string {
  return execFileSync(tool, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env: nonInteractiveEnv(),
    timeout: FORGE_TIMEOUT_MS,
  });
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
): { url: string | null; error?: string } {
  const host = hostFromUrl(repoUrl);
  try {
    const out =
      host && host.includes("github")
        ? forge("gh", ["pr", "create", "--head", branch, "--title", title, "--body", body], repoDir)
        : forge(
            "glab",
            ["mr", "create", "--source-branch", branch, "--title", title, "--description", body, "--yes"],
            repoDir,
          );
    return { url: extractUrl(out) };
  } catch (err) {
    // The branch is already pushed, so this is a soft failure (fall back to a manual
    // link) — but surface WHY, so the user isn't left guessing that gh/glab just
    // needs installing or `gh auth login`.
    const e = err as { code?: string; stderr?: string; message?: string };
    const tool = host && host.includes("github") ? "gh" : "glab";
    let reason: string;
    if (e?.code === "ENOENT") reason = `the ${tool} CLI is not installed`;
    else {
      const stderr = typeof e?.stderr === "string" ? e.stderr.trim() : "";
      reason = (stderr ? stderr.split("\n").at(-1)! : String(e?.message ?? err)).slice(0, 160);
    }
    return { url: null, error: reason };
  }
}

export interface PublishOutcome {
  ok: boolean;
  branch?: string;
  skillDir?: string;
  prUrl?: string;
  manualUrl?: string;
  error?: string;
  // why the forge CLI couldn't auto-open the PR (branch is pushed; link is manual)
  prError?: string;
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
      (s) => existsSync(join(repoDir, "skills", s)) || remoteBranches.has(`handbook/${s}`),
    );
    const branch = `handbook/${slug}`;
    const skillDir = `skills/${slug}`;
    const title = buildPrTitle(slug);
    try {
      git(["checkout", "-b", branch], repoDir);
      mkdirSync(join(repoDir, skillDir), { recursive: true });
      // Keep the SKILL.md name in sync with a suffixed slug so it doesn't shadow
      // the skill it collided with.
      writeFileSync(
        join(repoDir, skillDir, "SKILL.md"),
        slug === meta.slug ? candidateSkillMd : renameSkillMd(candidateSkillMd, slug),
      );
      if (existsSync(join(candidateDir, "grounded-case.json"))) {
        copyFileSync(
          join(candidateDir, "grounded-case.json"),
          join(repoDir, skillDir, "grounded-case.json"),
        );
      }
      git(["add", "-A"], repoDir);
      git([...identityArgs, "commit", "-m", title], repoDir);
      git(["push", "-u", "origin", branch], repoDir);
    } catch (err) {
      return { ok: false, error: `git push failed (branch ${branch}): ${String(err)}` };
    }
    const body = buildPrBody(meta, readGroundedCase(candidateDir));
    const pr = openPr(team.repoUrl, branch, title, body, repoDir, forge);
    if (pr.url) return { ok: true, branch, skillDir, prUrl: pr.url };
    return {
      ok: true,
      branch,
      skillDir,
      manualUrl: manualPrUrl(team.repoUrl, branch) ?? undefined,
      ...(pr.error ? { prError: pr.error } : {}),
    };
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}
