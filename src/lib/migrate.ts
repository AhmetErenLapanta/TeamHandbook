import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { auditServer, claudeConfigFile, readLocalServers, refusalMessage, refusalSummary } from "./mcp.js";
import type { McpAudit, McpServerEntry } from "./mcp.js";
import { auditSkillDir, intakeSkill, readCandidateMeta } from "./queue.js";
import type { CandidateStatus, SkillAudit } from "./queue.js";
import { candidatesDir } from "./skill-index.js";
import { handbookHome } from "./session-state.js";
import { publishMcpServers } from "./publish.js";
import type { McpPublishOutcome } from "./publish.js";
import { runGit } from "./init.js";
import type { GitRunner, TeamConfig } from "./init.js";
import { runForge } from "./forge.js";
import type { ForgeRunner } from "./forge.js";

// Taking a whole local setup to the team, rather than one thing at a time.
//
// /handbook:share-skill moves one skill and /handbook:mcp moves one server, and both were
// measured to be right about the thing they do. What neither of them can do is the thing a
// manager actually arrives with: twenty-two skills and two servers already installed, of
// which four should go to the team. Doing that one command at a time is a chore nobody
// finishes, and the evidence is that nobody did - zero skills reached a real team
// repository in the month before this existed.
//
// This module reads that setup and runs the selection. It opens no new route out of the
// machine: a selected skill goes through intakeSkill, a selected server through
// publishMcpServers, and both of those screen for credentials themselves. The screen is
// advisory; the refusal lives where it lived before.
//
// Everything here reads ~/.claude/skills, the current project's .claude/skills and
// ~/.claude.json. It writes to none of them.

export type InventoryScope = "personal" | "project" | "user";

export interface SkillItem {
  kind: "skill";
  name: string;
  scope: InventoryScope;
  dir: string;
  description: string;
  shareable: boolean;
  /** why it cannot travel as it stands, phrased for someone reading a list */
  reason?: string;
}

export interface ServerItem {
  kind: "mcp";
  name: string;
  scope: InventoryScope;
  entry: McpServerEntry;
  transport: string;
  startsProcess: boolean;
  requiresEnv: string[];
  shareable: boolean;
  reason?: string;
  /** the same refusal with the fix spelled out, for when it is reported rather than listed */
  fullReason?: string;
}

export interface Inventory {
  skills: SkillItem[];
  servers: ServerItem[];
}

export interface Selection {
  skills: string[];
  servers: string[];
}

/**
 * Every directory this feature reads, injectable as a set.
 *
 * The defaults are the real ones. They are parameters because a test of a screen that
 * enumerates the operator's whole machine has no business enumerating the operator's whole
 * machine, and because the card that asked for this made those three paths read-only.
 */
export interface InventoryPaths {
  /** ~/.teamhandbook, for the review queue this cross-checks against */
  home?: string;
  /** the project whose .claude/skills and MCP scope apply here */
  cwd?: string;
  /** the home whose ~/.claude/skills holds the skills that load everywhere */
  userHome?: string;
  /** Claude Code's own config file, which holds the MCP servers */
  configFile?: string;
}

/**
 * Where a skill this machine loads can be: the user-level directory that loads in every
 * project, and the current project's own.
 *
 * Mirrors readLocalServers deliberately. A manager's setup is both, the client resolves
 * the project one over the personal one when the names collide, and offering a list that
 * disagrees with what Claude Code actually loads would share the wrong file.
 */
export function localSkillDirs(paths: InventoryPaths = {}): Array<{ dir: string; scope: InventoryScope }> {
  return [
    { dir: join(paths.userHome ?? homedir(), ".claude", "skills"), scope: "personal" },
    { dir: join(paths.cwd ?? process.cwd(), ".claude", "skills"), scope: "project" },
  ];
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function queueState(home: string, name: string): CandidateStatus | null {
  const dir = join(candidatesDir(home), name);
  if (!existsSync(dir)) return null;
  return readCandidateMeta(dir)?.status ?? "pending";
}

function skillRefusal(audit: SkillAudit): string {
  switch (audit.reason) {
    case "unsafe-name":
      return "its directory name cannot be a skill name (lowercase letters, digits and dashes)";
    case "no-skill-md":
      return "it has no readable SKILL.md";
    case "no-frontmatter":
      return "its SKILL.md has no name and description frontmatter";
    case "irregular-entry":
      return `it contains "${audit.detail}", which is not a regular file`;
    case "no-files":
      return "it has no files to share";
    case "unreadable":
      return `"${audit.detail}" cannot be read, so it cannot be screened`;
    default:
      return `"${audit.secret?.file}" looks like it contains a secret (${audit.detail})`;
  }
}

function readSkillDir(dir: string, scope: InventoryScope, home: string): SkillItem {
  const name = basename(dir);
  const audit = auditSkillDir(dir);
  const queued = queueState(home, name);
  const base = { kind: "skill" as const, name, scope, dir, description: audit.summary?.description ?? "" };
  // A skill already in the queue is offered nowhere, whatever the queue decided about it:
  // intakeSkill refuses all four states, and a screen that offers it anyway spends the
  // manager's attention on an answer that is already recorded.
  if (queued) {
    return {
      ...base,
      shareable: false,
      reason: queued === "pending" ? "already waiting in the review queue" : `already ${queued} in the review queue`,
    };
  }
  return audit.shareable
    ? { ...base, shareable: true }
    : { ...base, shareable: false, reason: skillRefusal(audit) };
}

function serverItem(entry: McpServerEntry, audit: McpAudit): ServerItem {
  const base = {
    kind: "mcp" as const,
    name: entry.name,
    scope: entry.scope as InventoryScope,
    entry,
    transport: audit.transport,
    startsProcess: audit.startsProcess,
    requiresEnv: audit.requiresEnv,
  };
  // The short form here and the full one in the result: a list wants the fact, and the
  // refusal the user acts on wants the sentence that names the fix.
  return audit.migratable
    ? { ...base, shareable: true }
    : { ...base, shareable: false, reason: refusalSummary(audit), fullReason: refusalMessage(entry.name, audit) };
}

/**
 * The whole local setup, read and judged, in one pass.
 *
 * Read-only from end to end. The judgement is the same code the delivery paths run
 * (auditSkillDir, auditServer), which is the point: a preview written against its own
 * copy of the rules drifts, and the direction it drifts in is a screen that offers
 * something the sieve refuses.
 */
export function buildInventory(paths: InventoryPaths = {}): Inventory {
  const home = paths.home ?? handbookHome();
  const byName = new Map<string, SkillItem>();
  for (const { dir, scope } of localSkillDirs(paths)) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    // project scope overwrites personal for the same name, which is the skill Claude Code
    // actually loads in this directory
    for (const entry of entries.sort()) {
      // statSync rather than a Dirent: it follows symlinks, and a skill directory symlinked
      // in from somewhere else is a skill this machine loads. What it filters out is the
      // ordinary file sitting beside the skills - .DS_Store is in the real directory this
      // was measured against - which is not a skill that failed, it is not a skill.
      if (!isDirectory(join(dir, entry))) continue;
      byName.set(entry, readSkillDir(join(dir, entry), scope, home));
    }
  }
  const servers = readLocalServers(paths.configFile ?? claudeConfigFile(), paths.cwd ?? process.cwd()).map(
    (entry) => serverItem(entry, auditServer(entry.config)),
  );
  return { skills: [...byName.values()], servers };
}

// Long enough to tell two skills apart, short enough that twenty-two of them still read
// as a list. Hand-written descriptions carry their trigger phrases and run past 400
// characters; the whole text is one /handbook:review show away.
const DESCRIPTION_CHARS = 150;

function oneLine(text: string): string {
  const first = text.split("\n")[0]!.trim();
  return first.length > DESCRIPTION_CHARS ? `${first.slice(0, DESCRIPTION_CHARS).trimEnd()}...` : first;
}

/**
 * The read-only first screen.
 *
 * Refused entries are listed with everything else rather than filtered out, for the
 * reason formatServerList already gives: a manager who sees only what is offered
 * concludes the rest does not exist, while one who reads "headers.Authorization holds a
 * literal value" knows there is one edit between them and sharing it.
 *
 * The two halves are labelled with what selecting them DOES, because they do different
 * things. A skill lands in the review queue and stays on this machine; a server opens a
 * merge request. Reading "shared" over both would be wrong about one of them.
 */
export function formatInventory(inv: Inventory): string {
  if (!inv.skills.length && !inv.servers.length) {
    return (
      "No skills and no MCP servers are set up on this machine or in this project, so there " +
      "is nothing to take to the team yet."
    );
  }
  const lines = ["Your local Claude Code setup, as it is on this machine:"];
  if (inv.skills.length) {
    lines.push(
      "",
      `Skills (${inv.skills.length}) - the ones you pick are copied into the review queue; nothing leaves this machine`,
      "",
    );
    inv.skills.forEach((skill, i) => {
      lines.push(`  ${i + 1}. ${skill.name}  [${skill.scope}]${skill.shareable ? "" : `  not shareable: ${skill.reason}`}`);
      if (skill.shareable) lines.push(`     ${oneLine(skill.description) || "(no description)"}`);
    });
  }
  if (inv.servers.length) {
    lines.push(
      "",
      `MCP servers (${inv.servers.length}) - the ones you pick go out together as ONE merge request to the team repository`,
      "",
    );
    inv.servers.forEach((server, i) => {
      const needs = server.requiresEnv.length ? `, needs ${server.requiresEnv.join(", ")}` : "";
      const state = server.shareable
        ? server.startsProcess
          ? `shareable (starts a process on every teammate's machine)${needs}`
          : `shareable${needs}`
        : `not shareable: ${server.reason}`;
      lines.push(`  ${i + 1}. ${server.name}  [${server.scope}, ${server.transport}]  ${state}`);
    });
  }
  lines.push(
    "",
    "Nothing is selected and nothing has been shared. A skill carrying a credential is",
    "refused rather than redacted, and anything in a server's headers or env that is not a",
    "plain ${VAR} reference stays here: the name of a secret can travel, the secret cannot.",
  );
  return lines.join("\n");
}

export interface MigrateResult {
  /** skills now waiting in the review queue */
  queued: string[];
  /** the request the selected servers went out in, absent when none were selected */
  mcp?: McpPublishOutcome;
  /** anything named that did not travel, with the reason the path that refused it gave */
  refused: Array<{ name: string; kind: "skill" | "mcp"; reason: string }>;
}

/**
 * Run the selection.
 *
 * The order is deliberate: the reversible half first. Queueing a skill writes only to
 * ~/.teamhandbook and can be undone in /handbook:review; the servers open a merge request
 * that other people can see. A failure in the second half must not cost the first.
 *
 * Every selected skill is handed to intakeSkill even when the screen already marked it
 * refused, and every selected server to publishMcpServers. Those two own the credential
 * sieve, and a batch that decided for itself which items were worth screening would be
 * exactly the shortcut this card is easiest to break with.
 */
export function shareSelection(
  selection: Selection,
  team: TeamConfig | null,
  paths: InventoryPaths = {},
  git: GitRunner = runGit,
  forge: ForgeRunner = runForge,
): MigrateResult {
  const home = paths.home ?? handbookHome();
  const result: MigrateResult = { queued: [], refused: [] };
  const inv = buildInventory(paths);
  for (const name of selection.skills) {
    const skill = inv.skills.find((s) => s.name === name);
    if (!skill) {
      result.refused.push({ name, kind: "skill", reason: "no skill of that name is installed here" });
      continue;
    }
    const intake = intakeSkill(skill.dir, home);
    if (intake.ok) result.queued.push(intake.slug!);
    else result.refused.push({ name, kind: "skill", reason: intake.error! });
  }
  if (!selection.servers.length) return result;
  const entries: McpServerEntry[] = [];
  for (const name of selection.servers) {
    const server = inv.servers.find((s) => s.name === name);
    if (!server) result.refused.push({ name, kind: "mcp", reason: "no MCP server of that name is configured here" });
    else entries.push(server.entry);
  }
  if (!entries.length) return result;
  if (!team) {
    for (const entry of entries) {
      result.refused.push({
        name: entry.name,
        kind: "mcp",
        reason: "no team repository is configured. Run /handbook:init (or /handbook:join <url>) first",
      });
    }
    return result;
  }
  const outcome = publishMcpServers(entries, team, git, forge);
  result.mcp = outcome;
  for (const refusal of outcome.refused ?? []) {
    result.refused.push({ name: refusal.name, kind: "mcp", reason: refusal.reason });
  }
  // A whole-request failure (an unreadable team file, a rejected push, no git identity)
  // names no single server, so it would otherwise be reported about nothing at all. The
  // ones already turned back keep the reason they were turned back for.
  if (!outcome.ok && outcome.error) {
    const judged = new Set((outcome.refused ?? []).map((r) => r.name));
    for (const entry of entries) {
      if (!judged.has(entry.name)) result.refused.push({ name: entry.name, kind: "mcp", reason: outcome.error });
    }
  }
  return result;
}

/**
 * What happened, said in two groups because two things happened.
 *
 * The selection was one dialog, but it had two consequences: the skills are on this
 * machine waiting for a verdict, and the servers are in a merge request other people can
 * already read. A single "shared 7 things" line would leave the manager believing they
 * had sent five skills they have not sent.
 */
export function formatMigrateResult(result: MigrateResult, marketplaceName?: string): string {
  const lines: string[] = [];
  if (result.queued.length) {
    lines.push(
      `Queued for review (${result.queued.length}) - nothing has left this machine yet:`,
      ...result.queued.map((slug) => `  ${slug}`),
      "",
      "Run /handbook:review to send them to the team, add them to a project, or keep them.",
    );
  }
  const mcp = result.mcp;
  if (mcp?.ok) {
    const names = mcp.serverNames ?? [];
    if (lines.length) lines.push("");
    lines.push(
      `Shared with the team (${names.length}) in one merge request: ${names.join(", ")}`,
      `  - branch: ${mcp.branch}`,
      // see formatMcpShareResult: a remote whose host manualPrUrl cannot build a link for
      // still got the branch, and "undefined" is not a link
      mcp.prUrl
        ? `  - merge request: ${mcp.prUrl}`
        : mcp.manualUrl
          ? `  - open the merge request: ${mcp.manualUrl}`
          : "  - the branch is pushed; open the merge request in your forge",
    );
    if (mcp.prError) lines.push(`    (the forge CLI could not open it: ${mcp.prError})`);
    if (mcp.version) {
      lines.push(`  - plugin version raised to ${mcp.version}, which is what makes teammates fetch it`);
    }
    if (mcp.requiresEnv?.length) {
      lines.push(
        `  - each teammate must set ${mcp.requiresEnv.join(", ")} in their own environment, ` +
          "or those servers will not start for them",
      );
    }
    if (mcp.startsProcess) {
      lines.push("  - at least one of these starts a process on every teammate's machine; the request says which");
    }
    if (marketplaceName) {
      lines.push(
        `  - after the merge they appear as plugin:${marketplaceName}:<name>. Your own copies are untouched:`,
        "    this never writes to ~/.claude.json, so you will see both until you remove yours.",
      );
    }
  }
  if (result.refused.length) {
    if (lines.length) lines.push("");
    lines.push(`Not taken (${result.refused.length}):`, ...result.refused.map((r) => `  ${r.name} - ${r.reason}`));
  }
  if (!lines.length) return "Nothing was selected, so nothing was queued and nothing was shared.";
  return lines.join("\n");
}
