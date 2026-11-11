import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { seed } from "../../demo/seed.js";
import { git, gitMaybe } from "../git.js";
import { openSqliteStore } from "../store.js";
import type { RepoRecord } from "../store.js";
import { createLocalForge, deleteLocalBranch, inLocalTurn, localDescriptionRef, localRepoPath, mergeLocalBranch, mergeLocalRequest, safeRepoPath, TargetCheckedOut } from "./local.js";
import type { ChangeRequest } from "./types.js";
import { copyOf } from "../test-fixtures.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * The demo's first team repository, seeded once for the file and copied for each test. Seeding runs
 * dozens of git processes, and copying the whole demo writes some two hundred files a machine's
 * endpoint protection checks one by one; the one repository these tests use is all that is kept.
 */
async function fixture(): Promise<{ root: string; repo: RepoRecord; bare: string }> {
  const { root, made } = await copyOf("forge-local:first-repo", "orchestrator-forge-", async (at) => {
    const { configFile } = seed(join(at, "demo"));
    const config = JSON.parse(readFileSync(configFile, "utf8"));
    const entry = config.repos[0];
    const bare = join(at, "repo.git");
    renameSync(localRepoPath(entry.url)!, bare);
    rmSync(join(at, "demo"), { recursive: true, force: true });
    return { entry: { ...entry, url: String(entry.url).startsWith("file://") ? `file://${bare}` : bare }, tenant: String(config.tenant) };
  });
  dirs.push(root);
  const store = openSqliteStore(":memory:");
  const repo = await store.upsertRepo({ ...made.entry, tenant: made.tenant });
  return { root, repo, bare: localRepoPath(repo.url)! };
}

function change(bare: string, overrides: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    title: "feat(skill): add on-call-handover",
    body: "Proposed from the orchestrator.",
    branch: "handbook/on-call-handover",
    baseSha: git(["rev-parse", "main"], bare).trim(),
    files: [{ path: "skills/on-call-handover/SKILL.md", content: "---\nname: on-call-handover\ndescription: Use at shift change.\n---\n" }],
    author: { name: "Ada Example", email: "ada@example.invalid" },
    ...overrides,
  };
}

describe("the local forge", () => {
  it("given a change, when it is opened, then the branch carries it and the default branch does not move", async () => {
    // given
    const { root, repo, bare } = await fixture();
    const before = git(["rev-parse", "main"], bare).trim();
    let n = 0;
    const forge = createLocalForge(join(root, "work"), { nextNumber: async () => ++n });

    // when
    const opened = await forge.open(repo, change(bare));

    // then
    expect(opened.number).toBe(1);
    expect(git(["rev-parse", "main"], bare).trim()).toBe(before);
    expect(git(["show", `${opened.branch}:skills/on-call-handover/SKILL.md`], bare)).toContain("name: on-call-handover");
    expect(git(["log", "-1", "--format=%an <%ae>", opened.branch], bare).trim()).toBe("Ada Example <ada@example.invalid>");
  });

  it("given a request taken back, when it is deleted and the same branch is asked for again, then the branch and its description both go and the new request opens with its own", async () => {
    // given
    const { root, repo, bare } = await fixture();
    const forge = createLocalForge(join(root, "work"), { nextNumber: async () => 1 });
    const first = await forge.open(repo, change(bare, { body: "first description" }));

    // when
    await deleteLocalBranch(repo, first.branch);
    const gone = [gitMaybe(["rev-parse", "--verify", "--quiet", `refs/heads/${first.branch}`], bare), gitMaybe(["rev-parse", "--verify", "--quiet", localDescriptionRef(first.branch)], bare)];
    const again = await forge.open(repo, change(bare, { body: "second description" }));

    // then
    expect(gone).toEqual([null, null]);
    expect(git(["notes", "--ref", localDescriptionRef(again.branch), "show", again.branch], bare).trim()).toBe("second description");
  });

  it("given a description left for a branch that does not exist, when a request for that branch opens, then neither the branch nor the description is changed", async () => {
    // given
    const { root, repo, bare } = await fixture();
    const forge = createLocalForge(join(root, "work"), { nextNumber: async () => 1 });
    const stale = await forge.open(repo, change(bare, { branch: "handbook/stale", body: "stale" }));
    git(["update-ref", localDescriptionRef("handbook/on-call-handover"), git(["rev-parse", localDescriptionRef(stale.branch)], bare).trim()], bare);
    const left = git(["rev-parse", localDescriptionRef("handbook/on-call-handover")], bare).trim();

    // when
    const attempt = forge.open(repo, change(bare));

    // then
    await expect(attempt).rejects.toThrow();
    expect(gitMaybe(["rev-parse", "--verify", "--quiet", "refs/heads/handbook/on-call-handover"], bare)).toBeNull();
    expect(git(["rev-parse", localDescriptionRef("handbook/on-call-handover")], bare).trim()).toBe(left);
  });

  it("given a path that climbs out of the repository, when the change is opened, then it is refused and no branch appears", async () => {
    // given
    const { root, repo, bare } = await fixture();
    const forge = createLocalForge(join(root, "work"), { nextNumber: async () => 1 });

    // when
    const attempt = () => forge.open(repo, change(bare, { files: [{ path: "skills/../../escape.txt", content: "x" }] }));

    // then
    await expect(attempt()).rejects.toThrow(/refusing path/);
    expect(gitMaybe(["rev-parse", "--verify", "--quiet", "refs/heads/handbook/on-call-handover"], bare)).toBeNull();
  });

  it("given a branch that already exists, when a change asks for it again, then it is refused rather than overwritten", async () => {
    // given
    const { root, repo, bare } = await fixture();
    const forge = createLocalForge(join(root, "work"), { nextNumber: async () => 1 });
    const first = await forge.open(repo, change(bare));

    // when
    const again = () => forge.open(repo, change(bare, { files: [{ path: "README.md", content: "replaced\n" }] }));

    // then
    await expect(again()).rejects.toThrow(/already exists/);
    expect(git(["rev-parse", first.branch], bare).trim()).toBe(first.headSha);
  });

  it("given an opened request, when a person merges it, then the default branch moves to a merge commit holding the change", async () => {
    // given
    const { root, repo, bare } = await fixture();
    const forge = createLocalForge(join(root, "work"), { nextNumber: async () => 1 });
    const opened = await forge.open(repo, change(bare));

    // when
    const merged = await mergeLocalRequest(join(root, "work"), repo, opened.branch, { name: "Grace Example", email: "grace@example.invalid" });

    // then
    expect(git(["rev-parse", "main"], bare).trim()).toBe(merged);
    expect(git(["rev-list", "--parents", "-n1", "main"], bare).trim().split(" ")).toHaveLength(3);
    expect(git(["show", "main:skills/on-call-handover/SKILL.md"], bare)).toContain("on-call-handover");
  });

  it("given paths a user could type, when they are checked, then only plain paths inside the repository pass", async () => {
    const root = "/srv/work";
    expect(safeRepoPath(root, "skills/a/SKILL.md")).toBe("/srv/work/skills/a/SKILL.md");
    for (const bad of ["/etc/passwd", "../x", "skills/../../x", "skills//x", ".git/config", "skills/./x"]) {
      expect(() => safeRepoPath(root, bad), bad).toThrow(/refusing path/);
    }
  });
});

describe("the local forge and symbolic links in a team repository", () => {
  /** Commits a symbolic link into the bare repository the way a push from elsewhere would, and returns the outside place it points at. */
  function withLink(root: string, bare: string, link: string, pointsAtDir: boolean): string {
    const outside = join(root, "outside");
    mkdirSync(outside, { recursive: true });
    const target = pointsAtDir ? outside : join(outside, "victim.txt");
    if (!pointsAtDir) writeFileSync(target, "untouched\n");
    const work = mkdtempSync(join(root, "pusher-"));
    git(["clone", "--quiet", bare, work], work);
    if (link === "skills") rmSync(join(work, "skills"), { recursive: true, force: true });
    mkdirSync(join(work, link, ".."), { recursive: true });
    symlinkSync(target, join(work, link));
    git(["add", "-A"], work);
    git(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "--quiet", "-m", "link"], work);
    git(["fetch", "--quiet", work, "main:main"], bare);
    return outside;
  }

  it.each([
    ["a file link", "skills/evil/SKILL.md", false, "skills/evil/SKILL.md"],
    ["a folder link", "skills/evil", true, "skills/evil/SKILL.md"],
    ["the skills folder as a link", "skills", true, "skills/newone/SKILL.md"],
  ])("given %s in the repository, when a change writes through it, then it is refused, nothing outside the repository is written, and no branch appears", async (_label, link, pointsAtDir, path) => {
    // given
    const { root, repo, bare } = await fixture();
    const outside = withLink(root, bare, link, pointsAtDir);
    const forge = createLocalForge(join(root, "work"), { nextNumber: async () => 1 });

    // when
    const attempt = forge.open(repo, change(bare, { files: [{ path, content: "---\nname: evil\ndescription: x\n---\n" }] }));

    // then
    await expect(attempt).rejects.toThrow(/is a symbolic link/);
    if (pointsAtDir) expect(existsSync(join(outside, "SKILL.md")) || existsSync(join(outside, "newone"))).toBe(false);
    else expect(readFileSync(join(outside, "victim.txt"), "utf8")).toBe("untouched\n");
    expect(gitMaybe(["rev-parse", "--verify", "--quiet", "refs/heads/handbook/on-call-handover"], bare)).toBeNull();
  });

  it("given a change elsewhere in a repository that holds a link, when it is opened, then it goes through and the link is carried unchanged", async () => {
    // given
    const { root, repo, bare } = await fixture();
    withLink(root, bare, "skills/evil", true);
    const forge = createLocalForge(join(root, "work"), { nextNumber: async () => 1 });

    // when
    const opened = await forge.open(repo, change(bare));

    // then
    expect(git(["ls-tree", opened.branch, "--", "skills/evil"], bare)).toMatch(/^120000 /);
    expect(git(["show", `${opened.branch}:skills/on-call-handover/SKILL.md`], bare)).toContain("name: on-call-handover");
  });

  it("given two requests that change the same file differently, when both are merged, then the second is refused as a conflict and the default branch keeps the first", async () => {
    // given
    const { root, repo, bare } = await fixture();
    const forge = createLocalForge(join(root, "work"), { nextNumber: async () => 1 });
    const a = await forge.open(repo, change(bare, { branch: "handbook/a", files: [{ path: "README.md", content: "a\n" }] }));
    const b = await forge.open(repo, change(bare, { branch: "handbook/b", files: [{ path: "README.md", content: "b\n" }] }));
    await mergeLocalRequest(join(root, "work"), repo, a.branch, { name: "Grace Example", email: "grace@example.invalid" });
    const after = git(["rev-parse", "main"], bare).trim();

    // when
    const second = () => mergeLocalRequest(join(root, "work"), repo, b.branch, { name: "Grace Example", email: "grace@example.invalid" });

    // then
    await expect(second()).rejects.toThrow(/conflicts with main/);
    expect(git(["rev-parse", "main"], bare).trim()).toBe(after);
    expect(git(["show", "main:README.md"], bare)).toBe("a\n");
  });
});

describe("a request for a branch the runner already pushed", () => {
  const IDENTITY = ["-c", "user.name=Stand In", "-c", "user.email=stand-in@example.invalid"];
  const pushed = (bare: string, branch: string, parent: string | null) => {
    const sha = git([...IDENTITY, "commit-tree", "main^{tree}", ...(parent ? ["-p", parent] : []), "-m", "the runner's commit"], bare).trim();
    git(["update-ref", `refs/heads/${branch}`, sha], bare);
    return sha;
  };
  const forge = (root: string) => {
    let n = 0;
    return createLocalForge(join(root, "work"), { nextNumber: async () => ++n });
  };

  it("given a branch the runner pushed onto the task's base, when its request is opened, then it is recorded at the branch's head with its description, and the branch is left as pushed", async () => {
    const { root, repo, bare } = await fixture();
    const base = git(["rev-parse", "main"], bare).trim();
    const head = pushed(bare, "handbook/pushed", base);

    const opened = await forge(root).openForBranch!(repo, { title: "Add the pushed skill", body: "Written on the person's machine.", branch: "handbook/pushed", baseSha: base });

    expect(opened).toEqual({ number: 1, url: `local://requests/${repo.id}/1`, branch: "handbook/pushed", headSha: head });
    expect(git(["rev-parse", "refs/heads/handbook/pushed"], bare).trim()).toBe(head);
    expect(git(["notes", "--ref", localDescriptionRef("handbook/pushed"), "show", head], bare).trim()).toBe("Written on the person's machine.");
  });

  it("given no such branch, or one that does not start from the task's base, when its request is opened, then it is refused and nothing is recorded", async () => {
    const { root, repo, bare } = await fixture();
    const base = git(["rev-parse", "main"], bare).trim();
    pushed(bare, "handbook/elsewhere", null);
    const local = forge(root);

    await expect(local.openForBranch!(repo, { title: "t", body: "b", branch: "handbook/missing", baseSha: base })).rejects.toThrow(/handbook\/missing is not in .*the runner pushes it first/);
    await expect(local.openForBranch!(repo, { title: "t", body: "b", branch: "handbook/elsewhere", baseSha: base })).rejects.toThrow(/does not start from the commit the task started from/);
    expect(gitMaybe(["rev-parse", "--verify", "--quiet", localDescriptionRef("handbook/elsewhere")], bare)).toBeNull();
  });

  /** The person's own working copy with main checked out, and a request's branch in it that adds a skill. */
  const workingCopy = (root: string) => {
    const copy = join(root, "copy");
    mkdirSync(copy);
    git(["init", "-q", "-b", "main"], copy);
    writeFileSync(join(copy, "README.md"), "skills\n");
    git(["add", "."], copy);
    git([...IDENTITY, "commit", "-q", "-m", "first"], copy);
    git(["switch", "-q", "-c", "handbook/pushed"], copy);
    mkdirSync(join(copy, "skills", "retry"), { recursive: true });
    writeFileSync(join(copy, "skills", "retry", "SKILL.md"), "# Retry\n");
    git(["add", "."], copy);
    git([...IDENTITY, "commit", "-q", "-m", "the runner's commit"], copy);
    git(["switch", "-q", "main"], copy);
    return { copy, main: git(["rev-parse", "main"], copy).trim() };
  };

  it("given the person's working copy with its default branch checked out and nothing of theirs uncommitted, when a request is merged, then the branch checked out moves to the merge and its files with it", async () => {
    const { root, repo } = await fixture();
    const { copy, main } = workingCopy(root);
    const inCopy = { ...repo, url: `file://${copy}` };

    const merged = await mergeLocalRequest(join(root, "work"), inCopy, "handbook/pushed", { name: "Ada Example", email: "ada@example.invalid" });

    expect(git(["rev-parse", "main"], copy).trim()).toBe(merged);
    expect(git(["rev-parse", `${merged}^1`], copy).trim()).toBe(main);
    expect(git(["log", "-1", "--format=%an", merged], copy).trim()).toBe("Ada Example");
    expect(readFileSync(join(copy, "skills", "retry", "SKILL.md"), "utf8")).toBe("# Retry\n");
    expect(git(["status", "--porcelain"], copy).trim()).toBe("");
    expect(gitMaybe(["rev-parse", "--verify", "--quiet", "refs/orchestrator/merged"], copy)).toBeNull();
  });

  it("given the person's working copy with a change of theirs not committed, when a request is merged, then it is refused with what to do and the command to merge it there, and neither the branch nor their change moves", async () => {
    const { root, repo } = await fixture();
    const { copy, main } = workingCopy(root);
    writeFileSync(join(copy, "README.md"), "skills, being edited\n");
    const inCopy = { ...repo, url: `file://${copy}` };

    const refused = await mergeLocalRequest(join(root, "work"), inCopy, "handbook/pushed", { name: "Ada Example", email: "ada@example.invalid" }).catch((err: Error) => err);

    expect(refused).toBeInstanceOf(TargetCheckedOut);
    expect((refused as Error).message).toBe(`main is checked out in ${repo.name} with changes not committed; commit them or set them aside, then merge again, or merge it in your own repository: git merge handbook/pushed`);
    expect(git(["rev-parse", "main"], copy).trim()).toBe(main);
    expect(readFileSync(join(copy, "README.md"), "utf8")).toBe("skills, being edited\n");
  });
});

describe("a new commit on a local request's branch", () => {
  const IDENTITY = ["-c", "user.name=Stand In", "-c", "user.email=stand-in@example.invalid"];
  const local = (root: string) => createLocalForge(join(root, "work"), { nextNumber: async () => 1 });
  const update = (expectedHead: string) => ({ files: [{ path: "skills/on-call-handover/SKILL.md", content: "---\nname: on-call-handover\ndescription: Use at shift change, revised.\n---\n" }], title: "Address the review", author: { name: "Ada Example", email: "ada@example.invalid" }, expectedHead });

  it("given an open request's branch at the head the change was prepared on, when it is updated, then one commit on that head moves it, by the person, and the request's description moves with it", async () => {
    const { root, repo, bare } = await fixture();
    const opened = await local(root).open(repo, change(bare));

    const { headSha } = await local(root).updateBranch!(repo, opened.branch, update(opened.headSha));

    expect(git(["rev-parse", `refs/heads/${opened.branch}`], bare).trim()).toBe(headSha);
    expect(git(["rev-parse", `${headSha}^`], bare).trim()).toBe(opened.headSha);
    expect(git(["log", "-1", "--format=%an|%s", headSha], bare).trim()).toBe("Ada Example|Address the review");
    expect(git(["notes", "--ref", localDescriptionRef(opened.branch), "show", headSha], bare).trim()).toBe("Proposed from the orchestrator.");
    expect(gitMaybe(["rev-parse", "--verify", "--quiet", "refs/orchestrator/update"], bare)).toBeNull();
  });

  it("given a branch that moved since the change was prepared, when it is updated, then it is refused and keeps the commit that moved it", async () => {
    const { root, repo, bare } = await fixture();
    const opened = await local(root).open(repo, change(bare));
    const moved = git([...IDENTITY, "commit-tree", `${opened.headSha}^{tree}`, "-p", opened.headSha, "-m", "someone else"], bare).trim();
    git(["update-ref", `refs/heads/${opened.branch}`, moved], bare);

    await expect(local(root).updateBranch!(repo, opened.branch, update(opened.headSha))).rejects.toThrow(/moved since the change was prepared/);
    expect(git(["rev-parse", `refs/heads/${opened.branch}`], bare).trim()).toBe(moved);
  });

  it("given the request's branch checked out in the person's working copy, when it is updated, then it is refused and their files are not touched", async () => {
    const { root, repo } = await fixture();
    const copy = join(root, "copy");
    mkdirSync(copy);
    git(["init", "-q", "-b", "handbook/mine"], copy);
    writeFileSync(join(copy, "README.md"), "skills\n");
    git(["add", "."], copy);
    git([...IDENTITY, "commit", "-q", "-m", "first"], copy);
    const head = git(["rev-parse", "HEAD"], copy).trim();

    await expect(local(root).updateBranch!({ ...repo, url: `file://${copy}` }, "handbook/mine", update(head))).rejects.toThrow(/checked out in .*commit to it there/);
    expect(git(["rev-parse", "HEAD"], copy).trim()).toBe(head);
  });
});

describe("where a local request stands once the person acts on it in their own repository", () => {
  const IDENTITY = ["-c", "user.name=Stand In", "-c", "user.email=stand-in@example.invalid"];
  async function opened() {
    const { root, repo, bare } = await fixture();
    const recorded = new Map<number, { branch: string; headSha: string }>();
    const forge = createLocalForge(join(root, "work"), { nextNumber: async () => 1, request: async (_t, _id, n) => recorded.get(n) ?? null });
    const request = await forge.open(repo, change(bare));
    recorded.set(request.number, request);
    return { forge, repo, bare, request };
  }

  it("given a request nobody acted on, when its state is read, then it is open", async () => {
    const { forge, repo, request } = await opened();
    expect(await forge.status!(repo, request.number)).toEqual({ status: "open", mergedAt: null, headSha: request.headSha });
  });

  it("given the person merging the branch into the default one themselves, when its state is read, then it is merged, and it stays merged once they delete the branch", async () => {
    const { forge, repo, bare, request } = await opened();
    const main = git(["rev-parse", "main"], bare).trim();
    const merge = git([...IDENTITY, "commit-tree", `${request.headSha}^{tree}`, "-p", main, "-p", request.headSha, "-m", `Merge ${request.branch}`], bare).trim();
    git(["update-ref", "refs/heads/main", merge], bare);

    expect(await forge.status!(repo, request.number)).toEqual({ status: "merged", mergedAt: null, headSha: request.headSha });
    git(["update-ref", "-d", `refs/heads/${request.branch}`], bare);
    expect((await forge.status!(repo, request.number)).status).toBe("merged");
  });

  it("given the branch deleted without being merged, when its state is read, then it is closed", async () => {
    const { forge, repo, bare, request } = await opened();
    git(["update-ref", "-d", `refs/heads/${request.branch}`], bare);
    expect(await forge.status!(repo, request.number)).toEqual({ status: "closed", mergedAt: null });
  });

  it("given the request's own branch checked out in the person's copy, when its state is read, then it is open, not merged into itself", async () => {
    const { forge, repo, bare, request } = await opened();
    git(["symbolic-ref", "HEAD", `refs/heads/${request.branch}`], bare);
    expect((await forge.status!(repo, request.number)).status).toBe("open");
  });
});

describe("merging only the head that was checked", () => {
  const IDENTITY = ["-c", "user.name=Stand In", "-c", "user.email=stand-in@example.invalid"];
  const by = { name: "Ada Example", email: "ada@example.invalid" };

  it("given a request whose branch is at the head last checked, when it is merged with that head, then that commit merges into the default branch", async () => {
    const { root, repo, bare } = await fixture();
    const opened = await createLocalForge(join(root, "work"), { nextNumber: async () => 1 }).open(repo, change(bare));

    const merged = await inLocalTurn(repo, () => mergeLocalBranch(join(root, "work"), repo, opened.branch, by, opened.headSha));

    expect(git(["rev-parse", "main"], bare).trim()).toBe(merged);
    expect(git(["rev-parse", `${merged}^2`], bare).trim()).toBe(opened.headSha);
  });

  it("given a push to the branch after its head was checked, when it is merged with the checked head, then it is refused and the default branch stays where it was", async () => {
    const { root, repo, bare } = await fixture();
    const opened = await createLocalForge(join(root, "work"), { nextNumber: async () => 1 }).open(repo, change(bare));
    const main = git(["rev-parse", "main"], bare).trim();
    const pushed = git([...IDENTITY, "commit-tree", `${opened.headSha}^{tree}`, "-p", opened.headSha, "-m", "pushed after the check"], bare).trim();
    git(["update-ref", `refs/heads/${opened.branch}`, pushed], bare);

    await expect(inLocalTurn(repo, () => mergeLocalBranch(join(root, "work"), repo, opened.branch, by, opened.headSha))).rejects.toThrow("the branch moved since it was checked; it is checked again before it merges");
    expect(git(["rev-parse", "main"], bare).trim()).toBe(main);
  });
});

