import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitFailure, parseLog, readCommits, renamedTo, resolveRef } from "./git-log.js";
import { createFixture, type Fixture } from "./mine-fixture.js";

const R = "\x1e";
const F = "\x1f";

describe("parseLog", () => {
  it("joins the status letter from the raw block to the line counts from the numstat block", () => {
    // given one commit as git prints it with --raw and --numstat together
    const output =
      `${R}abc${F}p1${F}dev@acme.example${F}2025-01-01T00:00:00+00:00${F}TEAM-1 add a field\n\n` +
      `:100644 100644 aaa bbb M\tsrc/Invoice.kt\n` +
      `:000000 100644 000 ccc A\tsrc/Order.kt\n` +
      `3\t1\tsrc/Invoice.kt\n` +
      `10\t0\tsrc/Order.kt\n`;

    // when it is parsed
    const [commit] = parseLog(output);

    // then each file carries both
    expect(commit!.files).toEqual([
      { status: "M", path: "src/Invoice.kt", added: 3, removed: 1 },
      { status: "A", path: "src/Order.kt", added: 10, removed: 0 },
    ]);
    expect(commit!.parents).toEqual(["p1"]);
    expect(commit!.subject).toBe("TEAM-1 add a field");
  });

  it("keeps a rename under its new path and a binary file without counts", () => {
    // given a rename, whose raw line holds two paths, and a binary file, whose counts are "-"
    const output =
      `${R}abc${F}p1${F}dev@acme.example${F}2025-01-01T00:00:00+00:00${F}move\n\n` +
      `:100644 100644 aaa aaa R100\told/Thing.kt\tnew/Thing.kt\n` +
      `:100644 100644 bbb ccc M\tlogo.png\n` +
      `0\t0\tnew/Thing.kt\n` +
      `-\t-\tlogo.png\n`;

    // when it is parsed
    const [commit] = parseLog(output);

    // then the rename keeps its R and the path later commits will use, and the binary stays unknown
    expect(commit!.files).toEqual([
      { status: "R100", path: "new/Thing.kt", added: 0, removed: 0 },
      { status: "M", path: "logo.png", added: null, removed: null },
    ]);
  });

  it("reads a merge, which git prints without files, as a commit with two parents", () => {
    // given a merge record with no file block
    const output = `${R}m1${F}p1 p2${F}dev@acme.example${F}2025-01-01T00:00:00+00:00${F}Merge branch 'TEAM-4' into 'master'\n`;

    // when it is parsed
    const [merge] = parseLog(output);

    // then the parents are what say it is a merge
    expect(merge).toMatchObject({ parents: ["p1", "p2"], files: [] });
  });
});

describe("renamedTo", () => {
  it.each([
    ["src/{old => new}/Thing.kt", "src/new/Thing.kt"],
    ["{old => new}/Thing.kt", "new/Thing.kt"],
    ["src/{ => sub}/Thing.kt", "src/sub/Thing.kt"],
    ["src/{sub => }/Thing.kt", "src/Thing.kt"],
    ["Old.kt => New.kt", "New.kt"],
    ["src/Plain.kt", "src/Plain.kt"],
  ])("reads %s as %s", (compact, plain) => {
    // given a path as numstat prints it
    // when the new path is recovered
    // then it is the path the raw block uses
    expect(renamedTo(compact)).toBe(plain);
  });
});

describe("gitFailure", () => {
  it("names what git said went wrong rather than the command that failed", () => {
    // given a failed call whose stderr holds a warning before the fatal line
    const error = Object.assign(new Error("Command failed: git log HEAD --raw ..."), {
      stderr: "warning: refname is ambiguous\nfatal: ambiguous argument 'HEAD': unknown revision\n",
    });

    // when it is reduced to a reason
    // then the fatal line is the reason
    expect(gitFailure(error)).toBe("fatal: ambiguous argument 'HEAD': unknown revision");
  });
});

describe("readCommits", () => {
  let fixture: Fixture;
  beforeEach(() => {
    fixture = createFixture();
  });
  afterEach(() => fixture.cleanup());

  it("reports a moved file as a rename and a non-ASCII path as written", () => {
    // given a repository with a moved file and a file whose name is outside ASCII
    const repo = fixture.repo("acme-api");
    repo.commit({ files: { "old/Thing.kt": "class Thing\n", "src/表示.kt": "x\n" }, subject: "start", author: "Ada" });
    repo.commit({ files: {}, renames: { "old/Thing.kt": "new/Thing.kt" }, subject: "move", author: "Ada" });

    // when its history is read
    const [move, start] = readCommits(repo.path);

    // then the rename is visible, and the name is not octal-escaped into a different role
    expect(move!.files).toEqual([expect.objectContaining({ status: expect.stringMatching(/^R/), path: "new/Thing.kt" })]);
    expect(start!.files.map((f) => f.path).sort()).toEqual(["old/Thing.kt", "src/表示.kt"]);
  });

  it("reports no rename when rename detection is off, which is what a blobless clone needs", () => {
    // given the same move
    const repo = fixture.repo("acme-api");
    repo.commit({ files: { "old/Thing.kt": "class Thing\n" }, subject: "start", author: "Ada" });
    repo.commit({ files: {}, renames: { "old/Thing.kt": "new/Thing.kt" }, subject: "move", author: "Ada" });

    // when it is read without rename detection
    const [move] = readCommits(repo.path, { noRenames: true });

    // then git reports a delete and an add instead
    expect(move!.files.map((f) => f.status).sort()).toEqual(["A", "D"]);
  });

  it("falls back through the preferred refs to one the repository has", () => {
    // given a repository with a master branch and no remote
    const repo = fixture.repo("acme-api");
    repo.commit({ files: { "a.kt": "a\n" }, subject: "start", author: "Ada" });

    // when a ref is resolved from a preference list that starts with a remote ref
    const ref = resolveRef(repo.path, ["origin/master", "master", "HEAD"]);

    // then the first ref that exists wins
    expect(ref).toBe("master");
  });
});
