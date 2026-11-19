import { call } from "../api";
import { lastAnswer, rememberAnswer } from "../last-answer";

/** What a handbook holds, by name only: a server's settings and any secret in them are never read. Fields past `hooks` appear as the orchestrator can tell them. */
export interface HandbookSource {
  id: string;
  kind: "yours" | "folder" | "plugin" | "team-repo";
  name: string;
  version?: string;
  marketplace?: string;
  enabled: boolean;
  skills: { name: string; description?: string; context?: Context; used?: Used; whyNot?: string }[];
  commands: { name: string; whyNot?: string }[];
  mcpServers: { name: string; context?: Context; used?: Used; whyNot?: string }[];
  hooks: { name: string; commands?: string[]; matchers?: string[] }[];
  claudeMd?: boolean;
  /** Why this handbook cannot be turned off, as the orchestrator knows it: an organization's policy keeping it on. */
  whyNot?: string;
  /** The newer version the marketplace copy holds: the skills it adds, changes and removes, and every hook and MCP server it runs. */
  latest?: { version: string; added: string[]; changed: string[]; removed: string[]; hooks: { name: string; commands: string[] }[]; mcpServers: string[] };
  /** Runs hooks or servers the person has not closed the line about; a notice, tasks start with it. */
  notice?: { hooks: number; mcpServers: number };
}
/** About how much of the context a thing takes before the task starts, as the person's last task counted it; the share is of that task's window when its agent said one. */
export interface Context { tokens: number; percent?: number }
export interface Used { tasks: number; lastAt: string | null }

/** One item of a handbook, by the handbook's id and its own name. */
export interface ItemRef { source: string; name: string }
/** What one task leaves out of the person's own setup. */
export interface Off { sources: string[]; skills: ItemRef[]; commands: ItemRef[]; mcpServers: ItemRef[] }
export const NOTHING_OFF: Off = { sources: [], skills: [], commands: [], mcpServers: [] };
export type OffList = "skills" | "commands" | "mcpServers";

export type SourcesRead = { sources: HandbookSource[]; readAt: string } | { available: false; why: string };

const sourcesPath = (folder?: string) => `/api/handbook/sources${folder ? `?${new URLSearchParams({ folder })}` : ""}`;
const DEFAULTS_PATH = "/api/handbook/defaults";

export const handbookRead = {
  /** The last sources answer of this page's life, for a form opened again to draw at once while it reads behind it. */
  lastSources: (folder?: string) => lastAnswer<SourcesRead>(sourcesPath(folder)),
  lastDefaults: () => lastAnswer<Off>(DEFAULTS_PATH),
  /** The skills, commands and servers this person's agents start without; a plugin's state is Claude Code's own and is not here. */
  defaults: () => call<{ off: Partial<Off> }>("GET", DEFAULTS_PATH).then((r) => rememberAnswer(DEFAULTS_PATH, { ...NOTHING_OFF, ...r.off, sources: [] })),
  sources: (folder?: string) => call<SourcesRead>("GET", sourcesPath(folder)).then((r) => rememberAnswer(sourcesPath(folder), r)),
  /** Puts a plugin's notice away for the version it is about; a later version says it again. */
  noticed: (plugin: string) => call<{ noticed: string }>("POST", "/api/handbook/noticed", { plugin }),
  skill: (source: string, name: string) => call<{ content: string }>("GET", `/api/handbook/skill?${new URLSearchParams({ source, name })}`).then((r) => r.content),
};

export const sourceOff = (off: Off, source: HandbookSource) => !source.enabled || off.sources.includes(source.id);
export const itemOff = (off: Off, list: OffList, source: HandbookSource, name: string) => sourceOff(off, source) || off[list].some((x) => x.source === source.id && x.name === name);

export function flipSource(off: Off, source: string): Off {
  return off.sources.includes(source) ? { ...off, sources: off.sources.filter((s) => s !== source) } : { ...off, sources: [...off.sources, source] };
}

export function flipItem(off: Off, list: OffList, source: string, name: string): Off {
  const has = off[list].some((x) => x.source === source && x.name === name);
  return { ...off, [list]: has ? off[list].filter((x) => !(x.source === source && x.name === name)) : [...off[list], { source, name }] };
}
