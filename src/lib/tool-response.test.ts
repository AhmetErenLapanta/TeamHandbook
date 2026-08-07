import { describe, it, expect } from "vitest";
import { extractErrorText, extractExitCode } from "./tool-response.js";

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
