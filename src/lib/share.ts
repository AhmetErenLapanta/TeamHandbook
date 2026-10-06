import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  auditServer,
  claudeConfigFile,
  declaredServers,
  readLocalServers,
  refusalMessage,
  refusalSummary,
} from "./mcp.js";
import type { McpAudit, McpServerEntry } from "./mcp.js";
import { auditSkillDir, screenedRefusal } from "./queue.js";
import type { SkillAudit } from "./queue.js";
import { publishTeamSelection } from "./publish.js";
import type { PublishOptions, SkillShareEntry, TeamAssets, TeamPublishOutcome } from "./publish.js";
import { auditCommand, commandFile, commandRefusalSummary, readLocalCommands } from "./commands.js";
import type { CommandAudit, CommandEntry } from "./commands.js";
import { runGit } from "./init.js";
import type { GitRunner, TeamConfig } from "./init.js";
import { forgeNotice, forgeSignInProblem, runForge } from "./forge.js";
import type { ForgeRunner } from "./forge.js";
import { unattachedDescriptionLines } from "./branch.js";
import { overlappingSkills } from "./skill-health.js";
import { listExistingSkills } from "./skill-index.js";
import { listSkillFiles } from "./skill-files.js";
import { displayPath } from "./display-path.js";

// Taking the setup already on this machine to the team.
//
// This used to be three commands. One moved a single skill, one moved a single server,
// and this one moved a selection of both; each was right about the thing it did. Two
// measurements stand against that split. A manager arrives with twenty-two skills and
// two servers installed, of which four should go to the team, and doing that one command
// at a time is a chore nobody finishes - zero skills reached a real team repository in
// the month before a selection existed. And a plain sentence about sharing had three
// commands to choose between and reached the wrong one, which the wording of no single
// description could settle, because the ambiguity was the split. So there is one door,
// and it always opens on the selection screen. Naming a single item costs one more step;
// that price was paid deliberately.
//
// This module reads that setup and runs the selection. Everything selected leaves by ONE
// route: publishTeamSelection, which screens each item for credentials itself before it
// opens a merge request. The screen is advisory; the refusal lives in that single path.
//
// A skill used to be the exception - it was copied into the review queue and stopped there.
// That split is gone. The approval gate exists because the HARVEST proposes things nobody
// asked for; here the user opens the screen and picks their own skill, and that picking is
// the approval, exactly as it already was for a server and a command. /handbook:review
// keeps the job it was built for: the candidates the harvest produced.
//
// Everything here reads ~/.claude/skills, ~/.claude/commands, the current project's
// .claude/skills and .claude/commands, and ~/.claude.json - and, to tell which of those the
// team plugin already carries word for word, that plugin's copy on this machine. It writes
// to none of them, and it deletes nothing: a copy that became a duplicate is named, with
// the command that removes it, for the person to run.

export type InventoryScope = "personal" | "project" | "user";

/**
 * A name the team repository already carries.
 *
 * It is a third state, not a refusal: the thing can still travel, as an update to the
 * team's copy rather than as a new one. Marked rather than filtered because a manager who
 * cannot see it concludes the team does not have it - which is the belief this whole
 * mechanism exists to stop - and because the decision between "update theirs" and "leave it" is
 * theirs to make on a screen, not ours to make in a sort.
 */
export interface OnTeam {
  onTeam?: true;
}

export interface SkillItem extends OnTeam {
  kind: "skill";
  name: string;
  scope: InventoryScope;
  dir: string;
  description: string;
  shareable: boolean;
  /** why it cannot travel as it stands, phrased for someone reading a list */
  reason?: string;
  /** other skills, here or on the team, whose descriptions answer the same requests */
  overlaps?: string[];
}

export interface ServerItem extends OnTeam {
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

export interface CommandItem extends OnTeam {
  kind: "command";
  name: string;
  scope: InventoryScope;
  file: string;
  description: string;
  shareable: boolean;
  reason?: string;
}

export interface Inventory {
  skills: SkillItem[];
  servers: ServerItem[];
  commands: CommandItem[];
}

export interface Selection {
  skills: string[];
  servers: string[];
  commands: string[];
  /**
   * Skill directories named by absolute path instead of picked off the screen.
   *
   * The inventory lists the two directories Claude Code loads skills from, so a skill
   * being written somewhere else - in the repository it belongs to, before it is
   * installed - cannot appear on the screen at all. The single-skill command this
   * replaced took any path on disk without saying so in its own instructions; the
   * capability is kept, and this time the usage line carries it.
   */
  skillPaths?: string[];
}

/**
 * Every directory this feature reads, injectable as a set.
 *
 * The defaults are the real ones. They are parameters because a test of a screen that
 * enumerates the operator's whole machine has no business enumerating the operator's whole
 * machine, and because the requirement behind this made those three paths read-only.
 */
export interface InventoryPaths {
  /** the project whose .claude/skills and MCP scope apply here */
  cwd?: string;
  /** the home whose ~/.claude/skills and ~/.claude/commands load everywhere */
  userHome?: string;
  /** Claude Code's own config file, which holds the MCP servers */
  configFile?: string;
  /**
   * The team repository's skills as this machine's copy of it holds them, for the overlap
   * warning. Read from disk rather than asked of the repository, so the warning costs no request.
   */
  teamSkills?: string | null;
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
      return screenedRefusal(audit);
  }
}

/**
 * A skill as the screen shows it.
 *
 * The review queue is deliberately NOT consulted here. It used to be: while sharing a skill
 * meant copying it into the queue, a skill already sitting there could not be taken in
 * again, so offering it would have spent the manager's attention on an answer already
 * recorded. Now a skill travels to the team instead, the queue is not on its way, and
 * reading it would refuse skills for being somewhere that no longer matters - which is
 * exactly what stranded the ones queued by the old flow. What the team already has is a
 * separate, useful mark, and `onTeam` carries it.
 */
function readSkillDir(dir: string, scope: InventoryScope): SkillItem {
  const name = basename(dir);
  const audit = auditSkillDir(dir);
  const base = { kind: "skill" as const, name, scope, dir, description: audit.summary?.description ?? "" };
  return audit.shareable
    ? { ...base, shareable: true }
    : { ...base, shareable: false, reason: skillRefusal(audit) };
}

function commandItem(entry: CommandEntry, audit: CommandAudit): CommandItem {
  const base = { kind: "command" as const, name: entry.name, scope: entry.scope, file: entry.file };
  return audit.shareable
    ? { ...base, description: audit.description ?? "", shareable: true }
    : { ...base, description: "", shareable: false, reason: commandRefusalSummary(audit) };
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
export function buildInventory(paths: InventoryPaths = {}, teamHas: TeamAssets | null = null): Inventory {
  // Null when nobody asked, and null again when the repository could not be read: both
  // mean "not known", and neither is allowed to read as "not there". An item is marked
  // only on a positive match, so a missing index costs a label and never a refusal.
  const onTeam = <T extends { name: string }>(item: T, names: string[] | undefined): T =>
    names?.includes(item.name) ? { ...item, onTeam: true as const } : item;
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
      byName.set(entry, onTeam(readSkillDir(join(dir, entry), scope), teamHas?.skills));
    }
  }
  // A warning, never a refusal: two skills that answer the same sentence split the routing
  // between them, and which one should give way is the manager's call, made on this screen.
  const skills = [...byName.values()];
  const others = [...skills, ...(paths.teamSkills ? listExistingSkills([paths.teamSkills]) : [])];
  const overlaps = overlappingSkills(skills.filter((s) => s.shareable), others);
  for (const skill of skills) {
    const names = overlaps.get(skill.name);
    if (names?.length) skill.overlaps = names;
  }
  const servers = readLocalServers(paths.configFile ?? claudeConfigFile(), paths.cwd ?? process.cwd()).map(
    (entry) => onTeam(serverItem(entry, auditServer(entry.config)), teamHas?.servers),
  );
  const commands = readLocalCommands(paths.userHome ?? homedir(), paths.cwd ?? process.cwd()).map((entry) =>
    onTeam(commandItem(entry, auditCommand(entry.file, entry.name)), teamHas?.commands),
  );
  return { skills, servers, commands };
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
 * The three sections are labelled with what selecting them DOES. They now do the same
 * thing - every kind travels in one merge request - and saying so per section is what
 * stops a reader assuming the old split, where a skill stopped in the review queue.
 */
/** The third state, said where the refusals are said, so the two cannot be confused: one
 * of these can still go, and what it changes is what happens when it arrives. */
function onTeamNote(item: OnTeam): string {
  return item.onTeam ? "  already on the team: picking it sends an update to their copy" : "";
}

/**
 * `forge` is what the first screen says about how the request will reach the forge, when
 * this machine cannot open it with a CLI. It is said here, before anything is picked,
 * because the alternative was learning it from a result that had already pushed.
 * `duplicates` are the copies the team plugin here already carries word for word.
 */
export function formatInventory(inv: Inventory, forge?: string, duplicates: Duplicates = NO_DUPLICATES): string {
  if (!inv.skills.length && !inv.servers.length && !inv.commands.length) {
    return (
      "No skills, MCP servers or commands are set up on this machine or in this project, so " +
      "there is nothing to take to the team yet."
    );
  }
  const lines = ["Your local Claude Code setup, as it is on this machine:"];
  // Said before the list, not after it: past one dialog the reader is choosing between
  // clicking through rounds and naming what they want, and a person who already knows
  // their own setup has to see the second way before the first one starts. An escape
  // printed after a long list is reached only once the dialogs are already under way.
  const rounds = dialogRounds(inv);
  if (rounds > 1) {
    const offered = shareableEntries(inv).length;
    lines.push(
      "",
      `${offered} of these can be shared, and picking them through dialogs takes ${rounds} rounds.`,
      "Name what you want first instead: type names or patterns such as add-*, all skills or no mcp,",
      "and the dialogs then cover only what is left.",
    );
  }
  if (inv.skills.length) {
    lines.push(
      "",
      `Skills (${inv.skills.length}) - the ones you pick go out as part of ONE merge request to the team repository`,
      "",
    );
    inv.skills.forEach((skill, i) => {
      const state = skill.shareable ? onTeamNote(skill) : `  not shareable: ${skill.reason}`;
      lines.push(`  ${i + 1}. ${skill.name}  [${skill.scope}]${state}`);
      if (skill.shareable) lines.push(`     ${oneLine(skill.description) || "(no description)"}`);
      if (skill.overlaps?.length) {
        lines.push(`     overlaps ${skill.overlaps.join(", ")}: a request that reaches one may reach the other`);
      }
    });
  }
  if (inv.servers.length) {
    lines.push(
      "",
      `MCP servers (${inv.servers.length}) - the ones you pick travel in that SAME merge request`,
      "",
    );
    inv.servers.forEach((server, i) => {
      const needs = server.requiresEnv.length ? `, needs ${server.requiresEnv.join(", ")}` : "";
      const state = server.shareable
        ? server.startsProcess
          ? `shareable (starts a process on every teammate's machine)${needs}`
          : `shareable${needs}`
        : `not shareable: ${server.reason}`;
      lines.push(`  ${i + 1}. ${server.name}  [${server.scope}, ${server.transport}]  ${state}${onTeamNote(server)}`);
    });
  }
  if (inv.commands.length) {
    lines.push(
      "",
      `Commands (${inv.commands.length}) - the ones you pick travel in that SAME merge request, at the same path under commands/`,
      "",
    );
    inv.commands.forEach((command, i) => {
      const state = command.shareable ? onTeamNote(command) : `  not shareable: ${command.reason}`;
      lines.push(`  ${i + 1}. /${command.name}  [${command.scope}]${state}`);
      if (command.shareable) lines.push(`     ${oneLine(command.description) || "(no description)"}`);
    });
  }
  lines.push(
    "",
    "Everything you pick travels together, in one merge request, and other people can see it.",
    "Nothing is selected and nothing has been shared. A skill or a command carrying a",
    "credential is refused rather than redacted, and anything in a server's headers or env",
    "that is not a plain ${VAR} reference stays here: the name of a secret can travel, the",
    "secret cannot.",
    ...(forge ? ["", forge] : []),
  );
  if (duplicates.copies.length) lines.push("", formatDuplicateCopies(duplicates));
  return lines.join("\n");
}

type ItemKind = "skill" | "mcp" | "command";

const KINDS: readonly ItemKind[] = ["skill", "mcp", "command"];

interface Entry {
  kind: ItemKind;
  name: string;
  shareable: boolean;
  reason?: string;
  onTeam?: true;
}

function entries(inv: Inventory): Entry[] {
  return [
    ...inv.skills.map((s) => ({ ...s, kind: "skill" as const })),
    ...inv.servers.map((s) => ({ ...s, kind: "mcp" as const })),
    ...inv.commands.map((c) => ({ ...c, kind: "command" as const })),
  ];
}

function shareableEntries(inv: Inventory): Entry[] {
  return entries(inv).filter((e) => e.shareable);
}

// The question tool's own limits, which commands/share.md works within: four options to a
// question, four questions to a dialog, and each kind asked in questions of its own.
const OPTIONS_PER_QUESTION = 4;
const QUESTIONS_PER_DIALOG = 4;

/** How many dialogs picking from this screen one click at a time would take. */
export function dialogRounds(inv: Inventory): number {
  const offered = shareableEntries(inv);
  const questions = KINDS.map((kind) =>
    Math.ceil(offered.filter((e) => e.kind === kind).length / OPTIONS_PER_QUESTION),
  ).reduce((a, b) => a + b, 0);
  return Math.ceil(questions / QUESTIONS_PER_DIALOG);
}

const KIND_WORDS: Record<string, ItemKind> = {
  skill: "skill",
  skills: "skill",
  mcp: "mcp",
  server: "mcp",
  servers: "mcp",
  command: "command",
  commands: "command",
};

const KIND_LABELS: Record<ItemKind, string> = { skill: "skills", mcp: "MCP servers", command: "commands" };

const KIND_FLAGS: Record<ItemKind, string> = { skill: "--skill", mcp: "--mcp", command: "--command" };

export interface PickResult {
  /** what the expression picked, by name, ready to be shared as it stands */
  selection: Selection;
  /** names the screen could not offer: matched, reported with the reason, never picked */
  unshareable: Array<{ kind: ItemKind; name: string; reason: string }>;
  /** names a `no ...` term ruled out */
  declined: number;
  /** shareable names the expression left undecided - the only ones a dialog still asks about */
  remaining: Selection;
  /** names that will travel as an update to the team's own copy */
  onTeam: string[];
  offered: number;
}

/**
 * A glob over a name: `*` any run, `?` one character, everything else literal, and the
 * whole name has to match. Case is ignored, the way the share flags already resolve
 * "GitLab" to gitlab.
 */
function globMatcher(pattern: string): RegExp {
  const body = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${body}$`, "i");
}

/**
 * Turn what a person typed into a selection, deterministically.
 *
 * The expression is a list separated by commas: names and globs (`add-*`) pick, `all`
 * with a kind (`all skills`) or alone picks every shareable entry, and `no` followed by
 * a kind, a name or a glob rules entries out. The rest is left for the dialogs.
 *
 * Every refusal here stops the whole pick rather than skipping a term, because the person
 * reads the result as what they said: a name that matched nothing is a typo or a thing
 * that is not on this machine, and dropping it silently would share the other half of
 * the sentence as if it were all of it. A pattern made of nothing but wildcards is
 * refused the same way. It would pick everything without the word for everything ever
 * being typed, and picking everything is the answer this screen exists to stop being the
 * default - so "all" has to be written out.
 */
export function pickByPattern(inv: Inventory, expression: string): PickResult | { error: string } {
  const all = entries(inv);
  const key = (e: Entry) => `${e.kind}:${e.name}`;
  const picked = new Set<string>();
  const ruledOut = new Set<string>();
  const segments = expression
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!segments.length) return { error: "nothing to pick: type names or patterns, such as add-* or all skills" };
  const matching = (word: string): Entry[] | { error: string } => {
    const name = word.replace(/^\//, "");
    if (/^[*?]+$/.test(name)) {
      return {
        error: `"${word}" on its own would pick everything without saying so; write "all" (or "all skills") if that is what you mean`,
      };
    }
    const re = globMatcher(name);
    const hits = all.filter((e) => re.test(e.name));
    return hits.length
      ? hits
      : { error: `"${word}" matches nothing on this screen, so nothing was picked; use the names the list printed` };
  };
  // "all" and "no" each open a run that lasts to the next of them or to the comma, so
  // "add-* no mcp" reads the way it is said rather than as a name called "no".
  for (const segment of segments) {
    let mode: "pick" | "all" | "no" = "pick";
    let terms = 0;
    const close = (): { error: string } | null => {
      if (mode === "all" && !terms) for (const e of all) if (e.shareable) picked.add(key(e));
      return mode === "no" && !terms ? { error: `"no" needs a kind, a name or a pattern after it` } : null;
    };
    for (const word of segment.split(/\s+/)) {
      const lower = word.toLowerCase();
      if (lower === "all" || lower === "no") {
        const unfinished = close();
        if (unfinished) return unfinished;
        mode = lower;
        terms = 0;
        continue;
      }
      terms += 1;
      const kind = KIND_WORDS[lower];
      if (mode === "all") {
        if (!kind) return { error: `"all" takes skills, mcp or commands, not "${word}"` };
        for (const e of all) if (e.kind === kind && e.shareable) picked.add(key(e));
        continue;
      }
      const into = mode === "no" ? ruledOut : picked;
      if (kind && mode === "no") {
        for (const e of all) if (e.kind === kind) into.add(key(e));
        continue;
      }
      const hits = matching(word);
      if ("error" in hits) return hits;
      for (const e of hits) into.add(key(e));
    }
    const unfinished = close();
    if (unfinished) return unfinished;
  }
  const chosen = all.filter((e) => picked.has(key(e)) && !ruledOut.has(key(e)));
  const names = (from: Entry[], kind: ItemKind) => from.filter((e) => e.kind === kind).map((e) => e.name);
  const going = chosen.filter((e) => e.shareable);
  const open = all.filter((e) => e.shareable && !picked.has(key(e)) && !ruledOut.has(key(e)));
  return {
    selection: { skills: names(going, "skill"), servers: names(going, "mcp"), commands: names(going, "command") },
    unshareable: chosen
      .filter((e) => !e.shareable)
      .map((e) => ({ kind: e.kind, name: e.name, reason: e.reason ?? "it cannot be shared" })),
    declined: all.filter((e) => e.shareable && ruledOut.has(key(e))).length,
    remaining: { skills: names(open, "skill"), servers: names(open, "mcp"), commands: names(open, "command") },
    onTeam: going.filter((e) => e.onTeam).map((e) => e.name),
    offered: all.filter((e) => e.shareable).length,
  };
}

function namesOf(selection: Selection, kind: ItemKind): string[] {
  return kind === "skill" ? selection.skills : kind === "mcp" ? selection.servers : selection.commands;
}

function countByKind(selection: Selection): string {
  return KINDS.filter((kind) => namesOf(selection, kind).length)
    .map((kind) => `${namesOf(selection, kind).length} ${KIND_LABELS[kind]}`)
    .join(", ");
}

/** A word a POSIX shell reads back as itself: bare when it is safe, single-quoted otherwise.
 * A leading `~/` stays outside the quotes so the shell still expands it. */
export function shellWord(word: string): string {
  if (/^[\w@%+=:,./~-]+$/.test(word)) return word;
  const home = word.startsWith("~/") ? "~/" : "";
  return `${home}'${word.slice(home.length).replace(/'/g, `'\\''`)}'`;
}

/**
 * What a pick resolved to, in the words and numbers the person checks it by, and the one
 * command that shares exactly that. Every name is printed: the result is what they agree
 * to, and "4 skills" is not something anyone can agree to without seeing which four.
 */
export function formatPick(result: PickResult): string {
  const { selection } = result;
  const count = KINDS.reduce((n, kind) => n + namesOf(selection, kind).length, 0);
  const lines = [
    count
      ? `Picked ${count} of the ${result.offered} that can be shared:`
      : `Nothing picked yet, of the ${result.offered} that can be shared.`,
  ];
  for (const kind of KINDS) {
    const names = namesOf(selection, kind);
    if (names.length) lines.push(`  ${KIND_LABELS[kind]} (${names.length}): ${names.join(", ")}`);
  }
  if (result.onTeam.length) {
    lines.push(`  already on the team, so picking them sends an update to their copy: ${result.onTeam.join(", ")}`);
  }
  if (result.unshareable.length) {
    lines.push(
      "",
      `Matched but not shareable (${result.unshareable.length}), so not picked:`,
      ...result.unshareable.map((u) => `  ${u.name} - ${u.reason}`),
    );
  }
  if (result.declined) lines.push("", `Ruled out: ${result.declined}.`);
  const left = countByKind(result.remaining);
  lines.push(
    "",
    left
      ? `Not decided yet: ${left}. A dialog asks only about these, if you want any of them.`
      : "Nothing is left to decide.",
  );
  if (count) {
    const flags = KINDS.flatMap((kind) =>
      namesOf(selection, kind).map((name) => `${KIND_FLAGS[kind]} ${shellWord(name)}`),
    );
    lines.push("", "Nothing has been shared. To share exactly these:", `  share.js share ${flags.join(" ")}`);
  }
  return lines.join("\n");
}

export interface DuplicateCopy {
  kind: ItemKind;
  name: string;
  /** the command that removes this machine's own copy: printed for the person, never run */
  remove: string;
}

export interface Duplicates {
  copies: DuplicateCopy[];
  /**
   * The team plugin release the comparison was made against. Claude Code pulls the
   * marketplace in the background and updates the installed plugin separately, so this
   * copy can be ahead of the one that actually loads; removing yours before the installed
   * one reaches this version would leave neither. The screen names it so the person can
   * check that first.
   */
  release: { name: string; version: string } | null;
}

const NO_DUPLICATES: Duplicates = { copies: [], release: null };

function pluginRelease(pluginDir: string): Duplicates["release"] {
  try {
    const manifest = JSON.parse(readFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), "utf8"));
    return typeof manifest?.name === "string" && typeof manifest?.version === "string"
      ? { name: manifest.name, version: manifest.version }
      : null;
  } catch {
    return null;
  }
}

function digest(parts: Array<string | Buffer>): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part).update("\0");
  return hash.digest("hex");
}

/** A skill directory's content as one hash: every file's path and bytes, in a fixed order.
 * Null when it cannot all be read, which can only ever mean "not known to be the same". */
function skillDigest(dir: string): string | null {
  const { files, skipped } = listSkillFiles(dir);
  if (skipped.length || !files.length) return null;
  try {
    return digest(files.flatMap((file) => [file, readFileSync(join(dir, file))]));
  } catch {
    return null;
  }
}

function fileDigest(file: string): string | null {
  try {
    return digest([readFileSync(file)]);
  } catch {
    return null;
  }
}

/** A server definition with its keys sorted, so the team file's formatting cannot make two
 * identical definitions look different. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * The entries this machine now has twice: once as the person's own copy, and once inside
 * the team plugin, with the same content.
 *
 * The same content, not the same name. A name the team carries can hold a different
 * definition - an older version, a teammate's edit - and a person told "yours is a
 * duplicate" would remove the copy that was actually theirs. So a skill compares every
 * file, a command its bytes, a server its whole definition, and anything that cannot be
 * read is not a duplicate.
 *
 * Only copies that live on this machine alone are named. A skill or command in the
 * project's own .claude directory belongs to that repository and to everyone who works in
 * it, and removing it there is a change to their setup too; servers are this machine's in
 * both scopes, since both live in the client's own state file.
 *
 * Nothing is removed here. The command is printed because it is the one step the person
 * would otherwise have to look up, and the decision to take it stays theirs.
 */
export function duplicateCopies(inv: Inventory, pluginDir: string, paths: InventoryPaths = {}): Duplicates {
  const shown = (path: string) => shellWord(displayPath(path, paths.userHome));
  const found: DuplicateCopy[] = [];
  for (const skill of inv.skills) {
    if (skill.scope !== "personal") continue;
    const theirs = join(pluginDir, "skills", skill.name);
    if (!isDirectory(theirs)) continue;
    const mine = skillDigest(skill.dir);
    if (mine && mine === skillDigest(theirs)) {
      found.push({ kind: "skill", name: skill.name, remove: `rm -r ${shown(skill.dir)}` });
    }
  }
  let declared: Record<string, unknown> = {};
  try {
    declared = declaredServers(readFileSync(join(pluginDir, ".mcp.json"), "utf8"));
  } catch {
    // no team servers on this machine, so none of these can be a duplicate
  }
  for (const server of inv.servers) {
    if (!(server.name in declared)) continue;
    if (canonicalJson(server.entry.config) !== canonicalJson(declared[server.name])) continue;
    // Claude Code calls the per-project servers in its state file "local"; "project" is
    // its name for a repository's .mcp.json, which is not what this read.
    const scope = server.scope === "user" ? "user" : "local";
    found.push({ kind: "mcp", name: server.name, remove: `claude mcp remove ${shellWord(server.name)} -s ${scope}` });
  }
  for (const command of inv.commands) {
    if (command.scope !== "personal") continue;
    const mine = fileDigest(command.file);
    if (mine && mine === fileDigest(join(pluginDir, "commands", commandFile(command.name)))) {
      found.push({ kind: "command", name: command.name, remove: `rm ${shown(command.file)}` });
    }
  }
  return found.length ? { copies: found, release: pluginRelease(pluginDir) } : NO_DUPLICATES;
}

/** The duplicates, by name, then the commands - said as an offer, with nothing done. */
export function formatDuplicateCopies({ copies, release }: Duplicates): string {
  if (!copies.length) return "";
  const lines = [`On this machine twice (${copies.length}): the team plugin here carries an identical copy of each.`];
  for (const kind of KINDS) {
    const names = copies.filter((d) => d.kind === kind).map((d) => (kind === "command" ? `/${d.name}` : d.name));
    if (names.length) lines.push(`  ${KIND_LABELS[kind]}: ${names.join(", ")}`);
  }
  lines.push(
    "Nothing was removed, and both copies load until yours goes. Once /plugin shows",
    release
      ? `${release.name} installed at ${release.version} or later, these remove your own copies:`
      : "the team plugin installed and up to date, these remove your own copies:",
    ...copies.map((d) => `  ${d.remove}`),
  );
  return lines.join("\n");
}

/** The first screen's sentence about the merge request, or undefined when this machine
 * can open one. Asked of the same check every push makes, so the screen and the push
 * cannot disagree about it. */
export function forgeLine(team: TeamConfig | null, forge: ForgeRunner = runForge, cwd: string = process.cwd()): string | undefined {
  if (!team) return undefined;
  const problem = forgeSignInProblem(team.repoUrl, cwd, forge);
  return problem ? forgeNotice(team.repoUrl, problem) : undefined;
}

export interface ShareResult {
  /** the one request everything selected went out in, absent when nothing did */
  team?: TeamPublishOutcome;
  /** anything named that did not travel, with the reason the path that refused it gave.
   * `collision` marks the refusals that have a route out of them, so the report can group
   * them and name that route per item instead of the reader matching on prose. */
  refused: Array<{
    name: string;
    kind: "skill" | "mcp" | "command";
    reason: string;
    collision?: true;
    /**
     * How to name this one item again on a retry, flag and value.
     *
     * Only the caller knows it: a skill picked off the screen is `--skill <name>`, but one
     * named by path was never on the screen, so `--skill <name>` would come back "no skill
     * of that name is installed here". A refusal that names a command which fails when you
     * run it is the exact defect the collision message avoids by not naming one itself.
     */
    selector?: string;
  }>;
}

/**
 * Run the selection.
 *
 * Everything picked travels in ONE merge request, whatever kind it is. Skills used to be
 * handled first and separately because they stopped in the review queue; now that they go
 * to the team, splitting them out would open a second request for the same selection - and
 * two requests opened before either is merged both claim the same plugin version, which is
 * the defect publishTeamSelection exists to make impossible.
 *
 * Every selected item is handed to publishTeamSelection even when the screen already marked
 * it refused. That path owns the credential sieve, and a batch that decided for itself
 * which items were worth screening would be exactly the shortcut this safeguard exists to
 * prevent.
 */
export function shareSelection(
  selection: Selection,
  team: TeamConfig | null,
  paths: InventoryPaths = {},
  git: GitRunner = runGit,
  forge: ForgeRunner = runForge,
  options: PublishOptions = {},
): ShareResult {
  const result: ShareResult = { refused: [] };
  const inv = buildInventory(paths);
  const skills: SkillShareEntry[] = [];
  for (const name of selection.skills) {
    const skill = inv.skills.find((s) => s.name === name);
    if (!skill) {
      result.refused.push({ name, kind: "skill", reason: "no skill of that name is installed here" });
      continue;
    }
    skills.push({ name, dir: skill.dir, namedBy: "inventory" });
  }
  // Named by path, so there is no inventory entry to look up and nothing to check the name
  // against. The audit inside publishTeamSelection is still the only way out: it reads the
  // directory and refuses a credential exactly as it does for a skill picked off the screen.
  for (const dir of selection.skillPaths ?? []) {
    skills.push({ name: basename(dir), dir, namedBy: "user" });
  }
  const entries: McpServerEntry[] = [];
  for (const name of selection.servers) {
    const server = inv.servers.find((s) => s.name === name);
    if (!server) result.refused.push({ name, kind: "mcp", reason: "no MCP server of that name is configured here" });
    else entries.push(server.entry);
  }
  const commands: CommandEntry[] = [];
  for (const name of selection.commands) {
    const command = inv.commands.find((c) => c.name === name);
    if (!command) result.refused.push({ name, kind: "command", reason: "no command of that name is installed here" });
    else commands.push({ name: command.name, scope: command.scope === "project" ? "project" : "personal", file: command.file });
  }
  if (!entries.length && !commands.length && !skills.length) return result;
  if (!team) {
    // Every kind needs the repository now, so every kind is turned back by name rather
    // than one of them appearing to have succeeded.
    const reason = "no team repository is configured. Run /handbook:init (or /handbook:join <url>) first";
    for (const skill of skills) result.refused.push({ name: skill.name, kind: "skill", reason });
    for (const entry of entries) result.refused.push({ name: entry.name, kind: "mcp", reason });
    for (const command of commands) result.refused.push({ name: command.name, kind: "command", reason });
    return result;
  }
  const outcome = publishTeamSelection({ servers: entries, commands, skills }, team, git, forge, options);
  result.team = outcome;
  const selectors = new Map(
    skills.map((skill) => [
      skill.name,
      skill.namedBy === "user" ? `--skill-path ${skill.dir}` : `--skill ${skill.name}`,
    ]),
  );
  for (const refusal of outcome.refused ?? []) {
    const selector =
      refusal.kind === "skill"
        ? selectors.get(refusal.name)
        : refusal.kind === "mcp"
          ? `--mcp ${refusal.name}`
          : `--command ${refusal.name}`;
    result.refused.push({
      name: refusal.name,
      kind: refusal.kind,
      reason: refusal.reason,
      ...(refusal.collision ? { collision: true as const } : {}),
      ...(selector ? { selector } : {}),
    });
  }
  // A whole-request failure (an unreadable team file, a rejected push, no git identity)
  // names no single item, so it would otherwise be reported about nothing at all. The ones
  // already turned back keep the reason they were turned back for - and the set is keyed
  // by kind as well as name, because a server and a command may share one.
  // The one whole-request failure that is NOT fanned out: a request stopped for want of a
  // commit message was not refused item by item, and repeating one four-line sentence
  // against every name the user picked buries the proposal it is asking them to read.
  // formatShareResult prints it once instead, and the CLI still exits non-zero for it.
  if (!outcome.ok && outcome.error && !outcome.proposedMessage) {
    const judged = new Set((outcome.refused ?? []).map((r) => `${r.kind}:${r.name}`));
    for (const skill of skills) {
      if (!judged.has(`skill:${skill.name}`)) {
        result.refused.push({ name: skill.name, kind: "skill", reason: outcome.error });
      }
    }
    for (const entry of entries) {
      if (!judged.has(`mcp:${entry.name}`)) result.refused.push({ name: entry.name, kind: "mcp", reason: outcome.error });
    }
    for (const command of commands) {
      if (!judged.has(`command:${command.name}`)) {
        result.refused.push({ name: command.name, kind: "command", reason: outcome.error });
      }
    }
  }
  return result;
}

/**
 * What happened, listed by kind because one request carried three kinds of thing.
 *
 * Named per kind rather than totalled: a skill somebody reads, a server that connects and
 * a command somebody types are not interchangeable, and the manager checking what they
 * just sent reads this line, not the merge request.
 */
export function formatShareResult(
  result: ShareResult,
  marketplaceName?: string,
  duplicates: Duplicates = NO_DUPLICATES,
): string {
  const lines: string[] = [];
  const shared = result.team;
  if (shared?.ok) {
    const servers = shared.serverNames ?? [];
    const commands = shared.commandNames ?? [];
    const skills = shared.skillNames ?? [];
    lines.push(
      `Shared with the team (${skills.length + servers.length + commands.length}) in one merge request:`,
    );
    if (skills.length) lines.push(`  - skills (${skills.length}): ${skills.join(", ")}`);
    if (servers.length) lines.push(`  - MCP servers (${servers.length}): ${servers.join(", ")}`);
    if (commands.length) lines.push(`  - commands (${commands.length}): ${commands.join(", ")}`);
    // Named separately from the list above, because "shared" and "replaced what the team
    // was using" are not the same event and the manager is entitled to see which happened.
    const updated = [
      ...(shared.updated?.skills ?? []),
      ...(shared.updated?.servers ?? []),
      ...(shared.updated?.commands ?? []),
    ];
    if (updated.length) {
      lines.push(
        `  - sent as an update to the team's own copy (${updated.length}): ${updated.join(", ")} - the merge replaces theirs`,
      );
    }
    lines.push(
      `  - branch: ${shared.branch}`,
      // What the commit actually says, not what was offered: the message may be the user's
      // own wording, and it may have gained the team's prefix on the way in.
      `  - commit: ${shared.commitMessage}`,
      // manualPrUrl returns null for a remote whose host it does not know how to build a
      // "new merge request" link for. The branch is pushed either way, and printing
      // "undefined" at someone is worse than telling them the link is theirs to find.
      shared.prUrl
        ? `  - merge request: ${shared.prUrl}`
        : shared.manualUrl
          ? `  - open the merge request: ${shared.manualUrl}`
          : "  - the branch is pushed; open the merge request in your forge",
    );
    if (shared.prError) lines.push(`    (the forge CLI could not open it: ${shared.prError})`);
    if (shared.version) {
      lines.push(`  - plugin version raised to ${shared.version}, which is what makes teammates fetch it`);
    }
    if (shared.requiresEnv?.length) {
      lines.push(
        `  - each teammate must set ${shared.requiresEnv.join(", ")} in their own environment, ` +
          "or those servers will not start for them",
      );
    }
    if (shared.startsProcess) {
      lines.push("  - at least one of these starts a process on every teammate's machine; the request says which");
    }
    if (marketplaceName && servers.length) {
      lines.push(
        `  - after the merge they appear as plugin:${marketplaceName}:<name>. Your own copies are untouched:`,
        "    this never writes to ~/.claude.json, so you will see both until you remove yours.",
      );
    }
    if (marketplaceName && commands.length) {
      lines.push(
        `  - after the merge the commands are typed as /${marketplaceName}:<name>. Your own are untouched:`,
        "    this never writes to ~/.claude/commands, so both names keep working.",
      );
    }
    // The copies this request makes into duplicates do not exist as duplicates yet: they
    // become that only once it is merged and the plugin is updated here. So the reader is
    // told where they will be named, rather than left to find out they have two of each.
    if (marketplaceName) {
      lines.push(
        "  - once it is merged and the plugin is updated here, /handbook:share names each of your copies",
        "    that became a duplicate, with the command that removes it",
      );
    }
    lines.push(...unattachedDescriptionLines(shared.unattachedDescription));
  }
  // Asked for once, about the whole request, because the request is what it is about.
  if (shared && !shared.ok && shared.proposedMessage && shared.error) {
    lines.push(shared.error);
  }
  // Two kinds of refusal, kept apart. One is a fault the user has to fix in their own
  // setup (a credential, an unreadable file); the other is a name the team already uses,
  // which is a question with an answer. Reading them as one list makes the second look
  // like the first, and the answer to it - naming that one item to --update - is the
  // thing the reader is here for.
  const collisions = result.refused.filter((r) => r.collision);
  const faults = result.refused.filter((r) => !r.collision);
  if (faults.length) {
    if (lines.length) lines.push("");
    lines.push(`Not taken (${faults.length}):`, ...faults.map((r) => `  ${r.name} - ${r.reason}`));
  }
  if (collisions.length) {
    if (lines.length) lines.push("");
    // Which retry to print depends on whether the rest of the selection travelled. It did
    // on a run that committed; it did NOT on a run that stopped for want of a commit
    // message, and there the one-item command below would split one selection into two
    // merge requests - two requests opened before either is merged claim the same plugin
    // version, and the second reaches nobody. That is the defect one request exists to
    // prevent, so the advice changes rather than the reader being expected to notice.
    const travelled = !!shared?.ok;
    lines.push(
      `The team already has these (${collisions.length})${travelled ? " - theirs is untouched:" : ":"}`,
      ...collisions.map((r) => `  ${r.name} - ${r.reason}`),
      "",
      ...(travelled
        ? [
            "To send one of them as an update to the team's copy, name that one and only that one:",
            // The selector the run itself recorded, not one rebuilt from the kind: a skill
            // named by path is re-named by that path, and printing "--skill <name>" for it
            // would hand the reader a command that comes back "no skill of that name is
            // installed here".
            ...collisions.map((r) => `  share.js share ${r.selector ?? `--skill ${r.name}`} --update ${r.name}`),
          ]
        : [
            "Nothing has been shared yet, so these are answered on the same run as the rest:",
            `add ${collisions.map((r) => `--update ${r.name}`).join(" ")} to the whole selection, for the`,
            "names the user said yes to and no others, and run it again.",
          ]),
    );
  }
  if (duplicates.copies.length) {
    if (lines.length) lines.push("");
    lines.push(formatDuplicateCopies(duplicates));
  }
  if (!lines.length) return "Nothing was selected, so nothing was shared.";
  return lines.join("\n");
}
