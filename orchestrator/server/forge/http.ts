import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { maskSecrets } from "../vault.js";
import { forgeMeter, operationOf, statusClass } from "./forge-metrics.js";

export class ForgeHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** When the forge said it would take calls again, for an answer that is a rate limit. */
    readonly retryAt: string | null = null,
  ) {
    super(message);
  }
}

/**
 * When a forge that turned a call down for its rate says to come back: `Retry-After` in seconds
 * or as a date, or the reset time GitHub (`x-ratelimit-reset`) and GitLab (`ratelimit-reset`)
 * give in epoch seconds. GitHub answers a spent limit with 403 and a remaining count of 0, which
 * is how it is told from a refusal. Null for any other answer.
 */
export function rateLimitedUntil(res: Pick<Response, "status" | "headers">, now = Date.now()): string | null {
  const spent = res.headers.get("x-ratelimit-remaining") === "0" || res.headers.get("ratelimit-remaining") === "0";
  if (res.status !== 429 && !(res.status === 403 && spent)) return null;
  const after = res.headers.get("retry-after");
  if (after && /^[0-9]+$/.test(after)) return new Date(now + Number(after) * 1000).toISOString();
  if (after && Number.isFinite(Date.parse(after))) return new Date(Date.parse(after)).toISOString();
  const reset = res.headers.get("x-ratelimit-reset") ?? res.headers.get("ratelimit-reset");
  if (reset && /^[0-9]+$/.test(reset)) return new Date(Number(reset) * 1000).toISOString();
  return new Date(now + 60_000).toISOString();
}

export interface ForgeHttp {
  request<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T>;
}

const MESSAGE_MAX = 300;

/**
 * Work nobody waits on - a sync, a refresh round, a scan - is run inside `inBackground`, so a
 * forge's quota running low holds it and leaves what is left to the calls a person is waiting on.
 */
const priority = new AsyncLocalStorage<"background">();

export function inBackground<T>(work: () => Promise<T>): Promise<T> {
  return priority.run("background", work);
}

/** Below this share of its quota left, a forge takes only calls a person waits on. */
export const INTERACTIVE_RESERVE = 0.1;
/** A forge that said to wait is not called again for at least this long, nor for longer than the most. */
export const BACKOFF_MIN_MS = 30_000;
export const BACKOFF_MAX_MS = 15 * 60_000;
/** The GET answers kept to ask again with If-None-Match: a forge's "not modified" costs no quota on GitHub. */
const KEPT_ANSWERS = 500;

interface Quota {
  /** No call is made before this time: the forge said to wait. */
  until: number | null;
  remaining: number | null;
  limit: number | null;
  resetAt: number | null;
}

/** Each forge host and credential's quota as its last answer said, shared by every call made with that credential. */
const quotas = new Map<string, Quota>();
const kept = new Map<string, { etag: string; text: string }>();

/** Forgets every quota and kept answer: for a test that starts its forge again. */
export function forgetForgeState(): void {
  quotas.clear();
  kept.clear();
}

function readQuota(res: Response, now: number, previous: Quota | undefined): Quota {
  const header = (...names: string[]) => names.map((n) => res.headers.get(n)).find((v) => v !== null && /^[0-9]+$/.test(v!));
  const remaining = header("x-ratelimit-remaining", "ratelimit-remaining");
  const limit = header("x-ratelimit-limit", "ratelimit-limit");
  const reset = header("x-ratelimit-reset", "ratelimit-reset");
  const retry = rateLimitedUntil(res, now);
  return {
    until: retry ? Math.min(Math.max(Date.parse(retry), now + BACKOFF_MIN_MS), now + BACKOFF_MAX_MS) : null,
    remaining: remaining !== undefined ? Number(remaining) : (previous?.remaining ?? null),
    limit: limit !== undefined ? Number(limit) : (previous?.limit ?? null),
    resetAt: reset !== undefined ? Number(reset) * 1000 : (previous?.resetAt ?? null),
  };
}

function messageOf(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const { message, error } = payload as { message?: unknown; error?: unknown };
  const value = message ?? error;
  if (typeof value === "string") return value;
  return value === undefined ? "" : JSON.stringify(value);
}

/**
 * JSON over fetch for one forge and one token. The token travels in a header and nowhere
 * else: a URL lands in proxy logs and error messages, a header does not. Every message this
 * produces has the token masked, because a forge repeats a request back in its errors more
 * often than one would expect.
 */
export function forgeHttp(
  forge: "GitLab" | "GitHub" | "Gitea",
  baseUrl: string,
  token: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
): ForgeHttp {
  const root = baseUrl.replace(/\/+$/, "");
  const host = new URL(root).host;
  // The quota is the credential's, kept under a fingerprint of it, never the token itself.
  const scope = `${forge}\0${host}\0${createHash("sha256").update(token).digest("hex").slice(0, 16)}`;
  return {
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      const operation = operationOf(method, path);
      const now = Date.now();
      const quota = quotas.get(scope);
      const lowOnQuota = quota !== undefined && quota.remaining !== null && quota.limit !== null && quota.remaining < quota.limit * INTERACTIVE_RESERVE && (quota.resetAt ?? 0) > now;
      const waitUntil = quota?.until && quota.until > now ? quota.until : lowOnQuota && priority.getStore() === "background" ? quota.resetAt : null;
      if (waitUntil) {
        forgeMeter.called(forge, host, operation, "held");
        const until = new Date(waitUntil).toISOString();
        throw new ForgeHttpError(`${forge} asked the orchestrator to wait until ${until}; ${method} ${path} was not sent, try again after that`, 429, until);
      }
      const cacheKey = method === "GET" ? `${scope}\0${path}` : null;
      const before = cacheKey ? kept.get(cacheKey) : undefined;
      let res: Response;
      try {
        res = await fetchImpl(`${root}${path}`, {
          method,
          headers: { ...headers, ...(before ? { "if-none-match": before.etag } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
          body: body === undefined ? undefined : JSON.stringify(body),
          // Not followed: the token goes to the address an admin entered and nowhere it points.
          redirect: "manual",
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        forgeMeter.called(forge, host, operation, statusClass(0));
        throw new ForgeHttpError(maskSecrets(`${forge} is unreachable on ${method} ${path}; try again, and if it repeats, whoever runs the orchestrator checks its network (${(err as Error).message})`, [token]).slice(0, MESSAGE_MAX), 0);
      }
      forgeMeter.called(forge, host, operation, statusClass(res.status));
      const seen = readQuota(res, now, quota);
      quotas.set(scope, seen);
      if (seen.remaining !== null) forgeMeter.reported(forge, host, seen.remaining, seen.limit);
      if (res.status === 304 && before) {
        // Not modified: the answer kept the last time this was asked stands.
        return (before.text ? JSON.parse(before.text) : null) as T;
      }
      if (res.status >= 300 && res.status < 400) {
        throw new ForgeHttpError(`${forge} answered ${res.status} on ${method} ${path}, a redirect the orchestrator does not follow; an owner or an admin checks the repository's API address`, res.status);
      }
      const text = await res.text();
      const etag = res.headers.get("etag");
      if (cacheKey && res.ok && etag) {
        kept.delete(cacheKey);
        kept.set(cacheKey, { etag, text });
        if (kept.size > KEPT_ANSWERS) kept.delete(kept.keys().next().value!);
      }
      let payload: unknown = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = null;
      }
      if (!res.ok) {
        const detail = messageOf(payload);
        const message = `${forge} answered ${res.status} on ${method} ${path}${detail ? `: ${detail}` : ""}`;
        throw new ForgeHttpError(maskSecrets(message, [token]).slice(0, MESSAGE_MAX), res.status, rateLimitedUntil(res));
      }
      return payload as T;
    },
  };
}

/** The same branch rule as the local forge: a name a user cannot turn into an option or a path climb. */
export const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

export function checkBranch(branch: string): void {
  if (!BRANCH.test(branch) || branch.includes("..")) throw new Error(`invalid branch name ${JSON.stringify(branch)}`);
}
