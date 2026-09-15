import { handbookWorkdir } from "./session-state.js";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeRemoteUrl, renameSkillMd, uniqueSlug } from "./distill.js";
import type { GroundedCase } from "./distill.js";
import { assertSafeGitUrl, pushFailureReason, runGit, teamBranchPrefix, teamCommitPrefix } from "./init.js";
import { hostFromUrl, manualPrUrl, openPr, runForge } from "./forge.js";
import type { ForgeRunner } from "./forge.js";
export { manualPrUrl, runForge } from "./forge.js";
export type { ForgeRunner } from "./forge.js";
import type { GitRunner, TeamConfig } from "./init.js";
import type { CandidateMeta } from "./queue.js";
import { auditServer, mergeServerIntoMcpJson, refusalMessage } from "./mcp.js";
import type { McpAudit, McpServerEntry } from "./mcp.js";
import { slugifySkillName } from "./distill.js";

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

/**
 * The ambient git identity, ready to be pinned onto a commit with -c.
 *
 * The commit runs inside a freshly cloned team repo, which inherits neither the user's
 * per-repo local identity nor (if unset) any global one, so validating the current repo's
 * identity is not enough: we capture the ambient name+email here and pin them. Git needs
 * BOTH, so an unset name is as fatal as an unset email. `git config` exits non-zero when a
 * key is unset (-> throw); a runner that does not capture stdout returns undefined, in
 * which case we cannot tell and proceed without pinning.
 */
function resolveGitIdentity(git: GitRunner): { args: string[] } | { error: string } {
  const read = (key: string): string | void => {
    try {
      return git(["config", key], process.cwd());
    } catch {
      return "";
    }
  };
  const email = read("user.email");
  const name = read("user.name");
  const unset = (v: string | void): boolean => typeof v === "string" && v.trim() === "";
  if (unset(email) || unset(name)) {
    return {
      error:
        "git user.name/user.email is not set - the PR would have a junk author. Run " +
        "`git config --global user.name \"Your Name\"` and `git config --global user.email you@example.com`, then approve again.",
    };
  }
  return {
    args:
      typeof name === "string" && name.trim() !== "" && typeof email === "string" && email.trim() !== ""
        ? ["-c", `user.name=${name.trim()}`, "-c", `user.email=${email.trim()}`]
        : [],
  };
}

function cloneTeamRepo(git: GitRunner, repoUrl: string, repoDir: string, workdir: string): string | null {
  try {
    git(["clone", "--depth", "1", "--", repoUrl, repoDir], workdir);
    return null;
  } catch (err) {
    return `git clone failed (is the team repo reachable?): ${String(err)}`;
  }
}

/**
 * The branch names the team repo already has.
 *
 * A previous approve may have pushed a branch whose PR is still open (or was abandoned):
 * checking only what is committed would reuse that name and the push would be rejected
 * non-fast-forward, locking the slug forever. Best-effort - an offline failure here costs
 * nothing, because the push itself still reports what went wrong.
 */
function listRemoteBranches(git: GitRunner, repoDir: string): Set<string> {
  try {
    const out = git(["ls-remote", "--heads", "origin"], repoDir);
    return new Set(
      String(out ?? "")
        .split("\n")
        .map((line) => line.split("\t")[1] ?? "")
        .filter(Boolean)
        .map((ref) => ref.replace("refs/heads/", "")),
    );
  } catch {
    return new Set<string>();
  }
}

/**
 * Push the branch, and if the forge refuses the NAME, retry under the prefix the team
 * already proved acceptable to this server.
 *
 * The default branch name is the one thing here the team never chose. If the forge refuses
 * it, recover from what they did choose rather than failing and asking them to configure
 * something first. The caller's slug was made unique against the DEFAULT prefix, so it
 * cannot have ruled out a collision under the derived one: refusing to push is the safe
 * half, and the other half is that the message the developer then gets - set branchPrefix
 * and try again - is also the fix, because the next run picks the name against the right
 * prefix and suffixes past it.
 */
function pushBranch(
  git: GitRunner,
  repoDir: string,
  branch: string,
  team: TeamConfig,
  slug: string,
  remoteBranches: Set<string>,
): { branch: string; learnedBranchPrefix?: string } {
  try {
    git(["push", "-u", "origin", branch], repoDir);
    return { branch };
  } catch (err) {
    const retry = retryBranchAfterNameRejection(err, team, slug);
    if (!retry || remoteBranches.has(retry.branch)) throw err;
    git(["branch", "-m", retry.branch], repoDir);
    git(["push", "-u", "origin", retry.branch], repoDir);
    return { branch: retry.branch, learnedBranchPrefix: retry.prefix };
  }
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
  const identity = resolveGitIdentity(git);
  if ("error" in identity) return { ok: false, error: identity.error };
  const identityArgs = identity.args;
  const workdir = handbookWorkdir("handbook-publish-");
  const repoDir = join(workdir, "repo");
  try {
    const cloneError = cloneTeamRepo(git, team.repoUrl, repoDir, workdir);
    if (cloneError) return { ok: false, error: cloneError };
    // A previous approve may have pushed handbook/<slug> whose PR is still open
    // (or was abandoned): the skills/ dir check alone would reuse that branch name
    // and the push would be rejected non-fast-forward, locking the slug forever.
    // Suffix past remote branches too.
    const remoteBranches = listRemoteBranches(git, repoDir);
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
      version = bumpPluginVersion(repoDir);
      git(["add", "-A"], repoDir);
      git([...identityArgs, "commit", "-m", `${commitPrefix}${title}`], repoDir);
      const pushed = pushBranch(git, repoDir, branch, team, slug, remoteBranches);
      branch = pushed.branch;
      learnedBranchPrefix = pushed.learnedBranchPrefix;
    } catch (err) {
      return {
        ok: false,
        error: pushFailureReason(
          team.repoUrl,
          branch,
          err,
          'Set "branchPrefix" under "team" in ~/.teamhandbook/config.json to a prefix that fits ' +
            '(for example "HEM-1-"), then approve again; it is remembered for every skill after that.',
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


// ---------------------------------------------------------------------------
// Sharing an MCP server with the team.
//
// Same repository, same merge request, same version signal as a skill: what widens is
// the KIND of thing that travels. A skill is inert markdown; an MCP server is a
// connection - and for a stdio one, a process that starts on every teammate's machine
// the moment the plugin is enabled. That is why the PR body below spells out the full
// command, and why a server carrying a literal credential is refused before this file
// touches git at all.
// ---------------------------------------------------------------------------

/** The file a plugin declares its MCP servers in. See mergeServerIntoMcpJson for why. */
export const TEAM_MCP_FILE = ".mcp.json";

export interface McpPublishOutcome {
  ok: boolean;
  serverName?: string;
  branch?: string;
  // the version this request raises the plugin to, which is what makes teammates fetch
  version?: string;
  prUrl?: string;
  manualUrl?: string;
  learnedBranchPrefix?: string;
  // variables each teammate must set before the server will start for them
  requiresEnv?: string[];
  startsProcess?: boolean;
  error?: string;
  prError?: string;
}

export function buildMcpPrTitle(name: string): string {
  return `feat(mcp): add ${name}`;
}

/**
 * The PR body a reviewer needs in order to approve this knowingly.
 *
 * A skill's merge request can be reviewed by reading the skill. An MCP server's cannot:
 * the consequence of merging is that something connects, or runs, on every machine
 * subscribed to this plugin. So the transport, the endpoint or the EXACT command with its
 * arguments, and every environment variable the teammate must supply are stated here in
 * full. The reviewer's merge is the team's consent, and consent needs the facts.
 */
export function buildMcpPrBody(entry: McpServerEntry, audit: McpAudit): string {
  const config = entry.config;
  const lines = [
    `Adds the \`${entry.name}\` MCP server to this plugin. Once this is merged, every`,
    "teammate whose copy refreshes has it connected: nobody installs or configures anything.",
    "",
    `- server: \`${entry.name}\``,
    `- transport: \`${audit.transport}\``,
  ];
  if (typeof config.url === "string") lines.push(`- endpoint: \`${config.url}\``);
  if (audit.startsProcess) {
    const args = Array.isArray(config.args) ? config.args.map(String) : [];
    lines.push(
      `- command: \`${String(config.command)}${args.length ? ` ${args.join(" ")}` : ""}\``,
      "",
      "## This one starts a process",
      "",
      "Enabling the plugin runs that command on every teammate's machine, with their",
      "privileges, for as long as the session lasts. Review it the way you would review a",
      "dependency you are adding, not the way you would review a document.",
    );
  }
  // State the check, never the conclusion. An earlier version of this section promised
  // outright that no credential travelled, which was a guarantee wider than anything
  // actually verified: a provider that embeds the token in the endpoint (Zapier, Composio,
  // Smithery) sailed through, and the reviewer read a written assurance over the top of the
  // credential itself. Human review was the one compensating control here, and a sentence
  // that tells the reviewer not to look is worse than no sentence at all.
  lines.push(
    "",
    "## What was checked",
    "",
    "Every value in `headers` and `env` is a plain ${VAR} reference rather than a literal, so",
    "no credential travels in those fields. The endpoint was also scanned for an embedded",
    "token and none was found.",
  );
  if (audit.requiresEnv.length) {
    lines.push(
      "",
      `Each teammate supplies these from their own environment: ${audit.requiresEnv.map((v) => `\`${v}\``).join(", ")}.` +
        " Until they do, the server will not start for them.",
    );
  }
  lines.push(
    "",
    "That is the whole of the check, and it is a narrower claim than \"this definition holds",
    "no secret\": the endpoint scan is a heuristic, and a credential passed in `args` is not",
    "checked at all. Read the endpoint and the command above before merging.",
    "",
    "---",
    "Opened by TeamHandbook at the explicit request of whoever ran the command.",
  );
  return lines.join("\n");
}

/**
 * Write the chosen server into the team repository as a merge request that also raises the
 * plugin version, so a merge reaches everyone the same way a skill does.
 *
 * Nothing here reads ~/.claude.json and nothing writes it: the caller hands over one entry
 * it already read, and the manager's own local server is left exactly as it was.
 */
export function publishMcpServer(
  entry: McpServerEntry,
  team: TeamConfig,
  git: GitRunner = runGit,
  forge: ForgeRunner = runForge,
): McpPublishOutcome {
  // FIRST, before assertSafeGitUrl and before the identity preflight, because those call
  // git. A refusal has to happen while the credential still exists nowhere but this
  // process: not in a clone, not in an index, not in a working tree that a later crash
  // could leave behind. The order of these lines is the boundary.
  const audit = auditServer(entry.config);
  if (!audit.migratable) {
    return { ok: false, serverName: entry.name, error: refusalMessage(entry.name, audit) };
  }
  try {
    assertSafeGitUrl(team.repoUrl);
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err) };
  }
  const base = slugifySkillName(entry.name);
  if (!base) {
    return { ok: false, error: `cannot derive a branch name from the server name "${entry.name}"` };
  }
  const identity = resolveGitIdentity(git);
  if ("error" in identity) return { ok: false, error: identity.error };
  const prefix = teamBranchPrefix(team);
  const commitPrefix = teamCommitPrefix(team);
  const workdir = handbookWorkdir("handbook-mcp-");
  const repoDir = join(workdir, "repo");
  try {
    const cloneError = cloneTeamRepo(git, team.repoUrl, repoDir, workdir);
    if (cloneError) return { ok: false, error: cloneError };
    const remoteBranches = listRemoteBranches(git, repoDir);
    const slug = uniqueSlug(`mcp-${base}`, (s) => remoteBranches.has(`${prefix}${s}`));
    let branch = `${prefix}${slug}`;
    let learnedBranchPrefix: string | undefined;
    let version: string | null = null;
    const target = join(repoDir, TEAM_MCP_FILE);
    let merged: string;
    try {
      merged = mergeServerIntoMcpJson(
        existsSync(target) ? readFileSync(target, "utf8") : null,
        entry.name,
        entry.config,
      );
    } catch (err) {
      return { ok: false, serverName: entry.name, error: String(err instanceof Error ? err.message : err) };
    }
    const title = buildMcpPrTitle(entry.name);
    try {
      git(["checkout", "-b", branch], repoDir);
      writeFileSync(target, merged);
      version = bumpPluginVersion(repoDir);
      git(["add", "-A"], repoDir);
      git([...identity.args, "commit", "-m", `${commitPrefix}${title}`], repoDir);
      const pushed = pushBranch(git, repoDir, branch, team, slug, remoteBranches);
      branch = pushed.branch;
      learnedBranchPrefix = pushed.learnedBranchPrefix;
    } catch (err) {
      return {
        ok: false,
        serverName: entry.name,
        error: pushFailureReason(
          team.repoUrl,
          branch,
          err,
          'Set "branchPrefix" under "team" in ~/.teamhandbook/config.json to a prefix that fits ' +
            '(for example "HEM-1-"), then run this again.',
        ),
      };
    }
    const pr = openPr(team.repoUrl, branch, title, buildMcpPrBody(entry, audit), repoDir, forge);
    return {
      ok: true,
      serverName: entry.name,
      branch,
      requiresEnv: audit.requiresEnv,
      startsProcess: audit.startsProcess,
      ...(version ? { version } : {}),
      ...(pr.url ? { prUrl: pr.url } : { manualUrl: manualPrUrl(team.repoUrl, branch) ?? undefined }),
      ...(pr.url ? {} : pr.error ? { prError: pr.error } : {}),
      ...(learnedBranchPrefix ? { learnedBranchPrefix } : {}),
    };
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

/**
 * What the manager is told after the request is open.
 *
 * Two of these lines exist because the command deliberately does NOT act: the local copy
 * of the server stays where it is (this tool never writes ~/.claude.json), so after the
 * merge the same server is reachable under two names and the tidy-up is a decision only
 * the manager can make.
 */
export function formatMcpShareResult(outcome: McpPublishOutcome, marketplaceName: string): string {
  const lines = [
    `Shared "${outcome.serverName}" with the team.`,
    "",
    `- branch: ${outcome.branch}`,
    outcome.prUrl ? `- merge request: ${outcome.prUrl}` : `- open the merge request: ${outcome.manualUrl}`,
  ];
  if (outcome.prError) lines.push(`  (the forge CLI could not open it: ${outcome.prError})`);
  if (outcome.version) lines.push(`- plugin version raised to ${outcome.version}, which is what makes teammates fetch it`);
  if (outcome.requiresEnv?.length) {
    lines.push(
      `- each teammate must set ${outcome.requiresEnv.join(", ")} in their own environment, ` +
        "or the server will not start for them",
    );
  }
  if (outcome.startsProcess) {
    lines.push("- this server starts a process on every teammate's machine; the merge request says which");
  }
  lines.push(
    "",
    `After the merge it appears as plugin:${marketplaceName}:${outcome.serverName}. Your own copy is`,
    "untouched, so you will see both: this command never writes to ~/.claude.json. Remove the",
    `local "${outcome.serverName}" yourself (claude mcp remove) once the team's one is connected.`,
  );
  return lines.join("\n");
}
