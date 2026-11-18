import type { HandbookUsage } from "./handbook-usage.js";
import type { MeasuredContext } from "./tasks/handbook-context.js";

/** What a measure is put on: a source's skills and servers by the names the inventory lists. */
interface Measurable {
  id: string;
  kind: string;
  name: string;
  skills: { name: string }[];
  mcpServers: { name: string }[];
}

export interface Context { tokens: number; percent?: number }

/**
 * The names the agent gives one item of a source: a plugin's skill is called as `<plugin>:<skill>` and its server
 * is listed as `plugin_<plugin>_<server>`; anything else by its own name.
 */
function calledAs(source: Measurable, list: "skills" | "mcpServers", name: string): string[] {
  if (source.kind !== "plugin") return [name];
  return list === "skills" ? [`${source.name}:${name}`, name] : [`plugin_${source.name}_${name}`, name];
}

/** Each skill and server of the sources with one more field where `of` finds a value for it; the rest stay as they were. */
function annotated<T extends Measurable>(sources: readonly T[], field: string, of: (source: T, list: "skills" | "mcpServers", name: string) => unknown): T[] {
  const put = <I extends { name: string }>(source: T, list: "skills" | "mcpServers", items: I[]) =>
    items.map((item) => {
      const value = of(source, list, item.name);
      return value ? { ...item, [field]: value } : item;
    });
  return sources.map((s) => ({ ...s, skills: put(s, "skills", s.skills), mcpServers: put(s, "mcpServers", s.mcpServers) }));
}

/**
 * Each skill and server of the sources with what the person's last task counted of the context it takes. The share
 * is of that task's window when the agent said one; a name the measure does not hold is left as it was.
 */
export function withContext<T extends Measurable>(sources: readonly T[], measured: MeasuredContext | null, window: number | null): T[] {
  if (!measured) return [...sources];
  const tokensOf = (list: "skills" | "mcpServers") => new Map(measured[list].map((m) => [m.name, m.tokens]));
  const counted = { skills: tokensOf("skills"), mcpServers: tokensOf("mcpServers") };
  const contextOf = (source: T, list: "skills" | "mcpServers", name: string): Context | null => {
    const tokens = calledAs(source, list, name).map((n) => counted[list].get(n)).find((t) => t !== undefined);
    if (tokens === undefined) return null;
    return window ? { tokens, percent: Math.round((tokens * 1000) / window) / 10 } : { tokens };
  };
  return annotated(sources, "context", contextOf);
}

/**
 * Each skill and server of the sources with how many of the person's recent tasks used it and when last, by the
 * source the task's reading gave the use; a use whose source was not read is put on no row.
 */
export function withUsed<T extends Measurable>(sources: readonly T[], usage: HandbookUsage): T[] {
  const usedOf = (source: T, list: "skills" | "mcpServers", name: string) => {
    const names = calledAs(source, list, name);
    const use = usage[list].find((u) => u.source === source.id && names.includes(u.name));
    return use ? { tasks: use.tasks, lastAt: use.lastAt } : null;
  };
  return annotated(sources, "used", usedOf);
}

/** The context window of the newest of a person's tasks that said one; null when none did. */
export function lastWindow(tasks: readonly { createdAt: string; startedAt?: string | null; contextUsed?: { window: number | null } }[]): number | null {
  const said = tasks.filter((t) => t.contextUsed?.window).sort((a, b) => (b.startedAt ?? b.createdAt).localeCompare(a.startedAt ?? a.createdAt));
  return said[0]?.contextUsed?.window ?? null;
}
