import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runGit, skeletonFiles } from "./init.js";
import type { GitRunner, TeamConfig } from "./init.js";
import {
  PLUGIN_MANIFEST,
  formatUpgradeResult,
  mergeMarketplaceManifest,
  applyUpgrade,
  countStaleSkeleton,
  formatUpgradePlan,
  isTeamOwned,
  mergePluginManifest,
  planUpgrade,
  refreshable,
  upgradeCandidates,
} from "./upgrade.js";

// Every case here drives real git against a real bare repository, because the thing under
// test is what lands in a team's remote and a stubbed runner cannot answer that. Measured
// on this file alone: 50 cases in 21s, so roughly 420ms each - comfortably inside vitest's
// 5s default when the machine is idle, and past it when the rest of the suite is running
// its own clones in parallel. The timeout is raised for this file rather than the cases
// being weakened, because a case that times out under load has measured nothing.
vi.setConfig({ testTimeout: 30_000 });

let temps: string[];

beforeEach(() => {
  temps = [];
});

afterEach(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function writeAll(dir: string, files: Record<string, string>): void {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
}

/**
 * A team handbook as it exists in the wild: a scaffold from some earlier version, plus
 * the team's own approved content sitting beside it.
 *
 * `files` is built from the remote's own path rather than passed in, because the skeleton
 * writes that URL into the README it generates - a fixture seeded against a stand-in URL
 * would read as stale on a repository that is current, and the "nothing to refresh" case
 * would pass for the wrong reason.
 */
function handbookRepo(files: (remote: string) => Record<string, string>, branch = "main"): string {
  const remote = temp("handbook-remote-");
  execFileSync("git", ["init", "--bare", "-b", branch, remote]);
  const seed = temp("handbook-seed-");
  execFileSync("git", ["-C", seed, "init", "-b", branch]);
  writeAll(seed, files(remote));
  execFileSync("git", ["-C", seed, "add", "-A"]);
  execFileSync("git", ["-C", seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "seed"]);
  execFileSync("git", ["-C", seed, "push", remote, branch]);
  return remote;
}

/** The same, for a fixture whose contents do not depend on where the remote lives. */
function staticHandbookRepo(files: Record<string, string>): string {
  return handbookRepo(() => files);
}

const TEAM_CONTENT = {
  "skills/deploy-service/SKILL.md": "# deploy-service\n\nthe team's own skill\n",
  "skills/deploy-service/grounded-case.json": '{"case":"real"}\n',
  ".mcp.json": '{"mcpServers":{"notion":{"command":"notion-mcp"}}}\n',
  "commands/triage.md": "---\ndescription: the team's own command\n---\n\ntriage\n",
  "agents/reviewer.md": "the team's own agent\n",
};

function currentScaffold(team: TeamConfig, withCi = false): Record<string, string> {
  return skeletonFiles(team.marketplaceName, team.repoUrl, null, team.commitPrefix?.trim() ?? "", withCi);
}

/** A founder's config: this machine ran /handbook:init, so an absent commitPrefix is the
 * fact "no prefix" rather than the gap "nobody here knows". */
function teamFor(remote: string, extra: Partial<TeamConfig> = {}): TeamConfig {
  return { repoUrl: remote, marketplaceName: "acme-skills", initializedAt: "2026-01-01T00:00:00Z", ...extra };
}

/** A teammate's config, exactly as `joinTeamRepo` writes it: the repository and the
 * marketplace name, and no prefix of any kind. */
function joinerFor(remote: string): TeamConfig {
  return { repoUrl: remote, marketplaceName: "acme-skills", joinedAt: "2026-02-02T00:00:00Z" };
}

/** A handbook whose scaffold is exactly what this version writes. */
function currentHandbookRepo(): string {
  return handbookRepo((remote) => ({ ...currentScaffold(teamFor(remote)), ...TEAM_CONTENT }));
}

/** Real git for everything the flow actually does, with a fixed identity so the commit
 * author does not depend on whoever runs the suite. */
const gitWithIdentity: GitRunner = (args, cwd) => {
  if (args[0] === "config") return args[1] === "user.name" ? "Dev" : "dev@acme.com";
  return runGit(args, cwd);
};

const noForge = () => {
  const err = new Error("spawn gh ENOENT") as Error & { code: string };
  err.code = "ENOENT";
  throw err;
};

function tree(remote: string, ref: string): string {
  return execFileSync("git", ["-C", remote, "ls-tree", "-r", "--name-only", ref], { encoding: "utf8" });
}

function show(remote: string, ref: string, path: string): string {
  return execFileSync("git", ["-C", remote, "show", `${ref}:${path}`], { encoding: "utf8" });
}

function heads(remote: string): string {
  return execFileSync("git", ["-C", remote, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"], {
    encoding: "utf8",
  });
}

describe("isTeamOwned", () => {
  it("given the paths the red line names, when each is tested, then every one is the team's", () => {
    for (const path of ["skills/README.md", "skills/a/SKILL.md", "commands/x.md", "agents/y.md", ".mcp.json"]) {
      expect(isTeamOwned(path), path).toBe(true);
    }
    for (const path of ["README.md", "hooks/notice.mjs", PLUGIN_MANIFEST, "scripts/bump-version.mjs"]) {
      expect(isTeamOwned(path), path).toBe(false);
    }
  });
});

describe("upgradeCandidates", () => {
  it("given today's skeleton, when the refreshable set is built, then nothing the team owns is in it", () => {
    const repoDir = temp("handbook-repo-");
    const team = teamFor("git@gitlab.acme.com:team/skills.git");
    writeAll(repoDir, { ...currentScaffold(team), ...TEAM_CONTENT });

    const candidates = upgradeCandidates(repoDir, team).files;

    expect(Object.keys(candidates).length).toBeGreaterThan(0);
    for (const path of Object.keys(candidates)) expect(isTeamOwned(path), path).toBe(false);
    // skills/README.md is the skeleton's own file, and it still stays out: the boundary is
    // the directory, so a later skeleton file put there cannot slip through either.
    expect(candidates["skills/README.md"]).toBeUndefined();
  });

  it("given a repository without the CI marker, when the skeleton is regenerated, then no CI file is offered", () => {
    const repoDir = temp("handbook-repo-");
    const team = teamFor("git@gitlab.acme.com:team/skills.git");
    // a pipeline the team keeps for their own reasons, which must not read as "--with-ci"
    writeAll(repoDir, { ...currentScaffold(team), ".gitlab-ci.yml": "stages: [test]\n" });

    const candidates = upgradeCandidates(repoDir, team).files;

    expect(candidates[".gitlab-ci.yml"]).toBeUndefined();
    expect(candidates["scripts/bump-version.mjs"]).toBeUndefined();
  });

  it("given a repository initialized with CI, when the skeleton is regenerated, then the CI files come with it", () => {
    const repoDir = temp("handbook-repo-");
    const team = teamFor("git@gitlab.acme.com:team/skills.git");
    writeAll(repoDir, currentScaffold(team, true));

    const candidates = upgradeCandidates(repoDir, team).files;

    expect(candidates["scripts/bump-version.mjs"]).toBeDefined();
    expect(candidates[".gitlab-ci.yml"]).toBeDefined();
  });

  it("given a commit prefix in the config, when the CI job is regenerated, then it matches what init wrote", () => {
    const repoDir = temp("handbook-repo-");
    // init passed the prefix to skeletonFiles RAW while saving it trimmed; reading it back
    // through teamCommitPrefix would add a space and report a current CI file as stale.
    const team = teamFor("git@gitlab.acme.com:team/skills.git", { commitPrefix: "TEAM-1" });
    writeAll(repoDir, currentScaffold(team, true));

    const files = countStaleSkeleton(repoDir, team);

    expect(files).toEqual({ absent: 0, differs: 0 });
  });
});

describe("mergePluginManifest", () => {
  const fresh = JSON.stringify({ name: "acme-skills", description: "today", version: "0.1.0" }, null, 2) + "\n";

  it("given a repository at a later version, when the manifest is refreshed, then that version survives", () => {
    const existing = JSON.stringify({ name: "acme-skills", description: "old", version: "0.3.4" }, null, 2) + "\n";

    const merged = JSON.parse(mergePluginManifest(existing, fresh)!);

    expect(merged.version).toBe("0.3.4");
    expect(merged.description).toBe("today");
  });

  it("given fields the team added themselves, when the manifest is refreshed, then they are still there", () => {
    const existing =
      JSON.stringify({ name: "acme-skills", version: "0.3.4", author: { name: "Platform" }, homepage: "x" }, null, 2) +
      "\n";

    const merged = JSON.parse(mergePluginManifest(existing, fresh)!);

    expect(merged).toMatchObject({ version: "0.3.4", author: { name: "Platform" }, homepage: "x" });
  });

  it("given a manifest that was refreshed once, when it is refreshed again, then the bytes do not move", () => {
    const existing = JSON.stringify({ name: "acme-skills", description: "old", version: "0.3.4" }, null, 2) + "\n";

    const once = mergePluginManifest(existing, fresh)!;

    expect(mergePluginManifest(once, fresh)).toBe(once);
  });

  it("given a manifest that is not valid JSON, when it is refreshed, then it is dropped rather than guessed", () => {
    expect(mergePluginManifest("{ not json", fresh)).toBeNull();
  });

  it("given a repository with no manifest at all, when it is refreshed, then the scaffold's is offered whole", () => {
    expect(mergePluginManifest(null, fresh)).toBe(fresh);
  });
});

describe("planUpgrade", () => {
  it("given a repository already at this version, when it is planned, then there is nothing to refresh", () => {
    // the remote's own URL is baked into the generated README, so the fixture is seeded
    // with the skeleton that URL produces rather than a stand-in
    const remote = currentHandbookRepo();

    const plan = planUpgrade(teamFor(remote));

    expect(plan.ok).toBe(true);
    // an empty verdict is only worth something if files were actually compared: a filter
    // that let nothing through would report "nothing to refresh" in exactly the same words
    expect(plan.files!.length).toBeGreaterThanOrEqual(4);
    expect(refreshable(plan.files!)).toEqual([]);
    expect(formatUpgradePlan(plan)).toContain("Nothing to refresh");
  });

  it("given a scaffold from an older version, when it is planned, then the files behind are named and diffed", () => {
    const remote = staticHandbookRepo({
      ".claude-plugin/marketplace.json": '{"name":"acme-skills"}\n',
      [PLUGIN_MANIFEST]: '{\n  "name": "acme-skills",\n  "version": "0.3.4"\n}\n',
      "README.md": "# acme-skills\n\nan older, much shorter readme\n",
      ...TEAM_CONTENT,
    });
    const team = teamFor(remote);

    const plan = planUpgrade(team);

    expect(plan.ok).toBe(true);
    const states = new Map(plan.files!.map((file) => [file.path, file.state]));
    // grown in place
    expect(states.get("README.md")).toBe("differs");
    expect(states.get(".claude-plugin/marketplace.json")).toBe("differs");
    // shipped by a version later than the one that scaffolded this repository
    expect(states.get("hooks/notice.mjs")).toBe("absent");
    expect(states.get("hooks/hooks.json")).toBe("absent");
    expect(plan.diff).toContain("hooks/notice.mjs");
    expect(plan.diff).toContain("README.md");
    expect(plan.version).toEqual({ current: "0.3.4", next: "0.3.5" });
  });

  it("given a plan is taken, when it finishes, then not one byte of the repository moved", () => {
    const remote = staticHandbookRepo({
      ".claude-plugin/marketplace.json": '{"name":"acme-skills"}\n',
      "README.md": "# acme-skills\n",
      ...TEAM_CONTENT,
    });
    const before = heads(remote);

    const plan = planUpgrade(teamFor(remote));

    expect(refreshable(plan.files!).length).toBeGreaterThan(0);
    // the commit every branch points at, so a new branch or a rewritten one both show
    expect(heads(remote)).toBe(before);
  });

  it("given a repository that was never scaffolded as a handbook, when it is planned, then it refuses", () => {
    const remote = staticHandbookRepo({ "README.md": "someone else's repo\n" });

    const plan = planUpgrade(teamFor(remote));

    expect(plan.ok).toBe(false);
    expect(plan.error).toContain("not a handbook");
  });

  it("given a manifest that is not valid JSON, when it is planned, then it is reported skipped, not rewritten", () => {
    const remote = staticHandbookRepo({
      ".claude-plugin/marketplace.json": '{"name":"acme-skills"}\n',
      [PLUGIN_MANIFEST]: "{ not json\n",
      ...TEAM_CONTENT,
    });

    const plan = planUpgrade(teamFor(remote));

    expect(plan.unreadable).toEqual([PLUGIN_MANIFEST]);
    expect(plan.files!.some((file) => file.path === PLUGIN_MANIFEST)).toBe(false);
    expect(formatUpgradePlan(plan)).toContain("could not be read");
  });
});

describe("applyUpgrade", () => {
  function staleRepo(): string {
    return staticHandbookRepo({
      ".claude-plugin/marketplace.json": '{"name":"acme-skills"}\n',
      [PLUGIN_MANIFEST]: '{\n  "name": "acme-skills",\n  "version": "0.3.4",\n  "author": {\n    "name": "Platform"\n  }\n}\n',
      "README.md": "# acme-skills\n\nan older, much shorter readme\n",
      "hooks/notice.mjs": "// the team edited this by hand\nconsole.log('ours');\n",
      ...TEAM_CONTENT,
    });
  }

  it("given nothing is named, when a refresh is asked for, then nothing is written and nothing is pushed", () => {
    const remote = staleRepo();
    const before = heads(remote);

    const result = applyUpgrade(teamFor(remote), [], gitWithIdentity, noForge);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("no file was named");
    expect(heads(remote)).toBe(before);
  });

  it("given one file is named, when it is refreshed, then only that file is in the request", () => {
    const remote = staleRepo();

    const result = applyUpgrade(teamFor(remote), ["README.md"], gitWithIdentity, noForge);

    expect(result).toMatchObject({ ok: true, branch: "handbook/refresh-scaffold", refreshed: ["README.md"] });
    expect(show(remote, result.branch!, "README.md")).toContain("/handbook:join");
    // the file a team is most likely to have edited was not named, so it is untouched
    expect(show(remote, result.branch!, "hooks/notice.mjs")).toBe("// the team edited this by hand\nconsole.log('ours');\n");
  });

  it("given a refresh is sent, when the manifest is written, then the team's version is raised, never reset", () => {
    const remote = staleRepo();

    const result = applyUpgrade(teamFor(remote), [PLUGIN_MANIFEST, "README.md"], gitWithIdentity, noForge);

    const plugin = JSON.parse(show(remote, result.branch!, PLUGIN_MANIFEST));
    expect(plugin.version).toBe("0.3.5");
    expect(plugin.author).toEqual({ name: "Platform" });
    expect(result.version).toBe("0.3.5");
  });

  it("given a refresh is sent, when the branch is read, then the team's own content is byte-identical", () => {
    const remote = staleRepo();

    const result = applyUpgrade(
      teamFor(remote),
      ["README.md", "hooks/notice.mjs", "hooks/hooks.json", PLUGIN_MANIFEST],
      gitWithIdentity,
      noForge,
    );

    for (const [path, body] of Object.entries(TEAM_CONTENT)) {
      expect(show(remote, result.branch!, path), path).toBe(body);
    }
  });

  it("given a path the skeleton never produces, when it is named, then it is refused and nothing is pushed", () => {
    const remote = staleRepo();
    const before = heads(remote);

    for (const path of ["skills/deploy-service/SKILL.md", ".mcp.json", "commands/triage.md", "../escape"]) {
      const result = applyUpgrade(teamFor(remote), [path], gitWithIdentity, noForge);

      expect(result.ok, path).toBe(false);
      expect(result.error, path).toContain("not a scaffold file");
    }
    expect(heads(remote)).toBe(before);
  });

  it("given a file already at this version, when it is named, then it is refused rather than committed empty", () => {
    const remote = currentHandbookRepo();

    const result = applyUpgrade(teamFor(remote), ["README.md"], gitWithIdentity, noForge);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("already matches this version");
  });

  it("given the default branch, when a refresh is sent, then the request waits and the branch is untouched", () => {
    const remote = staleRepo();
    const mainBefore = show(remote, "main", "README.md");

    const result = applyUpgrade(teamFor(remote), ["README.md"], gitWithIdentity, noForge);

    expect(show(remote, "main", "README.md")).toBe(mainBefore);
    expect(tree(remote, "main")).not.toContain("hooks/hooks.json");
    // no forge CLI on a test machine, so the link to open it by hand is what comes back
    expect(result.prUrl).toBeUndefined();
    expect(result.prError).toContain("not installed");
  });

  it("given a repository that was never scaffolded as a handbook, when a refresh is sent, then nothing is pushed", () => {
    const remote = staticHandbookRepo({ "README.md": "someone else's repo\n" });
    const before = heads(remote);

    const result = applyUpgrade(teamFor(remote), ["README.md"], gitWithIdentity, noForge);

    expect(result.ok).toBe(false);
    expect(heads(remote)).toBe(before);
  });

  it("given a branch prefix the team's forge requires, when a refresh is sent, then the branch carries it", () => {
    const remote = staleRepo();

    const result = applyUpgrade(
      teamFor(remote, { branchPrefix: "TEAM-1-" }),
      ["README.md"],
      gitWithIdentity,
      noForge,
    );

    expect(result.branch).toBe("TEAM-1-refresh-scaffold");
  });
});

describe("a scaffold path the team repository ignores", () => {
  /** A handbook whose own .gitignore keeps a scaffold path out. `git add -A` obeys it, so
   * the file is written, silently left out of the commit, and would otherwise be reported
   * as refreshed. */
  function repoIgnoring(pattern: string): string {
    return staticHandbookRepo({
      ".gitignore": `${pattern}\n`,
      ".claude-plugin/marketplace.json": '{"name":"acme-skills"}\n',
      "README.md": "# acme-skills\n",
      ...TEAM_CONTENT,
    });
  }

  it("given the ignore rule, when a refresh is sent, then it refuses instead of reporting a file it dropped", () => {
    const remote = repoIgnoring("hooks/");
    const before = heads(remote);

    const result = applyUpgrade(teamFor(remote), ["hooks/hooks.json", "README.md"], gitWithIdentity, noForge);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("hooks/hooks.json");
    expect(result.error).toContain(".gitignore");
    expect(heads(remote)).toBe(before);
  });

  it("given the ignore rule, when the plan is printed, then it says the diff under-reports", () => {
    const remote = repoIgnoring("hooks/");

    const plan = planUpgrade(teamFor(remote));

    expect(plan.ignored).toContain("hooks/hooks.json");
    expect(formatUpgradePlan(plan)).toContain("WARNING");
  });

  it("given an ignore rule that touches nothing in the refresh, when it is sent, then it goes through", () => {
    const remote = repoIgnoring("node_modules/");

    const result = applyUpgrade(teamFor(remote), ["README.md"], gitWithIdentity, noForge);

    expect(result.ok).toBe(true);
  });
});

describe("a scaffold path the repository commits as a symbolic link", () => {
  /** A handbook that commits `README.md` as a link to a file outside it. git stores this
   * as mode 120000 and a clone materializes a real link, so an ordinary writeFileSync on
   * that path writes to the link's TARGET - outside the repository entirely. */
  function repoLinking(scaffoldPath: string, victim: string): string {
    const remote = temp("handbook-remote-");
    execFileSync("git", ["init", "--bare", "-b", "main", remote]);
    const seed = temp("handbook-seed-");
    execFileSync("git", ["-C", seed, "init", "-b", "main"]);
    writeAll(seed, {
      ".claude-plugin/marketplace.json": '{"name":"acme-skills"}\n',
      [PLUGIN_MANIFEST]: '{"name":"acme-skills","version":"0.3.4"}\n',
      ...TEAM_CONTENT,
    });
    mkdirSync(dirname(join(seed, scaffoldPath)), { recursive: true });
    symlinkSync(victim, join(seed, scaffoldPath));
    execFileSync("git", ["-C", seed, "add", "-A"]);
    execFileSync("git", ["-C", seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "seed"]);
    execFileSync("git", ["-C", seed, "push", remote, "main"]);
    return remote;
  }

  it("given the link, when the plan runs, then the file it points at is not touched", () => {
    const outside = temp("handbook-victim-");
    const victim = join(outside, "shell-rc");
    writeFileSync(victim, "# the reader's own file\n");
    const remote = repoLinking("README.md", victim);

    const plan = planUpgrade(teamFor(remote));

    expect(readFileSync(victim, "utf8")).toBe("# the reader's own file\n");
    expect(plan.linked?.map((file) => file.path)).toEqual(["README.md"]);
    expect(plan.files!.some((file) => file.path === "README.md")).toBe(false);
    expect(formatUpgradePlan(plan)).toContain("NOT OFFERED");
  });

  it("given a DIRECTORY on the path is the link, when the plan runs, then nothing is created inside it", () => {
    const outside = temp("handbook-victim-");
    writeFileSync(join(outside, "keep.txt"), "mine\n");
    const remote = repoLinking("hooks", outside);

    const plan = planUpgrade(teamFor(remote));

    expect(readdirSync(outside)).toEqual(["keep.txt"]);
    expect(plan.linked?.map((file) => file.path).sort()).toEqual(["hooks/hooks.json", "hooks/notice.mjs"]);
  });

  it("given the link, when the path is named for a refresh, then it is refused and nothing is written", () => {
    const outside = temp("handbook-victim-");
    const victim = join(outside, "shell-rc");
    writeFileSync(victim, "# the reader's own file\n");
    const remote = repoLinking("README.md", victim);
    const before = heads(remote);

    const result = applyUpgrade(teamFor(remote), ["README.md"], gitWithIdentity, noForge);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("symbolic link");
    expect(readFileSync(victim, "utf8")).toBe("# the reader's own file\n");
    expect(heads(remote)).toBe(before);
  });

  it("given an ordinary repository, when the plan runs, then the working tree of the clone is untouched too", () => {
    const remote = staticHandbookRepo({
      ".claude-plugin/marketplace.json": '{"name":"acme-skills"}\n',
      "README.md": "# acme-skills\n",
      ...TEAM_CONTENT,
    });

    const plan = planUpgrade(teamFor(remote));

    // the diff is real, and it was produced without writing a byte into the repository
    expect(plan.diff).toContain("README.md");
    expect(plan.stat).toContain("README.md");
    expect(formatUpgradePlan(plan)).toContain("Nothing has been changed, in this repository or on this machine");
  });
});

describe("a machine that joined rather than initialized", () => {
  /** A handbook scaffolded WITH the version-bump CI and a commit prefix, so the CI job
   * embeds `TEAM-1` in the message it commits. */
  function repoWithPrefixedCi(): string {
    return handbookRepo((remote) => ({
      ...skeletonFiles("acme-skills", remote, null, "TEAM-1", true),
      ...TEAM_CONTENT,
    }));
  }

  it("given the founder's machine, when the plan runs, then the CI file is up to date", () => {
    const remote = repoWithPrefixedCi();

    const plan = planUpgrade(teamFor(remote, { commitPrefix: "TEAM-1" }));

    expect(refreshable(plan.files!)).toEqual([]);
  });

  it("given a teammate's machine, when the plan runs, then the CI file is withheld rather than offered", () => {
    const remote = repoWithPrefixedCi();

    const plan = planUpgrade(joinerFor(remote));

    // NOT "differs": on this machine the prefix is unknown, so regenerating it would
    // silently delete the team's own
    expect(refreshable(plan.files!)).toEqual([]);
    expect(plan.withheld?.map((file) => file.path)).toEqual([".gitlab-ci.yml"]);
    expect(formatUpgradePlan(plan)).toContain("commit-message prefix");
  });

  it("given a teammate names the withheld file anyway, when it is sent, then it is refused", () => {
    const remote = repoWithPrefixedCi();
    const before = heads(remote);

    const result = applyUpgrade(joinerFor(remote), [".gitlab-ci.yml"], gitWithIdentity, noForge);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("commit-message prefix");
    expect(heads(remote)).toBe(before);
  });

  it("given a teammate and a repository with no CI at all, when the plan runs, then nothing is withheld", () => {
    const remote = handbookRepo((remote) => ({ ...currentScaffold(teamFor(remote)), ...TEAM_CONTENT }));

    const plan = planUpgrade(joinerFor(remote));

    expect(plan.withheld).toBeUndefined();
    expect(refreshable(plan.files!)).toEqual([]);
  });
});

describe("mergeMarketplaceManifest", () => {
  const fresh =
    JSON.stringify(
      {
        name: "acme-skills",
        owner: { name: "acme-skills maintainers" },
        plugins: [{ name: "acme-skills", source: "./", description: "today's description" }],
      },
      null,
      2,
    ) + "\n";

  const teamsOwn =
    JSON.stringify(
      {
        name: "acme-skills",
        owner: { name: "Acme Platform Guild", email: "guild@acme.example" },
        plugins: [
          { name: "acme-skills", source: "./", description: "Acme approved skills" },
          { name: "acme-extra", source: "./extra", description: "a second plugin the team added" },
        ],
      },
      null,
      2,
    ) + "\n";

  it("given a second plugin the team added, when the manifest is refreshed, then it is still there", () => {
    const merged = JSON.parse(mergeMarketplaceManifest(teamsOwn, fresh)!);

    expect(merged.plugins).toHaveLength(2);
    expect(merged.plugins[1]).toEqual({
      name: "acme-extra",
      source: "./extra",
      description: "a second plugin the team added",
    });
  });

  it("given an owner the team wrote, when the manifest is refreshed, then it is not replaced", () => {
    const merged = JSON.parse(mergeMarketplaceManifest(teamsOwn, fresh)!);

    expect(merged.owner).toEqual({ name: "Acme Platform Guild", email: "guild@acme.example" });
  });

  it("given the scaffold's own entry, when the manifest is refreshed, then its description moves forward", () => {
    const merged = JSON.parse(mergeMarketplaceManifest(teamsOwn, fresh)!);

    expect(merged.plugins[0].description).toBe("today's description");
  });

  it("given a manifest that was refreshed once, when it is refreshed again, then the bytes do not move", () => {
    const once = mergeMarketplaceManifest(teamsOwn, fresh)!;

    expect(mergeMarketplaceManifest(once, fresh)).toBe(once);
  });

  it("given a manifest that is not valid JSON, when it is refreshed, then it is dropped rather than guessed", () => {
    expect(mergeMarketplaceManifest("{ not json", fresh)).toBeNull();
  });

  it("given a repository whose manifest has no plugins array, when it is refreshed, then the scaffold's is added", () => {
    const merged = JSON.parse(mergeMarketplaceManifest('{"name":"acme-skills"}\n', fresh)!);

    expect(merged.plugins).toHaveLength(1);
    expect(merged.name).toBe("acme-skills");
  });
});

describe("a marketplace the team extended", () => {
  it("given a second plugin and their own owner, when the manifest is refreshed, then both survive the push", () => {
    const remote = staticHandbookRepo({
      ".claude-plugin/marketplace.json":
        JSON.stringify(
          {
            name: "acme-skills",
            owner: { name: "Acme Platform Guild", email: "guild@acme.example" },
            plugins: [
              { name: "acme-skills", source: "./", description: "Acme approved skills" },
              { name: "acme-extra", source: "./extra", description: "a second plugin the team added" },
            ],
          },
          null,
          2,
        ) + "\n",
      [PLUGIN_MANIFEST]: '{"name":"acme-skills","version":"0.3.4"}\n',
      ...TEAM_CONTENT,
    });

    const result = applyUpgrade(
      teamFor(remote),
      [".claude-plugin/marketplace.json"],
      gitWithIdentity,
      noForge,
    );

    const manifest = JSON.parse(show(remote, result.branch!, ".claude-plugin/marketplace.json"));
    expect(manifest.plugins.map((p: { name: string }) => p.name)).toEqual(["acme-skills", "acme-extra"]);
    expect(manifest.owner).toEqual({ name: "Acme Platform Guild", email: "guild@acme.example" });
  });
});

describe("a plugin version the refresh cannot raise", () => {
  function repoAtVersion(version: string | null): string {
    return staticHandbookRepo({
      ".claude-plugin/marketplace.json": '{"name":"acme-skills"}\n',
      [PLUGIN_MANIFEST]: version === null ? '{"name":"acme-skills"}\n' : `{"name":"acme-skills","version":"${version}"}\n`,
      "README.md": "# acme-skills\n",
      ...TEAM_CONTENT,
    });
  }

  it.each(["abc", "1.2.3-beta", "0.3"])(
    "given the version %s, when the plan runs, then it says the raise cannot happen",
    (version) => {
      const plan = planUpgrade(teamFor(repoAtVersion(version)));

      expect(plan.version?.next).toBeUndefined();
      const text = formatUpgradePlan(plan);
      expect(text).toContain("cannot be");
      expect(text).not.toContain("it is raised");
    },
  );

  it("given a version that is not three parts, when a refresh is sent, then nothing invents one", () => {
    const remote = repoAtVersion("1.2.3-beta");

    const result = applyUpgrade(teamFor(remote), ["README.md"], gitWithIdentity, noForge);

    expect(result.ok).toBe(true);
    expect(result.version).toBeUndefined();
    expect(result.versionNotRaised).toContain("1.2.3-beta");
    expect(JSON.parse(show(remote, result.branch!, PLUGIN_MANIFEST)).version).toBe("1.2.3-beta");
    expect(formatUpgradeResult(result)).toContain("NOT raised");
  });

  it("given no version field at all, when a refresh is sent, then the manifest the reader declined is unchanged", () => {
    const remote = repoAtVersion(null);

    const result = applyUpgrade(teamFor(remote), ["README.md"], gitWithIdentity, noForge);

    // the old shape wrote 0.1.1 into a file nobody selected, and said nothing about it
    expect(show(remote, result.branch!, PLUGIN_MANIFEST)).toBe('{"name":"acme-skills"}\n');
    expect(result.versionNotRaised).toContain("declares no version");
  });
});

describe("countStaleSkeleton", () => {
  it("given an older scaffold, when the doctor counts it, then absent and differing files are separated", () => {
    const repoDir = temp("handbook-repo-");
    const team = teamFor("git@gitlab.acme.com:team/skills.git");
    writeAll(repoDir, {
      ...currentScaffold(team),
      "README.md": "an older, much shorter readme\n",
      ...TEAM_CONTENT,
    });
    rmSync(join(repoDir, "hooks", "notice.mjs"));

    expect(countStaleSkeleton(repoDir, team)).toEqual({ absent: 1, differs: 1 });
  });
});

describe("formatUpgradePlan", () => {
  it("given files to refresh, when the plan is printed, then the flags to send them are spelled out", () => {
    const remote = staticHandbookRepo({
      ".claude-plugin/marketplace.json": '{"name":"acme-skills"}\n',
      "README.md": "# acme-skills\n",
      ...TEAM_CONTENT,
    });

    const text = formatUpgradePlan(planUpgrade(teamFor(remote)));

    expect(text).toContain("--file README.md");
    expect(text).toContain("Nothing has been changed");
    expect(text).toContain("skills/, commands/, agents/ and .mcp.json");
    // a difference is never labelled as an upgrade, because nothing records that it is one
    expect(text).toContain("may be an old scaffold or an edit your team");
  });
});

describe("the refreshed scaffold", () => {
  it("given a refresh is merged, when the plan is taken again, then it reports nothing left to do", () => {
    const remote = staticHandbookRepo({
      ".claude-plugin/marketplace.json": '{"name":"acme-skills"}\n',
      [PLUGIN_MANIFEST]: '{\n  "name": "acme-skills",\n  "version": "0.3.4"\n}\n',
      "README.md": "# acme-skills\n",
      ...TEAM_CONTENT,
    });
    const team = teamFor(remote);
    const first = planUpgrade(team);

    const result = applyUpgrade(team, refreshable(first.files!), gitWithIdentity, noForge);
    execFileSync("git", ["-C", remote, "update-ref", "refs/heads/main", `refs/heads/${result.branch}`]);

    // the version moved with the merge, and that is the only thing left different
    const second = planUpgrade(team);
    expect(refreshable(second.files!)).toEqual([]);
    expect(second.version?.current).toBe("0.3.5");
  });
});
