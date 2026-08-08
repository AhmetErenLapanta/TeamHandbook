import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bumpCounter, maybeDumpPayload, readCounters } from "./counters.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "handbook-counters-"));
  delete process.env.TEAMHANDBOOK_DEBUG;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.TEAMHANDBOOK_DEBUG;
});

describe("counters", () => {
  it("bumps independent fields", () => {
    bumpCounter("postToolUse", home);
    bumpCounter("postToolUse", home);
    bumpCounter("bashFailuresCaptured", home);
    const c = readCounters(home);
    expect(c.postToolUse).toBe(2);
    expect(c.bashFailuresCaptured).toBe(1);
    expect(c.pairsResolved).toBe(0);
  });
});

describe("maybeDumpPayload", () => {
  const raw = '{"tool_input":{"command":"curl -H \\"Authorization: Bearer sk-secret\\""}}';

  it("writes nothing unless TEAMHANDBOOK_DEBUG is set (raw payloads may hold secrets)", () => {
    maybeDumpPayload(raw, home);
    expect(existsSync(join(home, "debug"))).toBe(false);
  });

  it("dumps the raw payload only when explicitly opted in", () => {
    process.env.TEAMHANDBOOK_DEBUG = "1";
    maybeDumpPayload(raw, home);
    const dir = join(home, "debug");
    expect(existsSync(dir)).toBe(true);
    expect(readdirSync(dir)).toHaveLength(1);
  });
});
