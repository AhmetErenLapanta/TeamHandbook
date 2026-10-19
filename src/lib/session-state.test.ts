import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import {
  attachEditToOpenErrors,
  cleanupStaleSessionFiles,
  emptySessionState,
  loadSessionState,
  recordFailure,
  resolveOpenErrors,
  saveSessionState,
  resumedSinceSalvage,
  sessionHasSubstance,
  withSessionLock,
} from "./session-state.js";
import type { SessionState } from "./session-state.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "handbook-test-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const failure = {
  fingerprint: "abc123",
  family: "npm test",
  command: "npm test",
  error: "1 test failed",
  cwd: "/repo",
};

describe("session state", () => {
  it("returns empty state when no file exists", () => {
    const state = loadSessionState("s1", home);
    expect(state).toEqual({ sessionId: "s1", openErrors: [], resolvedPairs: [] });
  });

  it("round-trips state through save and load", () => {
    const state = recordFailure(emptySessionState("s1"), failure, "2026-08-08T00:00:00Z");
    saveSessionState(state, home);
    const loaded = loadSessionState("s1", home);
    expect(loaded.openErrors).toHaveLength(1);
    expect(loaded.openErrors[0]).toMatchObject({ fingerprint: "abc123", count: 1, edits: [] });
  });

  it("increments count for a repeated fingerprint", () => {
    let state = recordFailure(emptySessionState("s1"), failure, "2026-08-08T00:00:00Z");
    state = recordFailure(state, failure, "2026-08-08T00:05:00Z");
    expect(state.openErrors).toHaveLength(1);
    expect(state.openErrors[0]?.count).toBe(2);
    expect(state.openErrors[0]?.firstSeenAt).toBe("2026-08-08T00:00:00Z");
    expect(state.openErrors[0]?.lastSeenAt).toBe("2026-08-08T00:05:00Z");
  });

  it("keeps distinct fingerprints as separate open errors", () => {
    let state = recordFailure(emptySessionState("s1"), failure);
    state = recordFailure(state, { ...failure, fingerprint: "def456" });
    expect(state.openErrors).toHaveLength(2);
  });

  it("recovers from a corrupt state file", () => {
    mkdirSync(join(home, "sessions"), { recursive: true });
    writeFileSync(join(home, "sessions", "s1.json"), "{corrupt");
    expect(loadSessionState("s1", home)).toEqual({ sessionId: "s1", openErrors: [], resolvedPairs: [] });
  });

  it("normalizes legacy state files without edits or resolvedPairs", () => {
    mkdirSync(join(home, "sessions"), { recursive: true });
    const legacy = { sessionId: "s1", openErrors: [{ ...failure, count: 1, firstSeenAt: "x", lastSeenAt: "x" }] };
    writeFileSync(join(home, "sessions", "s1.json"), JSON.stringify(legacy));
    const loaded = loadSessionState("s1", home);
    expect(loaded.openErrors[0]?.edits).toEqual([]);
    expect(loaded.resolvedPairs).toEqual([]);
  });

  it("sanitizes session ids used as file names", () => {
    saveSessionState(emptySessionState("../../evil"), home);
    const loaded = loadSessionState("../../evil", home);
    expect(loaded.openErrors).toEqual([]);
  });
});

describe("attachEditToOpenErrors", () => {
  it("attaches the file to every open error once", () => {
    let state = recordFailure(emptySessionState("s1"), failure);
    state = recordFailure(state, { ...failure, fingerprint: "def456" });
    expect(attachEditToOpenErrors(state, "/repo/src/app.ts")).toBe(true);
    expect(attachEditToOpenErrors(state, "/repo/src/app.ts")).toBe(false);
    expect(state.openErrors.map((e) => e.edits)).toEqual([["/repo/src/app.ts"], ["/repo/src/app.ts"]]);
  });

  it("does nothing without open errors", () => {
    expect(attachEditToOpenErrors(emptySessionState("s1"), "/repo/src/app.ts")).toBe(false);
  });
});

describe("cleanupStaleSessionFiles", () => {
  it("removes only sessions older than the retention window", () => {
    saveSessionState(emptySessionState("old"), home);
    saveSessionState(emptySessionState("fresh"), home);
    const eightDaysFromNow = Date.now() + 8 * 24 * 60 * 60 * 1000;
    expect(cleanupStaleSessionFiles(home, eightDaysFromNow)).toBe(2);
    expect(cleanupStaleSessionFiles(home)).toBe(0);
    saveSessionState(emptySessionState("s2"), home);
    expect(cleanupStaleSessionFiles(home)).toBe(0);
    expect(loadSessionState("s2", home)).toEqual(emptySessionState("s2"));
  });
});

describe("resolveOpenErrors", () => {
  it("moves matching-family errors to resolved pairs", () => {
    let state = recordFailure(emptySessionState("s1"), failure);
    state = recordFailure(state, { ...failure, fingerprint: "def456", family: "cargo build" });
    attachEditToOpenErrors(state, "/repo/src/app.ts");
    const resolved = resolveOpenErrors(state, "npm test", "npm test", "/repo", "2026-08-08T01:00:00Z");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({
      fingerprint: "abc123",
      resolvedCommand: "npm test",
      resolvedAt: "2026-08-08T01:00:00Z",
      edits: ["/repo/src/app.ts"],
    });
    expect(state.openErrors).toHaveLength(1);
    expect(state.openErrors[0]?.family).toBe("cargo build");
    expect(state.resolvedPairs).toHaveLength(1);
  });

  it("returns empty when no family matches", () => {
    const state = recordFailure(emptySessionState("s1"), failure);
    expect(resolveOpenErrors(state, "cargo build", "cargo build")).toEqual([]);
    expect(state.openErrors).toHaveLength(1);
    expect(state.resolvedPairs).toEqual([]);
  });
});

describe("resolveOpenErrors - single most-recent (misattribution guard)", () => {
  it("resolves only the most-recently-seen matching error, leaving the rest open", () => {
    let state = recordFailure(emptySessionState("s1"), { ...failure, fingerprint: "old" }, "2026-08-08T00:00:00Z");
    state = recordFailure(state, { ...failure, fingerprint: "new" }, "2026-08-08T00:05:00Z");
    const resolved = resolveOpenErrors(state, "npm test", "npm test", "/repo", "2026-08-08T00:10:00Z");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.fingerprint).toBe("new");
    expect(state.openErrors.map((e) => e.fingerprint)).toEqual(["old"]);
  });
});

describe("attachEditToOpenErrors - most-recent-N ring buffer", () => {
  it("keeps the latest edits so a late real fix is not locked out", () => {
    let state = recordFailure(emptySessionState("s1"), failure);
    for (let i = 0; i < 25; i++) attachEditToOpenErrors(state, `/repo/flail-${i}.ts`);
    attachEditToOpenErrors(state, "/repo/the-real-fix.ts");
    const edits = state.openErrors[0]!.edits;
    expect(edits).toContain("/repo/the-real-fix.ts");
    expect(edits.length).toBeLessThanOrEqual(20);
    expect(edits).not.toContain("/repo/flail-0.ts");
  });
});

describe("harvest evidence fields + substance check", () => {
  it("round-trips transcriptPath, meaningfulToolCalls, and harvestedAt", () => {
    const state = emptySessionState("s1");
    state.transcriptPath = "/tmp/session.jsonl";
    state.meaningfulToolCalls = 7;
    state.harvestedAt = "2026-08-10T10:00:00Z";
    saveSessionState(state, home);
    expect(loadSessionState("s1", home)).toMatchObject({
      transcriptPath: "/tmp/session.jsonl",
      meaningfulToolCalls: 7,
      harvestedAt: "2026-08-10T10:00:00Z",
    });
  });

  it("classifies substance: pair OR full activity shape OR enough tool calls", () => {
    expect(sessionHasSubstance(emptySessionState("s1"))).toBe(false);

    const withPair = recordFailure(emptySessionState("s1"), failure);
    resolveOpenErrors(withPair, "npm test", "npm test", "/repo");
    expect(sessionHasSubstance(withPair)).toBe(true);

    const withActivity = emptySessionState("s2");
    withActivity.activity = { families: ["npm test"], exts: [".ts"] };
    expect(sessionHasSubstance(withActivity)).toBe(true);

    const familiesOnly = emptySessionState("s3");
    familiesOnly.activity = { families: ["npm test"], exts: [] };
    expect(sessionHasSubstance(familiesOnly)).toBe(false);

    const busy = emptySessionState("s4");
    busy.meaningfulToolCalls = 5;
    expect(sessionHasSubstance(busy)).toBe(true);
    busy.meaningfulToolCalls = 4;
    expect(sessionHasSubstance(busy)).toBe(false);
  });

  it("given a session that only typed prompts, when classified, then it is not substance and costs no model call", () => {
    const chatting = emptySessionState("s5");
    chatting.corrections = [
      { at: "2026-08-11T00:00:00Z", text: "what does this function actually do" },
      { at: "2026-08-11T00:01:00Z", text: "ok and where is it called from" },
    ];

    expect(sessionHasSubstance(chatting)).toBe(false);
  });
});

describe("withSessionLock", () => {
  const lockOf = (id: string) => join(home, "sessions", `${id}.json.lock`);

  it("given no other holder, when it runs, then the work runs and the lock is gone afterwards", () => {
    // given an uncontended session
    // when work runs under its lock
    const result = withSessionLock("s1", () => 42, home);
    // then it returned and left nothing behind
    expect(result).toBe(42);
    expect(existsSync(lockOf("s1"))).toBe(false);
  });

  it("given the work throws, when it runs, then the lock is still released", () => {
    // given work that fails
    // when it runs under the lock, then the error surfaces and the lock is gone
    expect(() =>
      withSessionLock("s1", () => {
        throw new Error("boom");
      }, home),
    ).toThrow("boom");
    expect(existsSync(lockOf("s1"))).toBe(false);
  });

  it("given a lock left by a hook that died, when another hook runs, then it breaks the lock and runs", () => {
    // given a lock file older than any live holder
    mkdirSync(join(home, "sessions"), { recursive: true });
    writeFileSync(lockOf("s1"), "");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockOf("s1"), old, old);
    // when work runs under the lock
    const started = Date.now();
    const result = withSessionLock("s1", () => "ran", home);
    // then it did not wait out the deadline
    expect(result).toBe("ran");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("given a live holder that never lets go, when another hook runs, then it runs after the wait rather than not at all", () => {
    // given a fresh lock nobody will release
    mkdirSync(join(home, "sessions"), { recursive: true });
    writeFileSync(lockOf("s1"), "");
    // when work runs with a short wait
    const result = withSessionLock("s1", () => "ran", home, 100);
    // then the capture still happened, and the other holder's lock was left alone
    expect(result).toBe("ran");
    expect(existsSync(lockOf("s1"))).toBe(true);
  });

  it("given several processes updating one session at once, when each holds the lock, then no update is lost", async () => {
    // given a script that loads the session, waits long enough to overlap, and saves one more error
    const scratch = mkdtempSync(join(tmpdir(), "handbook-lock-"));
    try {
      const entry = join(scratch, "entry.ts");
      const source = fileURLToPath(new URL("./session-state.ts", import.meta.url));
      writeFileSync(
        entry,
        [
          `import { loadSessionState, saveSessionState, withSessionLock } from ${JSON.stringify(source)};`,
          "const [home, n] = process.argv.slice(2);",
          "withSessionLock(\"s1\", () => {",
          "  const state = loadSessionState(\"s1\", home);",
          "  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);",
          "  state.openErrors.push({ fingerprint: `f${n}`, family: \"npm test\", command: \"npm test\", error: \"e\", cwd: \"/repo\", count: 1, firstSeenAt: \"\", lastSeenAt: \"\", edits: [] });",
          "  saveSessionState(state, home);",
          "}, home);",
        ].join("\n"),
      );
      const bundle = join(scratch, "entry.mjs");
      buildSync({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", outfile: bundle, logLevel: "silent" });
      // when eight of them run at the same time
      const runs = Array.from({ length: 8 }, (_, n) =>
        new Promise<number>((done) => spawn(process.execPath, [bundle, home, String(n)]).on("exit", (code) => done(code ?? 1))),
      );
      const codes = await Promise.all(runs);
      // then every one of the eight errors is in the session file
      expect(codes.every((code) => code === 0)).toBe(true);
      expect(loadSessionState("s1", home).openErrors.map((e) => e.fingerprint).sort()).toEqual(
        Array.from({ length: 8 }, (_, n) => `f${n}`).sort(),
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("resumedSinceSalvage", () => {
  function salvaged(bytes: number | undefined): SessionState {
    return { ...emptySessionState("s1"), harvestedAt: "2026-08-08T00:00:00Z", ...(bytes === undefined ? {} : { harvestedBytes: bytes }) };
  }

  it("given a transcript that grew after salvage, when the session ends, then it counts as resumed", () => {
    // given a session salvaged at 10 bytes whose transcript is now longer
    const transcript = join(home, "t.jsonl");
    writeFileSync(transcript, "x".repeat(25));
    // when it is checked, then the later work is recognized
    expect(resumedSinceSalvage(salvaged(10), transcript)).toBe(true);
  });

  it("given a transcript the size salvage saw, when the session ends, then it is not harvested again", () => {
    // given a session that never carried on
    const transcript = join(home, "t.jsonl");
    writeFileSync(transcript, "x".repeat(25));
    // when it is checked, then it is not resumed
    expect(resumedSinceSalvage(salvaged(25), transcript)).toBe(false);
  });

  it("given a salvage recorded before sizes were kept, when the session ends, then it keeps the old answer", () => {
    // given a stamped session with no recorded size
    const transcript = join(home, "t.jsonl");
    writeFileSync(transcript, "x".repeat(25));
    // when it is checked, then it is treated as already harvested
    expect(resumedSinceSalvage(salvaged(undefined), transcript)).toBe(false);
    expect(resumedSinceSalvage({ ...emptySessionState("s1") }, transcript)).toBe(false);
  });
});
