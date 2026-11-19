import { flipItem, itemOff, sourceOff } from "./handbook-read";
import type { Context, HandbookSource, Off, OffList, Used } from "./handbook-read";

export type { Context, Used };

export type EntryKind = "Skill" | "Server" | "Command" | "Hook" | "Rules";

/** Which list the list is drawn for: Team (how every agent started here begins), one task's start, or a task that ran. */
export type Level = "default" | "task" | "readonly";

/** One thing an agent loads, as a row says it: where it comes from, what kind it is, whether it is on, and whether it can be left out alone. */
export interface Entry {
  key: string;
  name: string;
  kind: EntryKind;
  source: HandbookSource;
  on: boolean;
  switchable: boolean;
  /** The list a switch writes to; none for a kind no switch reaches. */
  list?: OffList;
  sentence?: string;
  context?: Context;
  used?: Used;
  /** Why there is no switch, in one line. */
  whyNot?: string;
  /** A hook's matchers and the commands it runs, as the orchestrator shows them (masked, cut); its environment is never read. */
  hook?: { matchers: string[]; commands: string[] };
  /** Which of two items of the same name the agent is handed first, said on both rows; or that it is not known. */
  clash?: string;
  /** What being off means for this item, said while it is off. */
  offNote?: string;
}

/**
 * What a switch can reach, the same for one task as for the default (design.md, Handbooks; KAPATMA-sozlesme): a plugin as a
 * whole, a skill, command or server of Yours or This folder, one skill of a plugin as far as the agent allows. Never one
 * server of a plugin, never one hook.
 */
const PLUGIN_SERVER_WHY = "It comes with its plugin; turn the plugin off.";
const PLUGIN_COMMAND_WHY = "It comes with its plugin; turn the plugin off.";
const PLUGIN_HOOK_WHY = "Claude Code does not leave out one hook; turn off the plugin it comes with.";
const OWN_HOOK_WHY = "Claude Code runs your own hooks in every session.";

/** What being off says on Team, where the person's Claude Code itself is changed for a plugin and their default for the rest. */
const DEFAULT_ITEM_OFF = "Off for agents started here. Your terminal still has it.";
const DEFAULT_PLUGIN_SKILL_OFF = "Off for agents started here: the agent cannot call it; its name still shows.";
const TASK_PLUGIN_SKILL_OFF = "The agent cannot call it; its name still shows.";
export const PLUGIN_OFF = "Also off in your terminal.";

/** Two skills of Yours and This folder that share a name are left out together, since a task leaves a skill out by its name; a plugin's skill carries its plugin's name and never clashes. */
const sharedNameWhy = (name: string) => `Two skills are named ${name}; one cannot be left out without the other.`;

/**
 * Which of two of the same name an agent gets, as far as Claude Code's own listing shows it: Yours' skills, then This
 * folder's, then the commands in Yours. Where a folder's command sits in that listing is not seen, so a clash with one
 * says it is not known rather than guess; a plugin's skill or command carries its plugin's name and clashes with none.
 */
type Named = { kind: "Skill" | "Command"; source: HandbookSource };
const whose = (n: Named) => (n.source.kind === "yours" ? "yours" : "this folder's");
function clashOf(name: string, me: Named, named: Map<string, Named[]>): string | undefined {
  const other = (named.get(name) ?? []).find((n) => n.source.id !== me.source.id || n.kind !== me.kind);
  if (!other) return undefined;
  if (me.kind === "Skill" && other.kind === "Skill") {
    const [first, second] = me.source.kind === "yours" ? [me, other] : [other, me];
    return `Two skills are named ${name}: ${whose(first)} is listed first to the agent, ${whose(second)} after it.`;
  }
  if (me.kind === "Command" && other.kind === "Command") return `Two commands are named /${name}, in yours and this folder; which one an agent gets is not known.`;
  const command = me.kind === "Command" ? me : other;
  return command.source.kind === "yours"
    ? `A skill and a command are named ${name}: the skill is listed first to the agent, the command after it.`
    : `A skill and a command are named ${name}; which one an agent gets is not known.`;
}

const rank = (s: HandbookSource) => (s.kind === "yours" ? 0 : s.kind === "folder" ? 1 : s.kind === "team-repo" ? 2 : 3);

/** Yours, This folder, the team's, then plugins by name: the order is the same on every screen. */
export const ordered = (sources: HandbookSource[]) => [...sources].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));

/** Every item of every handbook, in the screens' order, with a switch only where it does something. */
export function entriesOf(sources: HandbookSource[], off: Off, level: Level): Entry[] {
  const all = ordered(sources);
  const ownNames = new Map<string, number>();
  for (const s of all) if (s.kind !== "plugin") for (const k of s.skills) ownNames.set(k.name, (ownNames.get(k.name) ?? 0) + 1);
  const named = new Map<string, Named[]>();
  const name = (key: string, n: Named) => named.set(key, [...(named.get(key) ?? []), n]);
  for (const s of all) {
    if (s.kind !== "yours" && s.kind !== "folder") continue;
    for (const k of s.skills) name(k.name, { kind: "Skill", source: s });
    for (const c of s.commands) name(c.name, { kind: "Command", source: s });
  }
  const clash = (kind: Named["kind"], s: HandbookSource, key: string) => {
    const said = s.kind === "yours" || s.kind === "folder" ? clashOf(key, { kind, source: s }, named) : undefined;
    return said ? { clash: said } : {};
  };
  return all.flatMap((s) => {
    const sourceIsOff = sourceOff(off, s);
    const plugin = s.kind === "plugin";
    const item = (kind: EntryKind, list: OffList | undefined, name: string, shown: string, extra: Partial<Entry>, why: string | undefined): Entry => {
      const on = list ? !itemOff(off, list, s, name) : !sourceIsOff;
      const switchable = Boolean(list) && !why && !sourceIsOff;
      return { key: `${s.id}\n${kind}\n${name}`, name: shown, kind, source: s, on, switchable, ...(list && !why ? { list } : {}), ...extra, ...(why ? { whyNot: why } : {}) };
    };
    const itemOffNote = level === "default" ? DEFAULT_ITEM_OFF : undefined;
    const skills = s.skills.map((k) => item("Skill", "skills", k.name, k.name, {
      ...(k.description ? { sentence: k.description } : {}),
      ...(k.context ? { context: k.context } : {}),
      ...(k.used ? { used: k.used } : {}),
      ...clash("Skill", s, k.name),
      ...(plugin ? { offNote: level === "default" ? DEFAULT_PLUGIN_SKILL_OFF : TASK_PLUGIN_SKILL_OFF } : itemOffNote ? { offNote: itemOffNote } : {}),
    }, k.whyNot ?? (!plugin && (ownNames.get(k.name) ?? 0) > 1 ? sharedNameWhy(k.name) : undefined)));
    const servers = s.mcpServers.map((m) => item("Server", plugin ? undefined : "mcpServers", m.name, m.name, {
      sentence: "An MCP server.",
      ...(m.context ? { context: m.context } : {}),
      ...(m.used ? { used: m.used } : {}),
      ...(itemOffNote && !plugin ? { offNote: itemOffNote } : {}),
    }, m.whyNot ?? (plugin ? PLUGIN_SERVER_WHY : undefined)));
    const commands = s.commands.map((c) => item("Command", plugin ? undefined : "commands", c.name, `/${c.name}`, { ...(itemOffNote && !plugin ? { offNote: itemOffNote } : {}), ...clash("Command", s, c.name) }, c.whyNot ?? (plugin ? PLUGIN_COMMAND_WHY : undefined)));
    const hooks = s.hooks.map((h) => item("Hook", undefined, h.name, h.name, { hook: { matchers: h.matchers ?? [], commands: h.commands ?? [] } }, plugin ? PLUGIN_HOOK_WHY : OWN_HOOK_WHY));
    const rules = s.claudeMd ? [item("Rules", undefined, "CLAUDE.md", "CLAUDE.md", {}, undefined)] : [];
    return [...skills, ...servers, ...commands, ...hooks, ...rules];
  });
}

/** Flips one row's own switch. */
export const flipEntry = (off: Off, e: Entry): Off => (e.list ? flipItem(off, e.list, e.source.id, e.kind === "Command" ? e.name.replace(/^\//, "") : e.name) : off);

/** "payments-skills 1.4.0", or "Yours": a handbook as every screen names it. */
export function handbookLabel(source: Pick<HandbookSource, "kind" | "name" | "version">): string {
  if (source.kind === "yours") return "Yours";
  if (source.kind === "folder") return `this folder (${source.name})`;
  if (source.kind === "team-repo") return `the team's ${source.name}`;
  return `${source.name}${source.version ? ` ${source.version}` : ""}`;
}

const k = (tokens: number) => (tokens >= 1000 ? `${Math.round(tokens / 100) / 10}k` : String(tokens));
export const tokensSaid = (c: Context) => `In every task about ${k(c.tokens)} tokens${c.percent === undefined ? "" : `, ${c.percent}% of the context`}.`;
/** The window the orchestrator counts use over (server/handbook-usage.ts USAGE_DAYS). */
const USED_WINDOW_DAYS = 30;

/** A skill's text without its front matter, which the row's own sentence already says in plain words; the editor shows it whole. */
export const skillBody = (text: string) => text.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "").trimStart();

export const usedSaid = (u: Used) =>
  u.tasks === 0 ? `Not used in ${USED_WINDOW_DAYS} days.` : `Used in ${u.tasks} ${u.tasks === 1 ? "task" : "tasks"}${u.lastAt ? `, last ${new Date(u.lastAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : ""}.`;

/** Past this share of the context, what loads before a task starts is said in the waiting tone. */
const HEAVY_PERCENT = 10;

/**
 * The line above the list, which carries the counts: "14 handbooks, 84 of 159 on, 2 updates", then what it costs of the
 * context only where something was measured. Servers are not started to be measured: their cost is the last task's,
 * and nothing is said of one that was not measured.
 */
export function summaryOf(sources: HandbookSource[], off: Off, entries: Entry[]): { text: string; heavy: boolean } {
  const live = entries.filter((e) => e.on);
  const measured = live.filter((e) => e.kind !== "Server" && e.context);
  const tokens = measured.reduce((n, e) => n + e.context!.tokens, 0);
  const serverTokens = live.filter((e) => e.kind === "Server" && e.context).reduce((n, e) => n + e.context!.tokens, 0);
  const updates = sources.filter((s) => s.latest && !sourceOff(off, s)).length;
  const percent = live.reduce((n, e) => n + (e.context?.percent ?? 0), 0);
  const counts = `${sources.length} ${sources.length === 1 ? "handbook" : "handbooks"}, ${live.length} of ${entries.length} on`;
  const cost = measured.length ? `, about ${k(tokens)} tokens in every task` : "";
  const server = serverTokens ? `${measured.length ? ", plus" : ", about"} ${k(serverTokens)} ${measured.length ? "for servers" : "tokens for servers"}, as measured in your last task` : "";
  return { text: `${counts}${updates ? `, ${updates} ${updates === 1 ? "update" : "updates"}` : ""}${cost}${server}`, heavy: percent >= HEAVY_PERCENT };
}

/** How many rows differ between two setups: what one task changed from the default. */
export function changesBetween(sources: HandbookSource[], off: Off, from: Off): number {
  const now = entriesOf(sources, off, "task");
  const before = new Map(entriesOf(sources, from, "task").map((e) => [e.key, e.on]));
  const plugins = sources.filter((s) => s.kind === "plugin" && off.sources.includes(s.id) !== from.sources.includes(s.id)).length;
  return plugins + now.filter((e) => e.list && before.get(e.key) !== e.on && !sourceOff(off, e.source) && !sourceOff(from, e.source)).length;
}
