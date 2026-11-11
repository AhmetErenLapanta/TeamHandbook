import { readFileSync } from "node:fs";

export interface RouteSummary {
  route: string;
  count: number;
  p50Ms: number;
  p90Ms: number;
  maxMs: number;
  /** Answers with a 5xx status. */
  failed: number;
}

const ID_AFTER = new Set(["repos", "orgs", "tasks", "events", "policies", "keys", "runners", "invites", "users", "members", "service-accounts", "requests"]);
const LOOKS_LIKE_ID = /^(?:\d+|[a-z]{3}_[0-9a-z]{26}|[0-9a-f]{12,})$/;

/** A request's path as its route: an id or a number where the path names one, so every repository's inventory counts as one route. */
export function routeOf(method: string, path: string): string {
  const parts = path.split("/");
  const shaped = parts.map((part, i) => (LOOKS_LIKE_ID.test(part) ? (/^\d+$/.test(part) ? ":n" : ":id") : i > 0 && ID_AFTER.has(parts[i - 1]!) && part ? ":id" : part));
  return `${method} ${shaped.join("/")}`;
}

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;

/** Reads the JSON log's request lines since `since` and gives each route's count, its p50, p90 and longest time, and how many failed, the slowest first. */
export function summarizeLog(lines: Iterable<string>, since?: string): RouteSummary[] {
  const times = new Map<string, { ms: number[]; failed: number }>();
  for (const line of lines) {
    if (!line.startsWith("{")) continue;
    let entry: { time?: unknown; msg?: unknown; method?: unknown; path?: unknown; status?: unknown; ms?: unknown };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.msg !== "request" || typeof entry.method !== "string" || typeof entry.path !== "string" || typeof entry.ms !== "number") continue;
    if (since && (typeof entry.time !== "string" || entry.time < since)) continue;
    const route = routeOf(entry.method, entry.path);
    const seen = times.get(route) ?? { ms: [], failed: 0 };
    seen.ms.push(entry.ms);
    if (typeof entry.status === "number" && entry.status >= 500) seen.failed += 1;
    times.set(route, seen);
  }
  return [...times]
    .map(([route, { ms, failed }]) => {
      const sorted = [...ms].sort((a, b) => a - b);
      return { route, count: sorted.length, p50Ms: percentile(sorted, 50), p90Ms: percentile(sorted, 90), maxMs: sorted[sorted.length - 1]!, failed };
    })
    .sort((a, b) => b.p90Ms - a.p90Ms || a.route.localeCompare(b.route));
}

/** A time given as an ISO instant, or as how long ago: 30m, 6h, 2d. */
export function sinceOf(value: string, now = new Date()): string {
  const ago = /^(\d+)([mhd])$/.exec(value);
  if (ago) return new Date(now.getTime() - Number(ago[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[ago[2] as "m" | "h" | "d"]).toISOString();
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) throw new Error(`--since takes an ISO time or how long ago, as 30m, 6h or 2d; ${JSON.stringify(value)} is neither`);
  return at.toISOString();
}

const USAGE = "usage: node dist/server.js log-summary <log file>... [--since <ISO time | 30m | 6h | 2d>]";

/** `node dist/server.js log-summary`: the JSON log, rotated files too, read on this machine and printed as one line per route. */
export function logSummaryCommand(args: readonly string[], print: (line: string) => void = console.log): number {
  const files: string[] = [];
  let since: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--since") since = args[++i];
    else files.push(args[i]!);
  }
  if (!files.length || (args.includes("--since") && !since)) {
    print(USAGE);
    return 2;
  }
  let from: string | undefined;
  try {
    from = since ? sinceOf(since) : undefined;
  } catch (err) {
    print((err as Error).message);
    return 2;
  }
  const lines = files.flatMap((file) => readFileSync(file, "utf8").split("\n"));
  const rows = summarizeLog(lines, from);
  if (!rows.length) {
    print("no request lines found; the orchestrator writes them when ORCHESTRATOR_LOG_FORMAT=json");
    return 0;
  }
  print("route\tcount\tp50 ms\tp90 ms\tmax ms\tfailed");
  for (const r of rows) print(`${r.route}\t${r.count}\t${r.p50Ms}\t${r.p90Ms}\t${r.maxMs}\t${r.failed}`);
  return 0;
}
