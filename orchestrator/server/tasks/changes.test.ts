import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "../git.js";
import { checkout, collectChanges, MAX_FILE_BYTES, MAX_FILES } from "./changes.js";
import { makeTaskDirs, taskPaths } from "./isolation.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A checkout of a one-commit repository, ready for an agent to change. */
async function workspace(prepare: (source: string, root: string) => void = () => {}) {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-changes-"));
  dirs.push(root);
  const source = join(root, "source");
  git(["init", "--quiet", "--initial-branch=main", source], root);
  writeFileSync(join(source, "README.md"), "team skills\n");
  prepare(source, root);
  git(["add", "-A"], source);
  git(["commit", "--quiet", "-m", "chore: start"], source);
  const paths = taskPaths(join(root, "data"), "t", "0123456789ab");
  await makeTaskDirs(paths);
  const base = await checkout(paths, source);
  return { paths, base };
}

const noCredential = () => false;

describe("reading back what an agent changed", () => {
  it("given an agent that edits and adds text files, when the change is read, then each file comes back whole", async () => {
    // given
    const { paths, base } = await workspace();
    writeFileSync(join(paths.work, "README.md"), "team skills, updated\n");
    writeFileSync(join(paths.work, "notes.md"), "new\n");

    // when
    const changes = await collectChanges(paths, base, noCredential);

    // then
    expect(changes).toEqual({ files: [{ path: "README.md", content: "team skills, updated\n" }, { path: "notes.md", content: "new\n" }] });
  });

  it("given a binary file, when the change is read, then it is refused", async () => {
    const { paths, base } = await workspace();
    writeFileSync(join(paths.work, "image.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    expect(await collectChanges(paths, base, noCredential)).toEqual({ refused: "The agent wrote image.bin as a binary file; the orchestrator proposes text files only." });
  });

  it("given a file over the size limit, when the change is read, then it is refused", async () => {
    const { paths, base } = await workspace();
    writeFileSync(join(paths.work, "big.md"), "x".repeat(MAX_FILE_BYTES + 1));
    expect(await collectChanges(paths, base, noCredential)).toHaveProperty("refused", expect.stringMatching(/big\.md at \d+ bytes, over the \d+-byte limit/));
  });

  it("given a file over the size limit and thousands of new files, when the change is read, then each is refused before git copies any of it into the task's git directory", async () => {
    // given
    const big = await workspace();
    writeFileSync(join(big.paths.work, "dump.bin"), randomBytes(8 * MAX_FILE_BYTES));
    const many = await workspace();
    mkdirSync(join(many.paths.work, "many"));
    for (let i = 0; i < 2000; i++) writeFileSync(join(many.paths.work, "many", `f-${i}.txt`), `${i}\n`);
    const objects = (paths: { git: string }) => readdirSync(join(paths.git, "objects")).filter((d) => /^[0-9a-f]{2}$/.test(d)).flatMap((d) => readdirSync(join(paths.git, "objects", d)));
    const before = [objects(big.paths).length, objects(many.paths).length];

    // when
    const refusals = [await collectChanges(big.paths, big.base, noCredential), await collectChanges(many.paths, many.base, noCredential)];

    // then
    expect(refusals).toEqual([
      { refused: `The agent wrote dump.bin at ${8 * MAX_FILE_BYTES} bytes, over the ${MAX_FILE_BYTES}-byte limit for one file.` },
      { refused: `The agent changed 2000 files, over the limit of ${MAX_FILES} for one request.` },
    ]);
    expect([objects(big.paths).length, objects(many.paths).length]).toEqual(before);
  });

  it("given more files than one request carries, when the change is read, then it is refused", async () => {
    const { paths, base } = await workspace();
    for (let i = 0; i <= MAX_FILES; i++) writeFileSync(join(paths.work, `note-${i}.md`), `${i}\n`);
    expect(await collectChanges(paths, base, noCredential)).toEqual({ refused: `The agent changed ${MAX_FILES + 1} files, over the limit of ${MAX_FILES} for one request.` });
  });

  it("given a repository with a link to a directory outside it, when the task checks it out and the agent writes through the link, then the link is a plain file, nothing reaches the outside, and the link is not reported as changed", async () => {
    // given
    let outside = "";
    const { paths, base } = await workspace((source, root) => {
      outside = join(root, "outside");
      mkdirSync(outside);
      symlinkSync(outside, join(source, "outlink"));
    });

    // when
    let wrote = true;
    try {
      writeFileSync(join(paths.work, "outlink", "pwned.txt"), "x");
    } catch {
      wrote = false;
    }

    // then
    expect(lstatSync(join(paths.work, "outlink")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(paths.work, "outlink"), "utf8")).toBe(outside);
    expect(wrote).toBe(false);
    expect(readdirSync(outside)).toEqual([]);
    expect(await collectChanges(paths, base, noCredential)).toEqual({ files: [] });
  });

  it("given the plain file a link arrived as, when the agent rewrites it, then the change is refused as a link", async () => {
    const { paths, base } = await workspace((source, root) => symlinkSync(join(root, "elsewhere"), join(source, "outlink")));
    writeFileSync(join(paths.work, "outlink"), "/etc");
    expect(await collectChanges(paths, base, noCredential)).toEqual({ refused: "The agent made outlink a symbolic link; the orchestrator proposes regular files only." });
  });
});
