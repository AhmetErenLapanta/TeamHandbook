import { describe, expect, it } from "vitest";
import { dataSaid, sizeSaid } from "./DataSize";

const MB = 1024 ** 2;
const parts = (over: Partial<Record<string, number>>) => ({ database: 0, "task-folders": 0, attachments: 0, copies: 0, repositories: 0, other: 0, ...over }) as Parameters<typeof dataSaid>[0]["parts"];

describe("what the data takes, in a sentence", () => {
  it("given parts of a tenth or more, when it is said, then the largest come first and the others are the rest", () => {
    // given
    const size = { total: 412 * MB, parts: parts({ "task-folders": 300 * MB, copies: 70 * MB, database: 20 * MB, other: 22 * MB }), partial: false };

    // when
    const said = dataSaid(size);

    // then
    expect(said).toBe("It keeps 412 MB here: 300 MB of task folders, 70 MB of backups and 42 MB of the rest.");
  });

  it("given a walk that stopped at its cap, when it is said, then the total is a floor", () => {
    // given
    const size = { total: 40 * MB, parts: parts({ "task-folders": 40 * MB }), partial: true };

    // when
    const said = dataSaid(size);

    // then
    expect(said).toBe("It keeps at least 40 MB here: 40 MB of task folders.");
  });

  it("given more than three parts of a tenth, when it is said, then three are named and the rest holds the others", () => {
    // given
    const size = { total: 100 * MB, parts: parts({ "task-folders": 30 * MB, copies: 25 * MB, repositories: 20 * MB, attachments: 15 * MB, database: 10 * MB }), partial: false };

    // when
    const said = dataSaid(size);

    // then
    expect(said).toBe("It keeps 100 MB here: 30 MB of task folders, 25 MB of backups, 20 MB of repository copies and 25 MB of the rest.");
  });
});

describe("a size in words", () => {
  it.each([
    [2048, "2 KB"],
    [412 * MB, "412 MB"],
    [2.34 * 1024 ** 3, "2.3 GB"],
    [12.4 * 1024 ** 3, "12 GB"],
  ])("given %d bytes, when it is said, then it reads %s", (bytes, expected) => {
    // when
    const said = sizeSaid(bytes);

    // then
    expect(said).toBe(expected);
  });
});
