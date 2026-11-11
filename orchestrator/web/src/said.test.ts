import { describe, expect, it } from "vitest";
import { mergeCommand, sentence } from "./said";

describe("sentence", () => {
  it("given a server's reason in lower case, with and without its full stop, when shown, then it opens with a capital and ends with one full stop", () => {
    // then
    expect(sentence("the store did not answer")).toBe("The store did not answer.");
    expect(sentence("enter a valid email address.")).toBe("Enter a valid email address.");
    expect(sentence("  unknown task  ")).toBe("Unknown task.");
  });

  it("given a reason that opens with a name, a path or a tool's own words, when shown, then its opening is kept as written", () => {
    // then
    expect(sentence("ada-laptop is offline; start it again")).toBe("ada-laptop is offline; start it again.");
    expect(sentence("~/code/empty holds no folder with a SKILL.md")).toBe("~/code/empty holds no folder with a SKILL.md.");
    expect(sentence("fatal: could not read from the remote repository")).toBe("fatal: could not read from the remote repository.");
    expect(sentence("PATH is set by the orchestrator")).toBe("PATH is set by the orchestrator.");
  });
});

describe("mergeCommand", () => {
  it("given a merge refused where the branch is checked out, when shown, then the command is cut from the words without the page's full stop", () => {
    // when
    const cut = mergeCommand("Main is checked out in ~/code/shop with changes of its own; merge it there: git merge handbook/task-7.");

    // then
    expect(cut).toEqual({ said: "Main is checked out in ~/code/shop with changes of its own; merge it there", command: "git merge handbook/task-7" });
  });

  it("given a reason with no command at its end, when shown, then nothing is cut", () => {
    // then
    expect(mergeCommand("The request is already merged.")).toBeNull();
    expect(mergeCommand("Run this: git merge .")).toBeNull();
  });
});
