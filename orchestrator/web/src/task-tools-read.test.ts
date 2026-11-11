import { describe, expect, it } from "vitest";
import { namedValues, sourceInput, sourcePlace } from "./task-tools-read";

describe("sourceInput", () => {
  it("given a path from home, a full path and git addresses, when added as a skill repository, then paths go as folders and the rest as addresses the server reads", () => {
    // then
    expect(sourceInput(" ~/code/team-skills ")).toEqual({ folder: "~/code/team-skills" });
    expect(sourceInput("/srv/skills")).toEqual({ folder: "/srv/skills" });
    expect(sourceInput("https://github.com/team/skills")).toEqual({ url: "https://github.com/team/skills" });
    expect(sourceInput("git@gitlab.com:team/skills.git")).toEqual({ url: "git@gitlab.com:team/skills.git" });
  });
});

describe("namedValues", () => {
  it("given NAME=value lines with spaces, an empty value, a blank line and a value holding =, when read, then each name keeps its value and nothing nameless is kept", () => {
    // when
    const read = namedValues(" API_TOKEN = abc\nEMPTY=\n\nQUERY=a=b\n=orphan");

    // then
    expect(read).toEqual({ API_TOKEN: "abc", EMPTY: "", QUERY: "a=b" });
  });
});

describe("sourcePlace", () => {
  it("given a folder source and a git one, when shown, then the folder reads from home and the git one by its address", () => {
    // then
    expect(sourcePlace({ id: "s1", kind: "folder", path: "~/code/team-skills", name: "team-skills", skills: [], readAt: "t" })).toBe("~/code/team-skills");
    expect(sourcePlace({ id: "s2", kind: "git", url: "https://github.com/team/skills", name: "skills", head: "abc", skills: [], readAt: "t" })).toBe("https://github.com/team/skills");
  });
});
