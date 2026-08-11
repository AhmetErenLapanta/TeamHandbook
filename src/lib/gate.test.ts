import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultGateConfig, runRuleSieves, sieveSignal } from "./gate.js";
import { readCounters } from "./counters.js";
import type { Signal } from "./signals.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "handbook-test-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function manual(overrides: Partial<Signal> = {}): Signal {
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
    edits: ["/repo/src/app.ts"],
    resolvedCommand: "npm test",
    trigger: "manual",
    ...overrides,
  };
}

describe("sieveSignal", () => {
  it("passes an ordinary manual capture", () => {
    expect(sieveSignal(manual())).toMatchObject({ pass: true });
  });

  it("vetoes a secret and names the pattern, never the content", () => {
    const decision = sieveSignal(manual({ error: "auth failed: api_key=abcd1234efgh5678" }));
    expect(decision).toMatchObject({ pass: false, reason: "secret" });
    expect(decision.detail).toBe("assigned-secret");
    expect(JSON.stringify(decision.detail)).not.toContain("abcd1234");
  });

  it.each([
    ["error", { error: "x".repeat(defaultGateConfig.maxErrorChars + 1) }],
    ["command", { command: "x".repeat(defaultGateConfig.maxCommandChars + 1) }],
    ["edits", { edits: Array.from({ length: defaultGateConfig.maxEditCount + 1 }, (_, i) => `/f${i}.ts`) }],
  ])("drops a case too large to distill (%s)", (field, overrides) => {
    expect(sieveSignal(manual(overrides))).toMatchObject({ pass: false, reason: "oversized", detail: field });
  });

  it("drops an oversized task procedure", () => {
    const task = { goal: "g", steps: ["s".repeat(defaultGateConfig.maxTaskChars + 1)], verification: "v" };
    expect(sieveSignal(manual({ task }))).toMatchObject({ pass: false, reason: "oversized", detail: "task" });
  });

  it("keeps a capture with no edits and no resolving command — the user asked for it", () => {
    // the automatic path has its own sieves; this one only guards secrets and size
    expect(sieveSignal(manual({ edits: [], resolvedCommand: undefined }))).toMatchObject({ pass: true });
  });
});

describe("runRuleSieves", () => {
  it("splits a batch and counts secret vetoes exactly once each", () => {
    const { passed, dropped } = runRuleSieves(
      [manual(), manual({ fingerprint: "leak", error: "token=abcd1234efgh5678" })],
      home,
    );
    expect(passed).toHaveLength(1);
    expect(dropped.map((d) => d.reason)).toEqual(["secret"]);
    expect(readCounters(home).redactionBlocked).toBe(1);
  });

  it("leaves the counter alone when nothing was vetoed", () => {
    runRuleSieves([manual()], home);
    expect(readCounters(home).redactionBlocked).toBe(0);
  });
});
