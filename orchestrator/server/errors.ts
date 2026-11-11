import type { Context, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * Every refusal the orchestrator gives, in one shape: a message for a person and a code a program
 * reads. The app's one error handler turns it into `{error, code}` with its status, so a route
 * throws one rather than shaping its own answer.
 */
export class OrchestratorError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: ContentfulStatusCode = 400,
  ) {
    super(message);
  }
}

/** The code an answer gets from its status alone, for a refusal a route wrote without one. */
export const STATUS_CODES: Partial<Record<number, string>> = {
  400: "invalid",
  401: "signed-out",
  403: "forbidden",
  404: "not-found",
  409: "conflict",
  413: "too-large",
  421: "wrong-host",
  429: "rate-limited",
  500: "internal",
  502: "upstream",
};

export function errorAnswer(c: Context, err: OrchestratorError): Response {
  return c.json({ error: err.message, code: err.code }, err.status);
}

/**
 * Gives a JSON refusal that names no code the one its status implies, so every error body a
 * client reads carries `code` beside `error`, whichever route wrote it.
 */
export function errorCodes(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    if (c.res.status < 400 || !(c.res.headers.get("content-type") ?? "").startsWith("application/json")) return;
    const body = (await c.res.clone().json().catch(() => null)) as { error?: unknown; code?: unknown } | null;
    if (!body || typeof body.error !== "string" || body.code !== undefined) return;
    const headers = new Headers(c.res.headers);
    headers.delete("content-length");
    c.res = new Response(JSON.stringify({ ...body, code: STATUS_CODES[c.res.status] ?? "error" }), { status: c.res.status, headers });
  };
}
