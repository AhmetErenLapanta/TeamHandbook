import type { AgentFailure } from "./contract.js";

/**
 * The first message of a session the orchestrator resumes on its own once a usage limit has reset.
 * The agent was cut off mid-step, so it checks what already happened before doing it again.
 */
export const CONTINUE_AFTER_LIMIT = "Continue where you left off. Check whether anything you started before the usage limit already happened before doing it again.";

/** A reset further away than this is not believed: a misread unit would otherwise park a task for years. */
const LONGEST_WAIT_MS = 31 * 24 * 60 * 60 * 1000;

/** A usage limit's reset from the agent's epoch seconds, kept only when it is a whole number in the near future. */
export function resetAtFrom(seconds: unknown, now: number = Date.now()): string | undefined {
  if (typeof seconds !== "number" || !Number.isInteger(seconds)) return undefined;
  return near(seconds * 1000, now);
}

/** A usage limit's reset a runner reports as a time, kept only when it is one, ahead and near. */
export function resetAtFromTime(at: unknown, now: number = Date.now()): string | undefined {
  return typeof at === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(at) ? near(Date.parse(at), now) : undefined;
}

const near = (at: number, now: number): string | undefined => (at > now && at - now <= LONGEST_WAIT_MS ? new Date(at).toISOString() : undefined);

/**
 * When a refused request is worth trying again, from the provider's response headers as OpenCode
 * reads them: `retry-after-ms`, else `retry-after` in seconds or as an HTTP date.
 */
export function resetAtFromHeaders(headers: unknown, now: number = Date.now()): string | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const h = headers as Record<string, unknown>;
  const ms = typeof h["retry-after-ms"] === "string" ? Number(h["retry-after-ms"]) : NaN;
  if (Number.isFinite(ms)) return near(now + ms, now);
  const after = h["retry-after"];
  if (typeof after !== "string" || !after.trim()) return undefined;
  const seconds = Number(after);
  return near(Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(after), now);
}

const WORDS: Record<AgentFailure["class"], (agent: string, code: string | undefined) => string> = {
  usage_limit: (agent) => `${agent} reached its usage limit.`,
  sign_in: (agent) => `${agent} is not signed in, or its sign-in was refused.`,
  provider: (_agent, code) => `The model provider failed the request${code ? ` (${code})` : ""}.`,
  provider_retrying: (agent, code) => `The model provider is having trouble${code ? ` (${code})` : ""}, and ${agent} is trying again on its own.`,
  transport: (agent) => `${agent} ended without reporting how its turn went.`,
};

/**
 * A failure in the orchestrator's own words. The agent's text goes in `detail` as data, for the log
 * the runner masks; the message, which the card shows and the task keeps, never quotes it.
 */
export function failure(agent: string, cls: AgentFailure["class"], options: { code?: string; retryable?: boolean; resetAt?: string; detail?: string } = {}): AgentFailure {
  return {
    class: cls,
    message: WORDS[cls](agent, options.code),
    retryable: options.retryable ?? cls !== "sign_in",
    ...(options.code ? { code: options.code } : {}),
    ...(options.resetAt ? { resetAt: options.resetAt } : {}),
    ...(options.detail ? { detail: options.detail } : {}),
  };
}

/** What an HTTP status from the model provider stands for: 429 a limit, 401 and 403 the sign-in, 5xx the provider having trouble. */
export function httpFailure(agent: string, status: number, options: { resetAt?: string; detail?: string } = {}): AgentFailure {
  const code = `HTTP ${status}`;
  if (status === 429) return failure(agent, "usage_limit", { code, retryable: true, ...options });
  if (status === 401 || status === 403) return failure(agent, "sign_in", { code, detail: options.detail });
  return failure(agent, "provider", { code, retryable: status >= 500, detail: options.detail });
}
