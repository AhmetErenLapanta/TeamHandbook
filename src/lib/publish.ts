import { handbookWorkdir } from "./session-state.js";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { auditServer, mergeServersIntoMcpJson, refusalMessage } from "./mcp.js";
import type { McpAudit, McpServerEntry } from "./mcp.js";
import { auditCommand, commandRefusalMessage } from "./commands.js";
import type { CommandEntry } from "./commands.js";
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

/** The file a plugin declares its MCP servers in. See mergeServerIntoMcpJson for why. */
export const TEAM_MCP_FILE = ".mcp.json";

/**
 * Where a plugin's slash commands live. Claude Code discovers this directory by
 * convention - it is how this repository's own commands reach the people who install it -
 * so a merged command needs no registration anywhere else.
 */
export const TEAM_COMMANDS_DIR = "commands";

export interface TeamPublishOutcome {
  ok: boolean;
  serverName?: string;
  // every server this one request carries, which is one or many
  serverNames?: string[];
  // every command it carries, for the same reason
  commandNames?: string[];
  // what the selection named that did not travel, each with the reason it did not. The
  // kind travels with the name: a caller reporting "explain" back to the user has to be
  // able to say which of its three lists that name came from.
  refused?: { name: string; kind: "mcp" | "command"; reason: string }[];
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

/**
 * One title for a request that may carry two kinds of thing.
 *
 * The conventional scope stays honest about what is inside: a reviewer who reads
 * `feat(mcp)` and finds four slash commands in the diff learns not to trust the subject
 * line, and the subject line is the only part of a merge request everyone reads.
 */
export function buildSelectionPrTitle(serverNames: string[], commandNames: string[]): string {
  const scopes = [serverNames.length ? "mcp" : "", commandNames.length ? "commands" : ""].filter(Boolean);
  return `feat(${scopes.join(",")}): add ${[...serverNames, ...commandNames].join(", ")}`;
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

function selectionIntro(servers: number, commands: number): string[] {
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
 * migrate.ts's own post-share message promises the sharer ("the commands are typed as
 * /<marketplaceName>:<name>"). A bare `/<command>` here would tell the reviewer a name
 * that does not resolve once the plugin is installed.
 */
export function buildSelectionPrBody(
  subjects: McpShareSubject[],
  commands: CommandSubject[],
  marketplaceName: string,
): string {
  const single = subjects.length === 1 && !commands.length;
  const lines = selectionIntro(subjects.length, commands.length).map((line) =>
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

/** One server, the shape /handbook:mcp shares. */
export function publishMcpServer(
  entry: McpServerEntry,
  team: TeamConfig,
  git: GitRunner = runGit,
  forge: ForgeRunner = runForge,
): TeamPublishOutcome {
  return publishTeamSelection({ servers: [entry] }, team, git, forge);
}

/** Servers only, the shape /handbook:migrate shared before commands could travel. */
export function publishMcpServers(
  entries: McpServerEntry[],
  team: TeamConfig,
  git: GitRunner = runGit,
  forge: ForgeRunner = runForge,
): TeamPublishOutcome {
  return publishTeamSelection({ servers: entries }, team, git, forge);
}

function collisionMessage(name: string): string {
  return (
    `the team repository already declares an MCP server named "${name}". ` +
    "Rename yours, or edit the team's .mcp.json directly."
  );
}

/**
 * A command the team already has is never written over. The team's copy may have been
 * edited since it was shared, and replacing it here would take that edit out of a merge
 * request nobody opened for it - which is a change to the team's setup made by somebody
 * sharing their own. Updating an existing one is a different operation, with a different
 * question for the reviewer, and it is not this one.
 */
function commandCollisionMessage(name: string): string {
  return (
    `the team repository already has a command named "${name}" (${TEAM_COMMANDS_DIR}/${name}.md). ` +
    "It was left exactly as it is; rename yours, or change theirs in the team repository."
  );
}

export interface TeamSelection {
  servers?: McpServerEntry[];
  commands?: CommandEntry[];
}

/**
 * Write the chosen servers and commands into the team repository as ONE merge request that
 * also raises the plugin version, so a merge reaches everyone the same way a skill does.
 *
 * One request for the whole selection, not one per item, and the version is the reason.
 * `bumpPluginVersion` reads the version from a fresh clone, so two requests opened before
 * either is merged both claim the same number; git merges the identical line without a
 * conflict and the second change lands with no version of its own, which means no
 * teammate's copy refreshes for it. Selecting six servers would have
 * hit that five times over. Collecting them into one commit makes the arithmetic right by
 * construction: one clone, one bump, one request - and that is why commands joined this
 * function instead of getting a publishing path of their own, which would have re-created
 * the defect inside a single run.
 *
 * Nothing here reads ~/.claude.json or ~/.claude/commands and nothing writes them: the
 * caller hands over what it already read, and the local copies are left as they were.
 */
export function publishTeamSelection(
  selection: TeamSelection,
  team: TeamConfig,
  git: GitRunner = runGit,
  forge: ForgeRunner = runForge,
): TeamPublishOutcome {
  const entries = selection.servers ?? [];
  const commandEntries = selection.commands ?? [];
  const single = entries.length === 1 && !commandEntries.length ? { serverName: entries[0]!.name } : {};
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
  if (!subjects.length && !commands.length) {
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
    if (subjects.length) {
      try {
        ({ merged, collided } = mergeServersIntoMcpJson(
          existsSync(target) ? readFileSync(target, "utf8") : null,
          subjects.map((s) => s.entry),
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
      refused.push({ name, kind: "mcp", reason: collisionMessage(name) });
    }
    const going = subjects.filter((s) => !collided.includes(s.entry.name));
    const goingCommands: CommandSubject[] = [];
    for (const command of commands) {
      if (existsSync(join(repoDir, TEAM_COMMANDS_DIR, `${command.name}.md`))) {
        collisions.push(commandCollisionMessage(command.name));
        refused.push({ name: command.name, kind: "command", reason: commandCollisionMessage(command.name) });
        continue;
      }
      goingCommands.push(command);
    }
    if (!going.length && !goingCommands.length) {
      return { ok: false, ...single, refused, error: collisions[0] ?? refused[0]?.reason ?? "nothing was left to share" };
    }
    const names = going.map((s) => s.entry.name);
    const commandNames = goingCommands.map((c) => c.name);
    const all = [...names, ...commandNames];
    const label = names.length ? (commandNames.length ? "share" : "mcp") : "commands";
    const first = slugifySkillName(all[0]!);
    const base = all.length === 1 ? `${label}-${first}` : `${label}-${first}-and-${all.length - 1}-more`;
    const slug = uniqueSlug(base, (s) => remoteBranches.has(`${prefix}${s}`));
    let branch = `${prefix}${slug}`;
    let learnedBranchPrefix: string | undefined;
    let version: string | null = null;
    const title = buildSelectionPrTitle(names, commandNames);
    try {
      git(["checkout", "-b", branch], repoDir);
      if (going.length) writeFileSync(target, merged);
      if (goingCommands.length) mkdirSync(join(repoDir, TEAM_COMMANDS_DIR), { recursive: true });
      for (const command of goingCommands) {
        writeFileSync(join(repoDir, TEAM_COMMANDS_DIR, `${command.name}.md`), command.content);
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
      buildSelectionPrBody(going, goingCommands, team.marketplaceName),
      repoDir,
      forge,
    );
    return {
      ok: true,
      ...single,
      ...(names.length ? { serverNames: names } : {}),
      ...(commandNames.length ? { commandNames } : {}),
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

/**
 * What the manager is told after the request is open.
 *
 * Two of these lines exist because the command deliberately does NOT act: the local copy
 * of the server stays where it is (this tool never writes ~/.claude.json), so after the
 * merge the same server is reachable under two names and the tidy-up is a decision only
 * the manager can make.
 */
export function formatMcpShareResult(outcome: TeamPublishOutcome, marketplaceName: string): string {
  const lines = [
    `Shared "${outcome.serverName}" with the team.`,
    "",
    `- branch: ${outcome.branch}`,
    // manualPrUrl returns null for a remote whose host it does not know how to build a
    // "new merge request" link for, and printing "undefined" at someone is worse than
    // telling them the branch is there and the link is theirs to find.
    outcome.prUrl
      ? `- merge request: ${outcome.prUrl}`
      : outcome.manualUrl
        ? `- open the merge request: ${outcome.manualUrl}`
        : "- the branch is pushed; open the merge request in your forge",
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
