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
import { flushResolvedPairs, ledgerPairsForSession, signalsFile } from "./signals.js";
import { enqueueHarvestJob, pendingDir } from "./pipeline.js";
import { readCounters } from "./counters.js";

// The auto path that runs thousands of times in dogfood:
// PostToolUse → Stop → flushResolvedPairs (ledger) → session-end harvest job.
// A Bearer token in the failing command must not survive to ANY file on disk.
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

describe("secret redaction on the flush + harvest-job path", () => {
  it("leaks the secret into neither signals.jsonl nor the harvest job file", () => {
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

    flushResolvedPairs("s1", home, "2026-08-08T00:03:00Z");
    // the session-end hook builds the job from the (sanitized) ledger — redacted
    // rows are excluded from harvest evidence entirely
    const pairs = ledgerPairsForSession("s1", home);
    enqueueHarvestJob(
      { sessionId: "s1", cwd: home, evidence: { pairs, recurrence: {} } },
      home,
    );

    const ledger = readFileSync(signalsFile(home), "utf8");
    const jobs = readAll(pendingDir(home));
    expect(ledger).not.toContain(SECRET);
    expect(ledger).not.toContain("Bearer");
    expect(jobs).not.toContain(SECRET);
    expect(jobs).not.toContain("Bearer");
    // fingerprint still recorded (recurrence survives) and the veto was counted
    expect(ledger).toContain("fp1");
    expect(pairs).toEqual([]); // a redacted row never becomes harvest evidence
    expect(readCounters(home).redactionBlocked).toBe(1);
  });
});
