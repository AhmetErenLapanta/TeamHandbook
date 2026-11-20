import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFileSync(join(here, path), "utf8");

/** The metric names the orchestrator exports, as its own HELP lines name them. */
const exported = () => new Set([...read("metrics.ts").matchAll(/# HELP (teamhandbook_orchestrator_[a-z_]+)/g)].map((m) => m[1]!));

/** Each alert of the rules file with its lines, read by its fixed layout: `- alert: Name`, then expr, for, labels and annotations. */
const alerts = () =>
  read("../deploy/observability/rules.yml")
    .split(/^\s+- alert: /m)
    .slice(1)
    .map((block) => ({ name: block.split("\n")[0]!.trim(), block }));

describe("the alert rules Prometheus evaluates", () => {
  it("given the rules file, when each expression is read, then every metric it names is one the orchestrator exports, so an alert cannot watch a name that was renamed away", () => {
    // given
    const known = exported();

    // when
    const named = alerts().flatMap(({ name, block }) => {
      const expr = block.match(/^\s+expr: (.+)$/m)?.[1] ?? "";
      return [...expr.matchAll(/\b(teamhandbook_orchestrator_[a-z_]+)/g)].map((m) => ({ name, metric: m[1]! }));
    });

    // then
    expect(alerts().length).toBeGreaterThanOrEqual(4);
    expect(named.filter(({ metric }) => !known.has(metric))).toEqual([]);
  });

  it("given each alert, when it is read, then it has an expression, a severity and a summary that says what to look at, and the up alert waits before it fires", () => {
    // given
    const all = alerts();

    // when
    const lacking = all.filter(({ block }) => !/^\s+expr: .+$/m.test(block) || !/^\s+severity: (critical|warning)$/m.test(block) || !/^\s+summary: .{20,}$/m.test(block));

    // then
    expect(lacking.map((a) => a.name)).toEqual([]);
    expect(all.find((a) => a.name === "OrchestratorDown")?.block).toMatch(/^\s+for: 2m$/m);
    expect(new Set(all.map((a) => a.name)).size).toBe(all.length);
  });

  it("given the Prometheus config and the observability compose file, when they are read, then the config lists the rules file at the path the compose file mounts it", () => {
    // given
    const config = read("../deploy/observability/prometheus.yml");
    const compose = read("../deploy/docker-compose.observability.yml");

    // when
    const listed = config.match(/rule_files:\n\s+- (\S+)/)?.[1];
    const mounted = compose.match(/- \.\/observability\/rules\.yml:(\S+?):ro/)?.[1];

    // then
    expect(listed).toBe("/etc/prometheus/rules.yml");
    expect(mounted).toBe(listed);
  });
});
