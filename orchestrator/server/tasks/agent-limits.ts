import type { AccountStore } from "../accounts.js";

/** How old a person's last reading of a window may be and still be shown: past a week it says nothing about now. */
export const LIMIT_SHOWN_MS = 7 * 86_400_000;

export interface LimitReading {
  window: string;
  status: "allowed" | "warning" | "refused";
  /** The share of the window spent, 1 at its limit. */
  used: number | null;
  resetAt: string | null;
  at: string;
}

const keyOf = (agent: string, person: string) => `agent-limit:${agent}:${person}`;

type Settings = Pick<AccountStore, "getSetting" | "setSetting">;

/** Keeps what an agent last said of one of its person's usage windows, beside the others it said. */
export async function noteLimit(store: Settings, tenant: string, agent: string, person: string, event: { window: string; status: LimitReading["status"]; used?: number; resetAt?: string }, at: string): Promise<void> {
  const key = keyOf(agent, person);
  const held = await readings(store, tenant, key);
  const next = held.filter((r) => r.window !== event.window);
  next.push({ window: event.window, status: event.status, used: typeof event.used === "number" && Number.isFinite(event.used) ? event.used : null, resetAt: event.resetAt ?? null, at });
  await store.setSetting(tenant, key, JSON.stringify(next));
}

/** What the agent last said of each of the person's windows within LIMIT_SHOWN_MS, newest first. */
export async function lastLimits(store: Settings, tenant: string, agent: string, person: string, now = Date.now()): Promise<LimitReading[]> {
  return (await readings(store, tenant, keyOf(agent, person))).filter((r) => now - Date.parse(r.at) <= LIMIT_SHOWN_MS).sort((a, b) => b.at.localeCompare(a.at));
}

async function readings(store: Settings, tenant: string, key: string): Promise<LimitReading[]> {
  try {
    const held = JSON.parse((await store.getSetting(tenant, key)) ?? "[]") as unknown;
    return Array.isArray(held) ? (held as LimitReading[]) : [];
  } catch {
    return [];
  }
}
