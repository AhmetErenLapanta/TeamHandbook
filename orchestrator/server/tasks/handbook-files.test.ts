import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { deleteOwnFile, digestOf, filePath, readForEditing, readOwnFile, writeOwnFile } from "./handbook-files.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function claudeDir(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "th-files-")));
  dirs.push(root);
  const dir = join(root, ".claude");
  mkdirSync(join(dir, "skills", "triage-notes"), { recursive: true });
  writeFileSync(join(dir, "skills", "triage-notes", "SKILL.md"), "---\nname: triage-notes\ndescription: d\n---\nOld steps.\n");
  return dir;
}

describe("the person's own skill and command files", () => {
  it("given a name with a dot-dot, a slash, a leading dash, a space or capitals, when its path is asked, then there is none", () => {
    for (const name of ["../settings", "a/b", "-rf", "two words", "Triage", "a::b", "a:"]) {
      expect(filePath("/home/.claude", name.includes(":") ? "command" : "skill", name)).toBeNull();
    }
    expect(filePath("/home/.claude", "command", "release:notes")).toBe("/home/.claude/commands/release/notes.md");
  });

  it("given an edit made on what the person read, when it is written, then the file holds it, and a second edit on the old digest is refused as changed", async () => {
    // given
    const dir = claudeDir();
    const read = await readOwnFile(dir, "skill", "triage-notes");
    const seen = read && "digest" in read ? read.digest : "";

    // when
    const first = await writeOwnFile(dir, "skill", "triage-notes", "---\nname: triage-notes\ndescription: d\n---\nNew steps.\n", seen);
    const second = await writeOwnFile(dir, "skill", "triage-notes", "another", seen);

    // then
    expect(first).toEqual({ digest: digestOf("---\nname: triage-notes\ndescription: d\n---\nNew steps.\n") });
    expect(readFileSync(join(dir, "skills", "triage-notes", "SKILL.md"), "utf8")).toContain("New steps.");
    expect(second).toEqual({ refused: "changed" });
  });

  it("given a new command, an existing name taken as new, text holding a token and text too large, when each is written, then only the new command lands", async () => {
    // given
    const dir = claudeDir();

    // when
    const fresh = await writeOwnFile(dir, "command", "standup", "---\ndescription: x\n---\nSay what you did.\n", null);
    const taken = await writeOwnFile(dir, "skill", "triage-notes", "x", null);
    const secret = await writeOwnFile(dir, "skill", "leaky", "token ghp_abcdefghijklmnopqrstuvwxyz0123456789", null);
    const large = await writeOwnFile(dir, "skill", "large", "x".repeat(70 * 1024), null);

    // then
    expect(fresh).toMatchObject({ digest: expect.any(String) });
    expect([taken, secret, large]).toEqual([{ refused: "exists" }, { refused: "looks-secret" }, { refused: "too-large" }]);
    expect(existsSync(join(dir, "skills", "leaky"))).toBe(false);
  });

  it("given a skill whose SKILL.md is a link out of the folder, when it is read, written or deleted, then each is refused and the outside file is untouched", async () => {
    // given
    const dir = claudeDir();
    const outside = join(dir, "..", "outside.md");
    writeFileSync(outside, "outside");
    mkdirSync(join(dir, "skills", "linked"), { recursive: true });
    symlinkSync(outside, join(dir, "skills", "linked", "SKILL.md"));

    // when
    const read = await readOwnFile(dir, "skill", "linked");
    const written = await writeOwnFile(dir, "skill", "linked", "replaced", digestOf("outside"));
    const deleted = await deleteOwnFile(dir, "skill", "linked", digestOf("outside"));

    // then
    expect([read, written, deleted]).toEqual([{ refused: "outside" }, { refused: "outside" }, { refused: "outside" }]);
    expect(readFileSync(outside, "utf8")).toBe("outside");
  });

  it("given a skill the person read, when it is deleted on that digest, then its folder goes, and a delete on a stale digest is refused", async () => {
    // given
    const dir = claudeDir();
    const read = await readOwnFile(dir, "skill", "triage-notes");
    const seen = read && "digest" in read ? read.digest : "";

    // when
    const stale = await deleteOwnFile(dir, "skill", "triage-notes", digestOf("something else"));
    const done = await deleteOwnFile(dir, "skill", "triage-notes", seen);

    // then
    expect(stale).toEqual({ refused: "changed" });
    expect(done).toEqual({ deleted: true });
    expect(existsSync(join(dir, "skills", "triage-notes"))).toBe(false);
  });

  it("given a skills folder that is a link out of the Claude folder, when a new skill is written, then it is refused and no folder is made outside", async () => {
    // given
    const root = realpathSync(mkdtempSync(join(tmpdir(), "th-files-link-")));
    dirs.push(root);
    const dir = join(root, ".claude");
    const outside = join(root, "elsewhere");
    mkdirSync(dir);
    mkdirSync(outside);
    symlinkSync(outside, join(dir, "skills"));

    // when
    const written = await writeOwnFile(dir, "skill", "fresh", "Steps.\n", null);

    // then
    expect(written).toEqual({ refused: "outside" });
    expect(existsSync(join(outside, "fresh"))).toBe(false);
  });

  it("given a new skill without frontmatter, one named apart from its folder and one in the plugin's form, when each is written, then only the last lands, whole, with nothing left beside it", async () => {
    // given
    const dir = claudeDir();

    // when
    const bare = await writeOwnFile(dir, "skill", "release-notes", "Write the notes.\n", null);
    const misnamed = await writeOwnFile(dir, "skill", "release-notes", "---\nname: other\ndescription: d\n---\nWrite the notes.\n", null);
    const good = await writeOwnFile(dir, "skill", "release-notes", "---\nname: release-notes\ndescription: When a release is cut\n---\nWrite the notes.\n", null);

    // then
    expect(bare).toMatchObject({ refused: "bad-format", detail: expect.stringContaining("frontmatter") });
    expect(misnamed).toMatchObject({ refused: "bad-format", detail: expect.stringContaining("has to match") });
    expect(good).toMatchObject({ digest: expect.any(String) });
    expect(readdirSync(join(dir, "skills", "release-notes"))).toEqual(["SKILL.md"]);
  });

  it("given a command of the person's that already holds a token, when it is opened for editing, then it is not given to the page", async () => {
    // given
    const dir = claudeDir();
    mkdirSync(join(dir, "commands"), { recursive: true });
    writeFileSync(join(dir, "commands", "deploy.md"), `Push with ${"gh" + "p_" + "a1".repeat(18)}.\n`);

    // when
    const opened = await readForEditing(dir, "command", "deploy");
    const plain = await readForEditing(dir, "skill", "triage-notes");

    // then
    expect(opened).toEqual({ refused: "looks-secret" });
    expect(plain).toMatchObject({ content: expect.stringContaining("Old steps.") });
  });

  it("given a command of the person's larger than the editor takes, when it is opened, then it is refused as too large and not read whole", async () => {
    // given
    const dir = claudeDir();
    mkdirSync(join(dir, "commands"), { recursive: true });
    writeFileSync(join(dir, "commands", "huge.md"), "x".repeat(200 * 1024));

    // when
    const opened = await readOwnFile(dir, "command", "huge");

    // then
    expect(opened).toEqual({ refused: "too-large" });
  });
});
