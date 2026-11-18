import { HANDBOOK_OFF_PREFIX, HANDBOOK_NOTICED_PREFIX } from "./store.js";
import type { Store } from "./store.js";
import { SOURCE_ID } from "./tasks/handbook-use.js";

/**
 * What a person keeps off for the agents started here: single skills, commands and MCP servers,
 * which Claude Code has no command of its own to turn off. Kept for them in the orchestrator and
 * applied to each task they start; their terminal still has them. A whole plugin is not kept here:
 * its switch is Claude Code's own command, so its state is read from Claude Code.
 */
export interface HandbookOff {
  skills: { source: string; name: string }[];
  commands: { source: string; name: string }[];
  mcpServers: { source: string; name: string }[];
}

export const NOTHING_OFF: HandbookOff = { skills: [], commands: [], mcpServers: [] };

const MAX_ENTRIES = 300;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

const settingKey = (userId: string) => `${HANDBOOK_OFF_PREFIX}${userId}`;

function named(value: unknown): { source: string; name: string }[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ENTRIES) return null;
  const found: { source: string; name: string }[] = [];
  for (const item of value as Record<string, unknown>[]) {
    if (!item || typeof item.source !== "string" || !SOURCE_ID.test(item.source) || typeof item.name !== "string" || !NAME.test(item.name)) return null;
    if (!found.some((f) => f.source === item.source && f.name === item.name)) found.push({ source: item.source, name: item.name });
  }
  return found;
}

/** A body of what to keep off, checked: an unknown shape, a source id that is no source's or a name with odd characters refuses it whole. */
export function parseOff(body: unknown): HandbookOff | null {
  if (!body || typeof body !== "object") return null;
  const { skills, commands, mcpServers } = body as Record<string, unknown>;
  const k = named(skills);
  const c = named(commands);
  const m = named(mcpServers);
  return k && c && m ? { skills: k, commands: c, mcpServers: m } : null;
}

/** The person's own list, kept in the orchestrator's store; Claude Code's folder is never written for it. */
export async function handbookOff(store: Pick<Store, "getSetting">, tenant: string, userId: string): Promise<HandbookOff> {
  const kept = await store.getSetting(tenant, settingKey(userId));
  if (!kept) return NOTHING_OFF;
  try {
    return parseOff(JSON.parse(kept)) ?? NOTHING_OFF;
  } catch {
    return NOTHING_OFF;
  }
}

export async function saveHandbookOff(store: Pick<Store, "setSetting">, tenant: string, userId: string, off: HandbookOff): Promise<void> {
  await store.setSetting(tenant, settingKey(userId), JSON.stringify(off));
}

/**
 * The plugins whose hooks and MCP servers the person has closed the one line about, by name and
 * version: a plugin that runs hooks or servers says so once on Team and in the task form, and a new
 * version says it again. It is a notice, never a gate: tasks start with every plugin the person has
 * on. Only closing the line writes here; reading the page never does.
 */
const noticedKey = (userId: string) => `${HANDBOOK_NOTICED_PREFIX}${userId}`;
const PLUGIN_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}@[A-Za-z0-9][A-Za-z0-9._-]{0,99}@[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/;
const NOTICED_MAX = 500;

export async function handbookNoticed(store: Pick<Store, "getSetting">, tenant: string, userId: string): Promise<ReadonlySet<string>> {
  try {
    const kept = JSON.parse((await store.getSetting(tenant, noticedKey(userId))) ?? "[]") as unknown;
    return new Set(Array.isArray(kept) ? kept.filter((v): v is string => typeof v === "string" && PLUGIN_VERSION.test(v)) : []);
  } catch {
    return new Set();
  }
}

/** Records the line about one plugin at one version as closed: `<name>@<marketplace>@<version>`. */
export async function markHandbookNoticed(store: Pick<Store, "getSetting" | "setSetting">, tenant: string, userId: string, pluginAtVersion: string): Promise<boolean> {
  if (!PLUGIN_VERSION.test(pluginAtVersion)) return false;
  const noticed = [...(await handbookNoticed(store, tenant, userId))].filter((v) => v !== pluginAtVersion);
  await store.setSetting(tenant, noticedKey(userId), JSON.stringify([...noticed, pluginAtVersion].slice(-NOTICED_MAX)));
  return true;
}

/** A plugin source's key for its line, or null when it runs no hook and no server, which has none. */
export function noticeKeyOf(source: { kind: string; name: string; marketplace?: string; version?: string; hooks: unknown[]; mcpServers: unknown[] }): string | null {
  if (source.kind !== "plugin" || !source.marketplace || !source.version) return null;
  return source.hooks.length || source.mcpServers.length ? `${source.name}@${source.marketplace}@${source.version}` : null;
}

/** Each plugin that is on and runs hooks or servers the person has not closed the line about, with how many of each. */
export function withNotices<T extends { kind: string; name: string; marketplace?: string; version?: string; enabled: boolean; hooks: unknown[]; mcpServers: unknown[] }>(sources: readonly T[], noticed: ReadonlySet<string>): (T & { notice?: { hooks: number; mcpServers: number } })[] {
  return sources.map((s) => {
    const key = noticeKeyOf(s);
    return s.enabled && key !== null && !noticed.has(key) ? { ...s, notice: { hooks: s.hooks.length, mcpServers: s.mcpServers.length } } : s;
  });
}
