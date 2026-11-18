import { describe, expect, it } from "vitest";
import { foundChecks } from "./runner.js";

describe("the checks an agent names for its folder", () => {
  it("given a last message with checks named as asked, in a list and in code marks, one twice, one that climbs out and twelve in all, when it is read, then each is kept once with its file, the one that climbs out is not, and ten at most are kept", () => {
    // given
    const said = ["Done.", "- `CHECK: npm test (from package.json)`", "CHECK: npm test (from package.json)", "CHECK: make lint (from /etc/Makefile)", "CHECK: make lint (from ../Makefile)", ...Array.from({ length: 12 }, (_, i) => `CHECK: step ${i} (from scripts/s${i}.sh)`)].join("\n");

    // when
    const found = foundChecks(said);

    // then
    expect(found[0]).toEqual({ command: "npm test", source: "package.json" });
    expect(found.some((f) => f.source.startsWith("/") || f.source.includes(".."))).toBe(false);
    expect(found).toHaveLength(10);
  });
});
