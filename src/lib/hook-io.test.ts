import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import { readStdin, parseHookInput } from "./hook-io.js";

describe("parseHookInput", () => {
  it("parses a valid hook payload", () => {
    const raw = JSON.stringify({
      session_id: "abc",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    });
    const result = parseHookInput(raw);
    expect(result).not.toBeNull();
    expect(result?.tool_name).toBe("Bash");
    expect(result?.tool_input).toEqual({ command: "npm test" });
  });

  it("returns null for empty input", () => {
    expect(parseHookInput("")).toBeNull();
    expect(parseHookInput("   \n")).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(parseHookInput("{not json")).toBeNull();
  });

  it("returns null for non-object JSON", () => {
    expect(parseHookInput('"a string"')).toBeNull();
    expect(parseHookInput("[1,2]")).toBeNull();
    expect(parseHookInput("null")).toBeNull();
  });
});

describe("readStdin", () => {
  it("reads a full stream into a string", async () => {
    const stream = Readable.from([Buffer.from('{"a":'), Buffer.from("1}")]);
    expect(await readStdin(stream)).toBe('{"a":1}');
  });
});
