import { HANDBOOK_CONTEXT_PREFIX } from "../store.js";
import type { Store } from "../store.js";

/**
 * What a person's last task counted of the context their setup takes: each MCP server and each skill by name with its
 * tokens, as the task's agent said when its session opened. No session is opened to measure; a task that ran is the
 * only source, so the page says it is their last task's.
 */
export interface MeasuredContext {
  at: string;
  mcpServers: { name: string; tokens: number }[];
  skills: { name: string; tokens: number }[];
  /** The model's context window in that task, for the share; absent where its agent did not say. */
  window?: number;
}

const MEASURED_MAX = 300;
const NAME_MAX = 200;

/** The agent's words, held as data: a printable name, cut, with a whole count that is not negative; anything else is dropped. */
function counted(list: unknown): { name: string; tokens: number }[] {
  if (!Array.isArray(list)) return [];
  return list
    .flatMap((entry: { name?: unknown; tokens?: unknown } | null) => {
      const name = typeof entry?.name === "string" && !/[\u0000-\u001f\u007f]/.test(entry.name) ? entry.name.trim().slice(0, NAME_MAX) : "";
      return name && typeof entry!.tokens === "number" && Number.isFinite(entry!.tokens) && entry!.tokens >= 0 ? [{ name, tokens: Math.round(entry!.tokens) }] : [];
    })
    .slice(0, MEASURED_MAX);
}

const windowOf = (value: unknown): { window?: number } => (typeof value === "number" && Number.isInteger(value) && value >= 1 ? { window: value } : {});

export async function keepMeasuredContext(store: Pick<Store, "setSetting">, tenant: string, userId: string, said: { mcpServers: unknown; skills: unknown; window?: unknown }, at: string): Promise<void> {
  const measured: MeasuredContext = { at, mcpServers: counted(said.mcpServers), skills: counted(said.skills), ...windowOf(said.window) };
  await store.setSetting(tenant, `${HANDBOOK_CONTEXT_PREFIX}${userId}`, JSON.stringify(measured));
}

export async function measuredContext(store: Pick<Store, "getSetting">, tenant: string, userId: string): Promise<MeasuredContext | null> {
  try {
    const kept = JSON.parse((await store.getSetting(tenant, `${HANDBOOK_CONTEXT_PREFIX}${userId}`)) ?? "null") as Partial<MeasuredContext> | null;
    return kept && typeof kept.at === "string" ? { at: kept.at, mcpServers: counted(kept.mcpServers), skills: counted(kept.skills), ...windowOf(kept.window) } : null;
  } catch {
    return null;
  }
}
