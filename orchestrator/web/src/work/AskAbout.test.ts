import { describe, expect, it } from "vitest";
import { answerLines, askedSaid } from "./AskAbout";

describe("when a question about an issue was asked, as its card says it", () => {
  const now = new Date(2026, 10, 13, 15, 0);

  it.each([
    [new Date(2026, 10, 13, 10, 42), "Asked at 10:42"],
    [new Date(2026, 10, 12, 10, 42), "Asked yesterday"],
  ])("given %s, when it is said, then it reads %s", (at, expected) => {
    // when
    const said = askedSaid(at.toISOString(), now);

    // then
    expect(said).toBe(expected);
  });

  it("given an older day, when it is said, then the day follows Asked without at", () => {
    // when
    const said = askedSaid(new Date(2026, 10, 10, 9, 0).toISOString(), now);

    // then
    expect(said.startsWith("Asked ")).toBe(true);
    expect(said.startsWith("Asked at")).toBe(false);
  });
});

describe("the first lines of an answer", () => {
  it("given a markdown answer with a heading, when its first lines are taken, then the heading marks are gone and only two lines stay", () => {
    // when
    const lines = answerLines("# Estimate\n\n- Roughly three files\n- All in the retry helper");

    // then
    expect(lines).toEqual(["Estimate", "Roughly three files"]);
  });

  it("given a very long line, when taken, then it is cut", () => {
    // when
    const [line] = answerLines("x".repeat(400));

    // then
    expect(line!.length).toBeLessThanOrEqual(161);
  });
});

describe("an answer as plain words", () => {
  it("given bold, code marks, a link and a bullet, when its lines are taken, then only the words remain", () => {
    // when
    const lines = answerLines("- **Roughly three files** in `retry.ts`, see [the note](https://example.invalid/n)\n\n| File | Change |\n|---|---|");

    // then
    expect(lines).toEqual(["Roughly three files in retry.ts, see the note", "File  Change"]);
  });
});
