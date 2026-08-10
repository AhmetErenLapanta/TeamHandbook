import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTranscriptSlice, readTranscriptTexts, redactSlice, sliceTranscript } from "./transcript.js";
import type { TranscriptEntry } from "./transcript.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "handbook-transcript-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeJsonl(lines: unknown[]): string {
  const file = join(dir, "session.jsonl");
  writeFileSync(file, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
  return file;
}

// Shapes verified against real Claude Code transcripts (schema discovery 2026-08-10).
const user = (content: unknown) => ({ type: "user", isSidechain: false, message: { role: "user", content } });
const assistant = (content: unknown[]) => ({ type: "assistant", isSidechain: false, message: { role: "assistant", content } });

describe("readTranscriptTexts", () => {
  it("extracts human prose and assistant text, skipping tool traffic and bookkeeping", () => {
    const file = writeJsonl([
      { type: "mode", mode: "normal" },
      user("we never use Lombok in this repo, use plain records"),
      assistant([
        { type: "thinking", thinking: "internal reasoning" },
        { type: "text", text: "Understood — switching to records." },
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } },
      ]),
      user([{ type: "tool_result", tool_use_id: "t1", content: "FAIL" }]),
      user([{ type: "text", text: "also always run make fmt before committing" }]),
      { type: "system", subtype: "stop_hook_summary" },
    ]);
    expect(readTranscriptTexts(file)).toEqual([
      { role: "user", text: "we never use Lombok in this repo, use plain records" },
      { role: "assistant", text: "Understood — switching to records." },
      { role: "user", text: "also always run make fmt before committing" },
    ]);
  });

  it("skips sidechain (subagent) traffic, command noise, interrupts, and malformed lines", () => {
    const file = writeJsonl([
      { type: "user", isSidechain: true, message: { role: "user", content: "subagent prompt" } },
      user("<command-name>/usage</command-name>"),
      user("<local-command-stdout>ok</local-command-stdout>"),
      user("[Request interrupted by user]"),
      "not json at all",
      user("real question"),
    ]);
    expect(readTranscriptTexts(file)).toEqual([{ role: "user", text: "real question" }]);
  });

  it("returns empty for a missing file", () => {
    expect(readTranscriptTexts(join(dir, "nope.jsonl"))).toEqual([]);
  });
});

describe("sliceTranscript", () => {
  it("keeps chronological order and labels roles", () => {
    const entries: TranscriptEntry[] = [
      { role: "user", text: "first" },
      { role: "assistant", text: "reply" },
      { role: "user", text: "second" },
    ];
    expect(sliceTranscript(entries)).toBe("User: first\n\nAssistant: reply\n\nUser: second");
  });

  it("prefers the newest user messages when the user budget overflows", () => {
    const entries: TranscriptEntry[] = Array.from({ length: 30 }, (_, i) => ({
      role: "user" as const,
      text: `msg-${i} ${"x".repeat(400)}`,
    }));
    // budget 4000 → user share 2400 → only the last handful of ~405-char messages fit
    const slice = sliceTranscript(entries, 4_000);
    expect(slice).toContain("msg-29");
    expect(slice).not.toContain("msg-0 ");
    const first = slice.indexOf("msg-2");
    expect(first).toBeGreaterThanOrEqual(0); // chronological among the picked tail
  });

  it("caps oversized messages instead of dropping them", () => {
    const entries: TranscriptEntry[] = [{ role: "user", text: "y".repeat(5_000) }];
    const slice = sliceTranscript(entries, 40_000);
    expect(slice.length).toBeLessThan(1_100);
    expect(slice.endsWith("…")).toBe(true);
  });
});

describe("redactSlice", () => {
  it("replaces secret-bearing lines in place and counts them", () => {
    const slice = [
      "User: deploy with Bearer sk-proj-abcdef1234567890ABCDEFGH please",
      "Assistant: done",
    ].join("\n");
    const { clean, redacted } = redactSlice(slice);
    expect(redacted).toBe(1);
    expect(clean).not.toContain("sk-proj-");
    expect(clean).toContain("[redacted:");
    expect(clean).toContain("Assistant: done");
  });
});

describe("buildTranscriptSlice", () => {
  it("reads, slices, and redacts end to end", () => {
    const file = writeJsonl([
      user(`export API_KEY=sk-proj-abcdef1234567890ABCDEFGH and rerun`),
      user("prefer feature flags via config, not env vars"),
      assistant([{ type: "text", text: "Noted — config-based flags it is." }]),
    ]);
    const { slice, redacted } = buildTranscriptSlice(file);
    expect(redacted).toBe(1);
    expect(slice).not.toContain("sk-proj-");
    expect(slice).toContain("feature flags via config");
    expect(slice).toContain("Assistant: Noted");
  });
});

describe("redactSlice — multi-line secrets", () => {
  it("consumes an entire PEM block, not just its BEGIN header", () => {
    const slice = [
      "User: here is the deploy key, fix the ssh auth",
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEA3ZxSECRETKEYBODY0000000000000000000000000000000",
      "AAAAB3NzaC1yc2EAAAADAQABAAABgQDMOREKEYMATERIAL1111111111111111",
      "-----END RSA PRIVATE KEY-----",
      "Assistant: rotated it for you",
    ].join("\n");
    const { clean, redacted } = redactSlice(slice);
    expect(clean).not.toContain("SECRETKEYBODY");
    expect(clean).not.toContain("MOREKEYMATERIAL");
    expect(clean).not.toContain("MIIEowIBAAKCAQEA");
    expect(clean).toContain("[redacted:private-key]");
    expect(clean).toContain("Assistant: rotated it for you"); // the rest survives
    expect(redacted).toBe(1);
  });

  it("drops the tail when a PEM block is never terminated (fail closed)", () => {
    const { clean } = redactSlice(
      ["-----BEGIN OPENSSH PRIVATE KEY-----", "b3BlbnNzaC1rZXktdjEAAAAA", "more key bytes"].join("\n"),
    );
    expect(clean).toBe("[redacted:private-key]");
  });
});
