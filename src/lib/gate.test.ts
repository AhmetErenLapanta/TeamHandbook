import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultGateConfig, runRuleSieves, sieveSignal } from "./gate.js";
import { countersFile, incrementRedactionBlocked, readCounters } from "./counters.js";
import { appendSignals } from "./signals.js";
import type { Signal } from "./signals.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "handbook-test-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function candidate(overrides: Partial<Signal> = {}): Signal {
  return {
    ts: "2026-08-08T00:00:00Z",
    sessionId: "s1",
    kind: "candidate",
    fingerprint: "abc123",
    family: "npm test",
    command: "npm test",
    error: "1 test failed",
    cwd: "/repo",
    count: 1,
    edits: ["/repo/app.ts"],
    resolvedCommand: "npm test",
    resolvedAt: "2026-08-08T00:10:00Z",
    ...overrides,
  };
}

describe("sieveSignal", () => {
  it("passes a clean candidate with a persisted edit and enough recurrence", () => {
    expect(sieveSignal(candidate(), 2)).toEqual({ signal: candidate(), pass: true });
  });

  it("drops weak signals as not-candidate", () => {
    const decision = sieveSignal(candidate({ kind: "weak" }), 5);
    expect(decision).toMatchObject({ pass: false, reason: "not-candidate" });
  });

  it("drops candidates without any file change, including recurrence-promoted ones", () => {
    const promoted = candidate({ edits: [], promotedBy: "recurrence" });
    expect(sieveSignal(promoted, 5)).toMatchObject({ pass: false, reason: "no-file-change" });
  });

  it("drops candidates containing a secret and reports only the pattern name", () => {
    const decision = sieveSignal(
      candidate({ error: "request failed: Authorization: Bearer dGhpcy1pcy1hLXZlcnktbG9uZy10b2tlbg" }),
      5,
    );
    expect(decision).toMatchObject({ pass: false, reason: "secret", detail: "bearer-token" });
  });

  it("vetoes on secret before any other rule", () => {
    const decision = sieveSignal(
      candidate({ edits: [], command: "psql postgres://admin:hunter22@db.internal/prod" }),
      0,
    );
    expect(decision).toMatchObject({ pass: false, reason: "secret" });
  });

  it("scans resolved command and edit paths, not just the error", () => {
    const decision = sieveSignal(
      candidate({ resolvedCommand: "curl -H 'x: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fw'" }),
      5,
    );
    expect(decision).toMatchObject({ pass: false, reason: "secret", detail: "jwt" });
  });

  it("drops candidates below the repeat threshold", () => {
    const decision = sieveSignal(candidate(), 1);
    expect(decision).toMatchObject({
      pass: false,
      reason: "below-repeat-threshold",
      detail: "1/2",
    });
  });

  it("respects a configured repeat threshold", () => {
    expect(sieveSignal(candidate(), 1, { ...defaultGateConfig, repeatThreshold: 1 }).pass).toBe(true);
  });

  it("passes a manual signal despite no file change and no recurrence", () => {
    const manual = candidate({ trigger: "manual", edits: [] });
    expect(sieveSignal(manual, 1)).toEqual({ signal: manual, pass: true });
  });

  it("still vetoes a manual signal on secret", () => {
    const manual = candidate({ trigger: "manual", error: "token=glpat-xJ2vRq8kQzWn5pYtBs7d" });
    expect(sieveSignal(manual, 1)).toMatchObject({ pass: false, reason: "secret" });
  });

  it("still drops an oversized manual signal", () => {
    const manual = candidate({ trigger: "manual", error: "x".repeat(defaultGateConfig.maxErrorChars + 1) });
    expect(sieveSignal(manual, 1)).toMatchObject({ pass: false, reason: "oversized", detail: "error" });
  });

  it.each([
    ["error", { error: "x".repeat(defaultGateConfig.maxErrorChars + 1) }],
    ["command", { command: "npm " + "x".repeat(defaultGateConfig.maxCommandChars) }],
    ["edits", { edits: Array.from({ length: defaultGateConfig.maxEditCount + 1 }, (_, i) => `/repo/f${i}.ts`) }],
  ])("drops oversized %s", (field, overrides) => {
    const decision = sieveSignal(candidate(overrides as Partial<Signal>), 5);
    expect(decision).toMatchObject({ pass: false, reason: "oversized", detail: field });
  });
});

describe("runRuleSieves", () => {
  it("counts recurrence from the ledger and splits passed from dropped", () => {
    appendSignals([candidate(), candidate()], home);
    const fresh = candidate({ fingerprint: "def456" });
    const result = runRuleSieves([candidate(), fresh], home);
    expect(result.passed).toEqual([candidate()]);
    expect(result.dropped).toMatchObject([{ reason: "below-repeat-threshold" }]);
  });

  it("increments the redaction-blocked counter once per secret drop", () => {
    const leaky = candidate({ error: "token=glpat-xJ2vRq8kQzWn5pYtBs7d" });
    runRuleSieves([leaky, leaky, candidate({ kind: "weak" })], home);
    expect(readCounters(home)).toMatchObject({ redactionBlocked: 2 });
  });

  it("never writes candidate content to the counters file", () => {
    runRuleSieves([candidate({ error: "password: Sup3rS3cret!" })], home);
    const raw = readFileSync(countersFile(home), "utf8");
    expect(raw).not.toContain("Sup3rS3cret");
    expect(JSON.parse(raw)).toMatchObject({ redactionBlocked: 1 });
  });

  it("does not create the counters file when nothing is secret-dropped", () => {
    runRuleSieves([candidate()], home);
    expect(existsSync(countersFile(home))).toBe(false);
  });
});

describe("counters", () => {
  it("round-trips increments across calls", () => {
    incrementRedactionBlocked(home);
    expect(incrementRedactionBlocked(home, 2)).toMatchObject({ redactionBlocked: 3 });
    expect(readCounters(home)).toMatchObject({ redactionBlocked: 3 });
  });

  it("recovers from a corrupt counters file", () => {
    writeFileSync(countersFile(home), "not json");
    expect(readCounters(home)).toMatchObject({ redactionBlocked: 0 });
    expect(incrementRedactionBlocked(home)).toMatchObject({ redactionBlocked: 1 });
  });
});
