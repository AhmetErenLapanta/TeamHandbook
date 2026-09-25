import { handbookWorkdir } from "./session-state.js";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeRemoteUrl, renameSkillMd, uniqueSlug } from "./distill.js";
import { copySkillPayload } from "./skill-files.js";
import type { GroundedCase } from "./distill.js";
import { assertSafeGitUrl, pushFailureReason, pushRuleSubject, runGit, teamBranchPrefix, teamCommitPrefix } from "./init.js";
import { hostFromUrl, manualPrUrl, openPr, runForge } from "./forge.js";
import type { ForgeRunner } from "./forge.js";
export { manualPrUrl, runForge } from "./forge.js";
export type { ForgeRunner } from "./forge.js";
import type { GitRunner, TeamConfig } from "./init.js";
import { auditSkillDir, isSafeSlug, skillRefusalMessage } from "./queue.js";
import type { CandidateMeta } from "./queue.js";
import { auditServer, declaredServerNames, mergeServersIntoMcpJson, refusalMessage } from "./mcp.js";
import type { McpAudit, McpServerEntry } from "./mcp.js";
import { auditCommand, commandRefusalMessage } from "./commands.js";
import type { CommandEntry } from "./commands.js";
import { slugifySkillName } from "./distill.js";
import { displayPath } from "./display-path.js";

export function buildPrTitle(slug: string, update = false): string {
  return `feat(skill): ${update ? "update" : "add"} ${slug}`;
}

export function buildPrBody(meta: CandidateMeta, grounded: GroundedCase | null, update = false): string {
  const lines = [
    meta.description,
    "",
    `- scope: \`${meta.scope}\``,
    `- gate score: ${meta.gate ? `${meta.gate.total}/10` : "n/a"}`,
  ];
  if (update) {
    // A reviewer who reads this as an addition approves a new file; what is actually in
    // the diff is somebody else's skill, rewritten. The two need different attention, so
    // the body says which one this is rather than leaving it to the diff stat.
    lines.push(
      "",
      "## This replaces the skill the team already has",
      "",
      "The publisher was told the team already had a skill by this name and chose to send",
      "theirs as an update to it. Everything the team's copy said that this one does not say",
      "is gone after the merge, including edits made in the team repository since it landed.",
    );
  }
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
      "the evidence to review it against - nothing re-runs it automatically.",
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
      "it as the evidence to review it against - nothing re-runs it automatically.",
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

/** Why a name the destination already has was not simply written over. */
export interface Collision {
  kind: "skill" | "mcp" | "command";
  name: string;
}

/**
 * What to do about a name the team repository already has.
 *
 * The default is to refuse, for every kind of thing that travels. `update` is the
 * publisher's answer to that refusal and nothing else sets it: an overwrite is a change to
 * what the team already uses, and the only person entitled to ask for it is the one who
 * was shown the refusal. `as` is the other answer - send it under a different name - and
 * it is the one the suffix used to pick silently on the publisher's behalf.
 */
export interface PublishOptions {
  /**
   * `true` replaces whatever this request collides with; a list of names replaces only
   * those. The list exists because one request can carry a selection: a publisher shown
   * two refusals and consenting to one of them must not have the other overwritten by the
   * same word. Consent is per name, so the flag is too.
   */
  update?: boolean | string[];
  as?: string;
}

/** Whether this request was told it may replace `name`. */
export function mayUpdate(options: PublishOptions, name: string): boolean {
  return options.update === true || (Array.isArray(options.update) && options.update.includes(name));
}

/**
 * The one combination that cannot be consent.
 *
 * `--as` and `--update` are the two answers to a single refusal, and review.md offers them
 * as alternatives. Together they stop being alternatives: `--update` lands on the name
 * `--as` chose, not on the name the publisher was refused for, so it deletes a skill whose
 * existence was never put in front of them. That is the same defect the batch guard closed,
 * one axis over - there the extra names came from `--all`, here from `--as`.
 */
export function conflictingOptions(options: PublishOptions): string | null {
  if (options.as === undefined || !options.update) return null;
  return (
    "--as and --update answer the same refusal in different ways: --as sends this under a free name, " +
    "--update replaces the skill it collided with. Pick one."
  );
}

export interface PublishOutcome {
  ok: boolean;
  branch?: string;
  skillDir?: string;
  /** the name the skill was written under, which is not always the one asked for */
  skillSlug?: string;
  /** set when this request rewrites a skill the team already had */
  updatedExisting?: boolean;
  /** the team already has this name, and nothing was written */
  collision?: Collision;
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
 * the organisation enforces - three things to get right before anyone receives
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
 * had the answer accepted by the same server - it is sitting in the config as
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
  // A different rule wants a different knob, and GitLab words three of them the same way,
  // so the rule is read from the subject it names rather than from the one word it omits:
  // deriving a branch out of a rejection that was really about the commit author's email
  // would push a second time to be refused for the same reason.
  if (pushRuleSubject(raw) !== "branch-name") return null;
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

/**
 * A skill the team already has is never written over silently.
 *
 * This used to be the one kind of thing that answered the question differently: a server
 * and a command were both turned back by name, while a skill was quietly filed as
 * `skills/<slug>-2` and the publisher was told their own spelling. They then believed the
 * team had their correction, and the team had two skills disagreeing with each other. The
 * message names both ways forward, because "rename yours" was never a route the publisher
 * had - there was no way to say what to rename it to.
 */
function skillCollisionMessage(name: string, chosen: boolean): string {
  const taken = `the team repository already has a skill named "${name}" (skills/${name}/). Nothing was written.`;
  // A refusal has to name a route that WORKS. When the name came from --as, "--update" is
  // not one: it is refused alongside --as, so offering it here would send the publisher
  // into the dead end this message exists to prevent.
  return chosen
    ? `${taken} Pick a name nothing has taken with --as, or drop --as and approve with --update ` +
        "to send this candidate as an update to the skill it actually collided with."
    : `${taken} Approve again with --update to send yours as an update to it, ` +
        "or with --as <name> to send it under a different name.";
}

export function publishCandidate(
  candidateDir: string,
  meta: CandidateMeta,
  team: TeamConfig,
  git: GitRunner = runGit,
  forge: ForgeRunner = runForge,
  options: PublishOptions = {},
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
    return { ok: false, error: `candidate SKILL.md is missing or unreadable in ${displayPath(candidateDir)}` };
  }
  // The name the skill travels under: its own, or the one the publisher picked after being
  // told the first was taken. Checked here rather than at the copy, so a name that cannot
  // be a directory fails before a clone exists.
  const conflict = conflictingOptions(options);
  if (conflict) return { ok: false, error: conflict };
  const skillSlug = options.as ?? meta.slug;
  if (!isSafeSlug(skillSlug)) {
    return { ok: false, error: `"${skillSlug}" cannot be a skill name (lowercase letters, digits and dashes)` };
  }
  const identity = resolveGitIdentity(git);
  if ("error" in identity) return { ok: false, error: identity.error };
  const identityArgs = identity.args;
  const workdir = handbookWorkdir("handbook-publish-");
  const repoDir = join(workdir, "repo");
  try {
    const cloneError = cloneTeamRepo(git, team.repoUrl, repoDir, workdir);
    if (cloneError) return { ok: false, error: cloneError };
    const remoteBranches = listRemoteBranches(git, repoDir);
    const skillDir = `${TEAM_SKILLS_DIR}/${skillSlug}`;
    const occupied = existsSync(join(repoDir, skillDir));
    if (occupied && !mayUpdate(options, skillSlug)) {
      return {
        ok: false,
        collision: { kind: "skill", name: skillSlug },
        error: skillCollisionMessage(skillSlug, options.as !== undefined),
      };
    }
    // The BRANCH name is still made unique, and separately from the directory name, because
    // the two answer different questions. A previous approve may have pushed
    // handbook/<slug> whose PR is still open (or was abandoned); reusing that name gets the
    // push rejected non-fast-forward, and the slug is then locked forever. That is true of
    // an update too - which is exactly a second branch for a name that already went out
    // once - so the guard has to survive --update, and it does by living here instead of in
    // the directory name it used to be welded to.
    const branchSlug = uniqueSlug(skillSlug, (s) => remoteBranches.has(`${prefix}${s}`));
    let branch = `${prefix}${branchSlug}`;
    let learnedBranchPrefix: string | undefined;
    let version: string | null = null;
    const title = buildPrTitle(skillSlug, occupied);
    try {
      git(["checkout", "-b", branch], repoDir);
      // An update replaces the team's copy rather than merging into it: a file the new
      // version dropped would otherwise survive in the team's tree and keep being read.
      if (occupied) rmSync(join(repoDir, skillDir), { recursive: true, force: true });
      // Keep the SKILL.md name in sync with a suffixed slug so it doesn't shadow
      // the skill it collided with. Everything else the candidate carries goes with
      // it: a skill whose scripts and references were left behind is a skill the
      // reviewer approves and the teammate cannot run.
      copySkillPayload(
        candidateDir,
        join(repoDir, skillDir),
        skillSlug === meta.slug ? candidateSkillMd : renameSkillMd(candidateSkillMd, skillSlug),
      );
      version = bumpPluginVersion(repoDir);
      git(["add", "-A"], repoDir);
      git([...identityArgs, "commit", "-m", `${commitPrefix}${title}`], repoDir);
      const pushed = pushBranch(git, repoDir, branch, team, branchSlug, remoteBranches);
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
            '(for example "TEAM-1-"), then approve again; it is remembered for every skill after that.',
        ),
      };
    }
    const body = buildPrBody(meta, readGroundedCase(candidateDir), occupied);
    const learned = learnedBranchPrefix ? { learnedBranchPrefix } : {};
    const named = { skillDir, skillSlug, ...(occupied ? { updatedExisting: true } : {}) };
    const pr = openPr(team.repoUrl, branch, title, body, repoDir, forge);
    if (pr.url) {
      return { ok: true, branch, ...named, prUrl: pr.url, ...(version ? { version } : {}), ...learned };
    }
    return {
      ok: true,
      branch,
      ...named,
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
// Sharing the rest of a setup with the team: MCP servers and slash commands.
//
// Same repository, same merge request, same version signal as a skill: what widens is
// the KIND of thing that travels. A skill is inert markdown; an MCP server is a
// connection - and for a stdio one, a process that starts on every teammate's machine
// the moment the plugin is enabled. That is why the PR body below spells out the full
// command, and why a server carrying a literal credential is refused before this file
// touches git at all.
// ---------------------------------------------------------------------------

/** The file a plugin declares its MCP servers in. See mergeServersIntoMcpJson for why
 * this file rather than plugin.json, and why an existing one's shape is preserved. */
export const TEAM_MCP_FILE = ".mcp.json";

/**
 * Where a plugin's slash commands live. Claude Code discovers this directory by
 * convention - it is how this repository's own commands reach the people who install it -
 * so a merged command needs no registration anywhere else.
 */
export const TEAM_COMMANDS_DIR = "commands";

/**
 * Where a plugin's skills live, discovered by the same convention. publishCandidate has
 * always written here for a harvested candidate; a skill picked on the share screen lands
 * in the same place, so the team repository has one skills directory rather than one per
 * route in.
 */
export const TEAM_SKILLS_DIR = "skills";

export interface TeamPublishOutcome {
  ok: boolean;
  serverName?: string;
  // every server this one request carries, which is one or many
  serverNames?: string[];
  // every command it carries, for the same reason
  commandNames?: string[];
  // every skill it carries. A skill picked on the share screen travels in this same
  // request rather than through the review queue: the picking IS the approval, the same
  // way it already was for a server and a command.
  skillNames?: string[];
  // what the selection named that did not travel, each with the reason it did not. The
  // kind travels with the name: a caller reporting "explain" back to the user has to be
  // able to say which of its three lists that name came from. `collision` marks the one
  // refusal that has a way forward, so a caller can offer it without matching on prose.
  refused?: { name: string; kind: "mcp" | "command" | "skill"; reason: string; collision?: true }[];
  // the names in this request that rewrite something the team already had
  updated?: UpdatedNames;
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

/** A server that cleared the audit, kept together with the audit that cleared it. */
export interface McpShareSubject {
  entry: McpServerEntry;
  audit: McpAudit;
}

export function buildMcpPrTitle(names: string[]): string {
  return buildSelectionPrTitle(names, []);
}

/** The names in one request that rewrite the team's copy rather than adding a new one. */
export interface UpdatedNames {
  servers: string[];
  commands: string[];
  skills: string[];
}

const NOTHING_UPDATED: UpdatedNames = { servers: [], commands: [], skills: [] };

/**
 * One title for a request that may carry two kinds of thing.
 *
 * The conventional scope stays honest about what is inside: a reviewer who reads
 * `feat(mcp)` and finds four slash commands in the diff learns not to trust the subject
 * line, and the subject line is the only part of a merge request everyone reads.
 */
export function buildSelectionPrTitle(
  serverNames: string[],
  commandNames: string[],
  updated: UpdatedNames = NOTHING_UPDATED,
  skillNames: string[] = [],
): string {
  const scopes = [
    skillNames.length ? "skill" : "",
    serverNames.length ? "mcp" : "",
    commandNames.length ? "commands" : "",
  ].filter(Boolean);
  // Kept per kind rather than as one list of names, because a server and a command are
  // allowed to share a name and the verb in front of it would then be a coin toss.
  const added = [
    ...skillNames.filter((n) => !updated.skills.includes(n)),
    ...serverNames.filter((n) => !updated.servers.includes(n)),
    ...commandNames.filter((n) => !updated.commands.includes(n)),
  ];
  const changed = [
    ...skillNames.filter((n) => updated.skills.includes(n)),
    ...serverNames.filter((n) => updated.servers.includes(n)),
    ...commandNames.filter((n) => updated.commands.includes(n)),
  ];
  const parts = [];
  if (added.length) parts.push(`add ${added.join(", ")}`);
  if (changed.length) parts.push(`update ${changed.join(", ")}`);
  return `feat(${scopes.join(",")}): ${parts.join("; ")}`;
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
  return buildMcpServersPrBody([{ entry, audit }]);
}

export function buildMcpServersPrBody(subjects: McpShareSubject[]): string {
  // No commands ever travel through this path, so the marketplace name that would
  // namespace them is never read.
  return buildSelectionPrBody(subjects, [], "");
}

/** A command that cleared the audit, with the text that cleared it. */
export interface CommandSubject {
  name: string;
  content: string;
}

function selectionIntro(servers: number, commands: number, skills = 0): string[] {
  // The existing wording for a request of one kind is kept exactly as it was; only a
  // request that mixes kinds needs a sentence that can name all three.
  if (skills) {
    if (!servers && !commands) {
      return skills === 1
        ? [
            "Adds one skill to this plugin. Once this is merged, every teammate whose copy",
            "refreshes has it: nobody copies a directory into their own setup.",
          ]
        : [
            `Adds ${skills} skills to this plugin. Once this is merged, every teammate whose copy`,
            "refreshes has them: nobody copies a directory into their own setup.",
          ];
    }
    const parts = [
      `${skills} skill${skills === 1 ? "" : "s"}`,
      ...(servers ? [`${servers} MCP server${servers === 1 ? "" : "s"}`] : []),
      ...(commands ? [`${commands} slash command${commands === 1 ? "" : "s"}`] : []),
    ];
    const listed = parts.length === 2 ? parts.join(" and ") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
    return [
      `Adds ${listed} to this plugin. Once this is merged, every teammate whose copy`,
      "refreshes has all of it: nobody installs, configures or copies anything.",
    ];
  }
  if (!servers) {
    return commands === 1
      ? [
          "Adds one slash command to this plugin. Once this is merged, every teammate whose copy",
          "refreshes can type it: nobody copies a file into their own setup.",
        ]
      : [
          `Adds ${commands} slash commands to this plugin. Once this is merged, every teammate whose`,
          "copy refreshes can type them: nobody copies a file into their own setup.",
        ];
  }
  if (!commands) {
    return servers === 1
      ? [
          `Adds the \`SERVER_NAME\` MCP server to this plugin. Once this is merged, every`,
          "teammate whose copy refreshes has it connected: nobody installs or configures anything.",
        ]
      : [
          `Adds ${servers} MCP servers to this plugin. Once this is merged, every teammate whose`,
          "copy refreshes has them connected: nobody installs or configures anything.",
        ];
  }
  return [
    `Adds ${servers} MCP server${servers === 1 ? "" : "s"} and ${commands} slash command${commands === 1 ? "" : "s"} to this`,
    "plugin. Once this is merged, every teammate whose copy refreshes has the servers connected",
    "and can type the commands: nobody installs, configures or copies anything.",
  ];
}

/**
 * The whole request, described for a reviewer who has to decide knowingly.
 *
 * Two kinds of thing travel here and they ask the reviewer for different consent. A server
 * means something connects, or runs, on every subscribed machine - so the transport, the
 * endpoint or the exact command, and every variable the teammate must supply are stated in
 * full. A command means Claude reads a teammate's file as its instructions when they type
 * a word. Neither is reviewable by reading the title, so neither is summarised away.
 *
 * `marketplaceName` is the plugin every merged command is typed under: Claude Code
 * namespaces an installed plugin's commands as `/<plugin>:<command>`, the same form
 * share.ts's own post-share message promises the sharer ("the commands are typed as
 * /<marketplaceName>:<name>"). A bare `/<command>` here would tell the reviewer a name
 * that does not resolve once the plugin is installed.
 */
export function buildSelectionPrBody(
  subjects: McpShareSubject[],
  commands: CommandSubject[],
  marketplaceName: string,
  updated: UpdatedNames = NOTHING_UPDATED,
  skills: SkillSubject[] = [],
): string {
  const single = subjects.length === 1 && !commands.length && !skills.length;
  const lines = selectionIntro(subjects.length, commands.length, skills.length).map((line) =>
    line.replace("SERVER_NAME", subjects[0]?.entry.name ?? ""),
  );
  for (const { entry, audit } of subjects) {
    const config = entry.config;
    lines.push("", `- server: \`${entry.name}\``, `- transport: \`${audit.transport}\``);
    if (typeof config.url === "string") lines.push(`- endpoint: \`${config.url}\``);
    if (audit.startsProcess) {
      const args = Array.isArray(config.args) ? config.args.map(String) : [];
      lines.push(`- command: \`${String(config.command)}${args.length ? ` ${args.join(" ")}` : ""}\``);
    }
  }
  // The warning is written once for the whole request rather than under each server: a
  // reviewer who reads it three times reads it none. It names the servers it is about,
  // because in a request of six the other three are only a connection.
  const processes = subjects.filter((s) => s.audit.startsProcess).map((s) => s.entry.name);
  if (processes.length === 1) {
    lines.push(
      "",
      single ? "## This one starts a process" : `## \`${processes[0]}\` starts a process`,
      "",
      "Enabling the plugin runs that command on every teammate's machine, with their",
      "privileges, for as long as the session lasts. Review it the way you would review a",
      "dependency you are adding, not the way you would review a document.",
    );
  } else if (processes.length > 1) {
    lines.push(
      "",
      "## Some of these start a process",
      "",
      `Enabling the plugin runs the commands above for ${processes.map((n) => `\`${n}\``).join(", ")} on`,
      "every teammate's machine, with their privileges, for as long as the session lasts.",
      "Review them the way you would review a dependency you are adding, not the way you",
      "would review a document.",
    );
  }
  for (const command of commands) {
    lines.push(
      "",
      `- command: \`/${marketplaceName}:${command.name}\``,
      `- file: \`${TEAM_COMMANDS_DIR}/${command.name}.md\``,
    );
  }
  for (const skill of skills) {
    lines.push(
      "",
      `- skill: \`${skill.name}\``,
      `- files: \`${TEAM_SKILLS_DIR}/${skill.name}/\` (${skill.files.length})`,
    );
    if (skill.description) lines.push(`- description: ${skill.description}`);
  }
  if (skills.length) {
    // The reviewer is the only gate these passed. A harvested skill arrives with a gate
    // score and a grounded case to read it against; one picked off the share screen has
    // neither, because a person chose it deliberately instead of a model proposing it.
    // Saying so is what stops the absence of a score reading as a missing section.
    lines.push(
      "",
      skills.length === 1 ? "## This skill was written by hand" : "## These skills were written by hand",
      "",
      "Their author picked them from their own machine, so they carry no gate score and no",
      "grounded case: nothing proposed them and there is nothing to score. Review them by",
      "reading them, the same way you would review any other document in this repository.",
    );
  }
  const changed = [
    ...skills.filter((s) => updated.skills.includes(s.name)).map((s) => `${TEAM_SKILLS_DIR}/${s.name}/`),
    ...subjects.filter((s) => updated.servers.includes(s.entry.name)).map((s) => s.entry.name),
    // Namespaced, like the bullet above and for the same reason: a bare `/<command>` is a
    // name nobody can type once the plugin is installed. Two spellings of one command in
    // one document leave the reviewer deciding which of them to believe.
    ...commands.filter((c) => updated.commands.includes(c.name)).map((c) => `/${marketplaceName}:${c.name}`),
  ];
  if (changed.length) {
    // Said in its own section rather than as a word in the title: approving an addition and
    // approving a rewrite of what the team already runs are different decisions, and the
    // second one is only visible in the diff to a reviewer who already knows to look.
    lines.push(
      "",
      changed.length === 1 ? "## This one replaces what the team has" : "## Some of these replace what the team has",
      "",
      `${changed.map((n) => `\`${n}\``).join(", ")} ${changed.length === 1 ? "is" : "are"} already in this repository, and`,
      "the publisher was told so before asking for this. What is in the diff is the version on",
      "their machine, whole: anything the team's copy gained since it landed is gone after the",
      "merge, so read the removed lines as carefully as the added ones.",
    );
  }
  if (commands.length) {
    lines.push(
      "",
      commands.length === 1 ? "## This one is read as instructions" : "## These are read as instructions",
      "",
      "A merged command is typed by a teammate and then read by Claude as its instructions for",
      "that turn, with their tools and their permissions. Read the bod" + (commands.length === 1 ? "y" : "ies") +
        " in this diff the way you",
      "would read a runbook someone else is about to run, not the way you would read a note.",
    );
  }
  const requiresEnv: string[] = [];
  for (const { audit } of subjects) {
    for (const name of audit.requiresEnv) if (!requiresEnv.includes(name)) requiresEnv.push(name);
  }
  return finishMcpPrBody(lines, requiresEnv, subjects.length > 0, commands.length);
}

function finishMcpPrBody(
  lines: string[],
  requiresEnv: string[],
  hasServers: boolean,
  commandCount: number,
): string {
  // State the check, never the conclusion. An earlier version of this section promised
  // outright that no credential travelled, which was a guarantee wider than anything
  // actually verified: a provider that embeds the token in the endpoint (Zapier, Composio,
  // Smithery) sailed through, and the reviewer read a written assurance over the top of the
  // credential itself. Human review was the one compensating control here, and a sentence
  // that tells the reviewer not to look is worse than no sentence at all. The command
  // paragraph below is written under the same rule: it says what the scan looked for.
  lines.push("", "## What was checked", "");
  if (hasServers) {
    lines.push(
      "Every value in `headers` and `env` is a plain ${VAR} reference rather than a literal, so",
      "no credential travels in those fields. The endpoint was also scanned for an embedded",
      "token and none was found.",
    );
  }
  if (commandCount) {
    if (hasServers) lines.push("");
    lines.push(
      `Each command file was scanned for known credential shapes before it was copied, and one`,
      "that matched would have stopped this request rather than arriving with the token blanked",
      "out. That scan is a heuristic over the shapes it knows, not a proof.",
    );
  }
  if (requiresEnv.length) {
    lines.push(
      "",
      `Each teammate supplies these from their own environment: ${requiresEnv.map((v) => `\`${v}\``).join(", ")}.` +
        " Until they do, the server will not start for them.",
    );
  }
  // The closing names what the check does NOT cover, per kind, because that is the part a
  // reviewer cannot infer from the paragraphs above.
  lines.push("");
  if (hasServers) {
    lines.push(
      'That is the whole of the check, and it is a narrower claim than "this definition holds',
      'no secret": the endpoint scan is a heuristic, and a credential passed in `args` is not',
      "checked at all. Read the endpoint and the command above before merging.",
    );
  }
  if (commandCount) {
    const read = `Read the ${commandCount === 1 ? "file" : "files"} in this diff before merging.`;
    if (hasServers) {
      lines.push(
        "",
        "A command body is prose, and a credential in a shape the scan has never seen reads to it",
        `as prose too. ${read}`,
      );
    } else {
      lines.push(
        'That is the whole of the check, and it is a narrower claim than "these commands hold no',
        'secret": a command body is prose, and a credential in a shape the scan has never seen',
        `reads to it as prose too. ${read}`,
      );
    }
  }
  lines.push(
    "",
    "---",
    "Opened by TeamHandbook at the explicit request of whoever ran the command.",
  );
  return lines.join("\n");
}

/**
 * Nothing the team already has is written over by a request that did not ask to.
 *
 * The team's copy may have been edited since it was shared, and replacing it unasked would
 * take that edit out of a merge request nobody opened for it - a change to the team's setup
 * made by somebody sharing their own. So the first answer is always a refusal, and an
 * update is a second, deliberate request.
 *
 * These two state the fact and stop there: they do NOT name the command that sends the
 * update. The route is a CLI grammar this library does not own - `--update` takes the one
 * name being consented to, and it is the caller that knows how the selection it was handed
 * is written back. A refusal that names a command which fails when you run it is the exact
 * defect this function exists to avoid, so the caller appends the route in its own words,
 * next to the refusal it prints: see formatShareResult.
 */
function collisionMessage(name: string): string {
  return `the team repository already declares an MCP server named "${name}". It was left exactly as it is.`;
}

function commandCollisionMessage(name: string): string {
  return (
    `the team repository already has a command named "${name}" (${TEAM_COMMANDS_DIR}/${name}.md). ` +
    "It was left exactly as it is."
  );
}

/** What the team repository already carries, by kind. */
export interface TeamAssets {
  skills: string[];
  servers: string[];
  commands: string[];
}

function namesIn(dir: string, suffix?: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => (suffix ? entry.isFile() && entry.name.endsWith(suffix) : entry.isDirectory()))
      .map((entry) => (suffix ? entry.name.slice(0, -suffix.length) : entry.name));
  } catch {
    return [];
  }
}

/**
 * Everything the team already has, read once so a screen can say so before anyone picks.
 *
 * Advisory, and only advisory. The answer that decides anything is taken at publish time
 * inside the clone that is about to write; this one can go stale between the screen and the
 * choice, and it is null altogether when the repository is unreachable. So it may add a
 * label and may not withhold one thing or overwrite another. share.ts already draws this
 * line for the credential screen - "The screen is advisory; the refusal lives where it
 * lived before" - and the direction it must not drift in is a screen that decides.
 */
export function teamAssets(team: TeamConfig, git: GitRunner = runGit): TeamAssets | null {
  try {
    assertSafeGitUrl(team.repoUrl);
  } catch {
    return null;
  }
  const workdir = handbookWorkdir("handbook-index-");
  const repoDir = join(workdir, "repo");
  try {
    if (cloneTeamRepo(git, team.repoUrl, repoDir, workdir)) return null;
    const mcpFile = join(repoDir, TEAM_MCP_FILE);
    return {
      skills: namesIn(join(repoDir, "skills")),
      servers: declaredServerNames(existsSync(mcpFile) ? readFileSync(mcpFile, "utf8") : null),
      commands: namesIn(join(repoDir, TEAM_COMMANDS_DIR), ".md"),
    };
  } catch {
    return null;
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

/**
 * A skill named for sharing, as the caller found it: the directory to read, and how the
 * caller came by it. `namedBy` decides only how a refusal spells the path back - an
 * inventory entry is the machine's own and is shortened to "~", while a path the user
 * typed is echoed exactly as typed, because they have to recognize their own argument.
 */
export interface SkillShareEntry {
  name: string;
  dir: string;
  namedBy?: "inventory" | "user";
}

/** A skill that cleared the audit, with the exact file list that was screened. */
export interface SkillSubject {
  name: string;
  dir: string;
  skillMd: string;
  files: string[];
  description: string;
}

export interface TeamSelection {
  servers?: McpServerEntry[];
  commands?: CommandEntry[];
  skills?: SkillShareEntry[];
}

/**
 * Write the chosen skills, servers and commands into the team repository as ONE merge
 * request that also raises the plugin version, so a merge reaches everyone at once.
 *
 * One request for the whole selection, not one per item, and the version is the reason.
 * `bumpPluginVersion` reads the version from a fresh clone, so two requests opened before
 * either is merged both claim the same number; git merges the identical line without a
 * conflict and the second change lands with no version of its own, which means no
 * teammate's copy refreshes for it. Selecting six servers would have
 * hit that five times over. Collecting them into one commit makes the arithmetic right by
 * construction: one clone, one bump, one request - and that is why commands, and then
 * skills, joined this function instead of getting a publishing path of their own, which
 * would have re-created the defect inside a single run. Picking five skills escaped that
 * collision before only because those five never left the machine at all.
 *
 * A skill picked here has NOT been through /handbook:review, and does not need to be: the
 * user opened the screen and chose their own skill, and that choosing is the approval. What
 * /handbook:review still gates is everything the HARVEST proposed, which nobody chose.
 * publishCandidate remains that path; this one never touches the review queue.
 *
 * Nothing here reads ~/.claude.json, ~/.claude/commands or ~/.claude/skills and nothing
 * writes them: the caller hands over what it already read, the skill directories are only
 * read, and the local copies are left exactly as they were.
 */
export function publishTeamSelection(
  selection: TeamSelection,
  team: TeamConfig,
  git: GitRunner = runGit,
  forge: ForgeRunner = runForge,
  options: PublishOptions = {},
): TeamPublishOutcome {
  const entries = selection.servers ?? [];
  const commandEntries = selection.commands ?? [];
  const skillEntries = selection.skills ?? [];
  const single =
    entries.length === 1 && !commandEntries.length && !skillEntries.length
      ? { serverName: entries[0]!.name }
      : {};
  // FIRST, before assertSafeGitUrl and before the identity preflight, because those call
  // git. A refusal has to happen while the credential still exists nowhere but this
  // process: not in a clone, not in an index, not in a working tree that a later crash
  // could leave behind. The order of these lines is the boundary, and EVERY entry is
  // audited before the first git call, so a credential in the last one of six cannot
  // reach a clone opened for the first five. Commands are read here for the same reason
  // and not again later: the text that cleared the sieve is the text that gets written.
  const subjects: McpShareSubject[] = [];
  const refused: NonNullable<TeamPublishOutcome["refused"]> = [];
  for (const entry of entries) {
    const audit = auditServer(entry.config);
    if (audit.migratable) subjects.push({ entry, audit });
    else refused.push({ name: entry.name, kind: "mcp", reason: refusalMessage(entry.name, audit) });
  }
  const commands: CommandSubject[] = [];
  for (const entry of commandEntries) {
    const audit = auditCommand(entry.file);
    if (audit.shareable) commands.push({ name: entry.name, content: audit.content! });
    else refused.push({ name: entry.name, kind: "command", reason: commandRefusalMessage(entry.name, audit) });
  }
  // Skills are screened in this same pre-git loop, and for the same reason: a credential
  // in the last skill of six must not reach a clone opened for the first five. This route
  // used to pass through the review queue, which ran the sieve a second time; that stop is
  // gone, so this one is now the only one and it stays ahead of every git call.
  const skills: SkillSubject[] = [];
  for (const entry of skillEntries) {
    // Two selections resolving to one name would write the same skills/<name> twice and the
    // second would silently win. Named rather than merged: the user picked two things and is
    // entitled to know only one of them can travel under that name.
    if (skills.some((skill) => skill.name === entry.name)) {
      refused.push({
        name: entry.name,
        kind: "skill",
        reason: `two of the skills selected are named "${entry.name}"; only the first was taken`,
      });
      continue;
    }
    const audit = auditSkillDir(entry.dir);
    if (audit.shareable) {
      skills.push({
        name: entry.name,
        dir: entry.dir,
        skillMd: audit.skillMd!,
        files: audit.files!,
        description: audit.summary?.description ?? "",
      });
    } else {
      refused.push({
        name: entry.name,
        kind: "skill",
        reason: skillRefusalMessage(
          entry.namedBy === "user" ? entry.dir : displayPath(entry.dir),
          entry.name,
          audit,
        ),
      });
    }
  }
  if (!subjects.length && !commands.length && !skills.length) {
    return {
      ok: false,
      ...single,
      refused,
      error: refused[0]?.reason ?? "nothing was named to share",
    };
  }
  // Every early return from here on carries `refused` with it. A server that was turned
  // back for holding a credential has been judged, and losing that judgement to a later,
  // unrelated failure would report the credential as an unset git identity.
  try {
    assertSafeGitUrl(team.repoUrl);
  } catch (err) {
    return { ok: false, refused, error: String(err instanceof Error ? err.message : err) };
  }
  for (const { entry } of subjects) {
    if (!slugifySkillName(entry.name)) {
      return { ok: false, refused, error: `cannot derive a branch name from the server name "${entry.name}"` };
    }
  }
  // The name becomes a directory in the team repository, so it is checked before a clone
  // exists rather than at the copy - the same order publishCandidate uses.
  for (const skill of skills) {
    if (!isSafeSlug(skill.name)) {
      return {
        ok: false,
        refused,
        error: `"${skill.name}" cannot be a skill name (lowercase letters, digits and dashes)`,
      };
    }
  }
  const identity = resolveGitIdentity(git);
  if ("error" in identity) return { ok: false, refused, error: identity.error };
  const prefix = teamBranchPrefix(team);
  const commitPrefix = teamCommitPrefix(team);
  const workdir = handbookWorkdir("handbook-mcp-");
  const repoDir = join(workdir, "repo");
  try {
    const cloneError = cloneTeamRepo(git, team.repoUrl, repoDir, workdir);
    if (cloneError) return { ok: false, refused, error: cloneError };
    const remoteBranches = listRemoteBranches(git, repoDir);
    const target = join(repoDir, TEAM_MCP_FILE);
    let merged = "";
    let collided: string[] = [];
    let replacedServers: string[] = [];
    if (subjects.length) {
      try {
        ({ merged, collided, replaced: replacedServers } = mergeServersIntoMcpJson(
          existsSync(target) ? readFileSync(target, "utf8") : null,
          subjects.map((s) => s.entry),
          (name) => mayUpdate(options, name),
        ));
      } catch (err) {
        // A team file we cannot read is not one server's problem, so no part of the
        // selection is salvaged from it: nothing is committed and nothing is pushed.
        return { ok: false, ...single, refused, error: String(err instanceof Error ? err.message : err) };
      }
    }
    // Collisions are collected as their own reason rather than left to `refused[0]`: when
    // nothing gets through, the caller is told the name is taken, not told again about a
    // credential it was already told about.
    const collisions: string[] = [];
    for (const name of collided) {
      collisions.push(collisionMessage(name));
      refused.push({ name, kind: "mcp", reason: collisionMessage(name), collision: true });
    }
    const going = subjects.filter((s) => !collided.includes(s.entry.name));
    const goingCommands: CommandSubject[] = [];
    const replacedCommands: string[] = [];
    for (const command of commands) {
      if (existsSync(join(repoDir, TEAM_COMMANDS_DIR, `${command.name}.md`))) {
        if (!mayUpdate(options, command.name)) {
          collisions.push(commandCollisionMessage(command.name));
          refused.push({
            name: command.name,
            kind: "command",
            reason: commandCollisionMessage(command.name),
            collision: true,
          });
          continue;
        }
        replacedCommands.push(command.name);
      }
      goingCommands.push(command);
    }
    const goingSkills: SkillSubject[] = [];
    const replacedSkills: string[] = [];
    for (const skill of skills) {
      if (existsSync(join(repoDir, TEAM_SKILLS_DIR, skill.name))) {
        if (!mayUpdate(options, skill.name)) {
          collisions.push(skillCollisionMessage(skill.name, false));
          refused.push({
            name: skill.name,
            kind: "skill",
            reason: skillCollisionMessage(skill.name, false),
            collision: true,
          });
          continue;
        }
        replacedSkills.push(skill.name);
      }
      goingSkills.push(skill);
    }
    const updated: UpdatedNames = {
      servers: replacedServers.filter((n) => going.some((s) => s.entry.name === n)),
      commands: replacedCommands,
      skills: replacedSkills,
    };
    if (!going.length && !goingCommands.length && !goingSkills.length) {
      return { ok: false, ...single, refused, error: collisions[0] ?? refused[0]?.reason ?? "nothing was left to share" };
    }
    const names = going.map((s) => s.entry.name);
    const commandNames = goingCommands.map((c) => c.name);
    const skillNames = goingSkills.map((s) => s.name);
    const all = [...skillNames, ...names, ...commandNames];
    // Every kind that is actually in the request, so a skills-only one is not branched as
    // "commands-<name>" - a branch that lies about its contents is the thing a reviewer
    // scanning a list of open requests reads first.
    const label =
      [skillNames.length ? "skills" : "", names.length ? "mcp" : "", commandNames.length ? "commands" : ""]
        .filter(Boolean)
        .length > 1
        ? "share"
        : skillNames.length
          ? "skills"
          : names.length
            ? "mcp"
            : "commands";
    const first = slugifySkillName(all[0]!);
    const base = all.length === 1 ? `${label}-${first}` : `${label}-${first}-and-${all.length - 1}-more`;
    const slug = uniqueSlug(base, (s) => remoteBranches.has(`${prefix}${s}`));
    let branch = `${prefix}${slug}`;
    let learnedBranchPrefix: string | undefined;
    let version: string | null = null;
    const title = buildSelectionPrTitle(names, commandNames, updated, skillNames);
    try {
      git(["checkout", "-b", branch], repoDir);
      if (going.length) writeFileSync(target, merged);
      if (goingCommands.length) mkdirSync(join(repoDir, TEAM_COMMANDS_DIR), { recursive: true });
      for (const command of goingCommands) {
        writeFileSync(join(repoDir, TEAM_COMMANDS_DIR, `${command.name}.md`), command.content);
      }
      for (const skill of goingSkills) {
        const dest = join(repoDir, TEAM_SKILLS_DIR, skill.name);
        // An update replaces the team's copy rather than merging into it: a file the new
        // version dropped would otherwise survive in the team's tree and keep being read.
        if (replacedSkills.includes(skill.name)) rmSync(dest, { recursive: true, force: true });
        // The screened list, not a fresh walk: the set the sieve cleared is the set that
        // gets copied, so a file added between the audit and here cannot ride along.
        copySkillPayload(skill.dir, dest, skill.skillMd, skill.files);
      }
      version = bumpPluginVersion(repoDir);
      git(["add", "-A"], repoDir);
      git([...identity.args, "commit", "-m", `${commitPrefix}${title}`], repoDir);
      const pushed = pushBranch(git, repoDir, branch, team, slug, remoteBranches);
      branch = pushed.branch;
      learnedBranchPrefix = pushed.learnedBranchPrefix;
    } catch (err) {
      return {
        ok: false,
        ...single,
        refused,
        error: pushFailureReason(
          team.repoUrl,
          branch,
          err,
          'Set "branchPrefix" under "team" in ~/.teamhandbook/config.json to a prefix that fits ' +
            '(for example "TEAM-1-"), then run this again.',
        ),
      };
    }
    const requiresEnv: string[] = [];
    for (const { audit } of going) {
      for (const name of audit.requiresEnv) if (!requiresEnv.includes(name)) requiresEnv.push(name);
    }
    const pr = openPr(
      team.repoUrl,
      branch,
      title,
      buildSelectionPrBody(going, goingCommands, team.marketplaceName, updated, goingSkills),
      repoDir,
      forge,
    );
    return {
      ok: true,
      ...single,
      ...(names.length ? { serverNames: names } : {}),
      ...(commandNames.length ? { commandNames } : {}),
      ...(skillNames.length ? { skillNames } : {}),
      ...(updated.servers.length || updated.commands.length || updated.skills.length ? { updated } : {}),
      ...(refused.length ? { refused } : {}),
      branch,
      requiresEnv,
      startsProcess: going.some((s) => s.audit.startsProcess),
      ...(version ? { version } : {}),
      ...(pr.url ? { prUrl: pr.url } : { manualUrl: manualPrUrl(team.repoUrl, branch) ?? undefined }),
      ...(pr.url ? {} : pr.error ? { prError: pr.error } : {}),
      ...(learnedBranchPrefix ? { learnedBranchPrefix } : {}),
    };
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

