import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatJoinSuccess, joinTeamRepo } from "./join.js";
import { initTeamRepo, loadTeamConfig, saveTeamConfig } from "./init.js";

let home: string;
let remote: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "handbook-test-"));
  remote = mkdtempSync(join(tmpdir(), "handbook-team-"));
  execFileSync("git", ["init", "--bare", "-b", "main", remote]);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(remote, { recursive: true, force: true });
});

function seedTeamRepo(): void {
  const championHome = mkdtempSync(join(tmpdir(), "handbook-champion-"));
  try {
    const result = initTeamRepo(remote, "acme-skills", championHome);
    if (!result.ok) throw new Error(result.error);
  } finally {
    rmSync(championHome, { recursive: true, force: true });
  }
}

import { cloneFailureReason } from "./git-errors.js";

describe("cloneFailureReason", () => {
  const url = "https://github.com/acme/handbook";

  it("given git could not ask for a password, when reported, then it names credentials, not the URL", () => {
    // verbatim from a teammate's first /handbook:join
    const err = new Error("fatal: could not read Username for 'https://github.com': terminal prompts disabled");

    const reason = cloneFailureReason(url, err, { ghInstalled: false, ghAuthenticated: false });

    expect(reason).toContain("no git credentials");
    expect(reason).toContain("normally a private repo");
    expect(reason).not.toContain("is the URL correct");
  });

  it("given the machine has no gh at all, when reported, then it says install it and sign in", () => {
    const err = new Error("fatal: could not read Username for 'https://github.com': terminal prompts disabled");

    const reason = cloneFailureReason(url, err, { ghInstalled: false, ghAuthenticated: false });

    expect(reason).toContain("brew install gh");
    expect(reason).toContain("your own terminal");
  });

  it("given gh is installed but signed out, when reported, then it does not tell them to install it again", () => {
    const err = new Error("fatal: could not read Username for 'https://github.com': terminal prompts disabled");

    const reason = cloneFailureReason(url, err, { ghInstalled: true, ghAuthenticated: false });

    expect(reason).toContain("installed but not signed in");
    expect(reason).not.toContain("brew install");
  });

  it("given gh is signed in already, when reported, then it points at the account rather than the tooling", () => {
    const err = new Error("fatal: could not read Username for 'https://github.com': terminal prompts disabled");

    const reason = cloneFailureReason(url, err, { ghInstalled: true, ghAuthenticated: true });

    expect(reason).toContain("probably not the one");
    expect(reason).toContain("gh auth status");
  });

  it("given an ssh url with no credentials, when reported, then it talks about keys, not gh", () => {
    const err = new Error("fatal: could not read Username for 'https://github.com': terminal prompts disabled");

    const reason = cloneFailureReason("git@github.com:acme/handbook.git", err, { ghInstalled: false, ghAuthenticated: false });

    expect(reason).toContain("ssh-keygen");
    expect(reason).not.toContain("brew install gh");
  });

  it("given ssh refused the key, when reported, then it says which key to register", () => {
    const reason = cloneFailureReason("git@github.com:acme/handbook.git", new Error("git@github.com: Permission denied (publickey)."));

    expect(reason).toContain("not registered on that host");
  });

  it("given the repo answers not-found, when reported, then it says a private repo looks identical to a typo", () => {
    const reason = cloneFailureReason(url, new Error("remote: Repository not found."));

    expect(reason).toContain("same way as a typo");
  });

  it("given an unrecognized failure, when reported, then git's own first line survives", () => {
    const reason = cloneFailureReason(url, new Error("fatal: something entirely new\nsecond line"));

    expect(reason).toContain("something entirely new");
    expect(reason).not.toContain("second line");
  });
});

describe("joinTeamRepo", () => {
  it("clones the team repo, reads the marketplace name, and records the team config", () => {
    seedTeamRepo();
    const result = joinTeamRepo(remote, home, undefined, "2026-08-08T03:00:00Z");
    expect(result).toMatchObject({ ok: true, name: "acme-skills", url: remote });
    expect(loadTeamConfig(home)).toEqual({
      repoUrl: remote,
      marketplaceName: "acme-skills",
      joinedAt: "2026-08-08T03:00:00Z",
    });
  });

  it("re-joining the same repo refreshes joinedAt and keeps initializedAt", () => {
    seedTeamRepo();
    saveTeamConfig(
      { repoUrl: remote, marketplaceName: "acme-skills", initializedAt: "2026-08-08T02:00:00Z" },
      home,
    );
    const result = joinTeamRepo(remote, home, undefined, "2026-08-08T03:00:00Z");
    expect(result.ok).toBe(true);
    expect(loadTeamConfig(home)).toEqual({
      repoUrl: remote,
      marketplaceName: "acme-skills",
      initializedAt: "2026-08-08T02:00:00Z",
      joinedAt: "2026-08-08T03:00:00Z",
    });
  });

  it("refuses to join a different repo while another team is configured", () => {
    saveTeamConfig({ repoUrl: "git@x.com:other/team.git", marketplaceName: "other" }, home);
    const result = joinTeamRepo(remote, home);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("already joined git@x.com:other/team.git");
    expect(loadTeamConfig(home)?.repoUrl).toBe("git@x.com:other/team.git");
  });

  it("fails without touching config when the clone fails, and says which failure it was", () => {
    const result = joinTeamRepo(join(remote, "does-not-exist"), home);
    expect(result.ok).toBe(false);
    // a path that is not there gets the not-found wording, not a generic clone error
    expect(result.error).toContain("is not there, or your account cannot see it");
    expect(loadTeamConfig(home)).toBeNull();
  });

  it("rejects a repo that is not a TeamHandbook marketplace", () => {
    const seed = mkdtempSync(join(tmpdir(), "handbook-seed-"));
    try {
      execFileSync("git", ["-C", seed, "init", "-b", "main"]);
      writeFileSync(join(seed, "README.md"), "just a repo");
      execFileSync("git", ["-C", seed, "add", "-A"]);
      execFileSync("git", ["-C", seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "seed"]);
      execFileSync("git", ["-C", seed, "push", remote, "main"]);
    } finally {
      rmSync(seed, { recursive: true, force: true });
    }
    const result = joinTeamRepo(remote, home);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("marketplace.json");
    expect(loadTeamConfig(home)).toBeNull();
  });

  it("requires a URL", () => {
    expect(joinTeamRepo("  ", home)).toMatchObject({ ok: false });
  });
});

describe("formatJoinSuccess", () => {
  it("prints the two built-in commands that finish the marketplace connection", () => {
    const text = formatJoinSuccess({ ok: true, name: "acme-skills", url: "git@x.com:a/b.git", home });
    expect(text).toContain("/plugin marketplace add git@x.com:a/b.git");
    expect(text).toContain("/plugin install acme-skills");
  });
});
