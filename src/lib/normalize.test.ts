import { describe, it, expect } from "vitest";
import { commandFamily, fingerprint, normalizeErrorText } from "./normalize.js";

describe("normalizeErrorText", () => {
  it("strips ANSI escape codes", () => {
    expect(normalizeErrorText("\x1b[31mError:\x1b[0m failed")).toBe("Error: failed");
  });

  it("masks absolute user paths", () => {
    const a = normalizeErrorText("ENOENT: no such file /Users/alice/proj/src/app.ts");
    const b = normalizeErrorText("ENOENT: no such file /Users/bob/work/src/app.ts");
    expect(a).toContain("<path>");
    expect(a).toBe(b);
  });

  it("masks hex addresses, uuids and timestamps", () => {
    const result = normalizeErrorText(
      "at 0xDEADBEEF id=550e8400-e29b-41d4-a716-446655440000 time=2026-08-08T01:02:03Z",
    );
    expect(result).toBe("at <hex> id=<uuid> time=<ts>");
  });

  it("masks durations and line/column positions", () => {
    const a = normalizeErrorText("Test failed in 123ms at app.ts:12:5, see line 42");
    const b = normalizeErrorText("Test failed in 999ms at app.ts:99:1, see line 7");
    expect(a).toBe(b);
  });

  it("collapses runs of spaces and trims", () => {
    expect(normalizeErrorText("  error:    something   broke  ")).toBe("error: something broke");
  });

  it("truncates very long output", () => {
    const long = "x".repeat(10_000);
    expect(normalizeErrorText(long).length).toBeLessThanOrEqual(2000);
  });

  it("keeps only the leading lines", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `l${i}`).join("\n");
    const result = normalizeErrorText(lines);
    expect(result).toContain("l39");
    expect(result).not.toContain("l40");
  });
});

describe("commandFamily", () => {
  it("uses command plus subcommand", () => {
    expect(commandFamily("git push origin main")).toBe("git push");
    expect(commandFamily("npm test")).toBe("npm test");
  });

  it("keeps the script name for run-style subcommands", () => {
    expect(commandFamily("npm run build --silent")).toBe("npm run build");
  });

  it("skips cd prefixes and env assignments", () => {
    expect(commandFamily("cd /tmp/app && NODE_ENV=test npm test")).toBe("npm test");
  });

  it("skips wrapper commands and strips binary paths", () => {
    expect(commandFamily("sudo /usr/local/bin/systemctl restart nginx")).toBe("systemctl restart");
  });

  it("does not treat file arguments or flags as subcommands", () => {
    expect(commandFamily("node script.js")).toBe("node");
    expect(commandFamily("ls -la")).toBe("ls");
  });

  it("falls back to unknown for empty commands", () => {
    expect(commandFamily("")).toBe("unknown");
  });
});

describe("fingerprint", () => {
  it("is stable for identical input", () => {
    expect(fingerprint("npm test", "err")).toBe(fingerprint("npm test", "err"));
  });

  it("differs when family or error differ", () => {
    expect(fingerprint("npm test", "err")).not.toBe(fingerprint("git push", "err"));
    expect(fingerprint("npm test", "err")).not.toBe(fingerprint("npm test", "other"));
  });

  it("matches across machines for path-differing errors after normalization", () => {
    const a = normalizeErrorText("ENOENT /Users/alice/app/config.json");
    const b = normalizeErrorText("ENOENT /Users/bob/clone/config.json");
    expect(fingerprint("node", a)).toBe(fingerprint("node", b));
  });

  it("returns a 16-char hex id", () => {
    expect(fingerprint("npm test", "err")).toMatch(/^[0-9a-f]{16}$/);
  });
});
