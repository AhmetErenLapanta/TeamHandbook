import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTeamRepo as initTeamRepoDeciding, loadTeamConfig, runGit, saveTeamConfig } from "./init.js";
import type { GitRunner } from "./init.js";
import { joinTeamRepo } from "./join.js";
import { publishTeamSelection } from "./publish.js";
import { createGitLabRepo } from "./gitlab-fixture.js";
import type { CommitIdentity, GitLabPushRules, GitLabRepo, GitLabRepoOptions } from "./gitlab-fixture.js";
import type { CommitMessageChoice } from "./init.js";
import type { ForgeRunner } from "./forge.js";

/**
 * The answer every scaffold below gives about its commit message, because none of them is
 * about the wording: a plain sentence of the user's own. It carries no team prefix, so the
 * cases that measure the prefix still measure it. Delegating instead would cost every one
 * of them a second run, since "you decide" has to name the proposal it was shown.
 */
const APPROVED = { message: "chore: the case under test" } as const;

type InitArgs = Parameters<typeof initTeamRepoDeciding>;
function initTeamRepo(
  url: InitArgs[0],
  name?: InitArgs[1],
  home?: InitArgs[2],
  git?: InitArgs[3],
  now?: InitArgs[4],
  forge?: InitArgs[5],
  branchPrefix?: InitArgs[6],
  commitPrefix?: InitArgs[7],
  withCi?: InitArgs[8],
) {
  return initTeamRepoDeciding(url, name, home, git, now, forge, branchPrefix, commitPrefix, withCi, APPROVED);
}


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
const noForge = (_tool: "gh" | "glab", _args: string[]) => {
  const err = new Error("spawn glab ENOENT") as Error & { code: string };
  err.code = "ENOENT";
  throw err;
};

/** A machine that HAS the CLI and is signed in: `auth status` answers, and the request it
 * would open comes back as a link rather than a network call. Needed because a delegated
 * wording is refused on a machine that cannot open a merge request, so the cases about
 * delegation cannot use the runner that stands in for not having one. */
const signedInForge = (_tool: "gh" | "glab", args: string[]) =>
  args[0] === "auth" ? "Logged in to acme.example as dev" : "https://acme.example/team/skills/-/merge_requests/1";

function localSkill(name: string, body = "Body."): string {
  const dir = join(mkdtempSync(join(tmpdir(), "handbook-skill-")), name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: What ${name} is for.\n---\n\n${body}\n`);
  return dir;
}

function share(
  identity: CommitIdentity = MEMBER,
  name = "my-skill",
  commitMessage: CommitMessageChoice = APPROVED,
  forge: ForgeRunner = noForge,
  body?: string,
) {
  const selection = { skills: [{ name, dir: localSkill(name, body) }] };
  const team = loadTeamConfig(home)!;
  // The two runs a share takes when the user confirms the branch it proposes.
  const probe = publishTeamSelection(selection, team, gitAs(identity), forge, { commitMessage });
  return !probe.ok && probe.proposedBranch
    ? publishTeamSelection(selection, team, gitAs(identity), forge, { commitMessage, branch: probe.proposedBranch })
    : probe;
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
    expect(share()).toMatchObject({ ok: true, branch: "skills-my-skill" });
    expect(repo.filesOn("skills-my-skill")).toContain("skills/my-skill/SKILL.md");

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
  /** A handbook the founder scaffolded with this version: the repository records the
   * commit-message prefix, so joining reads it rather than asking for it again. */
  function joined(rules: GitLabPushRules, prefixes: { branchPrefix?: string; commitPrefix?: string } = {}) {
    const repo = project({ rules });
    const owner = mkdtempSync(join(tmpdir(), "handbook-owner-"));
    try {
      initTeamRepo(repo.url, "acme-skills", owner, gitAs(MEMBER), undefined, noForge, BRANCH_PREFIX, COMMIT_PREFIX);
    } finally {
      rmSync(owner, { recursive: true, force: true });
    }
    repo.mergeIntoDefault("TEAM-1-scaffold");
    return repo;
  }

  /** A handbook scaffolded before a repository recorded anything: the manifests a join
   * needs, and no prefix record for it to read. Written as a seed rather than scaffolded
   * and stripped, because that IS what those repositories are - and they are still out
   * there, so the route out of a rule they cannot answer has to stay measured. */
  function legacyScaffold(): Record<string, string> {
    return {
      ".claude-plugin/marketplace.json": JSON.stringify(
        {
          name: "acme-skills",
          owner: { name: "acme-skills maintainers" },
          plugins: [{ name: "acme-skills", source: "./", description: "The team's approved setup." }],
        },
        null,
        2,
      ) + "\n",
      ".claude-plugin/plugin.json": JSON.stringify(
        { name: "acme-skills", description: "The team's approved setup.", version: "0.1.0" },
        null,
        2,
      ) + "\n",
      "skills/README.md": "Approved skills live here.\n",
    };
  }

  it("given a repository that records the prefix, when a machine joins, then its first share goes straight in", () => {
    // The whole point of recording it: the rule the team already answered is answered
    // again on a machine that was never told, without anyone editing a config by hand.
    const repo = joined({ commitMessage: MESSAGE_RULE });

    expect(joinTeamRepo(repo.url, home)).toMatchObject({ ok: true, commitPrefix: COMMIT_PREFIX });
    expect(loadTeamConfig(home)).toMatchObject({ commitPrefix: COMMIT_PREFIX });

    const outcome = share();

    expect(outcome).toMatchObject({ ok: true, branch: "TEAM-1-skills-my-skill" });
    // the prefix did not just satisfy the rule, it is on the commit the project now holds
    expect(repo.subjectOn("TEAM-1-skills-my-skill")).toMatch(/^TEAM-1 /);
  });

  it("given a joined machine whose config carries both prefixes, when it shares first, then the project takes it", () => {
    // The branch prefix is the half a repository does not record, so it is still set here.
    const repo = joined({ branchName: BRANCH_RULE, commitMessage: MESSAGE_RULE, email: EMAIL_RULE });
    expect(joinTeamRepo(repo.url, home)).toMatchObject({ ok: true });
    saveTeamConfig({ ...loadTeamConfig(home)!, branchPrefix: BRANCH_PREFIX }, home);

    const outcome = share();

    expect(outcome).toMatchObject({ ok: true, branch: "TEAM-1-skills-my-skill" });
    expect(repo.filesOn("TEAM-1-skills-my-skill")).toContain("skills/my-skill/SKILL.md");
  });

  it("given a repository that records no prefix, when the commit message is refused, then the route offered is one this machine has", () => {
    // The case a repository scaffolded before the record still produces. Diagnosing the
    // rule correctly and answering it with `--commit-prefix` would be a flag the sharing
    // command has never had, so what is asserted here is the route, not just the rule.
    const repo = project({ rules: { commitMessage: MESSAGE_RULE }, seed: legacyScaffold() });
    expect(joinTeamRepo(repo.url, home)).toMatchObject({ ok: true });
    expect(loadTeamConfig(home)!.commitPrefix).toBeUndefined();

    const outcome = share();

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("rejected the commit MESSAGE");
    expect(outcome.error).toContain(MESSAGE_RULE);
    expect(outcome.error).toContain("/handbook:init --upgrade");
    expect(outcome.error).not.toContain("--commit-prefix");
    expect(repo.branches()).not.toContain("skills-my-skill");
  });

  it("given a joined machine and a branch rule, when it shares, then the proposal already carries the key the rule asks for", () => {
    // The key the repository records reaches the branch proposal as well as the commit, so
    // the name the user is asked to confirm is one the project accepts - and there is no
    // retry under a derived name for a refusal that never happens.
    const repo = joined({ branchName: BRANCH_RULE, commitMessage: MESSAGE_RULE });
    expect(joinTeamRepo(repo.url, home)).toMatchObject({ ok: true, commitPrefix: COMMIT_PREFIX });

    const outcome = share();

    expect(outcome).toMatchObject({ ok: true, branch: "TEAM-1-skills-my-skill" });
    expect(repo.branches()).toContain("TEAM-1-skills-my-skill");
  });
});

describe("a skill carrying a trace of the machine it was written on", () => {
  // The stand-in name and the path are assembled rather than written out: this repository
  // refuses a literal absolute home path on any line it takes in, a fixture's included.
  const STAND_IN = "alice";
  const HOME_PATH = ["", "Users", STAND_IN, "work", "api"].join("/");

  it("given a home path in its body, when it is shared, then the project is never opened and the refusal names the class, not the trace", () => {
    const repo = project();
    initTeamRepo(repo.url, "acme-skills", home, gitAs(MEMBER), undefined, noForge);
    repo.mergeIntoDefault("handbook/scaffold");
    const before = repo.branches();

    const result = share(MEMBER, "leaky-skill", APPROVED, noForge, `Run the suite from ${HOME_PATH} first.`);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("carries a trace of this machine");
    expect(result.error).toContain("home-path");
    // The whole outcome, not just the message: a refusal that prints the trace back would
    // put it in the terminal, the transcript and whatever the user pastes next.
    expect(JSON.stringify(result)).not.toContain(STAND_IN);
    expect(repo.branches()).toEqual(before);
  });

  it("given the same skill with the path taken out, when it is shared, then it goes out - the refusal was the trace, not the skill", () => {
    const repo = project();
    initTeamRepo(repo.url, "acme-skills", home, gitAs(MEMBER), undefined, noForge);
    repo.mergeIntoDefault("handbook/scaffold");

    const result = share(MEMBER, "leaky-skill", APPROVED, noForge, "Run the suite from the repository root first.");

    expect(result).toMatchObject({ ok: true, branch: "skills-leaky-skill" });
    expect(repo.filesOn("skills-leaky-skill")).toContain("skills/leaky-skill/SKILL.md");
  });
});

// The message on the commit, against the same project. It belongs in this suite rather
// than beside the mocked cases because the thing being asserted is what the PROJECT now
// holds: a runner that agrees with whatever it is asked would record the product's
// intention, and the intention was never the doubt. The doubt is whether the sentence the
// user approved is the sentence that ends up in the repository their team reads.
describe("the commit says what the user approved, not what the product derived", () => {
  const BRANCH = "TEAM-1-skills-my-skill";
  const PROPOSAL = "TEAM-1 feat(skill): add my-skill";

  /** A project whose three rules are already answered, so nothing below is refused for a
   * prefix and every case measures the message and only the message. */
  function answered(): GitLabRepo {
    const repo = project({ rules: { branchName: BRANCH_RULE, commitMessage: MESSAGE_RULE, email: EMAIL_RULE } });
    initTeamRepo(repo.url, "acme-skills", home, gitAs(MEMBER), undefined, noForge, BRANCH_PREFIX, COMMIT_PREFIX);
    repo.mergeIntoDefault("TEAM-1-scaffold");
    return repo;
  }

  it("given no decision about the message, when a share is run, then nothing is committed and the proposal comes back to be shown", () => {
    const repo = answered();

    const outcome = share(MEMBER, "my-skill", {});

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("commit message required");
    // The refusal is also the screen: it carries the exact sentence to put in front of
    // the user, so the round trip it costs is the round trip that asks them.
    expect(outcome.proposedMessage).toBe(PROPOSAL);
    expect(repo.branches()).not.toContain(BRANCH);
  });

  it("given a message the user approved, when it is shared, then the commit the project holds carries that message word for word", () => {
    const repo = answered();

    const outcome = share(MEMBER, "my-skill", { message: "feat: the deploy runbook everyone keeps asking for" });

    expect(outcome.ok).toBe(true);
    // Their wording, with the prefix their project demands and nothing else added.
    expect(repo.subjectOn(BRANCH)).toBe("TEAM-1 feat: the deploy runbook everyone keeps asking for");
    expect(outcome.commitMessage).toBe("TEAM-1 feat: the deploy runbook everyone keeps asking for");
  });

  it("given the user answered that you decide, when it is shared, then the commit carries the very sentence the refusal had shown them", () => {
    const repo = answered();
    // The two runs are the point: whatever the first one said it would commit is what the
    // second one commits, so "you decide" delegates the wording the user was shown rather
    // than a second sentence derived somewhere else. The fingerprint is what ties them.
    const probe = share(MEMBER, "my-skill", {});

    const outcome = share(MEMBER, "my-skill", { delegated: probe.proposalHash! }, signedInForge);

    expect(outcome.ok).toBe(true);
    expect(repo.subjectOn(BRANCH)).toBe(probe.proposedMessage);
  });

  it("given a delegation naming a sentence that is no longer the one this would commit, when it is shared, then it is refused with the new one", () => {
    const repo = answered();
    // The fingerprint of some other proposal: what a conversation carries when the
    // selection has moved on since the user was asked, or a teammate's merge has.
    const outcome = share(MEMBER, "my-skill", { delegated: "deadbeef" }, signedInForge);

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("not the one this would commit any more");
    expect(outcome.error).toContain(PROPOSAL);
    expect(repo.branches()).not.toContain(BRANCH);
  });

  it("given a machine with no way to open a merge request, when the wording is delegated, then nothing is committed at all", () => {
    const repo = answered();
    const probe = share(MEMBER, "my-skill", {});

    // noForge is a machine without the CLI. Everywhere else that is a soft failure - the
    // branch is pushed and the user opens the request by hand - but a delegation was given
    // FOR that request, so here there is nothing to honour it at.
    const outcome = share(MEMBER, "my-skill", { delegated: probe.proposalHash! });

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("no merge request can be opened from this machine");
    expect(repo.branches()).not.toContain(BRANCH);
  });

  it("given the user hands the proposal straight back, when it is shared, then the prefix is on the commit once", () => {
    const repo = answered();
    // Approving by echoing the sentence is the likeliest answer of all, and it is the one
    // that used to produce "TEAM-1 TEAM-1 ..." - which the project's own rule would have
    // accepted, since the rule only looks at the front of the title.
    const probe = share(MEMBER, "my-skill", {});

    const outcome = share(MEMBER, "my-skill", { message: probe.proposedMessage! });

    expect(outcome.ok).toBe(true);
    expect(repo.subjectOn(BRANCH)).toBe(PROPOSAL);
  });
});
