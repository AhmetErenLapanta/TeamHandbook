import { describe, expect, it } from "vitest";
import { checkedSaid, loadedFolder, whereSaid } from "./TaskWhere";

describe("how the folder a task works in is said", () => {
  it("given a folder picked from what the task asked, with and without a CLAUDE.md heading, and one fallen back to, when the line is said, then it names the heading, nothing, or that it was used last, and never the model's reason", () => {
    // given
    const picked = { path: "/home/ada/code/payments-api", reason: "the ask names refunds", fallback: false };
    const fell = { path: "/home/ada/code/notes", reason: "", fallback: true };

    // when
    const said = [whereSaid(picked, "Payments API"), whereSaid(picked, null), whereSaid(fell, "Notes")];

    // then
    expect(said).toEqual([", which its CLAUDE.md calls Payments API", "", ", the folder you use most"]);
    expect(said.join("")).not.toContain("refunds");
  });
});

describe("how the checks a task is held to are said", () => {
  it("given no check, one and two, when the line is made, then none says nothing and the others name each command", () => {
    // when
    const said = [checkedSaid([]), checkedSaid(["npm test"]), checkedSaid(["npm test", "npm run lint"])];

    // then
    expect(said).toEqual(["", ", checked with npm test", ", checked with npm test and npm run lint"]);
  });
});

describe("what the folder gives the task", () => {
  it("given a folder with skills, a CLAUDE.md and memory, one with a CLAUDE.md only and one with nothing, when it is said, then each names what is loaded and the empty one says so", () => {
    // when
    const said = [
      loadedFolder({ skills: 1, claudeMd: true, memory: true }, "~/code/mcp"),
      loadedFolder({ skills: 0, claudeMd: true, memory: false }, "~/code/notes"),
      loadedFolder({ skills: 12, claudeMd: false, memory: false }, "~/code/api"),
      loadedFolder({ skills: 0, claudeMd: false, memory: false }, "~/code/empty"),
    ];

    // then
    expect(said).toEqual([
      "Loaded: 1 skill, CLAUDE.md, memory from ~/code/mcp.",
      "Loaded: CLAUDE.md from ~/code/notes.",
      "Loaded: 12 skills from ~/code/api.",
      "Nothing of ~/code/empty's own is loaded: it has no CLAUDE.md, skills or memory.",
    ]);
  });
});
