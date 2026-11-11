import { describe, expect, it } from "vitest";
import { MOST_QUOTED, MOST_QUOTED_TEXT, quoteOf } from "./diff-quote";
import { numberLines } from "./design/DiffPatch";

const patch = ["diff --git a/src/refund.ts b/src/refund.ts", "--- a/src/refund.ts", "+++ b/src/refund.ts", "@@ -10,4 +10,5 @@ export function refund", " const total = sum(lines);", "-return round(total);", "+const rounded = halfEven(total);", "+return rounded;", " }", "@@ -30,2 +31,1 @@", "-// old note", "-// second note", " export {}"].join("\n");

describe("numberLines", () => {
  it("given a patch with two hunks, when its lines are numbered, then context counts on both sides, an added line after and a removed line before the change, and headers on neither", () => {
    // when
    const lines = numberLines(patch).map((l) => [l.kind, l.old, l.new]);

    // then
    expect(lines).toEqual([
      ["meta", null, null], ["meta", null, null], ["meta", null, null], ["hunk", null, null],
      ["context", 10, 10], ["del", 11, null], ["add", null, 11], ["add", null, 12], ["context", 12, 13],
      ["hunk", null, null], ["del", 30, null], ["del", 31, null], ["context", 32, 31],
    ]);
  });
});

describe("quoteOf", () => {
  it("given a pick from the bottom up across a removed and two added lines, when quoted, then it names the lines after the change and carries the code as shown", () => {
    // when
    const quote = quoteOf("src/refund.ts", patch, 7, 4);

    // then
    expect(quote).toEqual({ path: "src/refund.ts", lines: "10-12", text: " const total = sum(lines);\n-return round(total);\n+const rounded = halfEven(total);\n+return rounded;" });
  });

  it("given a pick of removed lines only, and one of headers only, when quoted, then the first names the lines before the change and the second is no quote", () => {
    // when
    const removed = quoteOf("src/refund.ts", patch, 10, 11);
    const headers = quoteOf("src/refund.ts", patch, 0, 3);

    // then
    expect(removed).toMatchObject({ lines: "30-31 before the change" });
    expect(headers).toBeNull();
  });

  it("given a pick longer than a quote carries, when quoted, then it stops at the most it carries", () => {
    // given
    const long = ["@@ -1,0 +1,60 @@", ...Array.from({ length: 60 }, (_, i) => `+line ${i + 1}`)].join("\n");

    // when
    const quote = quoteOf("notes.md", long, 0, 60)!;

    // then
    expect(quote.text.split("\n")).toHaveLength(MOST_QUOTED);
    expect(quote.lines).toBe(`1-${MOST_QUOTED}`);
  });

  it("given long lines past the characters a quote carries, when quoted, then it keeps whole lines up to that and no more", () => {
    // given
    const wide = ["@@ -1,0 +1,3 @@", `+${"a".repeat(1998)}`, `+${"b".repeat(1998)}`, `+${"c".repeat(1998)}`].join("\n");

    // when
    const quote = quoteOf("wide.txt", wide, 0, 3)!;

    // then
    expect(quote.text.length).toBeLessThanOrEqual(MOST_QUOTED_TEXT);
    expect(quote.lines).toBe("1-2");
  });
});
