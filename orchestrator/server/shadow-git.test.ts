import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { shadowChanges, shadowFile, shadowSnapshot, shadowUndo } from "./shadow-git.js";
import type { ShadowPlace } from "./shadow-git.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A plain folder in a home, its shadow in the orchestrator's data. */
function place(): ShadowPlace & { home: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "th-shadow-")));
  dirs.push(root);
  const home = join(root, "home");
  const folder = join(home, "notes");
  const dataDir = join(root, "data");
  mkdirSync(join(folder, "drafts"), { recursive: true });
  mkdirSync(dataDir);
  writeFileSync(join(folder, "todo.md"), "one\n");
  writeFileSync(join(folder, "drafts", "plan.md"), "plan\n");
  writeFileSync(join(folder, ".env"), "API_TOKEN=abc\n");
  return { home, folder, gitDir: join(dataDir, "shadow", "default", "notes"), where: { home, dataDir } };
}

const unwrap = <T>(v: T | { refused: string }): T => {
  if (v && typeof v === "object" && "refused" in v) throw new Error((v as { refused: string }).refused);
  return v as T;
};

describe("the record of a folder without git", () => {
  it("given a folder a task changes, when snapshots before and after are compared, then the changes read as a request's do, the shadow is in the data and nothing is written into the folder, and a secret file is listed by digest alone", async () => {
    // given
    const p = place();
    const before = unwrap(await shadowSnapshot(p, "before the task")).sha;
    writeFileSync(join(p.folder, "todo.md"), "one\ntwo\n");
    writeFileSync(join(p.folder, "new.md"), "new\n");
    rmSync(join(p.folder, "drafts", "plan.md"));
    writeFileSync(join(p.folder, ".env"), "API_TOKEN=changed\n");

    // when
    const after = unwrap(await shadowSnapshot(p, "after the task")).sha;
    const changes = await shadowChanges(p, before, after);
    const file = await shadowFile(p, before, after, "todo.md");

    // then
    if (typeof changes === "string" || !file || typeof file === "string") throw new Error("unread");
    expect(changes.files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ["drafts/plan.md", "deleted", 0, 1],
      ["new.md", "added", 1, 0],
      ["todo.md", "modified", 1, 0],
    ]);
    expect(changes.untracked).toEqual([{ path: ".env", status: "modified" }]);
    expect(file.patch).toContain("+two");
    expect(existsSync(join(p.folder, ".git"))).toBe(false);
    expect(statSync(p.gitDir).mode & 0o777).toBe(0o700);
  });

  it("given a task's changes and a file the person edited after it, when they are undone, then the task's are put back as they were and the person's edit is kept", async () => {
    // given
    const p = place();
    const before = unwrap(await shadowSnapshot(p, "before")).sha;
    writeFileSync(join(p.folder, "todo.md"), "one\ntask\n");
    writeFileSync(join(p.folder, "new.md"), "new\n");
    rmSync(join(p.folder, "drafts", "plan.md"));
    const after = unwrap(await shadowSnapshot(p, "after")).sha;
    writeFileSync(join(p.folder, "new.md"), "the person's own line\n");

    // when
    const undone = unwrap(await shadowUndo(p, before, after));

    // then
    expect(undone).toEqual({ undone: ["drafts/plan.md", "todo.md"], kept: ["new.md"] });
    expect(readFileSync(join(p.folder, "todo.md"), "utf8")).toBe("one\n");
    expect(readFileSync(join(p.folder, "drafts", "plan.md"), "utf8")).toBe("plan\n");
    expect(readFileSync(join(p.folder, "new.md"), "utf8")).toBe("the person's own line\n");
  });

  it("given a task that added a file two folders deep and one beside a file of its own in a new folder, and a folder that held a file before, when it is undone, then the folders it made are gone, one still holding the person's file stays, and the folder that was there stays", async () => {
    // given
    const p = place();
    const before = unwrap(await shadowSnapshot(p, "before")).sha;
    mkdirSync(join(p.folder, "skills", "handover"), { recursive: true });
    writeFileSync(join(p.folder, "skills", "handover", "SKILL.md"), "skill\n");
    mkdirSync(join(p.folder, "notes"));
    writeFileSync(join(p.folder, "notes", "task.md"), "task\n");
    writeFileSync(join(p.folder, "drafts", "extra.md"), "extra\n");
    const after = unwrap(await shadowSnapshot(p, "after")).sha;
    writeFileSync(join(p.folder, "notes", "mine.md"), "the person's\n");

    // when
    const undone = unwrap(await shadowUndo(p, before, after));

    // then
    expect(undone).toEqual({ undone: ["drafts/extra.md", "notes/task.md", "skills/handover/SKILL.md"], kept: [] });
    expect(existsSync(join(p.folder, "skills"))).toBe(false);
    expect(readFileSync(join(p.folder, "notes", "mine.md"), "utf8")).toBe("the person's\n");
    expect(existsSync(join(p.folder, "drafts", "plan.md"))).toBe(true);
  });

  it("given a task that renamed a file and made a script lose its executable mode, when it is undone, then the old file is back under its old name with its mode, and the new name is gone", async () => {
    // given
    const p = place();
    writeFileSync(join(p.folder, "run.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
    const before = unwrap(await shadowSnapshot(p, "before")).sha;
    renameSync(join(p.folder, "todo.md"), join(p.folder, "todo-old.md"));
    writeFileSync(join(p.folder, "run.sh"), "#!/bin/sh\necho changed\n");
    chmodSync(join(p.folder, "run.sh"), 0o644);
    const after = unwrap(await shadowSnapshot(p, "after")).sha;

    // when
    const undone = unwrap(await shadowUndo(p, before, after));

    // then
    expect(undone).toEqual({ undone: ["run.sh", "todo-old.md", "todo.md"], kept: [] });
    expect(readFileSync(join(p.folder, "todo.md"), "utf8")).toBe("one\n");
    expect(existsSync(join(p.folder, "todo-old.md"))).toBe(false);
    expect(statSync(join(p.folder, "run.sh")).mode & 0o777).toBe(0o755);
  });

  it("given a folder turned into a link after it was opened, one past the file limit and a link inside, when a snapshot is taken, then the first two are refused and the link is not recorded", async () => {
    // given
    const p = place();
    const elsewhere = join(p.home, "..", "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(join(elsewhere), join(p.folder, "outside-link"));
    const moved = { ...p, folder: join(p.home, "moved") };
    symlinkSync(p.folder, moved.folder);

    // when
    const linked = await shadowSnapshot(moved, "x");
    const kept = unwrap(await shadowSnapshot(p, "x")).sha;
    for (let i = 0; i < 5_001; i++) writeFileSync(join(p.folder, "drafts", `f${i}.md`), "x");
    const tooMany = await shadowSnapshot(p, "y");

    // then
    expect(linked).toMatchObject({ refused: expect.stringContaining("moved or became a link") });
    expect(kept).toMatch(/^[0-9a-f]{40}$/);
    expect(tooMany).toMatchObject({ refused: expect.stringContaining("over the 5000") });
  });
});
