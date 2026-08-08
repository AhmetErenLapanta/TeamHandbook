import { describe, it, expect } from "vitest";
import { extractErrorText, extractExitCode, isInterrupt } from "./tool-response.js";

describe("extractExitCode", () => {
  it("reads snake_case and camelCase keys", () => {
    expect(extractExitCode({ exit_code: 1 })).toBe(1);
    expect(extractExitCode({ exitCode: 2 })).toBe(2);
    expect(extractExitCode({ code: 0 })).toBe(0);
  });

  it("returns undefined for missing or non-numeric values", () => {
    expect(extractExitCode({})).toBeUndefined();
    expect(extractExitCode({ exit_code: "1" })).toBeUndefined();
    expect(extractExitCode("failed")).toBeUndefined();
    expect(extractExitCode(null)).toBeUndefined();
  });

  it("falls back to the interrupted flag and an embedded exit-code message", () => {
    expect(extractExitCode({ interrupted: true })).toBe(130);
    expect(extractExitCode({ stderr: "boom\nExit code 2" })).toBe(2);
    expect(extractExitCode("ls: no such file\nError: Exit code 1")).toBe(1);
  });
});

describe("isInterrupt", () => {
  it("flags Ctrl-C, timeout, and OOM kills but not real failures", () => {
    expect(isInterrupt({ interrupted: true })).toBe(true);
    expect(isInterrupt({ code: 130 })).toBe(true);
    expect(isInterrupt({ code: 143 })).toBe(true);
    expect(isInterrupt({ code: 1 })).toBe(false);
    expect(isInterrupt({ code: 0 })).toBe(false);
  });
});

describe("extractErrorText", () => {
  it("prefers stderr over stdout", () => {
    expect(extractErrorText({ stderr: "err", stdout: "out" })).toBe("err");
  });

  it("falls back to the tail of stdout", () => {
    const stdout = `${"x".repeat(3000)}FAIL`;
    const result = extractErrorText({ stderr: "  ", stdout });
    expect(result.length).toBeLessThanOrEqual(2000);
    expect(result).toContain("FAIL");
  });

  it("passes through string responses", () => {
    expect(extractErrorText("plain failure")).toBe("plain failure");
  });

  it("returns empty string when nothing is available", () => {
    expect(extractErrorText({})).toBe("");
    expect(extractErrorText(undefined)).toBe("");
  });
});
