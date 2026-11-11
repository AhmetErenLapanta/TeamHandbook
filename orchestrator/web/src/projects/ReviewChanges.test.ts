import { describe, expect, it } from "vitest";
import { keptLine } from "./ReviewChanges";

describe("keptLine", () => {
  it("given none, one and two files kept by an undo, when said, then nothing, one file and a count with their names", () => {
    // then
    expect(keptLine([])).toBeNull();
    expect(keptLine(["src/a.ts"])).toBe("One file was edited after the task and kept as you left it: src/a.ts.");
    expect(keptLine(["src/a.ts", "README.md"])).toBe("2 files were edited after the task and kept as you left them: src/a.ts, README.md.");
  });
});
