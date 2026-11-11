import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { workingCopies } from "./workspace.js";

describe("the working copies in a person's one work folder", () => {
  let root: string;
  beforeEach(() => void (root = mkdtempSync(join(tmpdir(), "workspace-"))));
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const repo = (path: string, file = false) => {
    mkdirSync(join(root, path), { recursive: true });
    if (file) writeFileSync(join(root, path, ".git"), "gitdir: elsewhere\n");
    else mkdirSync(join(root, path, ".git"));
  };

  it("given a folder of repositories, one a level deeper, one a worktree, one in node_modules, one hidden and one too deep, when its working copies are found, then the first three come back by their paths in order", async () => {
    // given
    repo("payments-api");
    repo("clients/web");
    repo("docs", true);
    repo("payments-api/node_modules/dep");
    repo(".cache/tool");
    repo("deep/er/still");

    // when
    const found = await workingCopies(root);

    // then
    expect(found).toEqual(["clients/web", "docs", "payments-api"]);
  });

  it("given a folder that is itself a repository, when its working copies are found, then it is the one", async () => {
    // given
    mkdirSync(join(root, ".git"));
    repo("vendored");

    // when
    const found = await workingCopies(root);

    // then
    expect(found).toEqual([""]);
  });

  it("given more repositories than a task opens, when its working copies are found, then the folder is said to hold too many", async () => {
    // given
    for (const name of ["a", "b", "c"]) repo(name);

    // when
    const found = await workingCopies(root, 2);

    // then
    expect(found).toEqual({ tooMany: true });
  });
});
