import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { OrchestratorContext } from "./app.js";
import { installLogger, logFormat, redactLine } from "./log.js";
import { Metrics, metricsToken, renderMetrics } from "./metrics.js";
import { orgRoutes } from "./orgs.js";
import { ORCHESTRATOR_RELEASE } from "./setup.js";
import { openSqliteStore, SCHEMA_VERSION } from "./store.js";

const TOKEN = "a-metrics-scrape-token-0123456789";
const originals = { log: console.log, info: console.info, warn: console.warn, error: console.error };
afterEach(() => Object.assign(console, originals));

async function served(options: { metricsToken?: string | null; logFormat?: "text" | "json"; broken?: boolean; dataDir?: string } = {}) {
  const store = openSqliteStore(":memory:");
  await store.upsertRepo({ tenant: "acme", id: "payments-skills", team: "Payments", name: "payments-skills", url: "file:///nonexistent.git" });
  await store.recordSync("acme", "payments-skills", { error: "fatal: repository not found" });
  const failing = options.broken ? new Proxy(store, { get: (t, k) => (k === "listRepos" ? async () => Promise.reject(new Error("the database is gone")) : Reflect.get(t, k)) }) : store;
  const ctx: OrchestratorContext = { store: failing, dataDir: "/nonexistent", tenant: "acme", allowedHosts: null };
  return orgRoutes([{ ctx, app: createApp(ctx) }], { mode: "local", secure: false, allowedHosts: null, logFormat: options.logFormat ?? "text", metricsToken: options.metricsToken ?? null, ...(options.dataDir ? { dataDir: options.dataDir } : {}) });
}

describe("health", () => {
  it("given an orchestrator whose store answers and whose one repository fails to sync, when liveness and readiness are asked without the metrics token, then it is alive and ready and says nothing else", async () => {
    // given
    const app = await served({ metricsToken: TOKEN });

    // when
    const live = await (await app.request("/api/health")).json();
    const ready = await app.request("/api/health/ready");
    const guessed = await app.request("/api/health/ready", { headers: { authorization: "Bearer not-the-metrics-token-0000000000" } });

    // then
    expect(live).toEqual({ ok: true });
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ ready: true });
    expect(await guessed.json()).toEqual({ ready: true });
  });

  it("given the operator's metrics token, when readiness is asked, then it says the release, the schema and each org's repositories and failing ones", async () => {
    // given
    const app = await served({ metricsToken: TOKEN });

    // when
    const ready = await app.request("/api/health/ready", { headers: { authorization: `Bearer ${TOKEN}` } });

    // then
    expect(await ready.json()).toEqual({ ready: true, version: ORCHESTRATOR_RELEASE, schema: SCHEMA_VERSION, secrets: "none", orgs: [{ org: "acme", ready: true, repos: 1, failing: 1 }] });
  });

  it("given a store that does not answer, when readiness is asked, then it answers 503 and liveness still answers", async () => {
    // given
    const app = await served({ broken: true });

    // when
    const ready = await app.request("/api/health/ready");
    const live = await app.request("/api/health");

    // then
    expect([ready.status, await ready.json()]).toEqual([503, { ready: false }]);
    expect(live.status).toBe(200);
  });
});

describe("metrics", () => {
  it("given no metrics token, when a scraper asks, then no metrics are served", async () => {
    expect((await (await served()).request("/metrics")).status).toBe(404);
  });

  it.each([["no token", undefined], ["another token", "Bearer not-the-metrics-token-0000000000"]])("given %s, when a scraper asks, then it is refused", async (_label, authorization) => {
    const res = await (await served({ metricsToken: TOKEN })).request("/metrics", authorization ? { headers: { authorization } } : {});
    expect(res.status).toBe(401);
  });

  it("given a scraper with the token, when it asks after a request was answered, then it reads the release, the requests, the repositories by state and the failed syncs in the Prometheus format", async () => {
    // given
    const app = await served({ metricsToken: TOKEN });
    await app.request("/api/health");

    // when
    const res = await app.request("/metrics", { headers: { authorization: `Bearer ${TOKEN}` } });
    const text = await res.text();

    // then
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain; version=0.0.4");
    expect(text).toContain(`teamhandbook_orchestrator_info{version="${ORCHESTRATOR_RELEASE}",schema="${SCHEMA_VERSION}"} 1`);
    expect(text).toMatch(/teamhandbook_orchestrator_http_requests_total\{method="GET",status="200"\} \d+/);
    expect(text).toContain('teamhandbook_orchestrator_repositories{org="acme",state="failing"} 1');
    expect(text).toContain("# TYPE teamhandbook_orchestrator_sync_failures_total counter");
  });

  it("given a sync that failed and a label with a quote, when the metrics are rendered, then the failure is counted and the label escaped", async () => {
    // given
    const counted = new Metrics();
    counted.syncFailed('ac"me');
    const ctx = { store: openSqliteStore(":memory:"), dataDir: "/nonexistent", tenant: 'ac"me' } as OrchestratorContext;

    // when
    const text = await renderMetrics([ctx], counted);

    // then
    expect(text).toContain('teamhandbook_orchestrator_sync_failures_total{org="ac\\"me"} 1');
  });

  it.each([[{}, null], [{ ORCHESTRATOR_METRICS_TOKEN: TOKEN }, TOKEN]])("given %j, when the token is read, then it is %s", (env, token) => {
    expect(metricsToken(env)).toBe(token);
  });

  it("given a token shorter than 24 characters, when it is read, then the orchestrator stops", () => {
    expect(() => metricsToken({ ORCHESTRATOR_METRICS_TOKEN: "short" })).toThrow();
  });
});

describe("the orchestrator's log", () => {
  it("given lines with a password in an address and with a token, when they are logged, then the first is masked and the second withheld", () => {
    expect(redactLine("sync payments: fatal: unable to access https://ops:hunter2@git.example.com/x.git")).toBe("sync payments: fatal: unable to access https://***@git.example.com/x.git");
    expect(redactLine("forge said: token ghp_abcdefghijklmnopqrstuvwxyz0123456789 is wrong")).toMatch(/^\[withheld: a log line that looks like it holds a /);
  });

  it("given JSON logging, when a line is written and a request is answered, then each is one JSON object, the request with its id and its path without the query", async () => {
    // given
    const lines: string[] = [];
    installLogger("json", (l) => lines.push(l), (l) => lines.push(l));
    const app = await served({ logFormat: "json" });

    // when
    console.error("sync payments: fatal: https://ops:hunter2@git.example.com/x.git");
    const res = await app.request("/api/auth/oidc/callback?code=secret-code&state=s", { headers: { "x-request-id": "req-42" } });
    const invented = await app.request("/api/health", { headers: { "x-request-id": "bad id with spaces" } });

    // then
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsed[0]).toMatchObject({ level: "error", msg: "sync payments: fatal: https://***@git.example.com/x.git" });
    expect(parsed.find((p) => p.requestId === "req-42")).toMatchObject({ level: "info", msg: "request", method: "GET", path: "/api/auth/oidc/callback" });
    expect(res.headers.get("x-request-id")).toBe("req-42");
    expect(invented.headers.get("x-request-id")).toMatch(/^[0-9a-f]{16}$/);
    expect(lines.join("")).not.toMatch(/hunter2|secret-code/);
  });

  it.each([[undefined, "text"], ["json", "json"]])("given ORCHESTRATOR_LOG_FORMAT=%s, when it is read, then the orchestrator logs %s", (value, as) => {
    expect(logFormat(value)).toBe(as);
  });

  it("given a format the orchestrator does not write, when it is read, then the orchestrator stops", () => {
    expect(() => logFormat("xml")).toThrow();
  });
});

describe("what the operator reads about the process", () => {
  it("given the metrics token, when /metrics is read, then the process's memory, uptime, event loop delay and each organization's unfinished tasks are there", async () => {
    // given
    const app = await served({ metricsToken: TOKEN });

    // when
    const text = await (await app.request("/metrics", { headers: { authorization: `Bearer ${TOKEN}` } })).text();

    // then
    expect(text).toMatch(/^teamhandbook_orchestrator_process_resident_memory_bytes \d+$/m);
    expect(text).toMatch(/^teamhandbook_orchestrator_process_uptime_seconds \d+$/m);
    expect(text).toContain('teamhandbook_orchestrator_event_loop_delay_seconds{quantile="max"}');
    expect(text).toContain('teamhandbook_orchestrator_tasks_unfinished{org="acme"} 0');
  });

  it("given a heap snapshot asked for without the token, without a data directory and with both, when each is answered, then only the last writes one, readable by its owner alone, and answers its path and nothing of its content", async () => {
    // given
    const dir = mkdtempSync(join(tmpdir(), "th-diagnostics-"));
    try {
      const withDir = await served({ metricsToken: TOKEN, dataDir: dir });
      const withoutDir = await served({ metricsToken: TOKEN });

      // when
      const anonymous = await withDir.request("/api/operator/heap-snapshot", { method: "POST" });
      const nowhere = await withoutDir.request("/api/operator/heap-snapshot", { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } });
      const taken = await withDir.request("/api/operator/heap-snapshot", { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } });

      // then
      expect([anonymous.status, nowhere.status, taken.status]).toEqual([401, 404, 200]);
      const body = (await taken.json()) as { path: string };
      expect(Object.keys(body)).toEqual(["path"]);
      expect(body.path.startsWith(join(dir, "diagnostics"))).toBe(true);
      expect(statSync(body.path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
