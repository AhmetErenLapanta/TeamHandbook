import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { calledSkill } from "../skill-rules.js";
import type { AgentLoaded } from "./adapters/contract.js";
import type { PersonalSetup } from "./personal-setup.js";
import type { TaskLoaded } from "./types.js";

/** Where a skill, a command or an MCP server comes from, as the handbook's inventory names it. */
export const SOURCE_ID = /^(yours|folder:(\/|~\/).{1,4000}|plugin:[^@\s]{1,200}@[^@\s]{1,200}|team:[a-z0-9][a-z0-9-]{0,62})$/;
export const UNKNOWN_SOURCE = { source: "unknown", sourceLabel: "unknown" } as const;
const NAME_MAX = 200;
// As many as a person's own list keeps (handbook-defaults), which a start with no list of its own takes whole.
const OFF_MAX = 300;
const USED_MAX = 50;
const STARTED_MAX = 300;

/** What its person turned off for one task: whole sources, single skills and single MCP servers, each by its source. */
export interface TaskOff {
  sources: string[];
  skills: { source: string; name: string }[];
  mcpServers: { source: string; name: string }[];
  /** Commands of the person's own or the folder's, by name without the slash; the agent calls them as it calls skills. */
  commands?: { source: string; name: string }[];
}

/** What a task's agent used, each with the source the server's own reading gave it and the log line of its first call. */
export interface TaskUsed {
  skills: { name: string; source: string; sourceLabel: string; version?: string; seq?: number }[];
  mcpServers: { name: string; source: string; sourceLabel: string; seq?: number }[];
}

export type SourceRef = { source: string; sourceLabel: string; version?: string };

/** One handbook source as a task found it when it started: its names alone, never a command, an address or a value. */
export interface TaskSetupSource {
  id: string;
  kind: "yours" | "folder" | "plugin" | "team-repo";
  name: string;
  version?: string;
  marketplace?: string;
  enabled: boolean;
  skills: { name: string }[];
  commands: { name: string }[];
  mcpServers: { name: string }[];
  hooks: { name: string }[];
  claudeMd?: boolean;
}

/** The sources of a reading as a task keeps them: names alone. */
export function setupOf(sources: readonly (TaskSetupSource & { hooks: { name: string }[] })[]): TaskSetupSource[] {
  const names = (list: readonly { name: string }[]) => list.map(({ name }) => ({ name }));
  return sources.map((s) => ({ id: s.id, kind: s.kind, name: s.name, ...(s.version ? { version: s.version } : {}), ...(s.marketplace ? { marketplace: s.marketplace } : {}), enabled: s.enabled, skills: names(s.skills), commands: names(s.commands), mcpServers: names(s.mcpServers), hooks: names(s.hooks), ...(s.claudeMd === undefined ? {} : { claudeMd: s.claudeMd }) }));
}

const cleanName = (value: unknown): string | null => (typeof value === "string" && value.trim() && value.length <= NAME_MAX && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : null);

/** A start's `off`, checked; absent when it names nothing. */
export function readOff(value: unknown): TaskOff | undefined | { error: string } {
  if (value === undefined || value === null) return undefined;
  const v = value as { sources?: unknown; skills?: unknown; mcpServers?: unknown; commands?: unknown };
  const bad = { error: "off is { sources?: [source id], skills?: [{ source, name }], mcpServers?: [{ source, name }], commands?: [{ source, name }] }" };
  if (typeof v !== "object" || Array.isArray(v)) return bad;
  const sources = v.sources ?? [];
  const pairs = (list: unknown) => (Array.isArray(list) && list.length <= OFF_MAX ? list.map((e: { source?: unknown; name?: unknown }) => (e && typeof e.source === "string" && SOURCE_ID.test(e.source) && cleanName(e.name) ? { source: e.source, name: cleanName(e.name)! } : null)) : null);
  const skills = pairs(v.skills ?? []);
  const mcpServers = pairs(v.mcpServers ?? []);
  const commands = pairs(v.commands ?? []);
  if (!Array.isArray(sources) || sources.length > OFF_MAX || !sources.every((s) => typeof s === "string" && SOURCE_ID.test(s)) || !skills || !mcpServers || !commands || skills.includes(null) || mcpServers.includes(null) || commands.includes(null)) return bad;
  const off: TaskOff = { sources: sources as string[], skills: skills as TaskOff["skills"], mcpServers: mcpServers as TaskOff["mcpServers"], ...(commands.length ? { commands: commands as TaskOff["skills"] } : {}) };
  return off.sources.length || off.skills.length || off.mcpServers.length || off.commands?.length ? off : undefined;
}

/** By how many items a start's list differs from its person's own: each one that only one of the two holds, a whole source counted once. */
export function offChanges(sent: TaskOff | undefined, own: Pick<TaskOff, "skills" | "mcpServers"> & { commands?: TaskOff["commands"] }): number {
  const keys = (off: Partial<TaskOff> | undefined) =>
    new Set([...(off?.sources ?? []).map((s) => `source ${s}`), ...(["skills", "mcpServers", "commands"] as const).flatMap((kind) => (off?.[kind] ?? []).map((e) => `${kind} ${e.source} ${e.name}`))]);
  const [a, b] = [keys(sent), keys(own)];
  return [...a].filter((k) => !b.has(k)).length + [...b].filter((k) => !a.has(k)).length;
}

/** What one run reads its sources from: the person's home, the folder it works in, their plugins and the team's setup. */
export interface HandbookPlace {
  home: string;
  folder: string | null;
  plugins: readonly { name: string; marketplace: string; version: string }[];
  team: { id: string; name: string; skills: readonly string[]; mcpServers: readonly string[] } | null;
}

const skillDirs = async (dir: string): Promise<string[]> => (await readdir(dir, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory()).map((e) => e.name);

/** The MCP server names a JSON file declares; never a definition, an address or a value. */
async function serverNames(file: string): Promise<string[]> {
  try {
    const servers = (JSON.parse(await readFile(file, "utf8")) as { mcpServers?: unknown }).mcpServers;
    return servers && typeof servers === "object" && !Array.isArray(servers) ? Object.keys(servers) : [];
  } catch {
    return [];
  }
}

const userConfig = (home: string) => join(process.env.CLAUDE_CONFIG_DIR || home, ".claude.json");
const yours: SourceRef = { source: "yours", sourceLabel: "Yours" };
const folderRef = (folder: string): SourceRef => ({ source: `folder:${folder}`, sourceLabel: basename(folder) });
const pluginRef = (p: HandbookPlace["plugins"][number]): SourceRef => ({ source: `plugin:${p.name}@${p.marketplace}`, sourceLabel: `${p.name} ${p.version}`, version: p.version });

/** The source of a skill the agent called, read from where skills live, never from what the agent said of it. */
export async function skillSource(place: HandbookPlace, name: string): Promise<SourceRef> {
  const colon = name.indexOf(":");
  if (colon > 0) {
    const plugin = place.plugins.find((p) => p.name === name.slice(0, colon));
    if (plugin) return pluginRef(plugin);
    // The team's skills reach a task as a plugin of the task's own, so the agent calls one of them by a plugin's name too.
    return place.team?.skills.includes(name.slice(colon + 1)) ? { source: `team:${place.team.id}`, sourceLabel: place.team.name } : UNKNOWN_SOURCE;
  }
  if (place.folder && (await skillDirs(join(place.folder, ".claude", "skills"))).includes(name)) return folderRef(place.folder);
  if (place.team?.skills.includes(name)) return { source: `team:${place.team.id}`, sourceLabel: place.team.name };
  if ((await skillDirs(join(process.env.CLAUDE_CONFIG_DIR || join(place.home, ".claude"), "skills"))).includes(name)) return yours;
  return UNKNOWN_SOURCE;
}

/** The source of an MCP server the agent called, read from where servers are declared. */
export async function mcpSource(place: HandbookPlace, server: string): Promise<SourceRef> {
  const plugin = /^plugin_([^_]+)_/.exec(server)?.[1];
  if (plugin) {
    const found = place.plugins.find((p) => p.name === plugin);
    return found ? pluginRef(found) : UNKNOWN_SOURCE;
  }
  if (place.folder && (await serverNames(join(place.folder, ".mcp.json"))).includes(server)) return folderRef(place.folder);
  if (place.team?.mcpServers.includes(server)) return { source: `team:${place.team.id}`, sourceLabel: place.team.name };
  if ((await serverNames(userConfig(place.home))).includes(server)) return yours;
  return UNKNOWN_SOURCE;
}

/** What a run's launch turns off, by name: the plugins whole, and each skill and MCP server of the sources and picks that are off. */
export async function offNames(place: HandbookPlace, off: TaskOff): Promise<{ plugins: string[]; skills: string[]; mcpServers: string[] }> {
  const plugins = off.sources.filter((s) => s.startsWith("plugin:")).map((s) => s.slice("plugin:".length));
  // A command of the person's own is left out as a skill is: the agent calls both the same way. A plugin's skill is
  // named with its plugin, so one of the same name in another source stays on.
  const named = (s: { source: string; name: string }) => (s.source.startsWith("plugin:") && !s.name.includes(":") ? `${s.source.slice("plugin:".length).split("@")[0]}:${s.name}` : s.name);
  const skills = new Set([...off.skills, ...(off.commands ?? [])].map(named));
  const servers = new Set(off.mcpServers.map((s) => s.name));
  for (const source of off.sources) {
    if (source === "yours") {
      for (const name of await skillDirs(join(process.env.CLAUDE_CONFIG_DIR || join(place.home, ".claude"), "skills"))) skills.add(name);
      for (const name of await serverNames(userConfig(place.home))) servers.add(name);
    } else if (source.startsWith("folder:") && place.folder && source === `folder:${place.folder}`) {
      for (const name of await skillDirs(join(place.folder, ".claude", "skills"))) skills.add(name);
      for (const name of await serverNames(join(place.folder, ".mcp.json"))) servers.add(name);
    } else if (source.startsWith("team:") && place.team && source === `team:${place.team.id}`) {
      for (const name of place.team.skills) skills.add(name);
      for (const name of place.team.mcpServers) servers.add(name);
    }
  }
  return { plugins, skills: [...skills], mcpServers: [...servers] };
}

/**
 * What of a person's own setup a run starts with, by count: what the run leaves out is not counted, a plugin left out
 * with the commands and servers it brings.
 */
export function loadedWithout(setup: Pick<PersonalSetup, "commands" | "plugins" | "mcpServers" | "claudeMd">, off: { plugins: readonly string[]; skills: readonly string[]; mcpServers: readonly string[] } = { plugins: [], skills: [], mcpServers: [] }): TaskLoaded {
  const gone = off.plugins.map((id) => `${id.split("@")[0]}:`);
  return {
    commands: setup.commands.filter((c) => !off.skills.includes(c.name) && !gone.some((prefix) => c.name.startsWith(prefix))).length,
    plugins: setup.plugins.filter((p) => p.enabled && !off.plugins.includes(`${p.name}@${p.marketplace}`)).length,
    mcpServers: setup.mcpServers.filter((m) => !off.mcpServers.includes(m.name) && !(m.plugin && off.plugins.includes(m.plugin))).length,
    claudeMd: setup.claudeMd,
  };
}

/**
 * What a task's agent said it started with as its session opened, kept for the task's page to hold against what the
 * task was to start with: names and each server's state, the agent's words held as data. Null for a kind the agent
 * does not report.
 */
export type TaskStartedWith = AgentLoaded;

export function startedWithOf(said: AgentLoaded): TaskStartedWith {
  const names = (list: readonly string[] | null) => (list ? list.flatMap((name) => cleanName(name) ?? []).slice(0, STARTED_MAX) : null);
  const servers = said.mcpServers?.flatMap((server) => (cleanName(server.name) ? [{ name: cleanName(server.name)!, state: server.state }] : [])).slice(0, STARTED_MAX);
  return { plugins: names(said.plugins), skills: names(said.skills), mcpServers: servers ?? null };
}

type Use = { name: string; source: string; sourceLabel: string; version?: string; seq?: number };

/**
 * Adds one use to a task's record, once per name and source, up to what a record keeps. One its log line put there
 * before its source was read takes the source now and keeps its line.
 */
export function withUse(used: TaskUsed | undefined, kind: keyof TaskUsed, name: string, ref: SourceRef): TaskUsed | null {
  const held: TaskUsed = used ?? { skills: [], mcpServers: [] };
  const list = held[kind] as Use[];
  // A use whose source was not read adds nothing beside one of that name already there.
  if (list.some((u) => u.name === name && (u.source === ref.source || ref.source === UNKNOWN_SOURCE.source))) return null;
  const entry: Use = kind === "skills" ? { name, ...ref } : { name, source: ref.source, sourceLabel: ref.sourceLabel };
  const unread = list.findIndex((u) => u.name === name && u.source === UNKNOWN_SOURCE.source);
  if (unread >= 0) return { ...held, [kind]: list.map((u, i) => (i === unread ? { ...entry, ...(u.seq === undefined ? {} : { seq: u.seq }) } : u)) };
  return list.length >= USED_MAX ? null : { ...held, [kind]: [...list, entry] };
}

/** The skill or MCP server a log line's event starts a call of, as a task's record names it; null for any other line. */
export function calledIn(kind: string | undefined, data: unknown): { kind: keyof TaskUsed; name: string } | null {
  const event = data as { tool?: unknown; target?: unknown; status?: unknown; mcp?: { server?: unknown } } | null;
  if (kind !== "tool_call" || !event || event.status !== "started") return null;
  const skill = typeof event.tool === "string" && event.tool.toLowerCase() === "skill" && typeof event.target === "string" ? calledSkill(event.target) : null;
  if (skill) return { kind: "skills", name: skill.slice(0, NAME_MAX) };
  return typeof event.mcp?.server === "string" && event.mcp.server ? { kind: "mcpServers", name: event.mcp.server.slice(0, NAME_MAX) } : null;
}

/** Keeps the log line of a use's first call: on the use of that name with no line yet, or on a new one whose source is read later. */
export function withUseAt(used: TaskUsed | undefined, kind: keyof TaskUsed, name: string, seq: number): TaskUsed | null {
  const held: TaskUsed = used ?? { skills: [], mcpServers: [] };
  const list = held[kind] as Use[];
  if (list.some((u) => u.name === name && u.seq !== undefined)) return null;
  const at = list.findIndex((u) => u.name === name);
  if (at >= 0) return { ...held, [kind]: list.map((u, i) => (i === at ? { ...u, seq } : u)) };
  return list.length >= USED_MAX ? null : { ...held, [kind]: [...list, { name, ...UNKNOWN_SOURCE, seq }] };
}
