import { describe, expect, it } from "vitest";
import { logSummaryCommand, routeOf, sinceOf, summarizeLog } from "./log-summary.js";

const line = (time: string, method: string, path: string, status: number, ms: number) => JSON.stringify({ time, level: "info", msg: "request", requestId: "r", method, path, status, ms });

describe("the log summary", () => {
  it("given request paths naming repositories, tasks, requests and ids, when their routes are read, then each repository's and task's become one route", () => {
    expect(routeOf("GET", "/api/repos/payments-skills/inventory")).toBe("GET /api/repos/:id/inventory");
    expect(routeOf("POST", "/api/repos/payments-skills/requests/12/merge")).toBe("POST /api/repos/:id/requests/:n/merge");
    expect(routeOf("GET", "/api/orgs/acme/tasks/tsk_01jbz3k9m2n4p6q8r0s2t4v6w8/events")).toBe("GET /api/orgs/:id/tasks/:id/events");
    expect(routeOf("GET", "/api/me")).toBe("GET /api/me");
  });

  it("given request lines of two routes, a failure, other lines and one before the window, when the log is summed up since a time, then each route has its count, p50, p90, longest time and failures, the slowest first", () => {
    // given
    const lines = [
      line("2026-11-03T09:00:00.000Z", "GET", "/api/me", 200, 999),
      ...[10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((ms, i) => line(`2026-11-03T10:00:0${i}.000Z`, "GET", `/api/repos/repo-${i}/inventory`, i === 9 ? 502 : 200, ms)),
      line("2026-11-03T10:01:00.000Z", "GET", "/api/me", 200, 5),
      JSON.stringify({ time: "2026-11-03T10:02:00.000Z", level: "info", msg: "cleanup: 1 events" }),
      "not json",
    ];

    // when
    const rows = summarizeLog(lines, "2026-11-03T10:00:00.000Z");

    // then
    expect(rows).toEqual([
      { route: "GET /api/repos/:id/inventory", count: 10, p50Ms: 50, p90Ms: 90, maxMs: 100, failed: 1 },
      { route: "GET /api/me", count: 1, p50Ms: 5, p90Ms: 5, maxMs: 5, failed: 0 },
    ]);
  });

  it("given --since as how long ago, an ISO time and a word that is neither, when it is read, then the first two are times and the third is refused with the usage", () => {
    const now = new Date("2026-11-03T12:00:00.000Z");
    expect([sinceOf("6h", now), sinceOf("2d", now), sinceOf("2026-11-03T08:00:00Z", now)]).toEqual(["2026-11-03T06:00:00.000Z", "2026-11-01T12:00:00.000Z", "2026-11-03T08:00:00.000Z"]);
    const printed: string[] = [];
    expect(logSummaryCommand(["log.jsonl", "--since", "yesterday"], (l) => printed.push(l))).toBe(2);
    expect(logSummaryCommand([], (l) => printed.push(l))).toBe(2);
    expect(printed[0]).toMatch(/--since takes an ISO time/);
    expect(printed[1]).toMatch(/^usage: node dist\/server\.js log-summary/);
  });
});
