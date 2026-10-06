import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildDemoRepo, createDemo, demoListing, draftDemoWorkflow, isDemoRepo } from "./demo.js";
import { listWorkflows } from "./mine-command.js";
import { readCandidateMeta } from "./queue.js";

const RECORDED = join(__dirname, "..", "..", "demo", "recorded-draft.md");

let root: string;
let repo: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "handbook-demo-test-"));
  repo = createDemo(root);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function fileMapRows(skill: string): string[] {
  return [...skill.matchAll(/^\| (shop-api:[^|]+?) \|/gm)].map((match) => match[1]!);
}

describe("the demo's scratch repository", () => {
  it("given a fresh demo repository, when it is listed at the thresholds the product ships, then the first workflow is the one the recorded draft maps", () => {
    // given the repository the demo builds, and the draft it ships with
    const recorded = readFileSync(RECORDED, "utf8");

    // when it is listed with no thresholds passed, exactly as the demo lists it
    const { workflows } = listWorkflows([repo]);

    // then both repeated pieces of work are found, and the recorded draft's file map is the
    // first one's: a draft of a workflow the list does not put first would be a demo of nothing
    expect(workflows.map((w) => w.jobs)).toEqual([10, 8]);
    expect(fileMapRows(recorded)).toEqual(workflows[0]!.files.map((f) => f.role));
  });

  it("given two builds, when their histories are compared, then they are the same commits", () => {
    // given a second build in a different place
    const again = buildDemoRepo(join(root, "again", "shop-api"));

    // when both tips are read
    const tip = (dir: string) => execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    // then they are identical, which is what lets one recorded draft stand for every user's copy
    expect(tip(again)).toBe(tip(repo));
  });

  it("given a repository beside the demo's own, in the same directory, when each is checked, then only the demo's is a demo repository", () => {
    // given a neighbouring repository sharing the scratch repository's parent directory
    const neighbour = join(dirname(repo), "neighbour");
    mkdirSync(neighbour, { recursive: true });
    execFileSync("git", ["init", "-q", neighbour]);

    // when each is checked, then the mark belongs to the repository that carries it and to no
    // repository merely standing next to it
    expect(isDemoRepo(neighbour)).toBe(false);
    expect(isDemoRepo(repo)).toBe(true);
  });

  it("given a fresh demo repository, when its status is read, then the mark that identifies it is not in the work tree", () => {
    // when git is asked what is untracked or changed
    const status = execFileSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" });

    // then nothing is, so approving a draft into it commits the skill and nothing else
    expect(status).toBe("");
  });

  it("given the listing, when it is read, then it offers both ways to a draft and names the scratch repository in each", () => {
    // when the listing is printed for a known script path
    const text = demoListing(repo, "/plugin/dist/demo.js");

    // then each way is a command against this repository, and neither is /handbook:mine's own
    // draft line, which would draft from wherever the user happens to be
    expect(text).toContain(`node "/plugin/dist/demo.js" recorded "${repo}"`);
    expect(text).toContain(`node "/plugin/dist/demo.js" live "${repo}"`);
    expect(text).not.toContain("/handbook:mine draft");
  });
});

describe("drafting in the demo", () => {
  let bin: string;
  let home: string;
  let marker: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    bin = mkdtempSync(join(tmpdir(), "handbook-bin-"));
    home = mkdtempSync(join(tmpdir(), "handbook-demo-home-"));
    marker = join(bin, "called");
    // A stand-in claude that records being started and replies with nothing.
    writeFileSync(join(bin, "claude"), `#!/bin/sh\ntouch "${marker}"\nexit 0\n`, { mode: 0o755 });
    originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    rmSync(bin, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("given the recorded draft, when the first workflow is drafted with it, then a draft from history is queued for the scratch repository and no claude is started", async () => {
    // given the draft the demo ships with
    const recorded = readFileSync(RECORDED, "utf8");

    // when it is handed in as the reply
    const outcome = await draftDemoWorkflow(repo, async () => recorded, home);

    // then it cleared the same gate and screen a fresh reply does, it waits in review as a
    // draft for the scratch repository, and nothing called the model to get there
    expect(outcome.ok).toBe(true);
    expect(readCandidateMeta(outcome.dir!)).toMatchObject({
      origin: "mine",
      status: "pending",
      suggestedTarget: "project",
      cwd: repo,
      demo: true,
      // the scratch repository is recorded as the one this draft came from, by its real path
      repoRoot: realpathSync(repo),
    });
    expect(readFileSync(join(outcome.dir!, "SKILL.md"), "utf8")).toBe(recorded);
    expect(existsSync(marker)).toBe(false);
  });

  it("given no recorded draft, when the first workflow is drafted, then the claude on PATH is what gets asked", async () => {
    // when nothing is handed in as the reply
    const outcome = await draftDemoWorkflow(repo, undefined, home);

    // then the stand-in was started, which is what makes its silence above a measurement and not
    // a stand-in nobody could reach; its empty reply is refused like any unusable one
    expect(existsSync(marker)).toBe(true);
    expect(outcome.ok).toBe(false);
  });
});
