import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checksInFolder, machineFolders } from "./folders.js";

describe("the folders a machine lists for its person's project picker", () => {
  let root: string;
  let home: string;
  let dataDir: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "machine-folders-"));
    home = join(root, "home");
    dataDir = join(home, "runner-data");
    for (const dir of ["projects/payments", "notes", ".ssh", "Library/Caches", "runner-data/runner"]) mkdirSync(join(home, dir), { recursive: true });
    writeFileSync(join(home, "projects", "payments", "package.json"), "{}\n");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("given a home with a project, a hidden folder, Library and the runner's data, when nothing is asked for, then the projects are suggested and every path leaves as ~ with the home's own path nowhere in the answer", async () => {
    // when
    const listed = await machineFolders(null, null, { home, dataDir });

    // then
    expect(listed).toMatchObject({ under: "~", parent: null, suggestions: [expect.objectContaining({ name: "payments", path: "~/projects/payments" })] });
    expect(JSON.stringify(listed)).not.toContain(root);
    const names = "folders" in listed ? listed.folders.map((f) => f.name) : [];
    expect(names).toEqual(expect.arrayContaining(["projects", "notes"]));
    expect(names).not.toEqual(expect.arrayContaining([".ssh"]));
  });

  it("given a folder asked for under ~, when it is listed, then its folders come back under ~ and its parent is ~", async () => {
    // when
    const listed = await machineFolders("~/projects", null, { home, dataDir });

    // then
    expect(listed).toMatchObject({ under: "~/projects", parent: "~", folders: [expect.objectContaining({ name: "payments", path: "~/projects/payments" })] });
  });

  it.each([
    ["the runner's own data", "~/runner-data/runner", "data-dir"],
    ["a folder outside the home", "/", "outside-home"],
    ["a folder that climbs out of the home", "~/../", "outside-home"],
    ["a hidden folder", "~/.ssh", "hidden"],
  ])("given the orchestrator asks for %s, when the machine reads it against its own rule, then it is refused and nothing is listed", async (_case, under, refused) => {
    // when
    const listed = await machineFolders(under, null, { home, dataDir });

    // then
    expect(listed).toMatchObject({ refused });
  });
});

describe("a folder project's checks, read on the machine its folder is on", () => {
  let root: string;
  let where: { home: string; dataDir: string; shadows: string };
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "machine-checks-")));
    const home = join(root, "home");
    where = { home, dataDir: join(home, "runner-data"), shadows: join(home, "runner-data", "shadow") };
    mkdirSync(join(home, "notes"), { recursive: true });
    mkdirSync(where.dataDir, { recursive: true });
    writeFileSync(join(home, "notes", "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("given a folder in the home whose package names its tests, when the screen asks for its checks, then the machine reads them off the files and runs nothing", async () => {
    // when
    const answer = await checksInFolder({ nonce: "n-1", projectId: "prj_notes", path: "~/notes" }, where);

    // then
    expect(answer).toMatchObject({ detected: { checks: [expect.objectContaining({ kind: "test", command: "npm test", source: "package.json scripts.test" })] } });
  });

  it("given a folder named outside the machine's home, when the screen asks for its checks, then the machine reads nothing", async () => {
    // when
    const answer = await checksInFolder({ nonce: "n-2", projectId: "prj_notes", path: "~/../elsewhere" }, where);

    // then
    expect(answer).toMatchObject({ refused: expect.any(String) });
  });
});
