import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attachEditToOpenErrors,
  emptySessionState,
  recordFailure,
  resolveOpenErrors,
  saveSessionState,
} from "./session-state.js";
import { flushResolvedPairs, signalsFile } from "./signals.js";
import { enqueuePendingSignals, pendingDir } from "./pipeline.js";
import { readCounters } from "./counters.js";

// The auto path that runs thousands of times in dogfood:
// PostToolUse → Stop → flushResolvedPairs (ledger) → enqueuePendingSignals (handoff).
// A Bearer token in the failing command must not survive to EITHER file on disk.
let home: string;
const SECRET = "sk-proj-abcdef1234567890ABCDEFGH";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "handbook-secretpath-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function readAll(dir: string): string {
  if (!existsSync(dir)) return "";
  return readdirSync(dir)
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");
}

describe("secret redaction on the flush + enqueue path", () => {
  it("leaks the secret into neither signals.jsonl nor pending/*.json", () => {
    const editedFile = join(home, "api.ts");
    writeFileSync(editedFile, "fixed");

    let state = recordFailure(
      emptySessionState("s1"),
      {
        fingerprint: "fp1",
        family: "curl example.com",
        command: `curl -H 'Authorization: Bearer ${SECRET}' https://example.com`,
        error: "401 unauthorized",
        cwd: home,
      },
      "2026-08-08T00:00:00Z",
    );
    attachEditToOpenErrors(state, editedFile, "2026-08-08T00:01:00Z");
    resolveOpenErrors(state, "curl example.com", "curl example.com", home, "2026-08-08T00:02:00Z");
    saveSessionState(state, home);

    const signals = flushResolvedPairs("s1", home, "2026-08-08T00:03:00Z");
    const candidates = signals.filter((s) => s.kind === "candidate");
    enqueuePendingSignals(candidates, home);

    const ledger = readFileSync(signalsFile(home), "utf8");
    const pending = readAll(pendingDir(home));
    expect(ledger).not.toContain(SECRET);
    expect(ledger).not.toContain("Bearer");
    expect(pending).not.toContain(SECRET);
    expect(pending).not.toContain("Bearer");
    // fingerprint still recorded (recurrence survives) and the veto was counted
    expect(ledger).toContain("fp1");
    expect(readCounters(home).redactionBlocked).toBe(1);
  });
});
