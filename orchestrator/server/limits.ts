import type { Context } from "hono";
import type { OrchestratorContext } from "./app.js";
import type { Principal } from "./auth.js";
import { recordEvent } from "./events.js";

/**
 * The orchestrator's one rate limiter: a minute's window per key, counted in memory, so an orchestrator
 * restarted forgets it. Sign-in, setup, invitation links, usage reports and every call made
 * with an API key count through it; each answers a refusal with 429 and how long to wait.
 */
export interface Verdict {
  ok: boolean;
  /** Whole seconds until the oldest call in the window leaves it; 0 when the call was let through. */
  retryAfter: number;
}

const WINDOW_MS = 60_000;

/**
 * A sliding one-minute window per key; a flood under one key cannot crowd out another's.
 * The keys are typed by whoever calls, so the map they key is bounded at `maxKeys`: once it is
 * full, the keys idle longest are dropped to make room. Refusing new keys instead would let
 * anyone who fills the table with made-up ones hold back every caller that comes after them.
 */
export function windowLimiter(perMinute: number, now: () => number = Date.now, maxKeys = 10_000): (key: string, count?: number) => Verdict {
  // In the order keys were last seen, so the first entries are the ones idle longest.
  const hits = new Map<string, number[]>();
  return (key, count = 1) => {
    const t = now();
    const recent = (hits.get(key) ?? []).filter((at) => t - at < WINDOW_MS);
    hits.delete(key);
    for (const idle of hits.keys()) {
      if (hits.size < maxKeys) break;
      hits.delete(idle);
    }
    if (recent.length + count > perMinute) {
      hits.set(key, recent);
      return { ok: false, retryAfter: Math.max(1, Math.ceil(((recent[recent.length + count - perMinute - 1] ?? t) + WINDOW_MS - t) / 1000)) };
    }
    for (let i = 0; i < count; i++) recent.push(t);
    hits.set(key, recent);
    return { ok: true, retryAfter: 0 };
  };
}

/** The same limiter where a caller only needs yes or no. */
export function rateLimiter(perMinute: number, now: () => number = Date.now, maxKeys = 10_000): (key: string) => boolean {
  const limit = windowLimiter(perMinute, now, maxKeys);
  return (key) => limit(key).ok;
}

/**
 * Calls a key may make a minute, and calls all the keys of one person or service account may
 * make together. Enough for a CI job or an agent reading as it works; a leaked key replaying a
 * task start or forge reads meets the first, and many keys of one account the second.
 */
export const PER_KEY_PER_MINUTE = 120;
export const PER_ACCOUNT_PER_MINUTE = 300;

/** Who a key-signed call counts against: the key, and the person or service account it acts for. */
export interface KeyCaller {
  tenant: string;
  keyId: string;
  owner: { kind: string; id: string };
}

/**
 * The gate every key-signed call passes: the REST API here, and the orchestrator's MCP server and
 * OAuth token endpoint through the same function, so a key spends one budget wherever it calls.
 */
export function keyGate(now: () => number = Date.now): (caller: KeyCaller) => Verdict & { limit?: "key" | "account" } {
  const perKey = windowLimiter(PER_KEY_PER_MINUTE, now);
  const perAccount = windowLimiter(PER_ACCOUNT_PER_MINUTE, now);
  return (caller) => {
    const key = perKey(`${caller.tenant}\0${caller.keyId}`);
    if (!key.ok) return { ...key, limit: "key" };
    const account = perAccount(`${caller.tenant}\0${caller.owner.kind}:${caller.owner.id}`);
    return account.ok ? account : { ...account, limit: "account" };
  };
}

/** The process's gate; one budget per key whichever route or organization it calls through. */
export const limitKeyCall = keyGate();

/** A refusal for too many calls, saying when to try again. */
export function tooMany(c: Context, verdict: Verdict, error: string): Response {
  c.header("Retry-After", String(verdict.retryAfter));
  return c.json({ error, retryAfter: verdict.retryAfter }, 429);
}

/** How long one key's refusals are folded into a single event-log row. */
export const LIMITED_EVENT_MS = 10 * 60_000;

/**
 * Writes that a key was held back, once per key per ten minutes: the log says it happened and
 * which key, and a key replaying calls does not fill the log with a row per refusal.
 */
export function limitedNotes(now: () => number = Date.now): (ctx: Pick<OrchestratorContext, "store" | "tenant">, actor: Principal, keyId: string, limit: string) => Promise<void> {
  const last = new Map<string, number>();
  return async (ctx, actor, keyId, limit) => {
    const at = now();
    const mark = `${ctx.tenant}\0${keyId}`;
    if ((last.get(mark) ?? -Infinity) > at - LIMITED_EVENT_MS) return;
    last.set(mark, at);
    if (last.size > 10_000) last.delete(last.keys().next().value!);
    await recordEvent(ctx, actor, "key.rate-limited", { subject: `key:${keyId}`, detail: `held back past ${limit === "account" ? `${PER_ACCOUNT_PER_MINUTE} calls a minute for the account` : `${PER_KEY_PER_MINUTE} calls a minute for the key`}; further refusals in the next ten minutes are not written` });
  };
}

export const noteLimited = limitedNotes();
