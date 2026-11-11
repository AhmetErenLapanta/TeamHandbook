import { describe, expect, it } from "vitest";
import { bodyStart, diffLines, numberLines } from "./DiffPatch";

describe("diffLines", () => {
  it("given a hunk of a unified diff, when it is read, then the hunk header, context, removals and additions are told apart", () => {
    // given
    const patch = ["@@ -1,3 +1,3 @@", " unchanged", "-old line", "+new line"].join("\n");

    // when
    const kinds = diffLines(patch);

    // then
    expect(kinds).toEqual(["hunk", "context", "del", "add"]);
  });

  it("given a diff with its file headers, when it is read, then the headers are none of the changed lines", () => {
    // given
    const patch = ["diff --git a/SKILL.md b/SKILL.md", "index 1a2b3c4..5d6e7f8 100644", "--- a/SKILL.md", "+++ b/SKILL.md", "@@ -1 +1 @@", "-a", "+b", "\\ No newline at end of file"].join("\n");

    // when
    const kinds = diffLines(patch);

    // then
    expect(kinds).toEqual(["meta", "meta", "meta", "meta", "hunk", "del", "add", "meta"]);
  });

  it("given a removed line whose text starts with two dashes, when it is read inside its hunk, then it is a removal and not a file header", () => {
    // given
    const patch = ["@@ -1,2 +1,1 @@", "--- a horizontal rule", "+++ an added line of pluses"].join("\n");

    // when
    const kinds = diffLines(patch);

    // then
    expect(kinds).toEqual(["hunk", "del", "add"]);
  });
});

describe("bodyStart", () => {
  it("given a patch with git's header lines before its first hunk, when it is drawn, then it starts at the hunk, and a patch with no hunk is shown whole", () => {
    // given
    const withHeader = diffLines("diff --git a/x b/x\nnew file mode 100644\nindex 0000000..e69de29\n--- /dev/null\n+++ b/x\n@@ -0,0 +1 @@\n+hello");
    const modeOnly = diffLines("diff --git a/x b/x\nold mode 100644\nnew mode 100755");

    // then
    expect(bodyStart(withHeader)).toBe(5);
    expect(bodyStart(modeOnly)).toBe(0);
  });
});

describe("numberLines", () => {
  it("given a new file's patch that ends with a newline, when its lines are numbered, then the newline is no line of its own", () => {
    // when
    const lines = numberLines("@@ -0,0 +1,2 @@\n+first\n+second\n");

    // then
    expect(lines.map((l) => [l.kind, l.old, l.new])).toEqual([["hunk", null, null], ["add", null, 1], ["add", null, 2]]);
  });
});
