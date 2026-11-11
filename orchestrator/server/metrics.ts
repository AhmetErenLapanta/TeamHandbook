import type { OrchestratorContext } from "./app.js";
import { inConfiguration } from "./app.js";
import { readSecretEnv } from "./secret-env.js";
import { ORCHESTRATOR_RELEASE } from "./setup.js";
import { SCHEMA_VERSION } from "./store.js";
import { loopDelay } from "./diagnostics.js";
import { forgeMeter } from "./forge/forge-metrics.js";
import type { ForgeMeter } from "./forge/forge-metrics.js";

/** What this process has counted since it started, for the metrics a scraper reads. */
export class Metrics {
  readonly requests = new Map<string, { count: number; seconds: number }>();
  readonly syncFailures = new Map<string, number>();

  observe(method: string, status: number, seconds: number): void {
    const key = `${method}\0${status}`;
    const seen = this.requests.get(key) ?? { count: 0, seconds: 0 };
    this.requests.set(key, { count: seen.count + 1, seconds: seen.seconds + seconds });
  }

  syncFailed(tenant: string): void {
    this.syncFailures.set(tenant, (this.syncFailures.get(tenant) ?? 0) + 1);
  }

  readonly effects = new Map<string, number>();

  effectSettled(kind: string, outcome: string): void {
    const key = `${kind}\0${outcome}`;
    this.effects.set(key, (this.effects.get(key) ?? 0) + 1);
  }
}

export const metrics = new Metrics();

/** ORCHESTRATOR_METRICS_TOKEN (or _FILE): the token a scraper sends; unset, the orchestrator serves no metrics. */
export function metricsToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const token = readSecretEnv(env, "ORCHESTRATOR_METRICS_TOKEN");
  if (token === undefined) return null;
  if (token.length < 24) throw new Error("ORCHESTRATOR_METRICS_TOKEN has to be at least 24 characters");
  return token;
}

const label = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

/** The Prometheus text exposition: the release, the requests served, each org's repositories by state, and the syncs that failed. */
export async function renderMetrics(contexts: readonly OrchestratorContext[], counted: Metrics = metrics, forges: ForgeMeter = forgeMeter): Promise<string> {
  const lines = [
    "# HELP teamhandbook_orchestrator_info The release this orchestrator runs and the schema version of its database.",
    "# TYPE teamhandbook_orchestrator_info gauge",
    `teamhandbook_orchestrator_info{version="${label(ORCHESTRATOR_RELEASE)}",schema="${SCHEMA_VERSION}"} 1`,
    "# HELP teamhandbook_orchestrator_http_requests_total Requests answered, by method and status.",
    "# TYPE teamhandbook_orchestrator_http_requests_total counter",
  ];
  const requests = [...counted.requests].sort(([a], [b]) => a.localeCompare(b));
  for (const [key, { count }] of requests) {
    const [method, status] = key.split("\0");
    lines.push(`teamhandbook_orchestrator_http_requests_total{method="${label(method!)}",status="${status}"} ${count}`);
  }
  lines.push("# HELP teamhandbook_orchestrator_http_request_duration_seconds Time spent answering, by method and status.", "# TYPE teamhandbook_orchestrator_http_request_duration_seconds summary");
  for (const [key, { count, seconds }] of requests) {
    const [method, status] = key.split("\0");
    const labels = `method="${label(method!)}",status="${status}"`;
    lines.push(`teamhandbook_orchestrator_http_request_duration_seconds_sum{${labels}} ${seconds.toFixed(6)}`, `teamhandbook_orchestrator_http_request_duration_seconds_count{${labels}} ${count}`);
  }
  lines.push("# HELP teamhandbook_orchestrator_repositories Listed repositories by the state of their last sync.", "# TYPE teamhandbook_orchestrator_repositories gauge");
  for (const ctx of contexts) {
    const repos = (await ctx.store.listRepos(ctx.tenant)).filter((r) => inConfiguration(ctx, r.id));
    const states = { ok: repos.filter((r) => r.head && !r.error).length, failing: repos.filter((r) => r.error).length, unread: repos.filter((r) => !r.head && !r.error).length };
    for (const [state, n] of Object.entries(states)) lines.push(`teamhandbook_orchestrator_repositories{org="${label(ctx.tenant)}",state="${state}"} ${n}`);
  }
  lines.push("# HELP teamhandbook_orchestrator_sync_failures_total Repository syncs that failed since the orchestrator started.", "# TYPE teamhandbook_orchestrator_sync_failures_total counter");
  for (const ctx of contexts) lines.push(`teamhandbook_orchestrator_sync_failures_total{org="${label(ctx.tenant)}"} ${counted.syncFailures.get(ctx.tenant) ?? 0}`);
  const memory = process.memoryUsage();
  const delay = loopDelay();
  lines.push(
    "# HELP teamhandbook_orchestrator_process_resident_memory_bytes Memory the process holds.",
    "# TYPE teamhandbook_orchestrator_process_resident_memory_bytes gauge",
    `teamhandbook_orchestrator_process_resident_memory_bytes ${memory.rss}`,
    "# HELP teamhandbook_orchestrator_process_heap_used_bytes JavaScript heap in use.",
    "# TYPE teamhandbook_orchestrator_process_heap_used_bytes gauge",
    `teamhandbook_orchestrator_process_heap_used_bytes ${memory.heapUsed}`,
    "# HELP teamhandbook_orchestrator_process_uptime_seconds Time since the process started.",
    "# TYPE teamhandbook_orchestrator_process_uptime_seconds gauge",
    `teamhandbook_orchestrator_process_uptime_seconds ${Math.round(process.uptime())}`,
    "# HELP teamhandbook_orchestrator_event_loop_delay_seconds The event loop's pauses in the last sample, longest and 99th percentile.",
    "# TYPE teamhandbook_orchestrator_event_loop_delay_seconds gauge",
    `teamhandbook_orchestrator_event_loop_delay_seconds{quantile="max"} ${(delay.maxMs / 1000).toFixed(3)}`,
    `teamhandbook_orchestrator_event_loop_delay_seconds{quantile="0.99"} ${(delay.p99Ms / 1000).toFixed(3)}`,
    "# HELP teamhandbook_orchestrator_tasks_unfinished Tasks queued or running, by organization.",
    "# TYPE teamhandbook_orchestrator_tasks_unfinished gauge",
  );
  for (const ctx of contexts) lines.push(`teamhandbook_orchestrator_tasks_unfinished{org="${label(ctx.tenant)}"} ${(await ctx.store.unfinishedTasks(ctx.tenant)).length}`);
  lines.push("# HELP teamhandbook_orchestrator_task_effects_total Task effects settled since the orchestrator started, by kind and outcome.", "# TYPE teamhandbook_orchestrator_task_effects_total counter");
  for (const [key, n] of [...counted.effects].sort(([a], [b]) => a.localeCompare(b))) {
    const [kind, outcome] = key.split("\0");
    lines.push(`teamhandbook_orchestrator_task_effects_total{kind="${label(kind!)}",outcome="${outcome}"} ${n}`);
  }
  // Labels from a fixed set and the API's host name only: never a path, project, branch or commit.
  lines.push("# HELP teamhandbook_orchestrator_forge_calls_total Calls to forges since the orchestrator started, by forge, host, operation and status class; held ones were not sent.", "# TYPE teamhandbook_orchestrator_forge_calls_total counter");
  for (const [key, n] of [...forges.calls].sort(([a], [b]) => a.localeCompare(b))) {
    const [forge, host, operation, status] = key.split("\0");
    lines.push(`teamhandbook_orchestrator_forge_calls_total{forge="${label(forge!)}",host="${label(host!)}",operation="${label(operation!)}",status="${label(status!)}"} ${n}`);
  }
  lines.push("# HELP teamhandbook_orchestrator_forge_quota_remaining What each forge last said was left of its rate limit for the orchestrator's credential.", "# TYPE teamhandbook_orchestrator_forge_quota_remaining gauge");
  for (const [key, { remaining }] of [...forges.quota].sort(([a], [b]) => a.localeCompare(b))) {
    const [forge, host] = key.split("\0");
    lines.push(`teamhandbook_orchestrator_forge_quota_remaining{forge="${label(forge!)}",host="${label(host!)}"} ${remaining}`);
  }
  return `${lines.join("\n")}\n`;
}
