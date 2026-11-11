import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { git, gitAsync, gitAsyncBytes, gitAsyncMaybe, gitBytes, gitMaybe, oneAtATime } from "./git.js";
import {
  auditServer,
  commandDescription,
  detectSecret,
  MARKETPLACE_MANIFEST,
  parseSkillFrontmatter,
  PLUGIN_MANIFEST,
  refusalSummary,
  TEAM_PREFIX_FILE,
} from "./plugin.js";
import { recordedCommitPrefix } from "./branches.js";
import { versionLineBack } from "./versions.js";
import { CODEOWNERS_FILES } from "./codeowners.js";
import { CI_JOB_FILES, setupFindings, skillFormatProblems } from "./setup.js";
import type { SetupFinding } from "./setup.js";

export interface SkillItem {
  slug: string;
  name: string;
  description: string;
  /** Every file the skill ships, relative to its directory. A skill is more than SKILL.md. */
  files: string[];
  /** Why the frontmatter could not be read, when it could not. */
  problem?: string;
  /** What the plugin's skill format says it lacks; empty when it lacks nothing. */
  format: string[];
}

export interface McpItem {
  name: string;
  transport: "stdio" | "http" | "sse" | "unknown";
  /** The program or URL, as declared; never an argument or a header value. */
  target: string;
  /** Names of the environment variables and headers it declares; their values are not shown. */
  envNames: string[];
  /** The plugin's own share rule applied to the definition already in the repository. */
  shareable: boolean;
  refusal?: string;
  /** Whether an orchestrator task gets it, and why; only on an orchestrator that runs tasks. */
  inTasks?: { usable: boolean; detail: string; signIn: boolean };
}

export interface CommandItem {
  /** As it is typed: a folder under commands/ is a namespace, `git/sync.md` is `git:sync`. */
  name: string;
  description: string;
  file: string;
}

export interface TeamRecord {
  /** Trimmed, and only when the plugin's rule takes it; otherwise `commitPrefixProblem` says why it is left unused. */
  commitPrefix?: string;
  commitPrefixProblem?: string;
  branchExample?: string;
  reviewers?: string[];
  labels?: string[];
  scaffoldVersion?: string;
  /** Where the team asked its teammates' plugins to report skill-use counts, if it did. */
  usageEndpoint?: string;
  problem?: string;
}

export interface Inventory {
  head: string;
  plugin: { name?: string; version?: string; versionedByCommit: boolean };
  marketplace: { name?: string; plugins: string[] };
  skills: SkillItem[];
  mcpServers: McpItem[];
  commands: CommandItem[];
  team: TeamRecord | null;
  /** The setup panel: what teammates can and cannot do with this repository, and what to do. */
  setup: SetupFinding[];
}

export interface HistoryEntry {
  sha: string;
  date: string;
  author: string;
  subject: string;
}

/**
 * A bare mirror of one team repository under the orchestrator's data directory. Reads go
 * through git objects at the mirror's HEAD, so the orchestrator never has a working tree to
 * keep clean and never runs a hook from a repository it does not own. Two syncs of one
 * mirror take turns: git refuses a second fetch into refs the first one has locked.
 */
export function syncMirror(url: string, dir: string, env?: Record<string, string>): Promise<string> {
  const options = env ? { env } : {};
  return oneAtATime(dir, async () => {
    if (!existsSync(dir)) {
      mkdirSync(dirname(dir), { recursive: true });
      // After "--", so an address can never be read as an option.
      await gitAsync(["clone", "--mirror", "--quiet", "--", url, dir], dirname(dir), undefined, undefined, options);
    } else {
      // The address the configuration gives now, not the one the mirror was cloned from: a URL
      // changed to rotate or drop a token is the one fetched, and the old token leaves the
      // mirror's git config.
      await gitAsync(["remote", "set-url", "origin", url], dir);
      await skipOrchestratorRefs(dir);
      await gitAsync(["remote", "update", "--prune"], dir, undefined, undefined, options);
    }
    await dropOrchestratorRefs(dir);
    return (await gitAsync(["rev-parse", "HEAD"], dir)).trim();
  });
}

// Branches the orchestrator moved aside in a team repository (refs/orchestrator/orphaned) are kept
// there to be brought back, not to be read; a mirror leaves them out, so they reach no
// inventory and hold no objects in the orchestrator's own copy.
const ORCHESTRATOR_REFS = "refs/orchestrator/*";

async function skipOrchestratorRefs(dir: string): Promise<void> {
  const fetch = ((await gitAsyncMaybe(["config", "--get-all", "remote.origin.fetch"], dir)) ?? "").split("\n");
  if (!fetch.includes(`^${ORCHESTRATOR_REFS}`)) await gitAsync(["config", "--add", "remote.origin.fetch", `^${ORCHESTRATOR_REFS}`], dir);
}

/** What a clone took before the mirror was told to leave these out, or an older mirror kept. */
async function dropOrchestratorRefs(dir: string): Promise<void> {
  const refs = (await gitAsync(["for-each-ref", "--format=%(refname)", "refs/orchestrator/"], dir)).split("\n").filter(Boolean);
  if (refs.length) await gitAsync(["update-ref", "--stdin"], dir, refs.map((ref) => `delete ${ref}\n`).join(""));
}

interface TreeEntry {
  type: string;
  sha: string;
  /** Bytes, as `ls-tree -l` reports them; 0 for a folder. */
  size: number;
}

/**
 * One commit's files, read with a few git processes however many files the repository has:
 * the whole tree, with each file's size, from one `ls-tree`, then the contents a reader asked
 * for through `cat-file --batch`. Reading each file with its own `git show` cost two processes
 * per skill, which on a repository of thousands of skills is most of a minute.
 */
export interface Tree {
  head: string;
  entries: Map<string, TreeEntry>;
  contents: Map<string, string>;
  /** Each folder's direct children and every file below it, built once, so a reader asking per skill does not walk the whole tree each time. */
  folders: Map<string, { children: { type: string; name: string }[]; files: string[] }>;
}

/** The most of one file the orchestrator reads, the same as one `git show` was allowed. */
export const MAX_FILE_BYTES = 64 * 1024 * 1024;
// One `cat-file --batch` call reads files whose sizes add up to at most this, so a skill
// folder holding several large files is read in several calls instead of overflowing one.
const BATCH_BYTES = 32 * 1024 * 1024;
// The tree's own listing is about 100 bytes a file; this allows a few million files.
const LISTING_BYTES = 512 * 1024 * 1024;

function parseEntries(out: string): Map<string, TreeEntry> {
  const entries = new Map<string, TreeEntry>();
  for (const record of out.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    const [, type, sha, size] = record.slice(0, tab).split(/ +/);
    entries.set(record.slice(tab + 1), { type: type!, sha: sha!, size: size === "-" ? 0 : Number(size) });
  }
  return entries;
}

/** `cat-file --batch` output: a header line, the object's bytes, a newline, for each object asked. */
function parseBatch(bytes: Buffer, into: Map<string, string>): void {
  let at = 0;
  while (at < bytes.length) {
    const end = bytes.indexOf(10, at);
    const [sha, type, size] = bytes.subarray(at, end).toString("utf8").split(" ");
    at = end + 1;
    if (type === "missing" || size === undefined) continue;
    into.set(sha!, bytes.subarray(at, at + Number(size)).toString("utf8"));
    at += Number(size) + 1;
  }
}

function folderIndex(entries: Map<string, TreeEntry>): Tree["folders"] {
  const folders: Tree["folders"] = new Map();
  const folder = (path: string) => {
    let f = folders.get(path);
    if (!f) folders.set(path, (f = { children: [], files: [] }));
    return f;
  };
  for (const [path, entry] of entries) {
    const parts = path.split("/");
    folder(parts.slice(0, -1).join("/")).children.push({ type: entry.type, name: parts[parts.length - 1]! });
    if (entry.type !== "blob") continue;
    for (let i = 1; i < parts.length; i++) folder(parts.slice(0, i).join("/")).files.push(parts.slice(i).join("/"));
  }
  for (const f of folders.values()) f.files.sort();
  return folders;
}

function treeFrom(head: string, entries: Map<string, TreeEntry>, wanted: string[], blobs: Map<string, string>): Tree {
  const contents = new Map<string, string>();
  for (const path of wanted) contents.set(path, blobs.get(entries.get(path)!.sha) ?? "");
  return { head, entries, contents, folders: folderIndex(entries) };
}

/**
 * The files to read, in groups no larger than one call reads. A file over the limit is
 * refused by name rather than left to fail as a buffer overflow nobody can place.
 */
function batches(entries: Map<string, TreeEntry>, want: (path: string) => boolean): { paths: string[]; groups: { input: string; bytes: number }[] } {
  const paths = [...entries].filter(([path, entry]) => entry.type === "blob" && want(path)).map(([path]) => path);
  const groups: { input: string; bytes: number }[] = [];
  let shas: string[] = [];
  let bytes = 0;
  for (const path of paths) {
    const { sha, size } = entries.get(path)!;
    if (size > MAX_FILE_BYTES) throw new Error(`${path} is ${Math.ceil(size / 1024 / 1024)} MiB; the orchestrator reads files of at most ${MAX_FILE_BYTES / 1024 / 1024} MiB`);
    if (shas.length && bytes + size > BATCH_BYTES) {
      groups.push({ input: shas.join("\n") + "\n", bytes });
      shas = [];
      bytes = 0;
    }
    shas.push(sha);
    bytes += size;
  }
  if (shas.length) groups.push({ input: shas.join("\n") + "\n", bytes });
  return { paths, groups };
}

// Room for each object's header line on top of its bytes.
const batchAllowance = (group: { input: string; bytes: number }) => group.bytes + group.input.length * 2 + 1024 * 1024;

const TREE_ARGS = ["ls-tree", "-r", "-t", "-l", "-z", "--full-tree"];

export async function loadTree(dir: string, ref: string, want: (path: string) => boolean, signal?: AbortSignal): Promise<Tree> {
  const head = (await gitAsync(["rev-parse", ref], dir, undefined, undefined, { signal })).trim();
  const entries = parseEntries(await gitAsync([...TREE_ARGS, head], dir, undefined, undefined, { signal, maxBuffer: LISTING_BYTES }));
  const { paths, groups } = batches(entries, want);
  const blobs = new Map<string, string>();
  for (const group of groups) parseBatch(await gitAsyncBytes(["cat-file", "--batch"], dir, group.input, { signal, maxBuffer: batchAllowance(group) }), blobs);
  return treeFrom(head, entries, paths, blobs);
}

/** The same, blocking, for callers not moved to the asynchronous git yet. */
export function loadTreeSync(dir: string, ref: string, want: (path: string) => boolean): Tree {
  const head = git(["rev-parse", ref], dir).trim();
  const entries = parseEntries(gitBytes([...TREE_ARGS, head], dir, undefined, LISTING_BYTES).toString("utf8"));
  const { paths, groups } = batches(entries, want);
  const blobs = new Map<string, string>();
  for (const group of groups) parseBatch(gitBytes(["cat-file", "--batch"], dir, group.input, batchAllowance(group)), blobs);
  return treeFrom(head, entries, paths, blobs);
}

/** A file's text, or null when the commit has no such file. Asking for a file the load did not want is a mistake here, not an absent file. */
function show(tree: Tree, path: string): string | null {
  const entry = tree.entries.get(path);
  if (!entry || entry.type !== "blob") return null;
  const text = tree.contents.get(path);
  if (text === undefined) throw new Error(`${path} was not read with this tree`);
  return text;
}

function listTree(tree: Tree, path: string): { type: string; name: string }[] {
  return tree.folders.get(path)?.children ?? [];
}

function listFilesUnder(tree: Tree, path: string): string[] {
  return tree.folders.get(path)?.files ?? [];
}

function readJson(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((v) => typeof v === "string") ? (value as string[]) : undefined;
}

function readSkills(tree: Tree): SkillItem[] {
  return listTree(tree, "skills")
    .filter((entry) => entry.type === "tree")
    .map((entry) => {
      const md = show(tree, `skills/${entry.name}/SKILL.md`);
      const files = listFilesUnder(tree, `skills/${entry.name}`);
      const summary = md === null ? null : parseSkillFrontmatter(md.replace(/\r\n/g, "\n"));
      if (!summary) {
        return {
          slug: entry.name,
          name: entry.name,
          description: "",
          files,
          problem: md === null ? "no SKILL.md" : "SKILL.md has no readable name and description",
          format: [],
        };
      }
      return { slug: entry.name, name: summary.name, description: summary.description, files, format: skillFormatProblems(md!) };
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

function transportOf(config: Record<string, unknown>): McpItem["transport"] {
  const type = config.type;
  if (type === "http" || type === "sse") return type;
  if (type === "stdio" || typeof config.command === "string") return "stdio";
  return "unknown";
}

function readMcp(tree: Tree): McpItem[] {
  const servers = readJson(show(tree, ".mcp.json"))?.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return [];
  return Object.entries(servers as Record<string, unknown>)
    .map(([name, raw]) => {
      const config = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
      const audit = auditServer(raw);
      const transport = transportOf(config);
      const declared = transport === "stdio" ? config.command : config.url;
      // A URL can carry a token in its query or path; the screen shows the host and path
      // shape only when the plugin's own rule would let the definition travel.
      const target = typeof declared === "string" && (audit.migratable || transport === "stdio") ? declared : "(withheld)";
      const env = config.env && typeof config.env === "object" ? Object.keys(config.env as object) : [];
      const headers = config.headers && typeof config.headers === "object" ? Object.keys(config.headers as object) : [];
      const item: McpItem = {
        name,
        transport,
        target: detectSecret(target) ? "(withheld)" : target,
        envNames: [...env, ...headers].sort(),
        shareable: audit.migratable,
      };
      if (!audit.migratable) item.refusal = refusalSummary(audit);
      return item;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Every command the plugin ships, in every folder under commands/, named the way Claude Code
 * names it - one namespace per folder - and described the way the plugin describes it: the
 * frontmatter's description, else the first line of text. A team's `git/sync.md` is a command
 * of its own, not a missing one.
 */
function readCommands(tree: Tree): CommandItem[] {
  return [...tree.entries]
    .filter(([path, entry]) => COMMAND.test(path) && entry.type === "blob")
    .map(([file]) => ({ name: file.slice("commands/".length, -".md".length).split("/").join(":"), description: commandDescription(show(tree, file) ?? ""), file }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const COMMAND = /^commands\/.+\.md$/;

/** The team file at a commit, read on its own. Blocking; `readTeamRecordAsync` is the same without holding the process. */
export function readTeamRecord(dir: string, ref: string): TeamRecord | null {
  return parseTeamRecord(gitMaybe(["show", `${ref}:${TEAM_PREFIX_FILE}`], dir));
}

export async function readTeamRecordAsync(dir: string, ref: string): Promise<TeamRecord | null> {
  return parseTeamRecord(await gitAsyncMaybe(["show", `${ref}:${TEAM_PREFIX_FILE}`], dir));
}

function parseTeamRecord(text: string | null): TeamRecord | null {
  if (text === null) return null;
  const json = readJson(text);
  if (!json) return { problem: `${TEAM_PREFIX_FILE} is not a JSON object` };
  const record: TeamRecord = {};
  const prefix = recordedCommitPrefix(json.commitPrefix);
  if (prefix.prefix !== undefined) record.commitPrefix = prefix.prefix;
  if (prefix.problem) record.commitPrefixProblem = prefix.problem;
  if (typeof json.branchExample === "string") record.branchExample = json.branchExample;
  if (typeof json.scaffoldVersion === "string") record.scaffoldVersion = json.scaffoldVersion;
  const reviewers = stringList(json.reviewers);
  const labels = stringList(json.labels);
  const usage = json.usage as { endpoint?: unknown } | undefined;
  if (usage && typeof usage.endpoint === "string") record.usageEndpoint = usage.endpoint;
  if (reviewers) record.reviewers = reviewers;
  if (labels) record.labels = labels;
  return record;
}

const INVENTORY_FILES = new Set([PLUGIN_MANIFEST, MARKETPLACE_MANIFEST, ".mcp.json", TEAM_PREFIX_FILE, "README.md", ...CI_JOB_FILES, ...CODEOWNERS_FILES]);

export async function readInventory(dir: string, ref = "HEAD", signal?: AbortSignal): Promise<Inventory> {
  const tree = await loadTree(dir, ref, (path) => INVENTORY_FILES.has(path) || /^skills\/[^/]+\/SKILL\.md$/.test(path) || COMMAND.test(path), signal);
  const head = tree.head;
  const plugin = readJson(show(tree, PLUGIN_MANIFEST)) ?? {};
  const marketplace = readJson(show(tree, MARKETPLACE_MANIFEST)) ?? {};
  const plugins = Array.isArray(marketplace.plugins)
    ? marketplace.plugins.flatMap((p) => (p && typeof p === "object" && typeof (p as { name?: unknown }).name === "string" ? [(p as { name: string }).name] : []))
    : [];
  const team = parseTeamRecord(show(tree, TEAM_PREFIX_FILE));
  const owner = (marketplace.owner as { name?: unknown } | undefined)?.name;
  const versionBack = typeof plugin.version === "string" ? await versionLineBack(dir, head) : null;
  return {
    head,
    plugin: {
      ...(typeof plugin.name === "string" ? { name: plugin.name } : {}),
      ...(typeof plugin.version === "string" ? { version: plugin.version } : {}),
      // Without a version line Claude Code versions the plugin by commit: every merge is the
      // update teammates receive.
      versionedByCommit: typeof plugin.version !== "string",
    },
    marketplace: { ...(typeof marketplace.name === "string" ? { name: marketplace.name } : {}), plugins },
    skills: readSkills(tree),
    mcpServers: readMcp(tree),
    commands: readCommands(tree),
    team,
    setup: setupFindings({
      plugin: { ...(typeof plugin.name === "string" ? { name: plugin.name } : {}), ...(typeof plugin.version === "string" ? { version: plugin.version } : {}) },
      marketplace: { ...(typeof marketplace.name === "string" ? { name: marketplace.name } : {}), ...(typeof owner === "string" ? { owner } : {}), plugins },
      team,
      readme: show(tree, "README.md"),
      paths: new Set(tree.entries.keys()),
      versionBack,
      ciJobs: CI_JOB_FILES.flatMap((path) => show(tree, path) ?? []),
      codeowners: CODEOWNERS_FILES.flatMap((path) => {
        const text = show(tree, path);
        return text === null ? [] : [{ path, text }];
      })[0] ?? null,
    }),
  };
}

const LOG_FORMAT = "%H%x1f%cI%x1f%an%x1f%s";

export async function readHistory(dir: string, path?: string, limit = 50, signal?: AbortSignal): Promise<HistoryEntry[]> {
  const args = ["log", `-n${limit}`, `--format=${LOG_FORMAT}`, "HEAD"];
  if (path) args.push("--", path);
  const out = (await gitAsyncMaybe(args, dir, signal ? { signal } : {})) ?? "";
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, date, author, subject] = line.split("\x1f");
      return { sha: sha!, date: date!, author: author!, subject: subject! };
    });
}

const MCP_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export interface TeamSetup {
  skills: { slug: string; files: { path: string; content: string }[] }[];
  /** Definitions that pass the plugin's share rule, as the repository declares them. */
  mcpServers: Record<string, Record<string, unknown>>;
  /** Servers left out, each with the share rule's reason. */
  refused: { name: string; reason: string }[];
}

/**
 * What a task's agent is given of the team's own setup: every skill the repository ships,
 * and the MCP servers the plugin's share rule would let travel. A server the rule refuses
 * carries a credential in its definition, so it is never written where an agent reads it.
 */
const TEAM_SETUP_FILES = (path: string) => path === ".mcp.json" || path.startsWith("skills/");

/** Blocking; `readTeamSetupAsync` reads the same without holding the process. */
export function readTeamSetup(dir: string, ref: string): TeamSetup {
  return teamSetupFrom(loadTreeSync(dir, ref, TEAM_SETUP_FILES));
}

export async function readTeamSetupAsync(dir: string, ref: string): Promise<TeamSetup> {
  return teamSetupFrom(await loadTree(dir, ref, TEAM_SETUP_FILES));
}

function teamSetupFrom(tree: Tree): TeamSetup {
  const skills = listTree(tree, "skills")
    .filter((entry) => entry.type === "tree" && show(tree, `skills/${entry.name}/SKILL.md`) !== null)
    .map((entry) => ({
      slug: entry.name,
      files: listFilesUnder(tree, `skills/${entry.name}`).map((path) => ({ path, content: show(tree, `skills/${entry.name}/${path}`) ?? "" })),
    }));
  const declared = readJson(show(tree, ".mcp.json"))?.mcpServers;
  const mcpServers: TeamSetup["mcpServers"] = {};
  const refused: TeamSetup["refused"] = [];
  if (declared && typeof declared === "object" && !Array.isArray(declared)) {
    for (const [name, raw] of Object.entries(declared as Record<string, unknown>)) {
      // The name becomes part of an agent's tool list (`mcp__<name>`), which is comma-separated.
      if (!MCP_NAME.test(name)) {
        refused.push({ name: JSON.stringify(name), reason: "its name has characters other than letters, digits, - and _" });
        continue;
      }
      const audit = auditServer(raw);
      if (audit.migratable) mcpServers[name] = raw as Record<string, unknown>;
      else refused.push({ name, reason: refusalSummary(audit) });
    }
  }
  return { skills, mcpServers, refused };
}
