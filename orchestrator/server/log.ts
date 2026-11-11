import { randomBytes } from "node:crypto";
import { format } from "node:util";
import type { MiddlewareHandler } from "hono";
import { detectSecret } from "./plugin.js";

export type LogFormat = "text" | "json";

/** ORCHESTRATOR_LOG_FORMAT: `text`, the default, for a person at a terminal; `json`, one object a line, for a log collector. */
export function logFormat(value: string | undefined = process.env.ORCHESTRATOR_LOG_FORMAT): LogFormat {
  if (value === undefined || value === "" || value === "text") return "text";
  if (value === "json") return "json";
  throw new Error(`ORCHESTRATOR_LOG_FORMAT=${JSON.stringify(value)} is not a format this orchestrator writes; use text or json`);
}

const LINE_MAX = 4000;

/**
 * A log line as it leaves the process: an address's user and password masked, and the whole
 * line withheld when it still looks like it holds a secret. A git error repeats the URL it was
 * given, and a forge's answer can carry what was sent to it; the log is read by whoever runs
 * the orchestrator and by every system it is shipped to.
 */
export function redactLine(text: string): string {
  const masked = text.replace(/(\w+:\/\/)[^/@\s]+@/g, "$1***@");
  const secret = detectSecret(masked);
  if (secret) return `[withheld: a log line that looks like it holds a ${secret}]`;
  return masked.length > LINE_MAX ? `${masked.slice(0, LINE_MAX - 1)}…` : masked;
}

const LEVELS = { log: "info", info: "info", warn: "warn", error: "error" } as const;

/**
 * Sends every line the orchestrator writes through `redactLine`, as text or as JSON. The orchestrator's
 * code writes with console.log and console.error; replacing them here keeps one place that
 * decides what reaches the log, whichever module wrote the line.
 */
export function installLogger(as: LogFormat, out: (line: string) => void = (l) => process.stdout.write(l), err: (line: string) => void = (l) => process.stderr.write(l)): void {
  for (const method of Object.keys(LEVELS) as (keyof typeof LEVELS)[]) {
    const level = LEVELS[method];
    console[method] = (...args: unknown[]) => {
      const fields = as === "json" && args.length === 2 && typeof args[0] === "string" && args[1] && typeof args[1] === "object" ? (args[1] as Record<string, unknown>) : null;
      const msg = redactLine(fields ? (args[0] as string) : format(...args));
      const write = level === "error" || level === "warn" ? err : out;
      if (as === "text") return write(`${msg}\n`);
      const safe = fields ? Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, typeof v === "string" ? redactLine(v) : v])) : {};
      write(`${JSON.stringify({ time: new Date().toISOString(), level, msg, ...safe })}\n`);
    };
  }
}

const REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Gives each request an id, the one its proxy sent when it is a plain token and a new one
 * otherwise, answers it in `x-request-id`, and in JSON logging writes one line for the request
 * when it is answered. The path is logged without its query: a sign-in's return carries its code
 * and state there.
 */
export function accessLog(as: LogFormat, observe: (method: string, status: number, seconds: number) => void = () => undefined): MiddlewareHandler {
  return async (c, next) => {
    const given = c.req.header("x-request-id");
    const id = given && REQUEST_ID.test(given) ? given : randomBytes(8).toString("hex");
    const started = performance.now();
    await next();
    c.header("x-request-id", id);
    const seconds = (performance.now() - started) / 1000;
    observe(c.req.method, c.res.status, seconds);
    if (as === "json") console.info("request", { requestId: id, method: c.req.method, path: new URL(c.req.url).pathname, status: c.res.status, ms: Math.round(seconds * 1000) });
  };
}
