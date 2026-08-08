import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildScorePrompt,
  defaultScoreConfig,
  loadScoreConfig,
  parseScoreResponse,
  scoreSignal,
} from "./score.js";
import type { Signal } from "./signals.js";

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
    count: 3,
    edits: ["/repo/app.ts"],
    resolvedCommand: "npm test",
    resolvedAt: "2026-08-08T00:10:00Z",
    ...overrides,
  };
}

const fullMarks =
  '{"scores": {"recurrence": 2, "unfindability": 2, "generality": 2, "durability": 2, "costOfError": 2}, "rationale": "recurring gotcha"}';

describe("buildScorePrompt", () => {
  it("includes the candidate facts and the ledger occurrence count", () => {
    const prompt = buildScorePrompt(candidate(), 4);
    expect(prompt).toContain("failed command: npm test");
    expect(prompt).toContain("error (normalized): 1 test failed");
    expect(prompt).toContain("files edited for the fix: /repo/app.ts");
    expect(prompt).toContain("seen in the local ledger: 4");
    expect(prompt).toContain("occurrences within the session: 3");
  });

  it("marks missing resolution and edits explicitly", () => {
    const prompt = buildScorePrompt(candidate({ resolvedCommand: undefined, edits: [] }), 1);
    expect(prompt).toContain("resolving command: (none recorded)");
    expect(prompt).toContain("files edited for the fix: (none)");
  });

  it("demands a JSON-only reply covering all five criteria", () => {
    const prompt = buildScorePrompt(candidate(), 1);
    expect(prompt).toContain("ONLY a JSON object");
    for (const criterion of ["recurrence", "unfindability", "generality", "durability", "costOfError"]) {
      expect(prompt).toContain(`"${criterion}"`);
    }
  });

  it("omits the dedup section when no existing skills are given", () => {
    expect(buildScorePrompt(candidate(), 1)).not.toContain("Existing skills");
  });

  it("lists existing skills and asks for duplicateOf", () => {
    const prompt = buildScorePrompt(candidate(), 1, [
      { name: "fix-npm-cache", description: "Use when npm install fails on a stale cache." },
    ]);
    expect(prompt).toContain("Existing skills already available to the team");
    expect(prompt).toContain("fix-npm-cache: Use when npm install fails on a stale cache.");
    expect(prompt).toContain('"duplicateOf"');
  });
});

describe("parseScoreResponse", () => {
  it("sums the five criteria and passes at the threshold", () => {
    const result = parseScoreResponse(fullMarks, 7);
    expect(result).toMatchObject({ total: 10, pass: true, rationale: "recurring gotcha" });
  });

  it("fails below the threshold", () => {
    const result = parseScoreResponse(
      '{"scores": {"recurrence": 2, "unfindability": 1, "generality": 1, "durability": 1, "costOfError": 1}}',
      7,
    );
    expect(result).toMatchObject({ total: 6, pass: false });
    expect(result?.rationale).toBeUndefined();
  });

  it("extracts JSON wrapped in a code fence or prose", () => {
    const result = parseScoreResponse("Here is my verdict:\n```json\n" + fullMarks + "\n```", 7);
    expect(result?.total).toBe(10);
  });

  it("fails a duplicate even when the score clears the threshold", () => {
    const result = parseScoreResponse(
      fullMarks.replace('"rationale"', '"duplicateOf": "fix-npm-cache", "rationale"'),
      7,
    );
    expect(result).toMatchObject({ total: 10, pass: false, duplicateOf: "fix-npm-cache" });
  });

  it("ignores a null or empty duplicateOf", () => {
    const withNull = parseScoreResponse(
      fullMarks.replace('"rationale"', '"duplicateOf": null, "rationale"'),
      7,
    );
    expect(withNull).toMatchObject({ pass: true });
    expect(withNull?.duplicateOf).toBeUndefined();
    const withEmpty = parseScoreResponse(
      fullMarks.replace('"rationale"', '"duplicateOf": "  ", "rationale"'),
      7,
    );
    expect(withEmpty).toMatchObject({ pass: true });
    expect(withEmpty?.duplicateOf).toBeUndefined();
  });

  it.each([
    ["no JSON at all", "I would score this highly."],
    ["invalid JSON", "{scores: broken}"],
    ["missing criterion", '{"scores": {"recurrence": 2}}'],
    ["out-of-range score", fullMarks.replace('"recurrence": 2', '"recurrence": 3')],
    ["negative score", fullMarks.replace('"recurrence": 2', '"recurrence": -1')],
    ["non-integer score", fullMarks.replace('"recurrence": 2', '"recurrence": 1.5')],
    ["non-numeric score", fullMarks.replace('"recurrence": 2', '"recurrence": "high"')],
  ])("returns null on %s", (_label, text) => {
    expect(parseScoreResponse(text, 7)).toBeNull();
  });
});

describe("scoreSignal", () => {
  it("promotes when the runner returns a passing score", async () => {
    const verdict = await scoreSignal(candidate(), 4, defaultScoreConfig, async () => fullMarks);
    expect(verdict.outcome).toBe("promote");
    expect(verdict.result?.total).toBe(10);
  });

  it("rejects when the score is below the threshold", async () => {
    const verdict = await scoreSignal(
      candidate(),
      4,
      defaultScoreConfig,
      async () =>
        '{"scores": {"recurrence": 0, "unfindability": 0, "generality": 0, "durability": 0, "costOfError": 0}}',
    );
    expect(verdict.outcome).toBe("reject");
    expect(verdict.result?.total).toBe(0);
  });

  it("passes the prompt, configured model, and timeout to the runner", async () => {
    const calls: Array<{ prompt: string; model: string; timeoutMs: number }> = [];
    await scoreSignal(candidate(), 2, { model: "opus", threshold: 7, timeoutMs: 1234 }, async (prompt, model, timeoutMs) => {
      calls.push({ prompt, model, timeoutMs });
      return fullMarks;
    });
    expect(calls).toEqual([
      { prompt: expect.stringContaining("npm test"), model: "opus", timeoutMs: 1234 },
    ]);
  });

  it("returns an error verdict when the runner throws", async () => {
    const verdict = await scoreSignal(candidate(), 4, defaultScoreConfig, async () => {
      throw new Error("claude not found");
    });
    expect(verdict.outcome).toBe("error");
    expect(verdict.error).toContain("claude not found");
  });

  it("returns an error verdict on an unparseable response", async () => {
    const verdict = await scoreSignal(candidate(), 4, defaultScoreConfig, async () => "no json here");
    expect(verdict).toMatchObject({ outcome: "error", error: "unparseable score response" });
  });

  it("includes existing skills in the prompt and rejects a declared duplicate", async () => {
    const prompts: string[] = [];
    const verdict = await scoreSignal(
      candidate(),
      4,
      defaultScoreConfig,
      async (prompt) => {
        prompts.push(prompt);
        return fullMarks.replace('"rationale"', '"duplicateOf": "fix-npm-cache", "rationale"');
      },
      [{ name: "fix-npm-cache", description: "Use when npm install fails on a stale cache." }],
    );
    expect(prompts[0]).toContain("fix-npm-cache:");
    expect(verdict.outcome).toBe("reject");
    expect(verdict.result?.duplicateOf).toBe("fix-npm-cache");
  });
});

describe("loadScoreConfig", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "handbook-test-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("returns defaults when no config file exists", () => {
    expect(loadScoreConfig(home)).toEqual(defaultScoreConfig);
  });

  it("applies gate overrides from config.json", () => {
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ gate: { model: "sonnet", threshold: 8, timeoutMs: 5000 } }),
    );
    expect(loadScoreConfig(home)).toEqual({ model: "sonnet", threshold: 8, timeoutMs: 5000 });
  });

  it("falls back per field on invalid values", () => {
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ gate: { model: 42, threshold: 99, timeoutMs: -1 } }),
    );
    expect(loadScoreConfig(home)).toEqual(defaultScoreConfig);
  });

  it("returns defaults on a corrupt config file", () => {
    writeFileSync(join(home, "config.json"), "not json");
    expect(loadScoreConfig(home)).toEqual(defaultScoreConfig);
  });
});
