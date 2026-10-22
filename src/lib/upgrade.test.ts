import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runGit, saveTeamConfig, skeletonFiles, TEAM_PREFIX_FILE } from "./init.js";
import type { GitRunner, TeamConfig } from "./init.js";
import { productVersion } from "./plugin-root.js";
import { createGitLabRepo } from "./gitlab-fixture.js";
import {
  PLUGIN_MANIFEST,
  formatUpgradeResult,
  mergeMarketplaceManifest,
  mergeTeamFile,
  scaffoldVersionProblem,
  applyUpgrade as applyUpgradeDeciding,
  countStaleSkeleton,
  formatUpgradePlan,
  isTeamOwned,
  mergePluginManifest,
  planUpgrade,
  refreshable,
  upgradeCandidates,
} from "./upgrade.js";


/**
 * The answer every case below gives about its commit message, because none of them is
 * about the wording: a plain sentence of the user's own. It carries no team prefix, so the
 * cases that measure the prefix still measure it. Delegating instead would cost every one
 * of them a second run, since "you decide" has to name the proposal it was shown.
 */
const APPROVED = { message: "chore: the case under test" } as const;

/**
 * The two runs a refresh takes when the user confirms the branch it proposes: the first
 * shows the name and pushes nothing, the second names it back.
 */
type UpgradeArgs = Parameters<typeof applyUpgradeDeciding>;
function applyUpgrade(
  team: UpgradeArgs[0],
  paths: UpgradeArgs[1],
  git?: UpgradeArgs[2],
  forge?: UpgradeArgs[3],
  message: UpgradeArgs[4] = APPROVED,
  choice: UpgradeArgs[5] = {},
) {
  if (choice.branch !== undefined) return applyUpgradeDeciding(team, paths, git, forge, message, choice);
  const probe = applyUpgradeDeciding(team, paths, git, forge, message, choice);
  return !probe.ok && probe.proposedBranch
    ? applyUpgradeDeciding(team, paths, git, forge, message, { ...choice, branch: probe.proposedBranch })
    : probe;
}

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

  it("given a manifest with no version, when it is refreshed from one carrying 0.1.0, then no version comes back", () => {
    // given a repository versioned by commit
    const existing = JSON.stringify({ name: "acme-skills", description: "old" }, null, 2) + "\n";

    // when
    const merged = JSON.parse(mergePluginManifest(existing, fresh)!);

    // then the skeleton's number is not carried in: the old merge put 0.1.0 here
    expect(merged).not.toHaveProperty("version");
    expect(merged.description).toBe("today");
  });

  it("given a manifest at 0.1.5, when it is refreshed by commit, then the version line goes and the team's fields stay", () => {
    // given
    const existing = JSON.stringify({ name: "acme-skills", version: "0.1.5", author: { name: "Platform" } }, null, 2) + "\n";

    // when
    const merged = JSON.parse(mergePluginManifest(existing, fresh, true)!);

    // then
    expect(merged).not.toHaveProperty("version");
    expect(merged.author).toEqual({ name: "Platform" });
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

  it("given no decision about the commit message, when a refresh is sent, then nothing is pushed and the proposal comes back", () => {
    const remote = staleRepo();
    const before = heads(remote);

    // The imported function, not the delegating wrapper: the answer is what is under test.
    const result = applyUpgradeDeciding(teamFor(remote), ["README.md"], gitWithIdentity, noForge);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("commit message required");
    expect(result.proposedMessage).toBe("chore: refresh the team handbook scaffold");
    expect(heads(remote)).toBe(before);
  });

  it("given no way to open a merge request, when a refresh delegates the wording, then nothing is pushed", () => {
    // Same rule as every other path: "you decide" is an answer about the request, and a
    // machine that cannot open one has nothing to honour it at. Measured on the remote,
    // because the check has to run before the push rather than after it.
    const remote = staleRepo();
    const before = heads(remote);
    const probe = applyUpgradeDeciding(teamFor(remote), ["README.md"], gitWithIdentity, noForge);

    const result = applyUpgradeDeciding(teamFor(remote), ["README.md"], gitWithIdentity, noForge, {
      delegated: probe.proposalHash!,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("no merge request can be opened from this machine");
    expect(heads(remote)).toBe(before);
  });

  it("given a machine that is signed in, when a refresh delegates the wording, then it goes out carrying the proposal", () => {
    const remote = staleRepo();
    const signedInForge = (_tool: "gh" | "glab", args: string[]) =>
      args[0] === "auth" ? "Logged in to acme.example as dev" : "https://acme.example/mr/2";
    const probe = applyUpgradeDeciding(teamFor(remote), ["README.md"], gitWithIdentity, signedInForge);

    const result = applyUpgradeDeciding(
      teamFor(remote),
      ["README.md"],
      gitWithIdentity,
      signedInForge,
      { delegated: probe.proposalHash! },
      { branch: probe.proposedBranch! },
    );

    expect(result).toMatchObject({ ok: true, commitMessage: probe.proposedMessage, branch: "refresh-scaffold" });
  });

  it("given a message the user approved, when a refresh is sent, then the refresh commit carries it", () => {
    const remote = staleRepo();

    const result = applyUpgrade(teamFor(remote), ["README.md"], gitWithIdentity, noForge, {
      message: "chore: bring our scaffold up to date",
    });

    expect(result).toMatchObject({ ok: true, commitMessage: "chore: bring our scaffold up to date" });
    expect(formatUpgradeResult(result)).toContain("chore: bring our scaffold up to date");
  });

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

    expect(result).toMatchObject({ ok: true, branch: "refresh-scaffold", refreshed: ["README.md"] });
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

  /** The same repository as a handbook scaffolded before `.teamhandbook.json` existed:
   * the prefix is in the CI job and nowhere a reader can find it. */
  function oldRepoWithPrefixedCi(): string {
    return handbookRepo((remote) => {
      const files: Record<string, string> = {
        ...skeletonFiles("acme-skills", remote, null, "TEAM-1", true),
        ...TEAM_CONTENT,
      };
      delete files[TEAM_PREFIX_FILE];
      return files;
    });
  }

  it("given a teammate and a repository that records its prefix, when the plan runs, then the CI file is up to date rather than withheld", () => {
    const remote = repoWithPrefixedCi();

    const plan = planUpgrade(joinerFor(remote));

    // The config is empty on this machine, but the repository answers the question, and a
    // file regenerated FROM that answer cannot drop the prefix - which is the only thing
    // withholding ever protected against.
    expect(refreshable(plan.files!)).toEqual([]);
    expect(plan.withheld).toBeUndefined();
  });

  it("given a teammate and a repository that records nothing, when the plan runs, then the CI file is withheld rather than offered", () => {
    const remote = oldRepoWithPrefixedCi();

    const plan = planUpgrade(joinerFor(remote));

    // NOT "differs": neither this machine nor the repository knows the prefix, so
    // regenerating it would silently delete the team's own. The record file is withheld
    // for the same reason and it matters more: writing it from a machine that does not
    // know the answer would publish "no prefix" to every teammate who joins after.
    expect(refreshable(plan.files!)).toEqual([]);
    expect(plan.withheld?.map((file) => file.path).sort()).toEqual([".gitlab-ci.yml", TEAM_PREFIX_FILE]);
    expect(formatUpgradePlan(plan)).toContain("commit-message prefix");
  });

  it("given the founder and a repository that records nothing, when the plan runs, then the record is offered carrying their prefix", () => {
    const remote = oldRepoWithPrefixedCi();

    const plan = planUpgrade(teamFor(remote, { commitPrefix: "TEAM-1" }));

    // The backward route both refusal messages send the reader to. If this file were not
    // offered here, "run /handbook:init --upgrade" would be advice that does nothing.
    expect(refreshable(plan.files!)).toEqual([TEAM_PREFIX_FILE]);

    const result = applyUpgrade(teamFor(remote, { commitPrefix: "TEAM-1" }), [TEAM_PREFIX_FILE], gitWithIdentity, noForge);

    expect(result.ok).toBe(true);
    expect(JSON.parse(show(remote, result.branch!, TEAM_PREFIX_FILE)).commitPrefix).toBe("TEAM-1");
  });

  it("given a teammate names the withheld file anyway, when it is sent, then it is refused", () => {
    const remote = oldRepoWithPrefixedCi();
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
    expect(result.versionNotRaised).toBeUndefined();
  });
});

describe("a repository versioned by commit", () => {
  function versionlessRepo(): string {
    return handbookRepo((remote) => ({ ...currentScaffold(teamFor(remote)), "README.md": "# older\n", ...TEAM_CONTENT }));
  }

  it("given a manifest with no version, when the plan runs, then it is the normal state and no warning is printed", () => {
    // given
    const remote = versionlessRepo();

    // when
    const plan = planUpgrade(teamFor(remote));

    // then
    expect(plan.version).toEqual({ byCommit: true });
    const text = formatUpgradePlan(plan);
    expect(text).toContain("This repository is versioned by commit");
    expect(text).not.toContain("WARNING");
    expect(text).not.toContain("no teammate's copy will pick it up");
    // there is no version to carry across, so the sentence about what is carried does not name one
    expect(text).toContain("fields the team added, any extra plugins, the marketplace owner - are carried across");
    expect(text).not.toContain("plugin version, any extra plugins");
  });

  it("given a repository running the version-bump job with no plugin.json, when planned, then the plan names the version the file is sent with", () => {
    // given
    const remote = handbookRepo((url) => {
      const { [PLUGIN_MANIFEST]: _manifest, ...files } = currentScaffold(teamFor(url), true);
      return { ...files, ...TEAM_CONTENT };
    });

    // when
    const plan = planUpgrade(teamFor(remote));

    // then the plan and the file it would send say the same thing
    expect(plan.version?.blocked).toContain("adds it at 0.1.0, the version the repository's version-bump job raises from");
    expect(plan.version?.blocked).not.toContain("versioned by commit");
    expect(plan.diff).toContain('+  "version": "0.1.0"');
  });

  it("given a manifest with no version, when a refresh is sent, then the manifest keeps none and the result says the merge is the delivery", () => {
    // given
    const remote = versionlessRepo();
    const before = show(remote, "main", PLUGIN_MANIFEST);

    // when
    const result = applyUpgrade(teamFor(remote), ["README.md"], gitWithIdentity, noForge);

    // then
    expect(result).toMatchObject({ ok: true, versionedByCommit: true });
    expect(result.version).toBeUndefined();
    expect(result.versionNotRaised).toBeUndefined();
    expect(show(remote, result.branch!, PLUGIN_MANIFEST)).toBe(before);
    expect(JSON.parse(before)).not.toHaveProperty("version");
    expect(formatUpgradeResult(result)).toContain("versioned by commit, so the merge is what teammates update to");
  });
});

describe("switching a repository to versioning by commit", () => {
  /** Today's scaffold in a repository that still raises a number, as every repository
   * scaffolded before this did. */
  function versionedRepo(withCi = false): string {
    return handbookRepo((remote) => {
      const files = skeletonFiles("acme-skills", remote, null, "", withCi, undefined, {}, undefined, "0.1.5");
      const plugin = { ...JSON.parse(files[PLUGIN_MANIFEST]!), author: { name: "Platform" } };
      return {
        ...files,
        [PLUGIN_MANIFEST]: JSON.stringify(plugin, null, 2) + "\n",
        "README.md": "# older\n",
        ...TEAM_CONTENT,
      };
    });
  }

  it("given a repository at 0.1.5, when it is planned without the flag, then its version line stays and is raised as before", () => {
    // given
    const remote = versionedRepo();

    // when
    const plan = planUpgrade(teamFor(remote));

    // then
    expect(plan.files!.find((file) => file.path === PLUGIN_MANIFEST)?.state).toBe("current");
    expect(plan.version).toEqual({ current: "0.1.5", next: "0.1.6" });
    expect(formatUpgradePlan(plan)).not.toContain("switches the repository");
  });

  it("given the flag, when it is planned, then it says what the switch does to open requests, teammates and older copies", () => {
    // given
    const remote = versionedRepo();

    // when
    const plan = planUpgrade(teamFor(remote), undefined, undefined, { commitVersioning: true });

    // then
    expect(plan.version).toEqual({ current: "0.1.5", byCommit: true });
    expect(plan.files!.find((file) => file.path === PLUGIN_MANIFEST)?.state).toBe("differs");
    expect(plan.diff).toContain('-  "version": "0.1.5",');
    const text = formatUpgradePlan(plan);
    expect(text).toContain("This request switches the repository to versioning by commit");
    expect(text).toContain("Open requests that raise the version conflict with this commit");
    expect(text).toContain("/plugin marketplace update acme-skills");
    expect(text).toContain("/reload-plugins");
    expect(text).toContain("update TeamHandbook first");
    expect(text).toContain(`--file ${PLUGIN_MANIFEST}`);
    expect(text).toContain("--commit-versioning");
    expect(text).not.toContain("raises the plugin version");
    expect(text.split("\n")[0]).toContain("how every merge reaches teammates' copies");
  });

  it("given the flag, when the refresh is sent naming only the README, then the manifest joins it without a version and nothing is saved", () => {
    // given
    const remote = versionedRepo();
    const home = temp("handbook-home-");
    saveTeamConfig(teamFor(remote), home);
    const config = readFileSync(join(home, "config.json"), "utf8");
    vi.stubEnv("TEAMHANDBOOK_HOME", home);

    // when
    let result;
    try {
      result = applyUpgrade(teamFor(remote), ["README.md"], gitWithIdentity, noForge, APPROVED, { commitVersioning: true });
    } finally {
      vi.unstubAllEnvs();
    }

    // then
    expect(result).toMatchObject({ ok: true, versionLineRemoved: true, versionedByCommit: true });
    expect(result.refreshed).toContain(PLUGIN_MANIFEST);
    expect(result.version).toBeUndefined();
    const plugin = JSON.parse(show(remote, result.branch!, PLUGIN_MANIFEST));
    expect(plugin).not.toHaveProperty("version");
    expect(plugin.author).toEqual({ name: "Platform" });
    expect(show(remote, result.branch!, "README.md")).toContain("carries no version, so Claude Code versions the plugin");
    expect(formatUpgradeResult(result)).toContain("line taken out");
    expect(readFileSync(join(home, "config.json"), "utf8")).toBe(config);
  });

  it("given a repository already versioned by commit, when the flag is given, then it is refused and nothing is pushed", () => {
    // given
    const remote = handbookRepo((url) => ({ ...currentScaffold(teamFor(url)), ...TEAM_CONTENT }));
    const before = heads(remote);

    // when
    const plan = planUpgrade(teamFor(remote), undefined, undefined, { commitVersioning: true });
    const result = applyUpgrade(teamFor(remote), [], gitWithIdentity, noForge, APPROVED, { commitVersioning: true });

    // then
    expect(plan.error).toContain("already versioned by commit");
    expect(result.error).toContain("already versioned by commit");
    expect(heads(remote)).toBe(before);
  });

  it("given a repository running the version-bump job, when the flag is given, then it is refused because the job needs a version", () => {
    // given
    const remote = versionedRepo(true);

    // when
    const plan = planUpgrade(teamFor(remote), undefined, undefined, { commitVersioning: true });

    // then
    expect(plan.ok).toBe(false);
    expect(plan.error).toContain("runs the version-bump job");
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

    const signedIn = (_tool: "gh" | "glab", args: string[]) => (args[0] === "auth" ? "Logged in" : "");
    const text = formatUpgradePlan(planUpgrade(teamFor(remote), undefined, signedIn));

    expect(text).toContain("--file README.md");
    // The screen that asks which files to send is the screen that shows what the commit
    // will say, so the refresh never has to ask for the wording in a second round trip.
    expect(text).toContain('commits as "chore: refresh the team handbook scaffold"');
    expect(text).toContain("--delegate-message");
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

describe("a commit prefix given on the refresh", () => {
  /** A handbook scaffolded with the version-bump CI and the prefix TEAM-1, before the team
   * file existed: the prefix is in the CI job and nowhere a teammate can read it. The job
   * still glues the prefix on without a space, the way scaffolds of that age did, so it is
   * behind today's and has something to be offered for. */
  function preRecordRepo(): string {
    return handbookRepo((remote) => {
      const files: Record<string, string> = { ...skeletonFiles("acme-skills", remote, null, "TEAM-1", true), ...TEAM_CONTENT };
      delete files[TEAM_PREFIX_FILE];
      files[".gitlab-ci.yml"] = files[".gitlab-ci.yml"]!.replace("TEAM-1 ci:", "TEAM-1ci:");
      return files;
    });
  }

  it("given a teammate and a repository that records nothing, when the prefix is given, then the team file and the CI file are offered carrying it", () => {
    const remote = preRecordRepo();

    const plan = planUpgrade(joinerFor(remote), gitWithIdentity, noForge, { commitPrefix: "TEAM-1" });

    expect(plan.withheld).toBeUndefined();
    expect(refreshable(plan.files!)).toEqual([TEAM_PREFIX_FILE, ".gitlab-ci.yml"]);
    expect(plan.diff).toContain('+  "commitPrefix": "TEAM-1"');
    expect(plan.diff).toMatch(/^\+.*TEAM-1 ci: bump plugin version/m);
    const text = formatUpgradePlan(plan);
    expect(text).toContain(`--file ${TEAM_PREFIX_FILE} --file .gitlab-ci.yml --commit-prefix "TEAM-1"`);
    expect(text).toContain('commits as "TEAM-1 chore: refresh the team handbook scaffold"');
  });

  it("given the same teammate, when the run that sends carries the prefix, then the record and the commit carry it", () => {
    const remote = preRecordRepo();

    const result = applyUpgrade(joinerFor(remote), [TEAM_PREFIX_FILE], gitWithIdentity, noForge, APPROVED, {
      commitPrefix: "TEAM-1",
    });

    expect(result.ok).toBe(true);
    expect(JSON.parse(show(remote, result.branch!, TEAM_PREFIX_FILE)).commitPrefix).toBe("TEAM-1");
    expect(result.commitMessage).toBe("TEAM-1 chore: the case under test");
  });

  it("given a teammate with no prefix and a repository that records one, when a refresh is sent, then the commit carries the repository's", () => {
    const remote = handbookRepo((remote) => ({
      ...currentScaffold(teamFor(remote, { commitPrefix: "TEAM-1" })),
      "README.md": "# older\n",
    }));

    const result = applyUpgrade(joinerFor(remote), ["README.md"], gitWithIdentity, noForge);

    expect(result.commitMessage).toBe("TEAM-1 chore: the case under test");
  });

  it("given a repository recording TEAM-1 and a machine that says OTHER-9, when no prefix is given, then the repository's is kept", () => {
    const repoDir = temp("handbook-repo-");
    const founder = teamFor("git@gitlab.acme.com:team/skills.git", { commitPrefix: "TEAM-1" });
    writeAll(repoDir, currentScaffold(founder));
    const other = { ...joinerFor("git@gitlab.acme.com:team/skills.git"), commitPrefix: "OTHER-9" };

    const candidates = upgradeCandidates(repoDir, other);

    expect(JSON.parse(candidates.files[TEAM_PREFIX_FILE]!).commitPrefix).toBe("TEAM-1");
    expect(candidates.files[TEAM_PREFIX_FILE]).toBe(readFileSync(join(repoDir, TEAM_PREFIX_FILE), "utf8"));
  });

  it("given a repository recording TEAM-1, when another prefix is given, then the given one is what the file would say", () => {
    const repoDir = temp("handbook-repo-");
    writeAll(repoDir, currentScaffold(teamFor("git@gitlab.acme.com:team/skills.git", { commitPrefix: "TEAM-1" })));

    const candidates = upgradeCandidates(repoDir, joinerFor("git@gitlab.acme.com:team/skills.git"), undefined, {}, "NEW-2");

    expect(JSON.parse(candidates.files[TEAM_PREFIX_FILE]!).commitPrefix).toBe("NEW-2");
  });

  it("given a prefix of nothing but spaces, when a refresh is planned or sent, then it is refused before anything is cloned", () => {
    const cloned: string[][] = [];
    const watching: GitRunner = (args, cwd) => {
      if (args[0] === "clone") cloned.push(args);
      return gitWithIdentity(args, cwd);
    };

    const plan = planUpgrade(joinerFor(currentHandbookRepo()), watching, noForge, { commitPrefix: "  " });
    const sent = applyUpgrade(joinerFor(currentHandbookRepo()), [TEAM_PREFIX_FILE], watching, noForge, APPROVED, {
      commitPrefix: "  ",
    });

    expect(plan).toMatchObject({ ok: false });
    expect(plan.error).toContain("--commit-prefix needs the prefix");
    expect(sent).toMatchObject({ ok: false });
    expect(cloned).toEqual([]);
  });

  it("given the shipped command run with --commit-prefix, when it plans and then sends, then the config file is byte-identical", () => {
    const remote = preRecordRepo();
    const home = temp("handbook-home-");
    saveTeamConfig(joinerFor(remote), home);
    const before = readFileSync(join(home, "config.json"));
    const userHome = temp("handbook-user-");
    writeAll(userHome, { ".gitconfig": "[user]\n\tname = Dev\n\temail = dev@acme.example\n" });
    const bin = temp("handbook-bin-");
    for (const tool of ["gh", "glab"]) {
      writeFileSync(join(bin, tool), "#!/bin/sh\necho 'not logged in' >&2\nexit 1\n");
      execFileSync("chmod", ["755", join(bin, tool)]);
    }
    const init = join(dirname(new URL(import.meta.url).pathname), "..", "..", "dist", "init.js");
    const run = (args: string[]) =>
      execFileSync(process.execPath, [init, "--upgrade", ...args], {
        cwd: temp("handbook-project-"),
        encoding: "utf8",
        env: { ...process.env, HOME: userHome, TEAMHANDBOOK_HOME: home, PATH: `${bin}:${process.env.PATH}` },
      });

    const planned = run(["--commit-prefix", "TEAM-1"]);
    const sent = run(["--file", TEAM_PREFIX_FILE, "--commit-prefix", "TEAM-1", "--branch", "TEAM-1-refresh", "--message", "chore: refresh"]);

    expect(planned).toContain(`NOT IN THE REPO  ${TEAM_PREFIX_FILE}`);
    expect(sent).toContain("commit:      TEAM-1 chore: refresh");
    expect(readFileSync(join(home, "config.json")).equals(before)).toBe(true);
  });
});

describe("a recorded example the refresh cannot carry", () => {
  function repoWithExample(branchExample: unknown): string {
    const repoDir = temp("handbook-repo-");
    const team = teamFor("git@gitlab.acme.com:team/skills.git", { commitPrefix: "TEAM-1" });
    const files = currentScaffold(team);
    const recorded = { ...JSON.parse(files[TEAM_PREFIX_FILE]!), branchExample };
    writeAll(repoDir, { ...files, [TEAM_PREFIX_FILE]: JSON.stringify(recorded, null, 2) + "\n" });
    return repoDir;
  }

  it("given an example longer than today's limit, when the refresh is built, then the team file is withheld with the reason", () => {
    const repoDir = repoWithExample(`TEAM-1-${"x".repeat(120)}`);

    const candidates = upgradeCandidates(repoDir, teamFor("git@gitlab.acme.com:team/skills.git"));

    expect(candidates.files[TEAM_PREFIX_FILE]).toBeUndefined();
    const reason = candidates.withheld.find((file) => file.path === TEAM_PREFIX_FILE)?.reason;
    expect(reason).toContain('its "branchExample" is longer than 100 characters');
    expect(reason).toContain("--branch-example");
    expect(reason).not.toContain("xxxxxxxx");
  });

  it("given an example that is not a string, when the refresh is built, then the team file is withheld rather than regenerated without it", () => {
    const repoDir = repoWithExample(42);

    const candidates = upgradeCandidates(repoDir, teamFor("git@gitlab.acme.com:team/skills.git"));

    expect(candidates.files[TEAM_PREFIX_FILE]).toBeUndefined();
    expect(candidates.withheld.find((file) => file.path === TEAM_PREFIX_FILE)?.reason).toContain(
      'its "branchExample" is not a branch name',
    );
  });

  it("given that example, when a new one is given on the same run, then the file is offered carrying the new one", () => {
    const repoDir = repoWithExample(`TEAM-1-${"x".repeat(120)}`);

    const candidates = upgradeCandidates(repoDir, teamFor("git@gitlab.acme.com:team/skills.git"), "TEAM-7-short");

    expect(candidates.withheld).toEqual([]);
    expect(JSON.parse(candidates.files[TEAM_PREFIX_FILE]!).branchExample).toBe("TEAM-7-short");
  });
});

describe("keys in the team file this copy does not write", () => {
  const fresh = skeletonFiles("acme-skills", "git@gitlab.acme.com:team/skills.git", null, "TEAM-1")[TEAM_PREFIX_FILE]!;
  const comment = JSON.parse(fresh).comment as string;

  it("given a key the team added at the end, when the refresh is built, then the file is byte-identical", () => {
    const existing = JSON.stringify({ ...JSON.parse(fresh), owner: "platform-team" }, null, 2) + "\n";

    expect(mergeTeamFile(existing, fresh)).toBe(existing);
  });

  it("given a key in the middle and an older comment, when the refresh is built, then only the comment moves and the order holds", () => {
    const existing = '{\n  "commitPrefix": "TEAM-1",\n  "owner": "platform-team",\n  "comment": "an older sentence"\n}\n';

    const merged = mergeTeamFile(existing, fresh);

    expect(merged).toBe(
      `{\n  "commitPrefix": "TEAM-1",\n  "owner": "platform-team",\n  "comment": ${JSON.stringify(comment)}\n}\n`,
    );
  });

  it("given a release stamp a newer copy wrote, when the refresh is built, then it is carried rather than dropped", () => {
    const existing = JSON.stringify({ ...JSON.parse(fresh), scaffoldVersion: "0.1.0" }, null, 2) + "\n";

    expect(mergeTeamFile(existing, fresh)).toBe(existing);
  });

  it("given a team file that is not valid JSON, when it is planned, then it is reported skipped, not rewritten", () => {
    const remote = handbookRepo((remote) => ({
      ...currentScaffold(teamFor(remote)),
      [TEAM_PREFIX_FILE]: '{ "commitPrefix": "TEAM-1", }\n',
    }));

    const plan = planUpgrade(teamFor(remote), gitWithIdentity, noForge);

    expect(plan.unreadable).toEqual([TEAM_PREFIX_FILE]);
    expect(plan.files!.map((file) => file.path)).not.toContain(TEAM_PREFIX_FILE);
  });
});

describe("scaffoldVersionProblem", () => {
  it("given a record newer than this copy, when it is checked, then the copy is told to update and the repository is not blamed", () => {
    const problem = scaffoldVersionProblem("9.9.9", "0.27.0");

    expect(problem).toContain("last written by TeamHandbook 9.9.9, and this copy is 0.27.0");
    expect(problem).toContain("`/plugin marketplace update teamhandbook` and then `/reload-plugins`");
    expect(problem).not.toContain("by hand");
  });

  it("given records at or behind this copy, when they are checked, then every one may be refreshed", () => {
    for (const recorded of [undefined, "0.27.0", "0.26.9", "0.1.0"]) {
      expect(scaffoldVersionProblem(recorded, "0.27.0"), String(recorded)).toBeNull();
    }
  });

  it("given records ahead by a minor or a major, when they are checked, then both are refused", () => {
    expect(scaffoldVersionProblem("0.28.0", "0.27.5")).not.toBeNull();
    expect(scaffoldVersionProblem("1.0.0", "0.99.99")).not.toBeNull();
  });

  it("given a record this copy cannot read, when it is checked, then it is refused like a newer one", () => {
    for (const recorded of ["banana", "1.0.0-beta", 7, null]) {
      expect(scaffoldVersionProblem(recorded, "0.27.0"), String(recorded)).toContain("/reload-plugins");
    }
  });

  it("given a copy that cannot read its own version, when anything is checked, then it is refused", () => {
    expect(scaffoldVersionProblem(undefined, null)).toContain("cannot read its own version");
  });
});

describe("the release that wrote the scaffold", () => {
  const release = productVersion()!;

  function stampedRepo(scaffoldVersion: string | undefined, extra: Record<string, string> = {}): string {
    return handbookRepo((remote) => {
      const files = currentScaffold(teamFor(remote, { commitPrefix: "TEAM-1" }));
      const recorded = { ...JSON.parse(files[TEAM_PREFIX_FILE]!), reviewers: ["alice"], labels: ["handbook"] };
      if (scaffoldVersion !== undefined) recorded.scaffoldVersion = scaffoldVersion;
      return { ...files, [TEAM_PREFIX_FILE]: JSON.stringify(recorded, null, 2) + "\n", ...TEAM_CONTENT, ...extra };
    });
  }

  it("given a repository a newer release wrote, when this copy plans, then it refuses and names the update", () => {
    const remote = stampedRepo("9.9.9", { "README.md": "# older\n" });

    const plan = planUpgrade(teamFor(remote, { commitPrefix: "TEAM-1" }), gitWithIdentity, noForge);

    expect(plan.ok).toBe(false);
    expect(plan.error).toContain("/plugin marketplace update teamhandbook");
    expect(plan.files).toBeUndefined();
  });

  it("given that repository, when this copy sends a file or only records a list, then nothing is pushed", () => {
    const remote = stampedRepo("9.9.9", { "README.md": "# older\n" });
    const before = heads(remote);
    const team = teamFor(remote, { commitPrefix: "TEAM-1" });

    const named = applyUpgrade(team, ["README.md"], gitWithIdentity, noForge);
    const recorded = applyUpgrade(team, [], gitWithIdentity, noForge, APPROVED, { reviewers: ["bob"] });

    expect(named.error).toContain("last written by TeamHandbook 9.9.9");
    expect(recorded.error).toContain("last written by TeamHandbook 9.9.9");
    expect(heads(remote)).toBe(before);
  });

  it("given a repository an older release wrote, when only the README is sent, then the record moves to this release and nothing else in it does", () => {
    const remote = stampedRepo("0.1.0", { "README.md": "# older\n" });
    const recordedBefore = JSON.parse(show(remote, "main", TEAM_PREFIX_FILE));

    const result = applyUpgrade(teamFor(remote, { commitPrefix: "TEAM-1" }), ["README.md"], gitWithIdentity, noForge);

    expect(result.ok).toBe(true);
    expect(result.refreshed).toEqual(["README.md", TEAM_PREFIX_FILE]);
    expect(result.scaffoldNotRecorded).toBeUndefined();
    expect(JSON.parse(show(remote, result.branch!, TEAM_PREFIX_FILE))).toEqual({ ...recordedBefore, scaffoldVersion: release });
  });

  it("given a repository written before the record existed, when a refresh is sent, then the record is added after every key it had", () => {
    const remote = stampedRepo(undefined, { "README.md": "# older\n" });
    const before = show(remote, "main", TEAM_PREFIX_FILE);

    const result = applyUpgrade(teamFor(remote, { commitPrefix: "TEAM-1" }), ["README.md"], gitWithIdentity, noForge);

    expect(show(remote, result.branch!, TEAM_PREFIX_FILE)).toBe(
      JSON.stringify({ ...JSON.parse(before), scaffoldVersion: release }, null, 2) + "\n",
    );
  });

  it("given a repository an older release wrote and nothing else behind, when it is planned, then there is nothing to refresh", () => {
    const remote = stampedRepo("0.1.0");

    const plan = planUpgrade(teamFor(remote, { commitPrefix: "TEAM-1" }), gitWithIdentity, noForge);

    expect(refreshable(plan.files!)).toEqual([]);
  });

  it("given files to refresh, when the plan is printed, then it says the record moves with them", () => {
    const remote = stampedRepo("0.1.0", { "README.md": "# older\n" });

    const text = formatUpgradePlan(planUpgrade(teamFor(remote, { commitPrefix: "TEAM-1" }), gitWithIdentity, noForge));

    expect(text).toContain(`It also records in ${TEAM_PREFIX_FILE} that TeamHandbook ${release} wrote this scaffold`);
  });

  it("given a teammate and a repository with no team file, when the plan is printed, then it warns that nothing records the release", () => {
    const remote = handbookRepo((remote) => {
      const files: Record<string, string> = { ...currentScaffold(teamFor(remote)), "README.md": "# older\n" };
      delete files[TEAM_PREFIX_FILE];
      return files;
    });

    const plan = planUpgrade(joinerFor(remote), gitWithIdentity, noForge);
    const result = applyUpgrade(joinerFor(remote), ["README.md"], gitWithIdentity, noForge);

    expect(formatUpgradePlan(plan)).toContain(`WARNING: nothing records that TeamHandbook ${release} wrote this scaffold`);
    expect(result.scaffoldNotRecorded).toContain(`${TEAM_PREFIX_FILE} is not offered here`);
    expect(tree(remote, result.branch!)).not.toContain(TEAM_PREFIX_FILE);
  });
});

describe("the refresh commit's prefix and the record's", () => {
  /** A team file recording TEAM-1 and a README behind today's, so there is a file to send. */
  function repoRecording(prefix: string, rules = {}) {
    const team = teamFor("unused", { commitPrefix: prefix });
    return createGitLabRepo({
      defaultBranch: "main",
      rules,
      seed: { ...currentScaffold(team), "README.md": "# older\n", ...TEAM_CONTENT },
    });
  }

  it("given a repository recording TEAM-1 and a machine that says OTHER-9, when a refresh is sent, then the commit carries OTHER-9 and the record keeps TEAM-1", () => {
    const repo = repoRecording("TEAM-1");
    const other = { ...joinerFor(repo.url), commitPrefix: "OTHER-9" };

    const plan = planUpgrade(other, gitWithIdentity, noForge);
    const result = applyUpgrade(other, ["README.md"], gitWithIdentity, noForge);

    expect(plan.proposedMessage).toBe("OTHER-9 chore: refresh the team handbook scaffold");
    expect(result.commitMessage).toBe("OTHER-9 chore: the case under test");
    expect(JSON.parse(repo.fileOn(result.branch!, TEAM_PREFIX_FILE)).commitPrefix).toBe("TEAM-1");
  });

  it("given a forge whose rule the commit's prefix does not satisfy, when the push is refused, then the reader is given --commit-prefix", () => {
    const repo = repoRecording("TEAM-1", { commitMessage: "^TEAM-1 " });
    const other = { ...joinerFor(repo.url), commitPrefix: "OTHER-9" };

    const result = applyUpgrade(other, ["README.md"], gitWithIdentity, noForge, APPROVED, { branch: "TEAM-1-refresh" });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('The prefix this machine uses, "OTHER-9", does not satisfy that rule.');
    expect(result.error).toContain('run the refresh again with --commit-prefix "<the prefix the rule requires>"');
    expect(repo.branches()).toEqual(["main"]);
  });

  it("given a teammate with no prefix of their own, when the push is refused, then the record is named as the repository's and corrected there", () => {
    // given
    const repo = repoRecording("TEAM-1", { commitMessage: "^OTHER-9 " });

    // when
    const result = applyUpgrade(joinerFor(repo.url), ["README.md"], gitWithIdentity, noForge, APPROVED, { branch: "TEAM-1-refresh" });

    // then
    expect(result.ok).toBe(false);
    expect(result.error).toContain(`The prefix the team repository records in ${TEAM_PREFIX_FILE}, "TEAM-1", does not satisfy that rule`);
    expect(result.error).not.toContain("The prefix this machine uses");
  });

  it("given a prefix given on the run, when the push is refused, then nothing on the machine is sent to be corrected", () => {
    // given
    const repo = repoRecording("TEAM-1", { commitMessage: "^TEAM-1 " });

    // when
    const result = applyUpgrade(joinerFor(repo.url), ["README.md"], gitWithIdentity, noForge, APPROVED, {
      branch: "TEAM-1-refresh",
      commitPrefix: "WRONG-1",
    });

    // then
    expect(result.ok).toBe(false);
    expect(result.error).toContain('The prefix given with --commit-prefix, "WRONG-1", does not satisfy that rule');
    expect(result.error).toContain('Run the refresh again with --commit-prefix "<the prefix the rule requires>"');
    expect(result.error).not.toContain("config.json");
  });

  it("given a teammate with no prefix of their own, when the refresh is planned, then the branch is proposed from the record as a share's is", () => {
    // given
    const repo = repoRecording("TEAM-1");

    // when
    const plan = planUpgrade(joinerFor(repo.url), gitWithIdentity, noForge);
    const probe = applyUpgradeDeciding(joinerFor(repo.url), ["README.md"], gitWithIdentity, noForge, APPROVED);

    // then
    expect(plan.branch).toEqual({ branch: "TEAM-1-refresh-scaffold" });
    expect(probe.proposedBranch).toBe("TEAM-1-refresh-scaffold");
  });

  it("given that refusal, when the refresh is run again with the prefix the rule requires, then it goes through", () => {
    const repo = repoRecording("TEAM-1", { commitMessage: "^TEAM-1 " });
    const other = { ...joinerFor(repo.url), commitPrefix: "OTHER-9" };

    const result = applyUpgrade(other, ["README.md"], gitWithIdentity, noForge, APPROVED, {
      branch: "TEAM-1-refresh",
      commitPrefix: "TEAM-1",
    });

    expect(result.ok).toBe(true);
    expect(repo.subjectOn("TEAM-1-refresh")).toBe("TEAM-1 chore: the case under test");
  });

  it("given a prefix a shell would act on inside double quotes, when it is given, then it is refused before anything is cloned", () => {
    const cloned: string[][] = [];
    const watching: GitRunner = (args, cwd) => {
      if (args[0] === "clone") cloned.push(args);
      return gitWithIdentity(args, cwd);
    };

    // `!` too: interactive bash and zsh expand history inside double quotes
    for (const prefix of ["TE`whoami`AM", 'TE"AM', "TE$(id)AM", "TE\\AM", "TE!AM", "TEAM-1!"]) {
      const plan = planUpgrade(joinerFor(currentHandbookRepo()), watching, noForge, { commitPrefix: prefix });
      expect(plan.error, prefix).toBe(
        "that commit-message prefix cannot be used: it is carrying a quote, a backtick, a dollar sign, a backslash or an exclamation mark. Nothing was changed.",
      );
    }
    expect(cloned).toEqual([]);
  });

  it("given a recorded prefix that fails today's checks, when the refresh is built, then the team file is withheld rather than rewritten with this machine's", () => {
    const repoDir = temp("handbook-repo-");
    const files = currentScaffold(teamFor("git@gitlab.acme.com:team/skills.git"));
    const recorded = { ...JSON.parse(files[TEAM_PREFIX_FILE]!), commitPrefix: "P".repeat(70) };
    writeAll(repoDir, { ...files, [TEAM_PREFIX_FILE]: JSON.stringify(recorded, null, 2) + "\n" });

    const candidates = upgradeCandidates(repoDir, teamFor("git@gitlab.acme.com:team/skills.git", { commitPrefix: "TEAM-1" }));

    expect(candidates.files[TEAM_PREFIX_FILE]).toBeUndefined();
    const reason = candidates.withheld.find((file) => file.path === TEAM_PREFIX_FILE)?.reason;
    expect(reason).toContain('its "commitPrefix" is longer than 64 characters');
    expect(reason).toContain("--commit-prefix");
    expect(reason).not.toContain("PPPP");
  });

  it("given that record, when a prefix is given on the same run, then the file is offered carrying the given one", () => {
    const repoDir = temp("handbook-repo-");
    const files = currentScaffold(teamFor("git@gitlab.acme.com:team/skills.git"));
    const recorded = { ...JSON.parse(files[TEAM_PREFIX_FILE]!), commitPrefix: "P".repeat(70) };
    writeAll(repoDir, { ...files, [TEAM_PREFIX_FILE]: JSON.stringify(recorded, null, 2) + "\n" });

    const candidates = upgradeCandidates(repoDir, teamFor("git@gitlab.acme.com:team/skills.git"), undefined, {}, "TEAM-1");

    expect(candidates.withheld).toEqual([]);
    expect(JSON.parse(candidates.files[TEAM_PREFIX_FILE]!).commitPrefix).toBe("TEAM-1");
  });
});

describe("the copy's own root", () => {
  it("given a copy whose own plugin.json carries no version, when it plans a refresh, then it reads its release from package.json and runs", () => {
    const repoRoot = join(dirname(new URL(import.meta.url).pathname), "..", "..");
    const copy = temp("handbook-copy-");
    writeAll(copy, {
      "dist/init.js": readFileSync(join(repoRoot, "dist", "init.js"), "utf8"),
      ".claude-plugin/plugin.json": JSON.stringify({ name: "handbook", description: "no version line" }, null, 2) + "\n",
      "package.json": JSON.stringify({ name: "teamhandbook", version: "9.9.9", type: "module" }, null, 2) + "\n",
    });
    const remote = handbookRepo((remote) => ({ ...currentScaffold(teamFor(remote)), "README.md": "# older\n" }));
    const home = temp("handbook-home-");
    saveTeamConfig(teamFor(remote), home);

    const out = execFileSync(process.execPath, [join(copy, "dist", "init.js"), "--upgrade"], {
      cwd: temp("handbook-project-"),
      encoding: "utf8",
      env: { ...process.env, TEAMHANDBOOK_HOME: home },
    });

    expect(out).toContain("DIFFERS          README.md");
    expect(out).toContain("that TeamHandbook 9.9.9 wrote this scaffold");
  });
});
