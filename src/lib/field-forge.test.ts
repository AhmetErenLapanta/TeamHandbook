import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTeamRepo, loadTeamConfig, runGit, saveTeamConfig } from "./init.js";
import type { GitRunner } from "./init.js";
import { joinTeamRepo } from "./join.js";
import { publishTeamSelection } from "./publish.js";
import { createGitLabRepo } from "./gitlab-fixture.js";
import type { CommitIdentity, GitLabPushRules, GitLabRepo, GitLabRepoOptions } from "./gitlab-fixture.js";

// The chain init -> share -> join against a project that refuses a push for real, rather
// than against a runner that agrees with whatever the product asks it. What these cases
// measure and the mocked ones cannot is the only thing the product actually reads back
// from a forge: the sentence it was refused with.

// The three rules one real project had switched on at once. Written so that the same
// string is a valid pattern for the hook's `grep -E` AND for the `new RegExp` the product
// builds out of the quoted rule when it derives a branch name to retry with; a pattern
// only one of them accepts would measure the harness rather than the product.
const BRANCH_RULE = "^(TEAM|OPS)-[0-9]+(-[a-z0-9]+)*$";
const MESSAGE_RULE = "^(TEAM|OPS)-[0-9]+ ";
const EMAIL_RULE = "@acme\\.example$";
const BRANCH_PREFIX = "TEAM-1-";
const COMMIT_PREFIX = "TEAM-1";

const MEMBER: CommitIdentity = { name: "Dev", email: "dev@acme.example" };
const OUTSIDER: CommitIdentity = { name: "Dev", email: "dev@personal.example" };

let home: string;
let savedHome: string | undefined;
let repos: GitLabRepo[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "handbook-field-"));
  // init and share open their scratch clones under the handbook home WITHOUT being passed
  // one, so the environment is the only thing that keeps this suite out of the real
  // ~/.teamhandbook - and init never deletes the clone it made.
  savedHome = process.env.TEAMHANDBOOK_HOME;
  process.env.TEAMHANDBOOK_HOME = home;
  repos = [];
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.TEAMHANDBOOK_HOME;
  else process.env.TEAMHANDBOOK_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
  for (const repo of repos) repo.remove();
});

function project(options: GitLabRepoOptions = {}): GitLabRepo {
  const repo = createGitLabRepo(options);
  repos.push(repo);
  return repo;
}

/** Real git for everything except the ambient identity, which the product reads from the
 * machine it runs on. Pinning it is what makes the email rule mean the same thing on
 * every machine, and keeps a developer's own address out of the fixtures. */
function gitAs(identity: CommitIdentity): GitRunner {
  return (args, cwd) => {
    if (args[0] === "config" && args[1] === "user.name") return identity.name;
    if (args[0] === "config" && args[1] === "user.email") return identity.email;
    return runGit(args, cwd);
  };
}

// No forge CLI is invoked from a test: the merge request is the one step this harness
// cannot hold locally, and calling the real glab would reach the network.
const noForge = () => {
  const err = new Error("spawn glab ENOENT") as Error & { code: string };
  err.code = "ENOENT";
  throw err;
};

function localSkill(name: string): string {
  const dir = join(mkdtempSync(join(tmpdir(), "handbook-skill-")), name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: What ${name} is for.\n---\n\nBody.\n`);
  return dir;
}

function share(identity: CommitIdentity = MEMBER, name = "my-skill") {
  return publishTeamSelection(
    { skills: [{ name, dir: localSkill(name) }] },
    loadTeamConfig(home)!,
    gitAs(identity),
    noForge,
  );
}

describe("the project refuses the way the server does", () => {
  // A hook that refused everything would pass every case below it, so each rule is first
  // observed refusing a push that no product code took part in, and the pair of controls
  // at the end shows it refuses those pushes for the rule and not on principle.
  const scaffold = { branch: "handbook/scaffold", message: "chore: scaffold team skill base" };

  it("given a branch-name rule, when a branch that breaks it is pushed, then git declines with the server's sentence", () => {
    const attempt = project({ rules: { branchName: BRANCH_RULE } }).pushAttempt({ ...scaffold, identity: MEMBER });

    expect(attempt.ok).toBe(false);
    expect(attempt.stderr).toContain(
      `remote: GitLab: Branch name 'handbook/scaffold' does not follow the pattern '${BRANCH_RULE}'`,
    );
    expect(attempt.stderr).toContain("(pre-receive hook declined)");
  });

  it("given a commit-message rule, when a message that breaks it is pushed, then git declines with the server's sentence", () => {
    const attempt = project({ rules: { commitMessage: MESSAGE_RULE } }).pushAttempt({ ...scaffold, identity: MEMBER });

    expect(attempt.ok).toBe(false);
    expect(attempt.stderr).toContain(`remote: GitLab: Commit message does not follow the pattern '${MESSAGE_RULE}'`);
    expect(attempt.stderr).toContain("(pre-receive hook declined)");
  });

  it("given an email rule, when a commit by another address is pushed, then git declines with the server's sentence", () => {
    const attempt = project({ rules: { email: EMAIL_RULE } }).pushAttempt({ ...scaffold, identity: OUTSIDER });

    expect(attempt.ok).toBe(false);
    expect(attempt.stderr).toContain(
      `remote: GitLab: Author's email 'dev@personal.example' does not follow the pattern '${EMAIL_RULE}'`,
    );
    expect(attempt.stderr).toContain("(pre-receive hook declined)");
  });

  it("given a protected default branch, when it is pushed to, then git declines with the server's sentence", () => {
    const repo = project({ rules: { protectedDefaultBranch: true } });

    const attempt = repo.pushAttempt({ branch: repo.defaultBranch, message: "chore: anything", identity: MEMBER });

    expect(attempt.ok).toBe(false);
    expect(attempt.stderr).toContain(
      "remote: GitLab: You are not allowed to push code to protected branches on this project.",
    );
    expect(attempt.stderr).toContain("(pre-receive hook declined)");
  });

  it("given a project with no rules, when the same push is made, then nothing declines it", () => {
    expect(project().pushAttempt({ ...scaffold, identity: OUTSIDER }).ok).toBe(true);
  });

  it("given a branch-name rule, when the DEFAULT branch is pushed to, then the name is not screened", () => {
    // The exemption the field case turned on: the branch was the default one, so the only
    // rule that could have fired was one about the commit, not one about the name.
    const repo = project({ rules: { branchName: BRANCH_RULE } });

    expect(repo.pushAttempt({ branch: repo.defaultBranch, message: "chore: anything", identity: MEMBER }).ok).toBe(true);
  });
});

describe("init against a project that enforces one rule", () => {
  it("given no rules, when the whole chain runs, then init, share and join all go through", () => {
    const repo = project();

    const result = initTeamRepo(repo.url, "acme-skills", home, gitAs(MEMBER), undefined, noForge);

    expect(result).toMatchObject({ ok: true, branch: "handbook/scaffold", merged: false });
    expect(repo.filesOn("handbook/scaffold")).toContain(".claude-plugin/marketplace.json");
    expect(repo.filesOn(repo.defaultBranch)).not.toContain(".claude-plugin/marketplace.json");

    repo.mergeIntoDefault("handbook/scaffold");
    expect(share()).toMatchObject({ ok: true, branch: "handbook/skills-my-skill" });
    expect(repo.filesOn("handbook/skills-my-skill")).toContain("skills/my-skill/SKILL.md");

    const teammate = mkdtempSync(join(tmpdir(), "handbook-mate-"));
    try {
      expect(joinTeamRepo(repo.url, teammate)).toMatchObject({ ok: true, name: "acme-skills" });
    } finally {
      rmSync(teammate, { recursive: true, force: true });
    }
  });

  it("given a branch-name rule, when the scaffold is refused, then the branch prefix is the flag it names", () => {
    const repo = project({ rules: { branchName: BRANCH_RULE } });

    const result = initTeamRepo(repo.url, "acme-skills", home, gitAs(MEMBER), undefined, noForge);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("rejected the branch NAME");
    expect(result.error).toContain(BRANCH_RULE);
    expect(result.error).toContain("--branch-prefix");
    expect(result.error).not.toContain("--commit-prefix");
    // nothing landed: a refused push leaves the project exactly as it was
    expect(repo.branches()).toEqual([repo.defaultBranch]);
  });

  it("given a commit-message rule, when the scaffold is refused, then the commit prefix is the flag it names", () => {
    const repo = project({ rules: { commitMessage: MESSAGE_RULE } });

    const result = initTeamRepo(repo.url, "acme-skills", home, gitAs(MEMBER), undefined, noForge);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("rejected the commit MESSAGE");
    expect(result.error).toContain("--commit-prefix");
    expect(result.error).not.toContain("branch NAME");
    expect(result.error).not.toContain("--branch-prefix");
  });

  it("given an email rule, when the scaffold is refused, then the git identity is named and no prefix is offered", () => {
    const repo = project({ rules: { email: EMAIL_RULE } });

    const result = initTeamRepo(repo.url, "acme-skills", home, gitAs(OUTSIDER), undefined, noForge);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("rejected the commit AUTHOR");
    expect(result.error).toContain("user.name/user.email");
    expect(result.error).toContain(EMAIL_RULE);
    expect(result.error).not.toContain("--branch-prefix");
    expect(result.error).not.toContain("--commit-prefix");
  });

  it("given a protected default branch and an empty project, when the scaffold is refused, then the role is what it asks for", () => {
    // The one push the product makes at a default branch, so the only place this rule can
    // reach it: an empty project has no branch to open a request against.
    const repo = project({ seed: null, rules: { protectedDefaultBranch: true } });

    const result = initTeamRepo(repo.url, "acme-skills", home, gitAs(MEMBER), undefined, noForge);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("not allowed to push code to protected branches");
    expect(result.error).toContain("Ask for the role");
    expect(result.error).not.toContain("--branch-prefix");
  });
});

describe("the whole chain against the project the field produced", () => {
  it("given all three rules, when the prefixes answer them, then init, share and join all go through", () => {
    const repo = project({ rules: { branchName: BRANCH_RULE, commitMessage: MESSAGE_RULE, email: EMAIL_RULE } });

    const init = initTeamRepo(
      repo.url,
      "acme-skills",
      home,
      gitAs(MEMBER),
      undefined,
      noForge,
      BRANCH_PREFIX,
      COMMIT_PREFIX,
    );

    expect(init).toMatchObject({ ok: true, branch: "TEAM-1-scaffold" });
    // what a maintainer merging the request amounts to, and what the two steps below need
    repo.mergeIntoDefault("TEAM-1-scaffold");

    const shared = share();
    expect(shared).toMatchObject({ ok: true, branch: "TEAM-1-skills-my-skill" });
    expect(repo.filesOn("TEAM-1-skills-my-skill")).toContain("skills/my-skill/SKILL.md");

    const teammate = mkdtempSync(join(tmpdir(), "handbook-mate-"));
    try {
      expect(joinTeamRepo(repo.url, teammate)).toMatchObject({ ok: true, name: "acme-skills" });
    } finally {
      rmSync(teammate, { recursive: true, force: true });
    }
  });

  it("given all three rules, when the identity does not answer the email rule, then share stops at the author", () => {
    // The prefixes fit and the branch is fine, so a diagnosis that reached for either of
    // them would be sending the developer at a flag that cannot fix this.
    const repo = project({ rules: { branchName: BRANCH_RULE, commitMessage: MESSAGE_RULE, email: EMAIL_RULE } });
    initTeamRepo(repo.url, "acme-skills", home, gitAs(MEMBER), undefined, noForge, BRANCH_PREFIX, COMMIT_PREFIX);
    repo.mergeIntoDefault("TEAM-1-scaffold");

    const outcome = share(OUTSIDER);

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("rejected the commit AUTHOR");
    expect(outcome.error).not.toContain("branchPrefix");
  });
});

describe("share by someone who joined a project that was already answered", () => {
  function joined(rules: GitLabPushRules, prefixes: { branchPrefix?: string; commitPrefix?: string }) {
    const repo = project({ rules });
    const owner = mkdtempSync(join(tmpdir(), "handbook-owner-"));
    try {
      initTeamRepo(repo.url, "acme-skills", owner, gitAs(MEMBER), undefined, noForge, BRANCH_PREFIX, COMMIT_PREFIX);
    } finally {
      rmSync(owner, { recursive: true, force: true });
    }
    repo.mergeIntoDefault("TEAM-1-scaffold");
    expect(joinTeamRepo(repo.url, home)).toMatchObject({ ok: true });
    saveTeamConfig({ ...loadTeamConfig(home)!, ...prefixes }, home);
    return repo;
  }

  it("given a joined machine whose config carries both prefixes, when it shares first, then the project takes it", () => {
    const repo = joined(
      { branchName: BRANCH_RULE, commitMessage: MESSAGE_RULE, email: EMAIL_RULE },
      { branchPrefix: BRANCH_PREFIX, commitPrefix: COMMIT_PREFIX },
    );

    const outcome = share();

    expect(outcome).toMatchObject({ ok: true, branch: "TEAM-1-skills-my-skill" });
    expect(repo.filesOn("TEAM-1-skills-my-skill")).toContain("skills/my-skill/SKILL.md");
  });

  it("given a commit-message rule and a config that knows no prefix, when it shares, then the message rule is what it names", () => {
    // The rule the sharing machine is refused by has to be read off the same sentence on
    // this path as on init's; which knob that machine is then offered is a separate
    // question, and not one this case settles.
    const repo = joined({ commitMessage: MESSAGE_RULE }, {});

    const outcome = share();

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("rejected the commit MESSAGE");
    expect(outcome.error).toContain(MESSAGE_RULE);
    expect(repo.branches()).not.toContain("handbook/skills-my-skill");
  });

  it("given only the commit prefix, when the branch name is refused, then the branch the retry derives is one the project accepts", () => {
    // The recovery exists because a project that polices branch names polices commit
    // messages too, so the answer to one is already the answer to the other. Whether the
    // derived name actually satisfies the rule is a question only a real refusal can put.
    const repo = joined({ branchName: BRANCH_RULE, commitMessage: MESSAGE_RULE }, { commitPrefix: COMMIT_PREFIX });

    const outcome = share();

    expect(outcome).toMatchObject({ ok: true, branch: "TEAM-1-skills-my-skill", learnedBranchPrefix: BRANCH_PREFIX });
    // the refused name is not left behind on the project
    expect(repo.branches()).not.toContain("handbook/skills-my-skill");
  });
});
