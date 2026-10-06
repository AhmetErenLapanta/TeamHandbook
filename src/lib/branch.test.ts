import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  branchNameProblem,
  openedRequestUrl,
  proposeBranch,
  pushQuestion,
  requestPushOptions,
} from "./branch.js";
import { approveAndDeliver } from "./deliver.js";
import { forgeNotice } from "./forge.js";
import type { ForgeRunner } from "./forge.js";
import { loadTeamConfig, runGit, saveTeamConfig, skeletonFiles, TEAM_PREFIX_FILE } from "./init.js";
import type { GitRunner, TeamConfig } from "./init.js";
import { formatJoinSuccess, joinTeamRepo } from "./join.js";
import { publishTeamSelection } from "./publish.js";
import { writeCandidateMeta } from "./queue.js";
import { buildInventory, forgeLine, formatInventory, formatShareResult } from "./share.js";
import { candidatesDir } from "./skill-index.js";
import { applyUpgrade, formatUpgradePlan, planUpgrade, refreshAudience, upgradeCandidates } from "./upgrade.js";
import { formatStatus, gatherStatus, newerRelease } from "./status.js";
import { runDoctor } from "./doctor.js";
import type { CommandRunner } from "./doctor.js";
import { createGitLabRepo } from "./gitlab-fixture.js";
import type { GitLabRepo } from "./gitlab-fixture.js";

// Every case that pushes drives real git against a local bare repository, and several
// clone it twice; the timeout is raised for this file rather than the cases being weakened.
vi.setConfig({ testTimeout: 30_000 });

const APPROVED = { message: "chore: the case under test" } as const;
const BRANCH_RULE = "^(TEAM|OPS)-[0-9]+(-[a-z0-9]+)*$";

let home: string;
let savedHome: string | undefined;
let temps: string[];
let repos: GitLabRepo[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "handbook-branch-"));
  // Every route here opens its scratch clones under the handbook home without being
  // passed one, so the environment is what keeps this file out of a real one.
  savedHome = process.env.TEAMHANDBOOK_HOME;
  process.env.TEAMHANDBOOK_HOME = home;
  temps = [];
  repos = [];
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.TEAMHANDBOOK_HOME;
  else process.env.TEAMHANDBOOK_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  for (const repo of repos) repo.remove();
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

const SCAFFOLD = {
  ".claude-plugin/marketplace.json":
    JSON.stringify({ name: "acme-skills", owner: { name: "acme" }, plugins: [{ name: "acme-skills", source: "./" }] }) + "\n",
  ".claude-plugin/plugin.json": JSON.stringify({ name: "acme-skills", version: "0.1.0" }, null, 2) + "\n",
  "README.md": "# acme-skills\n",
};

/** A handbook on a project that may police branch names, through the same hook a server uses. */
function handbook(rules: { branchName?: string } = {}, extra: Record<string, string> = {}): GitLabRepo {
  const repo = createGitLabRepo({ rules, seed: { ...SCAFFOLD, ...extra } });
  repos.push(repo);
  return repo;
}

function teamFor(url: string, extra: Partial<TeamConfig> = {}): TeamConfig {
  return { repoUrl: url, marketplaceName: "acme-skills", initializedAt: "2026-01-01T00:00:00Z", ...extra };
}

/** Real git, with the ambient identity pinned so no developer's own address reaches a fixture. */
const gitAs: GitRunner = (args, cwd) => {
  if (args[0] === "config" && args[1] === "user.name") return "Dev";
  if (args[0] === "config" && args[1] === "user.email") return "dev@acme.example";
  return runGit(args, cwd);
};

const noForge: ForgeRunner = () => {
  const err = new Error("spawn glab ENOENT") as Error & { code: string };
  err.code = "ENOENT";
  throw err;
};

function localSkill(name: string): string {
  const dir = join(temp("handbook-skill-"), name);
  writeAll(dir, { "SKILL.md": `---\nname: ${name}\ndescription: What ${name} is for.\n---\n\nBody.\n` });
  return dir;
}

function seedCandidate(slug: string): void {
  const dir = join(candidatesDir(home), slug);
  if (existsSync(dir)) return;
  mkdirSync(dir, { recursive: true });
  writeCandidateMeta(dir, {
    slug,
    status: "pending",
    createdAt: "2026-08-08T00:00:00Z",
    scope: "team",
    description: "Use when npm test fails with a stale snapshot.",
    fingerprint: "abc123",
    sessionId: "s1",
    cwd: home,
    gate: null,
  });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${slug}\ndescription: "Use when npm test fails."\n---\n\nBody.\n`);
}

function md5(file: string): string {
  return createHash("md5").update(readFileSync(file)).digest("hex");
}

interface PushChoices {
  branch?: string;
  commitMessage?: { message?: string; delegated?: string };
}

/**
 * The three routes that push to the team repository, each driven exactly as its command
 * drives it. The defect this file exists for was one of them pushing on its own terms, so
 * every case below runs against all three with the same fixture.
 */
const ROUTES: Array<{
  name: string;
  push: (repo: GitLabRepo, choice: PushChoices) => { ok: boolean; error?: string; branch?: string; proposedBranch?: string };
}> = [
  {
    name: "a share",
    push: (repo, { commitMessage = APPROVED, ...choice }) =>
      publishTeamSelection({ skills: [{ name: "my-skill", dir: localSkill("my-skill") }] }, teamFor(repo.url), gitAs, noForge, {
        commitMessage,
        ...choice,
      }),
  },
  {
    name: "a team approval out of review",
    push: (repo, { commitMessage = APPROVED, ...choice }) => {
      seedCandidate("my-skill");
      return approveAndDeliver(home, "my-skill", home, undefined, teamFor(repo.url), gitAs, noForge, "team", undefined, {
        commitMessage,
        ...choice,
      });
    },
  },
  {
    name: "a scaffold refresh",
    push: (repo, { commitMessage = APPROVED, ...choice }) =>
      applyUpgrade(teamFor(repo.url), ["README.md"], gitAs, noForge, commitMessage, choice),
  },
];

describe.each(ROUTES)("$name, against a project that polices branch names", ({ push }) => {
  it("given no branch and no message, when it runs, then nothing is pushed and one question asks for both", () => {
    const repo = handbook({ branchName: BRANCH_RULE });

    const result = push(repo, { commitMessage: {} });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^Branch `[^`]+` · message `[^`]+` - confirm or change either\.$/m);
    expect(result.proposedBranch).toBeTruthy();
    expect(repo.branches()).toEqual(["master"]);
  });

  it("given the message but no branch, when it runs, then only the branch is asked", () => {
    const repo = handbook({ branchName: BRANCH_RULE });

    const result = push(repo, {});

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^Branch `[^`]+` - confirm or change it\.$/m);
    expect(result.error).not.toContain("commit message required");
    expect(repo.branches()).toEqual(["master"]);
  });

  it("given a name the rule refuses, when it is pushed, then the forge's own sentence comes back with the question and nothing is retried", () => {
    const repo = handbook({ branchName: BRANCH_RULE });

    const result = push(repo, { branch: "my-share" });

    expect(result.ok).toBe(false);
    // the rule exactly as the server said it, not a paraphrase of it
    expect(result.error).toContain(`Branch name 'my-share' does not follow the pattern '${BRANCH_RULE}'`);
    // the same question as the first screen, on a line of its own, the refused name in it
    expect(result.error).toMatch(/^Branch `my-share` · message `chore: the case under test` - confirm or change either\.$/m);
    expect(result.error).toContain("--branch <name>");
    expect(result.proposedBranch).toBe("my-share");
    // no second push under a name of the product's choosing
    expect(repo.branches()).toEqual(["master"]);
  });

  it("given a name the rule accepts, when it is pushed, then it goes out under exactly that name and the config is untouched", () => {
    const repo = handbook({ branchName: BRANCH_RULE });
    saveTeamConfig(teamFor(repo.url), home);
    const before = md5(join(home, "config.json"));

    const result = push(repo, { branch: "TEAM-12" });

    expect(result).toMatchObject({ ok: true, branch: "TEAM-12" });
    expect(repo.branches().sort()).toEqual(["TEAM-12", "master"]);
    expect(md5(join(home, "config.json"))).toBe(before);
  });

  it("given a name the repository already has, when it is pushed, then it is put back to the user rather than suffixed", () => {
    const repo = handbook({ branchName: BRANCH_RULE });
    expect(repo.pushAttempt({ branch: "TEAM-12", message: "earlier", identity: { name: "Dev", email: "dev@acme.example" } }).ok).toBe(true);

    const result = push(repo, { branch: "TEAM-12" });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('already has a branch named "TEAM-12"');
    expect(result.error).toContain("Branch `TEAM-12` - confirm or change it.");
    expect(repo.branches().sort()).toEqual(["TEAM-12", "master"]);
  });

  it("given a name git does not accept, when it is pushed, then it is refused before anything reaches the project", () => {
    const repo = handbook();

    const result = push(repo, { branch: "TEAM-12 fix" });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('"TEAM-12 fix" cannot be the branch: git does not accept it as a branch name');
    expect(repo.branches()).toEqual(["master"]);
  });

  it("given a name carrying a home path, when it is pushed, then the trace is refused before git sees it", () => {
    const repo = handbook();

    const result = push(repo, { branch: "TEAM-12-/home/alice/notes" });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("trace of this machine (home-path)");
    // named by class, never by quoting the name that carries it
    expect(result.error).not.toContain("alice");
    expect(result.proposedBranch).toBeUndefined();
    expect(repo.branches()).toEqual(["master"]);
  });
});

describe("one push, defined once", () => {
  it("given the source, when every push it makes is looked for, then they all live in the branch module", () => {
    // The defect this replaced was a route that pushed on its own, after the other two had
    // been fixed. A second definition is how that comes back.
    const lib = join(dirname(new URL(import.meta.url).pathname));
    const pushing = readdirSync(lib)
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && file !== "gitlab-fixture.ts")
      .filter((file) => /\[\s*"push"/.test(readFileSync(join(lib, file), "utf8")));

    expect(pushing).toEqual(["branch.ts"]);
  });
});

describe("proposeBranch", () => {
  const team: TeamConfig = { repoUrl: "git@gitlab.example:acme/skills.git", marketplaceName: "acme" };
  const none = new Set<string>();

  it("given the branch the user is working on carries a ticket, when a name is proposed, then that ticket leads it", () => {
    const proposal = proposeBranch(
      "skills-x",
      { ...team, branchPrefix: "TEAM-1-" },
      "PROJ-123-short-description",
      { current: "TEAM-12-fix-login", previous: "OPS-7-other" },
      none,
    );

    expect(proposal).toEqual({ branch: "TEAM-12-skills-x" });
  });

  it("given no ticket where the user is working, when they named a branch earlier in the session, then its ticket is used", () => {
    const proposal = proposeBranch("skills-x", { ...team, branchPrefix: "TEAM-1-" }, undefined, { current: "main", previous: "OPS-7" }, none);

    expect(proposal).toEqual({ branch: "OPS-7-skills-x" });
  });

  it("given no ticket from either, when this machine has prefixes, then they come before the team's example", () => {
    expect(proposeBranch("skills-x", { ...team, branchPrefix: "TEAM-1-" }, "PROJ-123-x", {}, none)).toEqual({
      branch: "TEAM-1-skills-x",
    });
    expect(proposeBranch("skills-x", { ...team, commitPrefix: "TEAM-1" }, "PROJ-123-x", {}, none)).toEqual({
      branch: "TEAM-1-skills-x",
    });
  });

  it("given only the team's example, when a name is proposed, then it takes the example's shape and asks for the ticket", () => {
    expect(proposeBranch("skills-x", team, "PROJ-123-short-description", {}, none)).toEqual({
      template: "<TICKET>-skills-x",
      example: "PROJ-123-short-description",
    });
    expect(proposeBranch("skills-x", team, "feature/short-description", {}, none)).toEqual({ branch: "feature/skills-x" });
  });

  it("given nothing at all, when a name is proposed, then it is the plain slug", () => {
    expect(proposeBranch("skills-x", team, undefined, {}, none)).toEqual({ branch: "skills-x" });
  });

  it("given the proposal is taken, when a name is proposed, then the proposal steps aside", () => {
    expect(proposeBranch("skills-x", team, undefined, {}, new Set(["skills-x"]))).toEqual({ branch: "skills-x-2" });
  });
});

describe("the one question, as the screen prints it", () => {
  it("given each half answered or not, when the question is built, then it reads exactly as the commands relay it", () => {
    expect(pushQuestion({ branch: "TEAM-12-skills-x" }, "TEAM-1 feat(skill): add x")).toBe(
      "Branch `TEAM-12-skills-x` · message `TEAM-1 feat(skill): add x` - confirm or change either.",
    );
    expect(pushQuestion({ branch: "TEAM-12-skills-x" }, null)).toBe("Branch `TEAM-12-skills-x` - confirm or change it.");
    expect(pushQuestion(null, "feat(skill): add x")).toBe("Message `feat(skill): add x` - confirm or change it.");
    expect(pushQuestion({ template: "<TICKET>-skills-x", example: "PROJ-123-short-description" }, "feat(skill): add x")).toBe(
      "Branch `<TICKET>-skills-x` (branches here look like `PROJ-123-short-description`: which ticket is this?) · " +
        "message `feat(skill): add x` - confirm or change either.",
    );
  });

  it("given the three command files, when they describe the push, then each tells the agent to relay that one line", () => {
    const commands = join(dirname(new URL(import.meta.url).pathname), "..", "..", "commands");
    for (const file of ["share.md", "review.md", "init.md"]) {
      const body = readFileSync(join(commands, file), "utf8");
      expect(body, file).toContain("confirm or change either");
      expect(body, file).toContain("--branch");
    }
  });
});

describe("branchNameProblem", () => {
  it("given names git and the sieve accept or refuse, when they are screened, then only a usable branch passes", () => {
    const cwd = temp("handbook-cwd-");
    expect(branchNameProblem("TEAM-12-fix", runGit, cwd)).toBeNull();
    expect(branchNameProblem("feature/TEAM-12", runGit, cwd)).toBeNull();
    expect(branchNameProblem("fix..this", runGit, cwd)).toContain("git does not accept");
    expect(branchNameProblem("@{-1}", runGit, cwd)).toContain("git does not accept");
    expect(branchNameProblem("--upload-pack=x", runGit, cwd)).toContain("git does not accept");
    expect(branchNameProblem(`TEAM-12-${"ghp_" + "a".repeat(36)}`, runGit, cwd)).toContain("looks like a");
  });
});

/** A bare repository that a URL on a real forge host is rewritten to, so the host decides
 * the route while git still pushes somewhere local. */
function hostedAt(url: string, bare: string, reply?: (args: string[]) => string): GitRunner {
  return (args, cwd) => {
    const local = args.map((a) => (a === url ? bare : a));
    if (args[0] === "push" && reply) {
      // the push itself still lands; what changes is what the server says back
      const plain = local.filter((a, i) => a !== "-o" && local[i - 1] !== "-o");
      runGit(plain, cwd);
      return reply(args);
    }
    return gitAs(local, cwd);
  };
}

function bareHandbook(extra: Record<string, string> = {}): string {
  const bare = temp("handbook-bare-");
  execFileSync("git", ["init", "--bare", "-b", "main", bare]);
  const seed = temp("handbook-seed-");
  execFileSync("git", ["-C", seed, "init", "-b", "main"]);
  writeAll(seed, { ...SCAFFOLD, ...extra });
  execFileSync("git", ["-C", seed, "add", "-A"]);
  execFileSync("git", ["-C", seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "seed"]);
  execFileSync("git", ["-C", seed, "push", bare, "main"], { stdio: "ignore" });
  return bare;
}

const GITLAB = "git@gitlab.com:acme/skills.git";
const GITHUB = "git@github.com:acme/skills.git";
const OPENED =
  "remote: \nremote: View merge request for TEAM-12:\nremote:   https://gitlab.com/acme/skills/-/merge_requests/12\nremote: \n";
const CREATE_LINK =
  "remote: \nremote: To create a merge request for TEAM-12, visit:\n" +
  "remote:   https://gitlab.com/acme/skills/-/merge_requests/new?merge_request%5Bsource_branch%5D=TEAM-12\nremote: \n";

describe("opening the request without the forge CLI", () => {
  const share = (git: GitRunner, url: string, forge: ForgeRunner = noForge) =>
    publishTeamSelection({ skills: [{ name: "my-skill", dir: localSkill("my-skill") }] }, teamFor(url), git, forge, {
      commitMessage: APPROVED,
      branch: "TEAM-12",
    });

  it("given GitLab and no glab, when GitLab reports the request it opened, then that request is the result and its description is printed", () => {
    const pushes: string[][] = [];
    const bare = bareHandbook();
    const result = share(
      hostedAt(GITLAB, bare, (args) => {
        pushes.push(args);
        return OPENED;
      }),
      GITLAB,
    );

    expect(pushes[0]).toEqual([
      "push",
      "-o",
      "merge_request.create",
      "-o",
      "merge_request.title=chore: the case under test",
      "-o",
      "merge_request.remove_source_branch",
      "origin",
      "TEAM-12",
    ]);
    expect(result).toMatchObject({ ok: true, branch: "TEAM-12", prUrl: "https://gitlab.com/acme/skills/-/merge_requests/12" });
    const text = formatShareResult({ team: result, refused: [] });
    expect(text).toContain("merge request: https://gitlab.com/acme/skills/-/merge_requests/12");
    expect(text).toContain("a push cannot carry its description. Paste this into it:");
    expect(text).toContain("This skill was written by hand");
  });

  it("given GitLab and no glab, when GitLab only offers the create link, then the result says pushed and never says opened", () => {
    const bare = bareHandbook();
    const result = share(hostedAt(GITLAB, bare, () => CREATE_LINK), GITLAB);

    expect(result.ok).toBe(true);
    expect(result.prUrl).toBeUndefined();
    expect(result.prError).toContain("GitLab did not report opening a request for the push");
    expect(result.manualUrl).toContain("merge_requests/new");
    const text = formatShareResult({ team: result, refused: [] });
    expect(text).toContain("  - open the merge request: https://gitlab.com/acme/skills/-/merge_requests/new");
    expect(text).not.toContain("  - merge request: ");
    expect(text).not.toContain("Paste this into it");
  });

  it("given a server that does not take push options, when it is pushed to, then the same push goes plain", () => {
    const bare = bareHandbook();
    const pushes: string[][] = [];
    const git: GitRunner = (args, cwd) => {
      const local = args.map((a) => (a === GITLAB ? bare : a));
      if (args[0] === "push") {
        pushes.push(args);
        if (args.includes("-o")) throw new Error("git push failed: fatal: the receiving end does not support push options");
      }
      return gitAs(local, cwd);
    };

    const result = share(git, GITLAB);

    expect(result).toMatchObject({ ok: true, branch: "TEAM-12" });
    expect(pushes.map((p) => p.includes("-o"))).toEqual([true, false]);
    expect(result.prError).toContain("the glab CLI is not installed");
  });

  it("given GitHub and no gh, when a share is pushed, then no option is sent and the compare link is printed", () => {
    const bare = bareHandbook();
    const pushes: string[][] = [];
    const git: GitRunner = (args, cwd) => {
      if (args[0] === "push") pushes.push(args);
      return gitAs(args.map((a) => (a === GITHUB ? bare : a)), cwd);
    };

    const result = share(git, GITHUB);

    expect(pushes[0]).not.toContain("-o");
    expect(result).toMatchObject({ ok: true, manualUrl: "https://github.com/acme/skills/pull/new/TEAM-12" });
  });

  it("given the pieces, when the route is chosen, then only a GitLab host without glab asks the push for a request", () => {
    expect(requestPushOptions(GITLAB, "the glab CLI is not installed", "t")).toContain("merge_request.create");
    expect(requestPushOptions(GITLAB, null, "t")).toEqual([]);
    expect(requestPushOptions(GITHUB, "the gh CLI is not installed", "t")).toEqual([]);
    expect(requestPushOptions("/srv/git/skills.git", "the glab CLI is not installed", "t")).toEqual([]);
    expect(openedRequestUrl(OPENED)).toBe("https://gitlab.com/acme/skills/-/merge_requests/12");
    expect(openedRequestUrl(CREATE_LINK)).toBeNull();
  });

  it("given a server that replies to a push, when git pushes for real, then the reply reaches the caller", () => {
    // The forge's reply travels on stderr; dropping it is how a request GitLab opened would
    // have read as one it never opened.
    const bare = bareHandbook();
    const hook = join(bare, "hooks", "post-receive");
    writeFileSync(hook, "#!/bin/sh\necho 'View merge request for TEAM-12:'\necho '  https://gitlab.com/acme/skills/-/merge_requests/12'\n");
    chmodSync(hook, 0o755);
    execFileSync("git", ["-C", bare, "config", "core.hooksPath", "hooks"]);
    const work = temp("handbook-work-");
    execFileSync("git", ["clone", bare, join(work, "repo")], { stdio: "ignore" });

    const output = runGit(["push", "origin", "HEAD:TEAM-12"], join(work, "repo"));

    expect(openedRequestUrl(output)).toBe("https://gitlab.com/acme/skills/-/merge_requests/12");
  });
});

describe("what the first screen says about the request", () => {
  it("given GitLab and no glab, when the share list is shown, then the route and the refused delegation are both on it", () => {
    const text = formatInventory(
      { skills: [{ kind: "skill", name: "x", scope: "personal", dir: "/tmp/x", description: "d", shareable: true }], servers: [], commands: [] },
      forgeLine(teamFor(GITLAB), noForge, home),
    );

    expect(text).toContain(
      "This machine cannot open the merge request with glab (the glab CLI is not installed): the branch will be " +
        "pushed asking GitLab to open the request itself, and a link printed if it does not.",
    );
    expect(text).toContain('For the same reason "you decide" is not an answer to the commit message here');
  });

  it("given GitHub and no gh, when the share list is shown, then it says the branch is pushed and a link printed", () => {
    const line = forgeLine(teamFor(GITHUB), noForge, home);

    expect(line).toContain("This machine cannot open the merge request (the gh CLI is not installed): the branch will be pushed and a link printed.");
    expect(line).toBe(forgeNotice(GITHUB, "the gh CLI is not installed"));
  });

  it("given a signed-in CLI, when the share list is shown, then there is nothing to say", () => {
    expect(forgeLine(teamFor(GITLAB), () => "Logged in", home)).toBeUndefined();
    expect(forgeLine(null, noForge, home)).toBeUndefined();
  });

  it("given no glab, when a candidate is first approved to the team, then the route and the refused delegation share its one screen", () => {
    const bare = bareHandbook();
    seedCandidate("my-skill");

    const result = approveAndDeliver(home, "my-skill", home, undefined, teamFor(bare), gitAs, noForge, "team", undefined, {
      commitMessage: {},
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^Branch `my-skill` · message `feat\(skill\): add my-skill` - confirm or change either\.$/m);
    expect(result.error).toContain("commit message required");
    expect(result.error).toContain("This machine cannot open the merge request (the glab CLI is not installed)");
    expect(result.error).not.toContain("--delegate-message");
  });
});

describe("a version an unmerged branch already claims", () => {
  /** The case that was missed by a hair: an abandoned branch already carrying the raise a
   * second, unrelated request was about to make. */
  function withOpenRaise(version: string, branch = "TEAM-9-old"): string {
    const bare = bareHandbook();
    const work = temp("handbook-open-");
    execFileSync("git", ["clone", bare, join(work, "repo")], { stdio: "ignore" });
    const repo = join(work, "repo");
    execFileSync("git", ["-C", repo, "checkout", "-b", branch], { stdio: "ignore" });
    writeFileSync(
      join(repo, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "acme-skills", version, description: "raised on another branch" }, null, 2) + "\n",
    );
    execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-am", "raise"], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "push", "origin", branch], { stdio: "ignore" });
    return bare;
  }

  const share = (url: string, versionAfterOpen = false) =>
    publishTeamSelection({ skills: [{ name: "my-skill", dir: localSkill("my-skill") }] }, teamFor(url), gitAs, noForge, {
      commitMessage: APPROVED,
      branch: "TEAM-12",
      ...(versionAfterOpen ? { versionAfterOpen } : {}),
    });

  it("given an unmerged branch raising the same version, when a share is sent, then it stops first and offers both ways", () => {
    const bare = withOpenRaise("0.1.1");

    const result = share(bare);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('"TEAM-9-old" (0.1.1)');
    expect(result.error).toContain("the second one reaches nobody");
    expect(result.error).toContain("send this one as 0.1.2");
    expect(result.error).toContain("--version-after-open");
    expect(result.error).toContain("merge or close that branch first");
    expect(execFileSync("git", ["-C", bare, "branch", "--list"], { encoding: "utf8" })).not.toContain("TEAM-12");
  });

  it("given the user chose to go past it, when the share is sent again, then its version is set after the open one", () => {
    const bare = withOpenRaise("0.1.1");

    const result = share(bare, true);

    expect(result).toMatchObject({ ok: true, version: "0.1.2" });
    const manifest = execFileSync("git", ["-C", bare, "show", "TEAM-12:.claude-plugin/plugin.json"], { encoding: "utf8" });
    expect(JSON.parse(manifest).version).toBe("0.1.2");
  });

  it("given a branch that raises nothing past the default branch, when a share is sent, then it is not in the way", () => {
    const result = share(withOpenRaise("0.1.0"));

    expect(result).toMatchObject({ ok: true, version: "0.1.1" });
  });

  it("given the refresh plan, when an open branch claims its version, then the plan warns before anything is asked", () => {
    const bare = withOpenRaise("0.1.1");

    const text = formatUpgradePlan(planUpgrade(teamFor(bare), gitAs, noForge));

    expect(text).toContain('WARNING: the team repository has a branch that is not merged and already raises the plugin past 0.1.0: "TEAM-9-old" (0.1.1)');
  });
});

describe("the scaffold refresh says who it is for", () => {
  it("given only the team record is missing, when the plan is shown, then its first line says it can be skipped", () => {
    // Today's scaffold in full except the record, which is the repository the field had.
    const bare = temp("handbook-bare-");
    execFileSync("git", ["init", "--bare", "-b", "main", bare]);
    const seed = temp("handbook-seed-");
    execFileSync("git", ["-C", seed, "init", "-b", "main"]);
    const { [TEAM_PREFIX_FILE]: _record, ...scaffold } = skeletonFiles("acme-skills", bare, null);
    writeAll(seed, scaffold);
    execFileSync("git", ["-C", seed, "add", "-A"]);
    execFileSync("git", ["-C", seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "seed"]);
    execFileSync("git", ["-C", seed, "push", bare, "main"], { stdio: "ignore" });

    const text = formatUpgradePlan(planUpgrade(teamFor(bare), gitAs, noForge));

    expect(text.split("\n")[0]).toBe("This only matters to teammates who join after you; you can skip it and keep sharing.");
  });

  it("given the plugin manifest is missing, when the plan is shown, then its first line says shares are not reaching anyone", () => {
    const line = refreshAudience({ ok: true, files: [{ path: ".claude-plugin/plugin.json", state: "absent" }] });

    expect(line).toContain("Teammates receive nothing you share until this is merged");
  });

  it("given a plan with files to send, when it is shown, then the branch and the message are one question with the forge route under it", () => {
    const bare = bareHandbook();

    const text = formatUpgradePlan(planUpgrade(teamFor(bare), gitAs, noForge, { hints: { current: "TEAM-12-fix" } }));

    expect(text).toContain(
      "Branch `TEAM-12-refresh-scaffold` · message `chore: refresh the team handbook scaffold` - confirm or change either.",
    );
    expect(text).toContain("This machine cannot open the merge request (the glab CLI is not installed)");
    expect(text).not.toContain("--delegate-message");
  });
});

describe("the example branch a team records", () => {
  it("given an administrator's example, when the refresh records it, then the team file carries it and the prefix is kept", () => {
    const bare = bareHandbook();
    const before = formatUpgradePlan(planUpgrade(teamFor(bare, { commitPrefix: "TEAM-1" }), gitAs, noForge));
    expect(before).toContain("What does a branch name look like in this repository? e.g. TEAM-123-short-description");

    const result = applyUpgrade(teamFor(bare, { commitPrefix: "TEAM-1" }), [], gitAs, noForge, APPROVED, {
      branch: "TEAM-12-example",
      branchExample: "PROJ-123-short-description",
    });

    expect(result).toMatchObject({ ok: true, refreshed: [TEAM_PREFIX_FILE] });
    const recorded = JSON.parse(execFileSync("git", ["-C", bare, "show", `TEAM-12-example:${TEAM_PREFIX_FILE}`], { encoding: "utf8" }));
    expect(recorded).toMatchObject({ commitPrefix: "TEAM-1", branchExample: "PROJ-123-short-description" });
  });

  it("given a repository that records one, when a teammate joins, then the join reads it and their first proposal takes its shape", () => {
    const bare = bareHandbook({
      [TEAM_PREFIX_FILE]: JSON.stringify({ commitPrefix: "", branchExample: "PROJ-123-short-description" }, null, 2) + "\n",
    });

    const joined = joinTeamRepo(bare, home, gitAs);

    expect(joined).toMatchObject({ ok: true, branchExample: "PROJ-123-short-description" });
    expect(loadTeamConfig(home)?.branchExample).toBe("PROJ-123-short-description");
    expect(formatJoinSuccess(joined)).toContain('branches: proposed in the shape of "PROJ-123-short-description"');
    const asked = publishTeamSelection({ skills: [{ name: "my-skill", dir: localSkill("my-skill") }] }, loadTeamConfig(home)!, gitAs, noForge, {
      commitMessage: APPROVED,
    });
    expect(asked.error).toContain(
      "Branch `<TICKET>-skills-my-skill` (branches here look like `PROJ-123-short-description`: which ticket is this?) - confirm or change it.",
    );
    expect(asked.proposedBranch).toBeUndefined();
  });

  it("given a machine that never heard of the example, when it plans a refresh, then the team file is not offered for rewriting", () => {
    const bare = bareHandbook({
      [TEAM_PREFIX_FILE]:
        JSON.stringify(
          {
            commitPrefix: "",
            branchExample: "PROJ-123-short-description",
            comment:
              "Written by TeamHandbook. commitPrefix is what this project's forge requires at the front of a commit " +
              "message; /handbook:join reads it, so a teammate's first share satisfies that rule instead of being refused by it.",
          },
          null,
          2,
        ) + "\n",
    });
    const work = temp("handbook-clone-");
    execFileSync("git", ["clone", bare, join(work, "repo")], { stdio: "ignore" });

    const candidates = upgradeCandidates(join(work, "repo"), teamFor(bare));

    expect(candidates.files[TEAM_PREFIX_FILE]).toBe(readFileSync(join(work, "repo", TEAM_PREFIX_FILE), "utf8"));
  });

  it("given an example carrying a home path, when it is to be recorded, then nothing is written", () => {
    const bare = bareHandbook();

    const result = applyUpgrade(teamFor(bare), [], gitAs, noForge, APPROVED, {
      branch: "TEAM-12-example",
      branchExample: "TEAM-1-/home/alice/x",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("that example cannot be recorded as the example branch name");
    expect(result.error).not.toContain("alice");
    expect(execFileSync("git", ["-C", bare, "branch", "--list"], { encoding: "utf8" })).not.toContain("TEAM-12");
  });
});

describe("a newer release than the one installed", () => {
  /** The layout Claude Code installs into: a copy per version under cache, and the
   * marketplace clone it came from under marketplaces. */
  function installed(version: string): { root: string; marketRoot: string } {
    const plugins = temp("handbook-plugins-");
    const root = join(plugins, "cache", "acme-tools", "handbook", version);
    mkdirSync(root, { recursive: true });
    mkdirSync(join(plugins, "marketplaces", "acme-tools"), { recursive: true });
    return { root, marketRoot: join(plugins, "marketplaces") };
  }
  const TAGS = "a1\trefs/tags/v0.9.7\nb2\trefs/tags/v0.16.0\nb3\trefs/tags/v0.16.0^{}\nc3\trefs/tags/nightly\n";

  it("given an older install, when its source is asked for tags, then the newest release is named", () => {
    const { root, marketRoot } = installed("0.12.0");
    const asked: string[] = [];

    const newer = newerRelease("0.12.0", root, marketRoot, (args, cwd) => {
      asked.push(cwd);
      expect(args).toEqual(["ls-remote", "--tags", "origin"]);
      return TAGS;
    });

    expect(newer).toBe("0.16.0");
    expect(asked).toEqual([join(marketRoot, "acme-tools")]);
  });

  it("given the latest install, no network or a checkout run by hand, when it is asked, then it says nothing", () => {
    const { root, marketRoot } = installed("0.16.0");
    expect(newerRelease("0.16.0", root, marketRoot, () => TAGS)).toBeNull();
    expect(
      newerRelease("0.12.0", root, marketRoot, () => {
        throw new Error("Could not resolve host");
      }),
    ).toBeNull();
    let called = false;
    expect(
      newerRelease("0.12.0", temp("handbook-checkout-"), marketRoot, () => {
        called = true;
        return TAGS;
      }),
    ).toBeNull();
    expect(called).toBe(false);
  });

  it("given a newer release, when status and doctor are shown, then each says so in one line", () => {
    const { root, marketRoot } = installed("0.12.0");
    const report = gatherStatus(home, () => "99.0.0");
    expect(formatStatus(report).split("\n").filter((l) => l.includes("a newer version is available (99.0.0)"))).toHaveLength(1);
    expect(formatStatus(gatherStatus(home, () => null))).not.toContain("newer version");

    // The doctor reads the running version, so the release it is shown is one no version
    // of this repository will reach.
    const run: CommandRunner = (cmd, args) => {
      if (cmd === "git" && args[0] === "ls-remote" && args[1] === "--tags") return `${TAGS}d4\trefs/tags/v99.0.0\n`;
      if (cmd === "claude") return args[0] === "-p" ? "OK" : "2.1.0";
      if (cmd === "git") return args[0] === "config" ? "dev@acme.example" : "abc\trefs/heads/main";
      throw new Error(`unexpected command ${cmd}`);
    };
    const doctor = runDoctor(home, run, marketRoot, root);
    expect(doctor.checks.find((c) => c.name === "version")?.detail).toContain("a newer version is available (99.0.0)");
    const offline: CommandRunner = (cmd, args) => {
      if (cmd === "git" && args[0] === "ls-remote" && args[1] === "--tags") throw new Error("offline");
      return run(cmd, args, 0);
    };
    expect(runDoctor(home, offline, marketRoot, root).checks.find((c) => c.name === "version")).toBeUndefined();
  });
});

describe("a branch named for one share", () => {
  it("given the share command run with --branch, when it pushes, then the config file is byte-identical", () => {
    // The command used to write a branch prefix, and a commit prefix it read out of the
    // repository, back into this file after a push. Measured on the shipped bundle, because
    // that write lived in the entrypoint rather than in the library.
    const userHome = temp("handbook-user-");
    writeAll(userHome, {
      ".claude/skills/my-skill/SKILL.md": "---\nname: my-skill\ndescription: What my-skill is for.\n---\n\nBody.\n",
      ".gitconfig": "[user]\n\tname = Dev\n\temail = dev@acme.example\n",
    });
    const bare = bareHandbook({ [TEAM_PREFIX_FILE]: JSON.stringify({ commitPrefix: "TEAM-1" }) + "\n" });
    saveTeamConfig({ repoUrl: bare, marketplaceName: "acme-skills", joinedAt: "2026-02-02T00:00:00Z" }, home);
    const before = md5(join(home, "config.json"));
    // No forge CLI may be reached from a test: these stand in for both, signed out.
    const bin = temp("handbook-bin-");
    for (const tool of ["gh", "glab"]) {
      writeFileSync(join(bin, tool), "#!/bin/sh\necho 'not logged in' >&2\nexit 1\n");
      chmodSync(join(bin, tool), 0o755);
    }
    const repoRoot = join(dirname(new URL(import.meta.url).pathname), "..", "..");

    const out = execFileSync(
      process.execPath,
      [join(repoRoot, "dist", "share.js"), "share", "--skill", "my-skill", "--message", "add my skill", "--branch", "TEAM-12-mine"],
      {
        cwd: temp("handbook-project-"),
        encoding: "utf8",
        env: { ...process.env, HOME: userHome, TEAMHANDBOOK_HOME: home, PATH: `${bin}:${process.env.PATH}` },
      },
    );

    expect(out).toContain("branch: TEAM-12-mine");
    expect(out).toContain("commit: TEAM-1 add my skill");
    expect(md5(join(home, "config.json"))).toBe(before);
  });
});
