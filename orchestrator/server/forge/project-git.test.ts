import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cloneRepository, cloneTarget, commitChanges, commitPreview, initRepository } from "./project-git.js";

const STAND_IN_TOKEN = "ghp_Qa1Ws2Ed3Rf4Tg5Yh6Uj7Ik8Ol9P0";
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A person's folder with a few files, one named like a secret and one holding one, and a .gitignore. */
function folder() {
  const root = mkdtempSync(join(tmpdir(), "project-git-"));
  const dir = join(root, "app");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "README.md"), "app\n");
  writeFileSync(join(dir, "src", "main.ts"), "export {};\n");
  writeFileSync(join(dir, ".env"), "PORT=3000\n");
  writeFileSync(join(dir, "src", "settings.ts"), `export const token = "${STAND_IN_TOKEN}";\n`);
  writeFileSync(join(dir, ".gitignore"), "build/\n");
  mkdirSync(join(dir, "build"));
  writeFileSync(join(dir, "build", "out.js"), "built\n");
  return { root, dir };
}

/** The person's identity, set in the folder as their own git config would hold it. */
const signed = (dir: string) => {
  git(dir, "config", "user.name", "Ada Lovelace");
  git(dir, "config", "user.email", "ada@example.invalid");
};

describe("making a folder a Git repository", () => {
  it("given a folder that is no repository, when it is made one, then git init alone runs: no file is added and nothing is committed; a second time it is refused", async () => {
    const { dir } = folder();

    await initRepository(dir);

    expect(existsSync(join(dir, ".git"))).toBe(true);
    expect(() => git(dir, "rev-parse", "--verify", "--quiet", "HEAD")).toThrow();
    expect(git(dir, "ls-files")).toBe("");
    await expect(initRepository(dir)).rejects.toThrow("this folder is a Git repository already");
  });
});

describe("committing a folder's changes", () => {
  it("given a new repository, when what a commit would take is read, then each file comes with its size, the ignored ones are left out, and a file named or holding like a secret is marked", async () => {
    const { dir } = folder();
    await initRepository(dir);

    const preview = await commitPreview(dir);

    expect(preview.first).toBe(true);
    expect(preview.files.map((f) => [f.path, f.status, f.secretLike]).sort()).toEqual([
      [".env", "added", true],
      [".gitignore", "added", false],
      ["README.md", "added", false],
      ["src/main.ts", "added", false],
      ["src/settings.ts", "added", true],
    ]);
    expect(preview.files.find((f) => f.path === "README.md")!.bytes).toBe(4);
  });

  it("given the person's message and the secret-like files left out, when committed, then those files alone go in, as the person, and what they had staged by hand besides does not", async () => {
    const { dir } = folder();
    await initRepository(dir);
    signed(dir);
    writeFileSync(join(dir, "notes.md"), "mine\n");
    git(dir, "add", "notes.md");

    const { headSha } = await commitChanges(dir, "Start app", [".env", "src/settings.ts", "notes.md"]);

    expect(git(dir, "log", "-1", "--format=%an|%cn|%s", headSha)).toBe("Ada Lovelace|Ada Lovelace|Start app");
    expect(git(dir, "ls-tree", "-r", "--name-only", headSha).split("\n").sort()).toEqual([".gitignore", "README.md", "src/main.ts"]);
    expect(git(dir, "diff", "--cached", "--name-only")).toBe("notes.md");
    expect((await commitPreview(dir)).first).toBe(false);
  });

  it("given a file holding a secret ticked, an empty or two-line message, nothing left to commit, or no name in the person's git, when committed, then each is refused and nothing is committed", async () => {
    const { dir } = folder();
    await initRepository(dir);

    await expect(commitChanges(dir, "Start app", [".env"])).rejects.toThrow(/src\/settings.ts looks like it holds a .*; leave it out of the commit/);
    await expect(commitChanges(dir, "  ", [])).rejects.toThrow("a commit has a message, one line long");
    await expect(commitChanges(dir, "Start\nmore", [])).rejects.toThrow("a commit has a message, one line long");
    await expect(commitChanges(dir, "Start app", [".env", "src/settings.ts", ".gitignore", "README.md", "src/main.ts"])).rejects.toThrow("nothing to commit");
    git(dir, "config", "user.name", "");
    git(dir, "config", "user.email", "");
    await expect(commitChanges(dir, "Start app", [".env", "src/settings.ts"])).rejects.toThrow(/your git has no user.name; set it with `git config --global user.name/);
    expect(() => git(dir, "rev-parse", "--verify", "--quiet", "HEAD")).toThrow();
  });

  it("given a folder that is no repository, when its changes are read or committed, then it says to make it one first", async () => {
    const { dir } = folder();
    await expect(commitPreview(dir)).rejects.toThrow("this folder is not a Git repository yet");
  });
});

describe("a folder whose own git settings run a program", () => {
  const settings: [string, string, string][] = [
    ["a clean filter", "filter.x.clean", "sh -c 'touch {marker}; cat'"],
    ["a signing program", "gpg.program", "sh -c 'touch {marker}'"],
    ["an included file", "include.path", "{marker}"],
    ["a diff driver", "diff.x.textconv", "sh -c 'touch {marker}'"],
    ["an ssh command", "core.sshCommand", "sh -c 'touch {marker}'"],
  ];
  for (const [what, key, value] of settings) {
    it(`given ${what} in the folder's .git/config, when its changes are read or committed, then it is refused and the program never runs`, async () => {
      const { root, dir } = folder();
      await initRepository(dir);
      signed(dir);
      const marker = join(root, "ran");
      git(dir, "config", key, value.replace("{marker}", marker));
      writeFileSync(join(dir, ".gitattributes"), "* filter=x diff=x\n");

      await expect(commitPreview(dir)).rejects.toThrow(/this folder's own git settings run a program \(.+\); commit in the folder yourself/);
      await expect(commitChanges(dir, "Start app", [".env", "src/settings.ts"])).rejects.toThrow(/run a program/);
      expect(existsSync(marker)).toBe(false);
    });
  }

  for (const [key, value] of [["core.worktree", ".."], ["core.bare", "true"]] as const) {
    it(`given ${key} in the folder's .git/config, when its changes are read or committed, then it is refused, so no file outside the folder goes in`, async () => {
      const { root, dir } = folder();
      await initRepository(dir);
      signed(dir);
      writeFileSync(join(root, "outside.txt"), "not the folder's\n");
      git(dir, "config", key, value);

      await expect(commitPreview(dir)).rejects.toThrow(new RegExp(`this folder's own git settings work on files outside it \\(${key.replace(".", "\\.")}\\); commit in the folder yourself`));
      await expect(commitChanges(dir, "Start app", [])).rejects.toThrow(/work on files outside it/);
    });
  }

  it("given a folder whose hooks path is set, as husky sets it, with a pre-commit hook, when committed, then the commit is made and the hook does not run", async () => {
    const { root, dir } = folder();
    await initRepository(dir);
    signed(dir);
    const marker = join(root, "hook-ran");
    mkdirSync(join(dir, ".husky"));
    writeFileSync(join(dir, ".husky", "pre-commit"), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    git(dir, "config", "core.hooksPath", ".husky");

    await commitChanges(dir, "Start app", [".env", "src/settings.ts"]);

    expect(existsSync(marker)).toBe(false);
    expect(git(dir, "log", "-1", "--format=%s")).toBe("Start app");
  });

  it("given a folder whose .git is a file leading to another repository, when its changes are read, then it is refused", async () => {
    const { root, dir } = folder();
    execFileSync("git", ["init", "--quiet", "--bare", join(root, "elsewhere.git")]);
    writeFileSync(join(dir, ".git"), `gitdir: ${join(root, "elsewhere.git")}\n`);

    await expect(commitPreview(dir)).rejects.toThrow("this folder's .git leads elsewhere; commit in the folder yourself");
  });
});

describe("cloning a repository into the person's folders", () => {
  it("given https and ssh addresses, when the clone's target is made, then it goes to ~/code/<name>, or the place given", () => {
    expect(cloneTarget("https://github.com/acme/skills.git", "/home/stand-in")).toEqual({ url: "https://github.com/acme/skills.git", into: "/home/stand-in/code/skills" });
    expect(cloneTarget("git@gitlab.com:acme/platform/api.git", "/home/stand-in").into).toBe("/home/stand-in/code/api");
    expect(cloneTarget("ssh://git@git.example.invalid:2222/acme/web", "/home/stand-in").into).toBe("/home/stand-in/code/web");
    expect(cloneTarget("https://github.com/acme/skills", "/home/stand-in", "/home/stand-in/work/skills").into).toBe("/home/stand-in/work/skills");
  });

  it("given a local path, ext::, git://, plain http, an option, a token in the address, or a name that is no folder name, when the target is made, then each is refused", () => {
    for (const url of ["file:///srv/repo.git", "ext::sh -c touch% /tmp/x", "git://github.com/acme/skills.git", "http://github.com/acme/skills.git", "--upload-pack=touch", "https://ada:tok@github.com/acme/skills.git", "/srv/repo.git"]) {
      expect(() => cloneTarget(url, "/home/stand-in")).toThrow(/a repository address over https or ssh/);
    }
    expect(() => cloneTarget("https://github.com/acme/.hidden.git", "/home/stand-in")).toThrow(/is not a folder name for the clone/);
  });

  it("given a place that exists, when a clone goes there, then it is refused and the folder is untouched; a clone that fails leaves no folder behind", async () => {
    const { root, dir } = folder();
    const bare = join(root, "origin.git");
    execFileSync("git", ["init", "--quiet", "--bare", bare]);

    await expect(cloneRepository(`file://${bare}`, dir, "file")).rejects.toThrow(/already exists; choose another place/);
    expect(existsSync(join(dir, "README.md"))).toBe(true);
    await expect(cloneRepository(`file://${join(root, "missing.git")}`, join(root, "code", "missing"), "file")).rejects.toThrow(/git did not clone it/);
    expect(existsSync(join(root, "code", "missing"))).toBe(false);
  });

  it("given a repository reachable by the protocols allowed, when it is cloned into a new place, then the place holds its files", async () => {
    const { root } = folder();
    const seed = join(root, "seed");
    mkdirSync(seed);
    git(seed, "init", "--quiet", "-b", "main");
    writeFileSync(join(seed, "SKILL.md"), "# Skill\n");
    git(seed, "add", ".");
    execFileSync("git", ["-c", "user.name=Stand In", "-c", "user.email=stand-in@example.invalid", "commit", "--quiet", "-m", "first"], { cwd: seed });

    await cloneRepository(`file://${seed}`, join(root, "code", "skills"), "file");

    expect(existsSync(join(root, "code", "skills", "SKILL.md"))).toBe(true);
  });
});
