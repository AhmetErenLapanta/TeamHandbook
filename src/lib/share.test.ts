import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildInventory,
  dialogRounds,
  duplicateCopies,
  formatInventory,
  formatPick,
  formatShareResult,
  pickByPattern,
  shareSelection as shareSelectionDeciding,
} from "./share.js";
import type { InventoryPaths, Selection, ShareResult } from "./share.js";
import { formatCandidateList, listCandidates, writeCandidateMeta } from "./queue.js";
import { sessionStartNotice } from "./notify.js";
import { formatReviewQueue, reviewQueue } from "./review-list.js";
import type { CandidateMeta } from "./queue.js";
import { approveAndDeliver } from "./deliver.js";
import { candidatesDir } from "./skill-index.js";
import type { CommitMessageChoice, GitRunner } from "./init.js";
import { teamAssets } from "./publish.js";


/**
 * The answer every case below gives about its commit message, because none of them is
 * about the wording: a plain sentence of the user's own. It carries no team prefix, so the
 * cases that measure the prefix still measure it. Delegating instead would cost every one
 * of them a second run, since "you decide" has to name the proposal it was shown.
 */
const APPROVED = { message: "chore: the case under test" } as const;

/**
 * The two runs a delegated wording takes: the first shows the sentence and commits
 * nothing, the second names its fingerprint back. Used where what the case measures is
 * the derived title reaching the commit.
 */
function delegating(run: (choice: CommitMessageChoice) => ShareResult): ShareResult {
  const probe = run({});
  return run({ delegated: probe.team!.proposalHash! });
}

/**
 * The two runs a share takes when the user confirms the branch it proposes: the first shows
 * the name and pushes nothing, the second names it back.
 */
type ShareArgs = Parameters<typeof shareSelectionDeciding>;
function shareSelection(
  selection: ShareArgs[0],
  team: ShareArgs[1],
  paths?: ShareArgs[2],
  git?: ShareArgs[3],
  forge?: ShareArgs[4],
  options: NonNullable<ShareArgs[5]> = {},
) {
  const decided = { commitMessage: APPROVED, ...options };
  if (decided.branch !== undefined) return shareSelectionDeciding(selection, team, paths, git, forge, decided);
  const probe = shareSelectionDeciding(selection, team, paths, git, forge, decided);
  const proposed = probe.team && !probe.team.ok ? probe.team.proposedBranch : undefined;
  return proposed ? shareSelectionDeciding(selection, team, paths, git, forge, { ...decided, branch: proposed }) : probe;
}

let home: string;
let userHome: string;
let project: string;
let configFile: string;
let remote: string;

function paths(): InventoryPaths {
  return { userHome, cwd: project, configFile };
}

function select(overrides: Partial<Selection> = {}): Selection {
  return { skills: [], servers: [], commands: [], skillPaths: [], ...overrides };
}

function gitIn(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

function writeSkill(root: string, name: string, files: Record<string, string> = {}): void {
  const dir = join(root, ".claude", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: What ${name} is for.\n---\n\nBody.\n`);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

function writeCommand(root: string, name: string, body: string): void {
  const file = join(root, ".claude", "commands", `${name}.md`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
}

function writeServers(servers: Record<string, unknown>): void {
  writeFileSync(configFile, JSON.stringify({ mcpServers: servers }, null, 2));
}

function teamRepo(seedFiles: Record<string, string> = {}): string {
  const bare = mkdtempSync(join(tmpdir(), "handbook-team-"));
  execFileSync("git", ["init", "--bare", "-b", "main", bare]);
  const seed = mkdtempSync(join(tmpdir(), "handbook-seed-"));
  try {
    execFileSync("git", ["clone", bare, join(seed, "repo")], { stdio: "ignore" });
    const repo = join(seed, "repo");
    mkdirSync(join(repo, "skills"), { recursive: true });
    writeFileSync(join(repo, "skills", "README.md"), "skills\n");
    mkdirSync(join(repo, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(repo, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "acme", version: "1.0.0" }, null, 2) + "\n",
    );
    for (const [path, content] of Object.entries(seedFiles)) {
      mkdirSync(join(repo, dirname(path)), { recursive: true });
      writeFileSync(join(repo, path), content);
    }
    gitIn(repo, ["add", "-A"]);
    gitIn(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "seed"]);
    gitIn(repo, ["push", "origin", "main"]);
  } finally {
    rmSync(seed, { recursive: true, force: true });
  }
  return bare;
}

function team() {
  return { repoUrl: remote, marketplaceName: "acme" };
}

const forge = () => "https://example.com/mr/1";

// A real credential shape, in a header, which auditServer refuses on structure alone.
const withCredential = {
  type: "http",
  url: "https://api.acme.com/mcp",
  headers: { Authorization: "Bearer 8f2c41d9ab7e05631cd4a29f" },
};

// The other shape, and the one measurement showed the header/env nets both miss: the
// provider puts the secret in the endpoint itself. Nothing about this server is a
// literal in headers or env, so only the URL scan turns it back.
const TOKEN_IN_URL = "638a99e4-b962-4002-9f1c-1a2b3c4d5e6f";
const withTokenInUrl = { type: "http", url: `https://mcp.example.com/${TOKEN_IN_URL}/mcp` };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "handbook-home-"));
  userHome = mkdtempSync(join(tmpdir(), "handbook-user-"));
  project = mkdtempSync(join(tmpdir(), "handbook-project-"));
  configFile = join(mkdtempSync(join(tmpdir(), "handbook-config-")), ".claude.json");
  writeServers({});
  remote = "";
});

afterEach(() => {
  for (const dir of [home, userHome, project, dirname(configFile)]) {
    rmSync(dir, { recursive: true, force: true });
  }
  if (remote) rmSync(remote, { recursive: true, force: true });
});

describe("buildInventory", () => {
  it("given skills and servers on this machine, when the inventory is read, then both kinds arrive with their scope", () => {
    writeSkill(userHome, "deploy-runbook");
    writeSkill(project, "repo-conventions");
    writeServers({ gitlab: { type: "http", url: "https://gitlab.com/api/v4/mcp" } });

    const inv = buildInventory(paths());

    expect(inv.skills.map((s) => [s.name, s.scope, s.shareable])).toEqual([
      ["deploy-runbook", "personal", true],
      ["repo-conventions", "project", true],
    ]);
    expect(inv.skills[0]!.description).toBe("What deploy-runbook is for.");
    expect(inv.servers.map((s) => [s.name, s.shareable])).toEqual([["gitlab", true]]);
  });

  it("given a skill carrying a credential, when the inventory is read, then it is listed and the reason names the file", () => {
    writeSkill(userHome, "deploy-runbook", { "scripts/seed.sh": "export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n" });
    writeSkill(userHome, "repo-conventions");

    const inv = buildInventory(paths());
    const refused = inv.skills.find((s) => s.name === "deploy-runbook")!;

    // listed, not filtered out: a manager who only sees what is offered concludes the
    // rest does not exist, and there is one edit between them and sharing it
    expect(refused.shareable).toBe(false);
    expect(refused.reason).toContain("scripts/seed.sh");
    expect(refused.reason).toContain("aws-access-key");
    expect(inv.skills.find((s) => s.name === "repo-conventions")!.shareable).toBe(true);
  });

  it("given a server carrying a credential, when the inventory is read, then it is listed with the key to rewrite", () => {
    writeServers({ "acme-api": withCredential, gitlab: { type: "http", url: "https://gitlab.com/api/v4/mcp" } });

    const inv = buildInventory(paths());
    const refused = inv.servers.find((s) => s.name === "acme-api")!;

    expect(refused.shareable).toBe(false);
    expect(refused.reason).toContain("headers.Authorization");
    expect(inv.servers.find((s) => s.name === "gitlab")!.shareable).toBe(true);
  });

  it("given a server whose credential is in its URL, when the inventory is read, then the endpoint scan is what lists it", () => {
    writeServers({ zapier: withTokenInUrl });

    const server = buildInventory(paths()).servers[0]!;

    expect(server.shareable).toBe(false);
    expect(server.reason).toContain("looks like a credential");
    expect(formatInventory(buildInventory(paths()))).toContain("not shareable: its URL carries");
  });

  it("given a skill left in the review queue by the old flow, when the inventory is read, then it is still offered", () => {
    // The shape nine skills were actually found in on a real machine: copied into the
    // queue by the flow that used to put them there, with no candidate.json. That copy
    // used to make the screen refuse the skill - "already waiting in the review queue" -
    // while the queue never showed it either, so it could be neither shared nor withdrawn.
    writeSkill(userHome, "deploy-runbook");
    const queued = join(candidatesDir(home), "deploy-runbook");
    mkdirSync(queued, { recursive: true });
    writeFileSync(join(queued, "SKILL.md"), "---\nname: deploy-runbook\ndescription: old copy\n---\n");

    const inv = buildInventory(paths());

    expect(inv.skills[0]!.shareable).toBe(true);
    expect(inv.skills[0]!.reason).toBeUndefined();
  });

  it("given a skill left in the review queue by the old flow, when it is shared, then it travels and the old copy is untouched", () => {
    remote = teamRepo();
    writeSkill(userHome, "deploy-runbook");
    const queued = join(candidatesDir(home), "deploy-runbook");
    mkdirSync(queued, { recursive: true });
    const stale = "---\nname: deploy-runbook\ndescription: old copy\n---\n";
    writeFileSync(join(queued, "SKILL.md"), stale);

    const result = shareSelection(select({ skills: ["deploy-runbook"] }), team(), paths(), undefined, forge);

    expect(result.refused).toEqual([]);
    expect(result.team).toMatchObject({ ok: true, skillNames: ["deploy-runbook"] });
    // what travelled is the INSTALLED skill, not the stale queue copy
    expect(gitIn(remote, ["show", `${result.team!.branch!}:skills/deploy-runbook/SKILL.md`])).toContain(
      "What deploy-runbook is for.",
    );
    // and nothing rewrote or removed what was already in the user's queue
    expect(readFileSync(join(queued, "SKILL.md"), "utf8")).toBe(stale);
  });

  it("given a skill carrying a home path, when the inventory is read, then the screen offers it as unshareable and says where", () => {
    // Assembled rather than written out: this repository refuses a literal absolute home
    // path on any line it takes in, a fixture's included.
    const homePath = ["", "Users", "alice", "work", "api"].join("/");
    writeSkill(userHome, "deploy-runbook", { "reference/setup.md": `Run it from ${homePath}.\n` });

    const skill = buildInventory(paths()).skills[0]!;

    expect(skill.shareable).toBe(false);
    expect(skill.shareable === false && skill.reason).toContain("reference/setup.md:1 carries a trace of this machine");
    expect(skill.shareable === false && skill.reason).toContain("home-path");
    expect(JSON.stringify(skill)).not.toContain("alice");
  });

  it("given a command and a server that carry this machine, when the inventory is read, then both are offered as unshareable with their class", () => {
    // All three kinds leave through this one screen, so all three are screened here.
    const standIn = "alice";
    const homePath = ["", "Users", standIn, "work", "api"].join("/");
    writeCommand(userHome, "deploy", `Run it from ${homePath}.\n`);
    writeServers({ notes: { command: "node", args: [`${homePath}/servers/notes.js`] } });

    const inv = buildInventory(paths());

    const command = inv.commands[0]!;
    const server = inv.servers[0]!;
    expect(command.shareable).toBe(false);
    expect(command.shareable === false && command.reason).toContain("carries a trace of this machine");
    expect(server.shareable).toBe(false);
    expect(server.shareable === false && server.reason).toContain("carries a trace of this machine");
    // Only the sentences are checked: the inventory itself holds the server definition as
    // the user's own config has it, which is this machine describing itself to its owner.
    const said = [
      command.shareable === false && command.reason,
      server.shareable === false && server.reason,
      server.shareable === false && server.fullReason,
    ].join(" ");
    expect(said).not.toContain(standIn);
  });

  it("given a file sitting beside the skills, when the inventory is read, then it is not a skill that failed", () => {
    writeSkill(userHome, "deploy-runbook");
    writeFileSync(join(userHome, ".claude", "skills", ".DS_Store"), "junk");

    expect(buildInventory(paths()).skills.map((s) => s.name)).toEqual(["deploy-runbook"]);
  });

  it("given the same name in both scopes, when the inventory is read, then the project one wins as Claude Code resolves it", () => {
    writeSkill(userHome, "deploy-runbook");
    writeSkill(project, "deploy-runbook");

    const inv = buildInventory(paths());

    expect(inv.skills).toHaveLength(1);
    expect(inv.skills[0]!.scope).toBe("project");
    expect(inv.skills[0]!.dir.startsWith(project)).toBe(true);
  });

  it("given nothing set up at all, when the list is formatted, then it says so rather than printing an empty frame", () => {
    expect(formatInventory(buildInventory(paths()))).toContain("nothing to take to the team yet");
  });

  it("given a mixed inventory, when the list is formatted, then every section says what picking it does", () => {
    writeSkill(userHome, "deploy-runbook");
    writeServers({ gitlab: { type: "http", url: "https://gitlab.com/api/v4/mcp" } });

    const text = formatInventory(buildInventory(paths()));

    // every kind now has the same consequence, and the screen has to say so: a reader who
    // still believes a skill stops here picks one thinking it cannot be seen by anyone
    expect(text).toContain("Skills (1) - the ones you pick go out as part of ONE merge request");
    expect(text).toContain("MCP servers (1) - the ones you pick travel in that SAME merge request");
    expect(text).toContain("Everything you pick travels together, in one merge request");
    expect(text).not.toContain("nothing leaves this machine");
    expect(text).toContain("Nothing is selected and nothing has been shared.");
  });
});

describe("a refused entry says which line to fix, and never what is on it", () => {
  // Assembled rather than written out: this repository refuses a literal absolute home
  // path on any line it takes in, a fixture's included.
  const standIn = "alice";
  const homePath = ["", "Users", standIn, "work", "api"].join("/");
  const githubToken = `ghp_${"a1B2c3D4e5".repeat(3)}`;

  it("given a home path on the third line of a skill's script, when the list is read, then it names the file, the line and the class", () => {
    writeSkill(userHome, "deploy-runbook", {
      "scripts/helper.sh": `#!/bin/sh\nset -e\ncd ${homePath}\n`,
    });

    const skill = buildInventory(paths()).skills[0]!;

    expect(skill.shareable).toBe(false);
    expect(skill.reason).toBe(
      "scripts/helper.sh:3 carries a trace of this machine, a home directory path (home-path) - " +
        "edit the line and run share again",
    );
  });

  it("given a home path in a skill, when the whole screen is printed, then neither the stand-in nor the path reaches it", () => {
    writeSkill(userHome, "deploy-runbook", { "scripts/helper.sh": `cd ${homePath}\n` });

    const screen = formatInventory(buildInventory(paths()));

    expect(screen).toContain("scripts/helper.sh:1");
    expect(screen).not.toContain(standIn);
    expect(screen).not.toContain(["", "Users", ""].join("/"));
  });

  it("given a credential on the second line of a skill's file, when the list is read, then it names the line and not the value", () => {
    writeSkill(userHome, "deploy-runbook", { "scripts/seed.sh": `#!/bin/sh\nexport GITHUB_TOKEN=${githubToken}\n` });

    const skill = buildInventory(paths()).skills[0]!;

    expect(skill.reason).toBe(
      "scripts/seed.sh:2 looks like it contains a secret (github-token) - " +
        "take the credential out of that line and run share again",
    );
    expect(formatInventory(buildInventory(paths()))).not.toContain(githubToken);
  });

  it("given a home path on a command's second line, when the list is read, then the command is located the same way", () => {
    writeCommand(userHome, "deploy", `Deploy the service.\nRun it from ${homePath}.\n`);

    const command = buildInventory(paths()).commands[0]!;

    expect(command.reason).toBe(
      "deploy.md:2 carries a trace of this machine, a home directory path (home-path) - edit the line and run share again",
    );
    expect(command.reason).not.toContain(standIn);
  });

  it("given a credential in a command, when the list is read, then it names the line and not the value", () => {
    writeCommand(userHome, "release", `Publish it.\n\nexport GITHUB_TOKEN=${githubToken}\n`);

    const command = buildInventory(paths()).commands[0]!;

    expect(command.reason).toContain("release.md:3 looks like it contains a secret (github-token)");
    expect(command.reason).not.toContain(githubToken);
  });

  it("given a server whose arguments carry a home path, when the list is read, then it names the argument and not the path", () => {
    writeServers({ notes: { command: "node", args: ["--stdio", `${homePath}/servers/notes.js`] } });

    const server = buildInventory(paths()).servers[0]!;

    expect(server.reason).toBe(
      "its args[1] carries a trace of this machine, a home directory path (home-path) - edit that value and run share again",
    );
    expect(`${server.reason} ${server.fullReason}`).not.toContain(standIn);
  });

  it("given a server whose arguments carry a token, when the list is read, then it names the argument and not the token", () => {
    writeServers({ repo: { command: "npx", args: ["repo-mcp", githubToken] } });

    const server = buildInventory(paths()).servers[0]!;

    expect(server.reason).toContain("its args[1] looks like it contains a secret (github-token)");
    expect(`${server.reason} ${server.fullReason}`).not.toContain(githubToken);
  });
});

describe("picking by name or pattern before any dialog", () => {
  // More than one dialog's worth: twenty-five skills, four of which share a prefix, two
  // servers and two commands - twenty-nine things that can travel.
  const ADD = ["add-flag", "add-job", "add-migration", "add-route"];
  const OTHER = Array.from({ length: 21 }, (_, i) => `runbook-${String(i + 1).padStart(2, "0")}`);

  function crowdedSetup(): void {
    for (const name of [...ADD, ...OTHER]) writeSkill(userHome, name);
    writeServers({
      gitlab: { type: "http", url: "https://gitlab.com/api/v4/mcp" },
      notes: { command: "notes-mcp" },
    });
    writeCommand(userHome, "deploy", "Deploy the service.\n");
    writeCommand(userHome, "release", "Cut a release.\n");
  }

  it("given twenty-nine shareable entries, when add-* is typed, then exactly the four add- skills are picked", () => {
    crowdedSetup();

    const picked = pickByPattern(buildInventory(paths()), "add-*");

    expect("error" in picked).toBe(false);
    if ("error" in picked) return;
    expect(picked.offered).toBe(29);
    expect(picked.selection).toEqual({ skills: ADD, servers: [], commands: [] });
    expect(picked.remaining.skills).toEqual(OTHER);
  });

  it("given a pick, when it is printed, then it counts what was picked and hands back the exact share command", () => {
    crowdedSetup();
    const picked = pickByPattern(buildInventory(paths()), "add-*, no mcp");
    if ("error" in picked) throw new Error(picked.error);

    expect(formatPick(picked)).toBe(
      [
        "Picked 4 of the 29 that can be shared:",
        "  skills (4): add-flag, add-job, add-migration, add-route",
        "",
        "Ruled out: 2.",
        "",
        "Not decided yet: 21 skills, 2 commands. A dialog asks only about these, if you want any of them.",
        "",
        "Nothing has been shared. To share exactly these:",
        "  share.js share --skill add-flag --skill add-job --skill add-migration --skill add-route",
      ].join("\n"),
    );
  });

  it("given a name nothing on this machine answers to, when it is typed, then the whole pick is refused rather than half of it kept", () => {
    crowdedSetup();

    const picked = pickByPattern(buildInventory(paths()), "add-*, deploy-runbook");

    expect(picked).toEqual({
      error: '"deploy-runbook" matches nothing on this screen, so nothing was picked; use the names the list printed',
    });
  });

  it("given a bare wildcard, when it is typed, then it is refused and all has to be written out", () => {
    crowdedSetup();
    const inv = buildInventory(paths());

    for (const bare of ["*", "**", "?*"]) {
      const picked = pickByPattern(inv, bare);
      expect("error" in picked && picked.error).toContain('write "all"');
    }
    const ruledOut = pickByPattern(inv, "all skills, no *");
    expect("error" in ruledOut && ruledOut.error).toContain('write "all"');
  });

  it("given all written out, when it is typed, then it picks every shareable entry of that kind and no other", () => {
    crowdedSetup();
    const inv = buildInventory(paths());

    const skills = pickByPattern(inv, "all skills");
    const everything = pickByPattern(inv, "all");

    if ("error" in skills || "error" in everything) throw new Error("refused");
    expect(skills.selection).toEqual({ skills: [...ADD, ...OTHER], servers: [], commands: [] });
    expect(skills.remaining).toEqual({ skills: [], servers: ["gitlab", "notes"], commands: ["deploy", "release"] });
    expect(everything.selection.skills.length + everything.selection.servers.length + everything.selection.commands.length).toBe(29);
  });

  it("given a pattern that also matches an entry the screen refuses, when it is typed, then that one is named with its reason and not picked", () => {
    crowdedSetup();
    writeSkill(userHome, "add-secret", { "seed.sh": "export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n" });

    const picked = pickByPattern(buildInventory(paths()), "add-*");

    if ("error" in picked) throw new Error(picked.error);
    expect(picked.selection.skills).toEqual(ADD);
    expect(picked.unshareable).toEqual([
      {
        kind: "skill",
        name: "add-secret",
        reason: "seed.sh:1 looks like it contains a secret (aws-access-key) - take the credential out of that line and run share again",
      },
    ]);
  });

  it("given a ruling-out typed without a comma, when it is read, then it means what it would with one", () => {
    crowdedSetup();
    const inv = buildInventory(paths());

    const spoken = pickByPattern(inv, "add-* no mcp");

    expect(spoken).toEqual(pickByPattern(inv, "add-*, no mcp"));
    expect("error" in spoken).toBe(false);
  });

  it("given a kind ruled out and a name ruled out, when they are typed, then neither is picked nor left for a dialog", () => {
    crowdedSetup();

    const picked = pickByPattern(buildInventory(paths()), "add-*, no add-route, no commands");

    if ("error" in picked) throw new Error(picked.error);
    expect(picked.selection.skills).toEqual(["add-flag", "add-job", "add-migration"]);
    expect(picked.declined).toBe(3);
    expect(picked.remaining.commands).toEqual([]);
    expect(picked.remaining.skills).toEqual(OTHER);
  });

  it("given more than one dialog's worth, when the first screen is printed, then the typed way in comes before the first entry", () => {
    crowdedSetup();
    const inv = buildInventory(paths());

    const screen = formatInventory(inv);

    expect(dialogRounds(inv)).toBe(3);
    expect(screen.split("\n").slice(0, 5)).toEqual([
      "Your local Claude Code setup, as it is on this machine:",
      "",
      "29 of these can be shared, and picking them through dialogs takes 3 rounds.",
      "Name what you want first instead: type names or patterns such as add-*, all skills or no mcp,",
      "and the dialogs then cover only what is left.",
    ]);
    expect(screen.indexOf("add-*")).toBeLessThan(screen.indexOf("1. add-flag"));
  });

  it("given a setup one dialog holds, when the first screen is printed, then it opens on the list as before", () => {
    writeSkill(userHome, "deploy-runbook");
    writeServers({ gitlab: { type: "http", url: "https://gitlab.com/api/v4/mcp" } });

    const screen = formatInventory(buildInventory(paths()));

    expect(screen).not.toContain("type names or patterns");
    expect(screen.split("\n").slice(0, 3)).toEqual([
      "Your local Claude Code setup, as it is on this machine:",
      "",
      "Skills (1) - the ones you pick go out as part of ONE merge request to the team repository",
    ]);
  });
});

describe("a copy the team plugin already carries", () => {
  let pluginDir: string;

  beforeEach(() => {
    pluginDir = mkdtempSync(join(tmpdir(), "handbook-plugin-"));
  });

  afterEach(() => {
    rmSync(pluginDir, { recursive: true, force: true });
  });

  /** The team plugin's copy on this machine, laid out the way the team repository is. */
  function inPlugin(path: string, content: string): void {
    mkdirSync(join(pluginDir, dirname(path)), { recursive: true });
    writeFileSync(join(pluginDir, path), content);
  }

  function skillMd(name: string, body = "Body."): string {
    return `---\nname: ${name}\ndescription: What ${name} is for.\n---\n\n${body}\n`;
  }

  function countFiles(dir: string): number {
    return execFileSync("find", [dir, "-type", "f"], { encoding: "utf8" }).split("\n").filter(Boolean).length;
  }

  function mixedSetup(): void {
    inPlugin(".claude-plugin/plugin.json", JSON.stringify({ name: "acme", version: "1.4.0" }));
    writeSkill(userHome, "deploy-runbook", { "scripts/run.sh": "make deploy\n" });
    inPlugin("skills/deploy-runbook/SKILL.md", skillMd("deploy-runbook"));
    inPlugin("skills/deploy-runbook/scripts/run.sh", "make deploy\n");
    // the same name, but the team's copy has moved on: removing yours would lose your version
    writeSkill(userHome, "repo-conventions");
    inPlugin("skills/repo-conventions/SKILL.md", skillMd("repo-conventions", "A teammate's edit."));
    writeSkill(userHome, "only-mine");
    // a project's skill belongs to that repository, so it is never offered for removal
    writeSkill(project, "project-rules");
    inPlugin("skills/project-rules/SKILL.md", skillMd("project-rules"));
    const notes = { command: "notes-mcp", args: ["--stdio"] };
    writeServers({ notes, gitlab: { type: "http", url: "https://gitlab.com/api/v4/mcp" } });
    inPlugin(
      ".mcp.json",
      JSON.stringify({ mcpServers: { notes: { args: ["--stdio"], command: "notes-mcp" }, gitlab: { type: "http", url: "https://gitlab.example.com/mcp" } } }),
    );
    writeCommand(userHome, "deploy", "Deploy the service.\n");
    inPlugin("commands/deploy.md", "Deploy the service.\n");
    writeCommand(userHome, "release", "Cut a release.\n");
    inPlugin("commands/release.md", "Cut a release, then tag it.\n");
  }

  it("given copies that match the team's and copies that only share a name, when they are compared, then only the identical ones are named", () => {
    mixedSetup();

    const duplicates = duplicateCopies(buildInventory(paths()), pluginDir, paths());

    expect(duplicates.copies).toEqual([
      { kind: "skill", name: "deploy-runbook", remove: "rm -r ~/.claude/skills/deploy-runbook" },
      { kind: "mcp", name: "notes", remove: "claude mcp remove notes -s user" },
      { kind: "command", name: "deploy", remove: "rm ~/.claude/commands/deploy.md" },
    ]);
    // the release they were compared against, since the copy that loads can lag behind it
    expect(duplicates.release).toEqual({ name: "acme", version: "1.4.0" });
  });

  it("given duplicates, when the list and a share result are printed, then they name them and offer the commands without running any", () => {
    mixedSetup();
    const before = countFiles(userHome) + countFiles(pluginDir) + countFiles(project);

    const inv = buildInventory(paths());
    const duplicates = duplicateCopies(inv, pluginDir, paths());
    const screen = formatInventory(inv, undefined, duplicates);
    const result = formatShareResult({ refused: [] }, "acme", duplicates);

    const offer = [
      "On this machine twice (3): the team plugin here carries an identical copy of each.",
      "  skills: deploy-runbook",
      "  MCP servers: notes",
      "  commands: /deploy",
      "Nothing was removed, and both copies load until yours goes. Once /plugin shows",
      "acme installed at 1.4.0 or later, these remove your own copies:",
      "  rm -r ~/.claude/skills/deploy-runbook",
      "  claude mcp remove notes -s user",
      "  rm ~/.claude/commands/deploy.md",
    ].join("\n");
    expect(screen.endsWith(offer)).toBe(true);
    expect(result).toBe(offer);
    expect(countFiles(userHome) + countFiles(pluginDir) + countFiles(project)).toBe(before);
    expect(existsSync(join(userHome, ".claude", "skills", "deploy-runbook", "SKILL.md"))).toBe(true);
  });

  it("given no team plugin on this machine, when the copies are compared, then nothing is a duplicate", () => {
    writeSkill(userHome, "deploy-runbook");
    writeCommand(userHome, "deploy", "Deploy the service.\n");

    const duplicates = duplicateCopies(buildInventory(paths()), join(pluginDir, "absent"), paths());

    expect(duplicates).toEqual({ copies: [], release: null });
    expect(formatInventory(buildInventory(paths()), undefined, duplicates)).not.toContain("On this machine twice");
  });
});

describe("shareSelection", () => {
  it("given nothing was selected, when the selection runs, then nothing travels and git is never called", () => {
    writeSkill(userHome, "deploy-runbook");
    writeServers({ gitlab: { type: "http", url: "https://gitlab.com/api/v4/mcp" } });
    const calls: string[][] = [];
    const recordingGit: GitRunner = (args) => {
      calls.push(args);
      return "";
    };

    const result = shareSelection(select(), team(), paths(), recordingGit, forge);

    // "all" is not the default and neither is anything else: the empty selection is the
    // one the user is protected by
    expect(result).toEqual({ refused: [] });
    expect(listCandidates(home, "pending")).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("given one skill was selected, when the selection runs, then the whole skill reaches the team repository", () => {
    remote = teamRepo();
    writeSkill(userHome, "deploy-runbook", { "references/checklist.md": "1. drain\n" });
    writeSkill(userHome, "repo-conventions");

    const result = shareSelection(select({ skills: ["deploy-runbook"] }), team(), paths(), undefined, forge);

    expect(result.refused).toEqual([]);
    expect(result.team).toMatchObject({ ok: true, skillNames: ["deploy-runbook"], version: "1.0.1" });
    const branch = result.team!.branch!;
    // the whole skill, not just its SKILL.md
    expect(gitIn(remote, ["show", `${branch}:skills/deploy-runbook/references/checklist.md`])).toContain("drain");
    expect(gitIn(remote, ["show", `${branch}:skills/deploy-runbook/SKILL.md`])).toContain("deploy-runbook");
    // the one that was not selected did not travel
    expect(() => gitIn(remote, ["show", `${branch}:skills/repo-conventions/SKILL.md`])).toThrow();
    // the review queue is not on a shared skill's way any more
    expect(listCandidates(home, "pending")).toEqual([]);
  });

  it("given no team repository is configured, when a skill is selected, then it is turned back by name rather than queued", () => {
    writeSkill(userHome, "deploy-runbook");

    const result = shareSelection(select({ skills: ["deploy-runbook"] }), null, paths());

    expect(result.team).toBeUndefined();
    expect(result.refused).toEqual([
      { name: "deploy-runbook", kind: "skill", reason: expect.stringContaining("no team repository is configured") },
    ]);
    expect(listCandidates(home, "pending")).toEqual([]);
  });

  it("given no decision about the commit message, when several things are selected, then the request is asked about once, not once per name", () => {
    remote = teamRepo();
    writeSkill(userHome, "deploy-runbook");
    writeSkill(userHome, "repo-conventions");
    writeServers({ gitlab: { type: "http", url: "https://gitlab.com/api/v4/mcp" } });
    const before = gitIn(remote, ["branch", "--list"]);

    // the imported function, not the delegating wrapper: the answer is what is under test
    const result = shareSelectionDeciding(
      select({ skills: ["deploy-runbook", "repo-conventions"], servers: ["gitlab"] }),
      team(),
      paths(),
      undefined,
      forge,
    );

    expect(result.team?.ok).toBe(false);
    expect(result.team?.proposedMessage).toBe("feat(skill,mcp): add deploy-runbook, repo-conventions, gitlab");
    // One question about one request. Fanning it out would have turned a single four-line
    // sentence into three, and buried the proposal it is asking the user to read.
    expect(result.refused).toEqual([]);
    const printed = formatShareResult(result);
    expect(printed.match(/commit message required/g)).toHaveLength(1);
    expect(printed).toContain("feat(skill,mcp): add deploy-runbook, repo-conventions, gitlab");
    expect(gitIn(remote, ["branch", "--list"])).toBe(before);
  });

  it("given the user's own wording, when the selection runs, then the commit carries it and the result says so", () => {
    remote = teamRepo();
    writeSkill(userHome, "deploy-runbook");

    const result = shareSelection(
      select({ skills: ["deploy-runbook"] }),
      team(),
      paths(),
      undefined,
      forge,
      { commitMessage: { message: "feat: the deploy runbook, written down at last" } },
    );

    expect(result.team).toMatchObject({ ok: true, commitMessage: "feat: the deploy runbook, written down at last" });
    const branch = result.team!.branch!;
    expect(gitIn(remote, ["log", "-1", "--format=%s", branch]).trim()).toBe(
      "feat: the deploy runbook, written down at last",
    );
    expect(formatShareResult(result)).toContain("commit: feat: the deploy runbook, written down at last");
  });

  it("given a few of each were selected, when the selection runs, then every kind goes out in one request", () => {
    remote = teamRepo();
    writeSkill(userHome, "deploy-runbook");
    writeSkill(userHome, "repo-conventions");
    writeSkill(userHome, "incident-drill");
    writeServers({
      gitlab: { type: "http", url: "https://gitlab.com/api/v4/mcp" },
      linear: { type: "sse", url: "https://mcp.linear.app/sse" },
    });

    const result = shareSelection(
      select({ skills: ["deploy-runbook", "repo-conventions"], servers: ["gitlab", "linear"] }),
      team(),
      paths(),
      undefined,
      forge,
    );

    expect(result.refused).toEqual([]);
    expect(result.team).toMatchObject({
      ok: true,
      serverNames: ["gitlab", "linear"],
      skillNames: ["deploy-runbook", "repo-conventions"],
      // ONE bump for the whole selection, which is the reason they share a request
      version: "1.0.1",
    });
    const branch = result.team!.branch!;
    const declared = JSON.parse(gitIn(remote, ["show", `${branch}:.mcp.json`]));
    expect(Object.keys(declared.mcpServers).sort()).toEqual(["gitlab", "linear"]);
    // the skill nobody picked is still only on this machine
    expect(() => gitIn(remote, ["show", `${branch}:skills/incident-drill/SKILL.md`])).toThrow();
    // one commit carried all four
    expect(gitIn(remote, ["log", "--oneline", branch]).trim().split("\n")).toHaveLength(2);
  });

  it("given one screen sent a skill and a server, when the result is reported, then both are named in the one request", () => {
    remote = teamRepo();
    writeSkill(userHome, "deploy-runbook");
    writeServers({ gitlab: { type: "http", url: "https://gitlab.com/api/v4/mcp" } });

    const result = shareSelection(
      select({ skills: ["deploy-runbook"], servers: ["gitlab"] }),
      team(),
      paths(),
      undefined,
      forge,
    );
    const text = formatShareResult(result, "acme");

    // One screen, one destination, and the count is the whole selection. The kinds are
    // still named separately: a skill somebody reads and a server that connects are not
    // interchangeable to the manager checking what they just sent.
    expect(text).toContain("Shared with the team (2) in one merge request:");
    expect(text).toContain("  - skills (1): deploy-runbook");
    expect(text).toContain("  - MCP servers (1): gitlab");
    // the review queue is no longer on a shared skill's way, and the sentence is true of
    // the disk rather than just of itself
    expect(text).not.toContain("Queued for review");
    expect(listCandidates(home, "pending")).toEqual([]);
    const branch = result.team!.branch!;
    expect(gitIn(remote, ["ls-tree", "-r", "--name-only", branch])).toContain("skills/deploy-runbook/SKILL.md");
    expect(JSON.parse(gitIn(remote, ["show", `${branch}:.mcp.json`])).mcpServers.gitlab).toBeTruthy();
  });

  it("given a skill directory the screen cannot list, when it is named by path, then it travels like any other", () => {
    remote = teamRepo();
    const elsewhere = mkdtempSync(join(tmpdir(), "handbook-elsewhere-"));
    try {
      writeSkill(elsewhere, "release-drill");

      const result = shareSelection(
        select({ skillPaths: [join(elsewhere, ".claude", "skills", "release-drill")] }),
        team(),
        paths(),
        undefined,
        forge,
      );

      // the inventory reads the two directories Claude Code loads from, and this is in
      // neither, so the screen could not have offered it: the path is the only way in
      expect(buildInventory(paths()).skills.map((s) => s.name)).not.toContain("release-drill");
      expect(result.team).toMatchObject({ ok: true, skillNames: ["release-drill"] });
      expect(gitIn(remote, ["show", `${result.team!.branch!}:skills/release-drill/SKILL.md`])).toContain("release-drill");
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("given a skill named by path hides a credential, when the selection runs, then it is refused before git is reached", () => {
    remote = teamRepo();
    const elsewhere = mkdtempSync(join(tmpdir(), "handbook-elsewhere-"));
    const calls: string[][] = [];
    const recordingGit: GitRunner = (args) => {
      calls.push(args);
      return "";
    };
    try {
      writeSkill(elsewhere, "release-drill", { "scripts/seed.sh": "export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n" });

      const result = shareSelection(
        select({ skillPaths: [join(elsewhere, ".claude", "skills", "release-drill")] }),
        team(),
        paths(),
        recordingGit,
        forge,
      );

      // naming a directory instead of picking a row is not a way around the audit: the
      // screen is advisory and the audit inside publishTeamSelection is the boundary, on
      // both routes in
      expect(result.refused).toMatchObject([
        { name: "release-drill", kind: "skill", reason: expect.stringContaining("scripts/seed.sh") },
      ]);
      // and the refusal happens while the credential exists nowhere but this process: no
      // clone, no index, no working tree a later crash could leave behind
      expect(calls).toEqual([]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("given two servers were selected, when they are shared, then ONE request claims ONE version rather than two claiming the same one", () => {
    remote = teamRepo();
    writeServers({
      gitlab: { type: "http", url: "https://gitlab.com/api/v4/mcp" },
      linear: { type: "sse", url: "https://mcp.linear.app/sse" },
    });

    const result = delegating((commitMessage) =>
      shareSelection(select({ servers: ["gitlab", "linear"] }), team(), paths(), undefined, forge, {
        commitMessage,
      }),
    );

    // The defect this guards: two requests opened off the same base both write "1.0.1",
    // git merges the identical line without a conflict, and the second server lands
    // with no version of its own, so no teammate's copy refreshes for it.
    const branches = gitIn(remote, ["branch", "--list"]).trim().split("\n").map((b) => b.replace("*", "").trim());
    expect(branches.filter((b) => b !== "main")).toEqual([result.team!.branch]);
    expect(result.team!.version).toBe("1.0.1");
    expect(JSON.parse(gitIn(remote, ["show", `${result.team!.branch}:.claude-plugin/plugin.json`])).version).toBe("1.0.1");
    // one commit, carrying both servers and the version signal together
    const commits = gitIn(remote, ["log", "--format=%s", `main..${result.team!.branch}`]).trim().split("\n");
    expect(commits).toHaveLength(1);
    expect(commits[0]).toBe("feat(mcp): add gitlab, linear");
  });

  it("given everything was selected, when one skill hides a credential, then that one is refused and the rest still travel", () => {
    remote = teamRepo();
    writeSkill(userHome, "deploy-runbook");
    writeSkill(userHome, "incident-drill", { "references/queries.sql": "-- pass: AKIAIOSFODNN7EXAMPLE\n" });
    writeSkill(userHome, "repo-conventions");
    writeServers({ gitlab: { type: "http", url: "https://gitlab.com/api/v4/mcp" } });
    const inv = buildInventory(paths());

    const result = shareSelection(
      select({ skills: inv.skills.map((s) => s.name), servers: inv.servers.map((s) => s.name) }),
      team(),
      paths(),
      undefined,
      forge,
    );

    // selecting everything does not lower the bar the one-at-a-time path holds
    expect(result.refused).toMatchObject([
      { name: "incident-drill", kind: "skill", reason: expect.stringContaining("references/queries.sql") },
    ]);
    expect(result.team).toMatchObject({
      ok: true,
      serverNames: ["gitlab"],
      skillNames: ["deploy-runbook", "repo-conventions"],
    });
    expect(() => gitIn(remote, ["show", `${result.team!.branch!}:skills/incident-drill/SKILL.md`])).toThrow();
  });

  it("given everything was selected, when one server carries a credential, then it never reaches git and the clean one still goes", () => {
    remote = teamRepo();
    const calls: string[][] = [];
    const recordingGit: GitRunner = (args, cwd) => {
      calls.push(args);
      return execFileSync("git", args, { cwd, encoding: "utf8" });
    };
    writeServers({ "acme-api": withCredential, gitlab: { type: "http", url: "https://gitlab.com/api/v4/mcp" } });

    const result = shareSelection(select({ servers: ["acme-api", "gitlab"] }), team(), paths(), recordingGit, forge);

    expect(result.team).toMatchObject({ ok: true, serverNames: ["gitlab"] });
    expect(result.refused).toMatchObject([
      { name: "acme-api", kind: "mcp", reason: expect.stringContaining("headers.Authorization") },
    ]);
    // the credential reached no clone, no index and no working tree: not one git argument
    // in the whole run contains it, and the file that was committed does not declare it
    const everyArgument = calls.flat().join(" ");
    expect(everyArgument).not.toContain("8f2c41d9ab7e05631cd4a29f");
    const declared = JSON.parse(gitIn(remote, ["show", `${result.team!.branch}:.mcp.json`]));
    expect(Object.keys(declared.mcpServers)).toEqual(["gitlab"]);
  });

  it("given everything was selected, when a server hides its credential in the URL, then the endpoint scan turns it back too", () => {
    remote = teamRepo();
    const calls: string[][] = [];
    const recordingGit: GitRunner = (args, cwd) => {
      calls.push(args);
      return execFileSync("git", args, { cwd, encoding: "utf8" });
    };
    writeServers({ zapier: withTokenInUrl, gitlab: { type: "http", url: "https://gitlab.com/api/v4/mcp" } });

    const result = shareSelection(select({ servers: ["zapier", "gitlab"] }), team(), paths(), recordingGit, forge);

    // Selecting several does not lower the bar to the weakest of the three nets: this one
    // passes the headers/env rule and detectSecret, and only the URL scan catches it.
    expect(result.refused).toMatchObject([{ name: "zapier", kind: "mcp", reason: expect.stringContaining("its URL carries") }]);
    expect(result.team).toMatchObject({ ok: true, serverNames: ["gitlab"] });
    expect(calls.flat().join(" ")).not.toContain(TOKEN_IN_URL);
    expect(JSON.parse(gitIn(remote, ["show", `${result.team!.branch}:.mcp.json`])).mcpServers.zapier).toBeUndefined();
  });

  it("given every selected server carries a credential, when the selection runs, then git is never run at all", () => {
    const calls: string[][] = [];
    const recordingGit: GitRunner = (args) => {
      calls.push(args);
      return "";
    };
    writeServers({ "acme-api": withCredential });

    const result = shareSelection(
      select({ servers: ["acme-api"] }),
      { repoUrl: "git@gitlab.acme.com:team/skills.git", marketplaceName: "acme" },
      paths(),
      recordingGit,
      forge,
    );

    expect(result.team!.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("given the team already declares one of the selected servers, when they are shared, then theirs survives and the others still go", () => {
    remote = teamRepo({
      ".mcp.json": JSON.stringify({ mcpServers: { linear: { type: "sse", url: "https://mcp.linear.app/theirs" } } }, null, 2) + "\n",
    });
    writeServers({
      gitlab: { type: "http", url: "https://gitlab.com/api/v4/mcp" },
      linear: { type: "sse", url: "https://mcp.linear.app/mine" },
    });

    const result = shareSelection(select({ servers: ["gitlab", "linear"] }), team(), paths(), undefined, forge);

    expect(result.team).toMatchObject({ ok: true, serverNames: ["gitlab"] });
    expect(result.refused).toMatchObject([
      // collision: true is what tells the report this refusal has a route out of it
      { name: "linear", kind: "mcp", reason: expect.stringContaining("already declares"), collision: true },
    ]);
    const declared = JSON.parse(gitIn(remote, ["show", `${result.team!.branch}:.mcp.json`]));
    expect(declared.mcpServers.linear.url).toBe("https://mcp.linear.app/theirs");
  });

  it("given the team's .mcp.json cannot be read, when servers are selected, then no part of the selection is pushed over it", () => {
    remote = teamRepo({ ".mcp.json": '{"mcpServers": ' });
    writeServers({ gitlab: { type: "http", url: "https://gitlab.com/api/v4/mcp" } });

    const result = shareSelection(select({ servers: ["gitlab"] }), team(), paths(), undefined, forge);

    expect(result.team!.ok).toBe(false);
    expect(result.refused[0]!.reason).toContain("not valid JSON");
    expect(gitIn(remote, ["branch", "--list"]).replace(/[*\s]/g, "")).toBe("main");
  });

  it("given a later failure stops the whole request, when it is reported, then a credential is not reported as that failure", () => {
    remote = teamRepo({ ".mcp.json": '{"mcpServers": ' });
    writeServers({ "acme-api": withCredential, gitlab: { type: "http", url: "https://gitlab.com/api/v4/mcp" } });

    const result = shareSelection(select({ servers: ["acme-api", "gitlab"] }), team(), paths(), undefined, forge);

    // The audit already judged acme-api. Letting the unreadable team file overwrite that
    // verdict would tell the user their credential problem was a JSON problem, and the
    // next run would hit the same wall with a different explanation.
    const byName = Object.fromEntries(result.refused.map((r) => [r.name, r.reason]));
    expect(byName["acme-api"]).toContain("headers.Authorization");
    expect(byName["gitlab"]).toContain("not valid JSON");
  });

  it("given no team repository is configured, when a mixed selection runs, then every kind says why not", () => {
    writeSkill(userHome, "deploy-runbook");
    writeServers({ gitlab: { type: "http", url: "https://gitlab.com/api/v4/mcp" } });

    const result = shareSelection(select({ skills: ["deploy-runbook"], servers: ["gitlab"] }), null, paths());

    // Both kinds need the repository now, so neither may look like it succeeded.
    expect(result.refused.map((r) => r.kind).sort()).toEqual(["mcp", "skill"]);
    for (const refusal of result.refused) expect(refusal.reason).toContain("/handbook:init");
    expect(result.team).toBeUndefined();
  });

  it("given a name nothing on this machine answers to, when it is selected, then it is reported rather than silently dropped", () => {
    const result = shareSelection(select({ skills: ["not-here"], servers: ["nor-here"] }), null, paths());

    expect(result.refused.map((r) => r.kind)).toEqual(["skill", "mcp"]);
    expect(result.team).toBeUndefined();
  });
});

describe("shareSelection carries commands", () => {
  const SECRET_COMMAND = "Deploy with: curl -H 'Authorization: Bearer ghp_aaaabbbbccccddddeeeeffff' ...\n";

  it("given commands on this machine, when the inventory is read, then they are listed with their scope and description", () => {
    writeCommand(userHome, "explain", "---\ndescription: Deep-dive explanation of code.\n---\n\nBody.\n");
    writeCommand(project, "deploy", "Deploy this repo.\n");

    const inv = buildInventory(paths());

    expect(inv.commands.map((c) => [c.name, c.scope, c.shareable])).toEqual([
      ["explain", "personal", true],
      ["deploy", "project", true],
    ]);
    expect(inv.commands[0]!.description).toBe("Deep-dive explanation of code.");
    const text = formatInventory(inv);
    expect(text).toContain("Commands (2)");
    expect(text).toContain("  1. /explain  [personal]");
  });

  it("given no command was selected, when the selection runs, then none travels and git is never called", () => {
    writeCommand(userHome, "explain", "Explain something.\n");
    const calls: string[][] = [];
    const recordingGit: GitRunner = (args) => {
      calls.push(args);
      return "";
    };

    const result = shareSelection(select(), team(), paths(), recordingGit, forge);

    expect(result.team).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("given one command was selected, when the selection runs, then it lands in the team repo as commands/<name>.md", () => {
    remote = teamRepo();
    writeCommand(userHome, "explain", "---\ndescription: Deep-dive.\n---\n\nBody.\n");
    writeCommand(userHome, "fix-tests", "Fix the tests.\n");

    const result = shareSelection(select({ commands: ["explain"] }), team(), paths(), undefined, forge);

    expect(result.team).toMatchObject({ ok: true, commandNames: ["explain"], version: "1.0.1" });
    expect(result.refused).toEqual([]);
    const branch = result.team!.branch!;
    expect(gitIn(remote, ["show", `${branch}:commands/explain.md`])).toBe("---\ndescription: Deep-dive.\n---\n\nBody.\n");
    // the one nobody picked is still only on this machine
    expect(() => gitIn(remote, ["show", `${branch}:commands/fix-tests.md`])).toThrow();
  });

  it("given a command in a subdirectory, when the list is read, then it is offered under the name it is typed with", () => {
    writeCommand(userHome, "git/sync", "---\ndescription: Sync with upstream.\n---\n\nBody.\n");
    writeCommand(userHome, "sync", "Sync the docs.\n");

    const inv = buildInventory(paths());

    expect(inv.commands.map((c) => [c.name, c.shareable])).toEqual([
      ["git:sync", true],
      ["sync", true],
    ]);
    const text = formatInventory(inv);
    expect(text).toContain("  1. /git:sync  [personal]");
    expect(text).toContain("     Sync with upstream.");
    expect(text).not.toContain("cannot travel");
  });

  it("given git/sync.md and sync.md were selected, when the selection runs, then each lands at its own path in the team repo", () => {
    remote = teamRepo();
    writeCommand(userHome, "git/sync", "Sync with upstream.\n");
    writeCommand(userHome, "sync", "Sync the docs.\n");

    const result = shareSelection(select({ commands: ["git:sync", "sync"] }), team(), paths(), undefined, forge);

    expect(result.team).toMatchObject({ ok: true, commandNames: ["git:sync", "sync"] });
    const branch = result.team!.branch!;
    expect(gitIn(remote, ["show", `${branch}:commands/git/sync.md`])).toBe("Sync with upstream.\n");
    expect(gitIn(remote, ["show", `${branch}:commands/sync.md`])).toBe("Sync the docs.\n");
    expect(formatShareResult(result, "acme")).toContain("git:sync");
  });

  it("given the team already has sync.md, when git/sync.md is shared, then the two are not a collision", () => {
    remote = teamRepo({ "commands/sync.md": "The team's own sync.\n" });
    writeCommand(userHome, "git/sync", "Sync with upstream.\n");

    const result = shareSelection(select({ commands: ["git:sync"] }), team(), paths(), undefined, forge);

    expect(result.team).toMatchObject({ ok: true, commandNames: ["git:sync"] });
    expect(result.refused).toEqual([]);
    const branch = result.team!.branch!;
    expect(gitIn(remote, ["show", `${branch}:commands/sync.md`])).toBe("The team's own sync.\n");
  });

  it("given the team already has git/sync.md, when another git/sync.md is shared, then it collides at that path", () => {
    remote = teamRepo({ "commands/git/sync.md": "The team's own sync.\n" });
    writeCommand(userHome, "git/sync", "My sync.\n");

    const result = shareSelection(select({ commands: ["git:sync"] }), team(), paths(), undefined, forge);

    expect(result.team?.ok).toBe(false);
    expect(result.refused).toMatchObject([
      { name: "git:sync", kind: "command", collision: true, reason: expect.stringContaining("commands/git/sync.md") },
    ]);
  });

  it("given a namespaced command merged into the team repo, when this machine installs it, then it sits at the same path and reads as on the team", () => {
    remote = teamRepo();
    writeCommand(userHome, "git/sync", "Sync with upstream.\n");
    const shared = shareSelection(select({ commands: ["git:sync"] }), team(), paths(), undefined, forge);
    const merge = mkdtempSync(join(tmpdir(), "handbook-merge-"));
    const installed = mkdtempSync(join(tmpdir(), "handbook-installed-"));
    try {
      execFileSync("git", ["clone", "-q", remote, merge]);
      gitIn(merge, ["-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", `origin/${shared.team!.branch!}`]);
      gitIn(merge, ["push", "-q", "origin", "main"]);
      // what the marketplace subscription installs is a checkout of the team repository
      execFileSync("git", ["clone", "-q", remote, join(installed, "acme")]);

      const pluginDir = join(installed, "acme");
      expect(readFileSync(join(pluginDir, "commands", "git", "sync.md"), "utf8")).toBe("Sync with upstream.\n");
      const assets = teamAssets(team());
      expect(assets?.commands).toEqual(["git:sync"]);
      const inv = buildInventory(paths(), assets);
      expect(inv.commands[0]).toMatchObject({ name: "git:sync", onTeam: true });
      expect(duplicateCopies(inv, pluginDir, paths()).copies).toEqual([
        { kind: "command", name: "git:sync", remove: "rm ~/.claude/commands/git/sync.md" },
      ]);
    } finally {
      rmSync(merge, { recursive: true, force: true });
      rmSync(installed, { recursive: true, force: true });
    }
  });

  it("given a namespaced command hides a credential, when it is selected, then it is refused before git runs", () => {
    const calls: string[][] = [];
    const recordingGit: GitRunner = (args) => {
      calls.push(args);
      return "";
    };
    writeCommand(userHome, "git/deploy", SECRET_COMMAND);

    const inv = buildInventory(paths());
    const result = shareSelection(
      select({ commands: ["git:deploy"] }),
      { repoUrl: "git@gitlab.acme.com:team/skills.git", marketplaceName: "acme" },
      paths(),
      recordingGit,
      forge,
    );

    expect(inv.commands[0]).toMatchObject({ name: "git:deploy", shareable: false });
    expect(calls).toEqual([]);
    expect(result.refused[0]).toMatchObject({ name: "git:deploy", kind: "command" });
    expect(result.refused[0]!.reason).toContain("git/deploy.md");
  });

  it("given every kind was selected, when the selection runs, then ONE request carries them and claims ONE version", () => {
    remote = teamRepo();
    writeSkill(userHome, "deploy-runbook");
    writeCommand(userHome, "explain", "Explain something.\n");
    writeCommand(userHome, "fix-tests", "Fix the tests.\n");
    writeServers({ gitlab: { type: "http", url: "https://gitlab.com/api/v4/mcp" } });
    const inv = buildInventory(paths());

    const result = delegating((commitMessage) =>
      shareSelection(
        select({
          skills: inv.skills.map((s) => s.name),
          servers: inv.servers.map((s) => s.name),
          commands: inv.commands.map((c) => c.name),
        }),
        team(),
        paths(),
        undefined,
        forge,
        { commitMessage },
      ),
    );

    expect(result.team).toMatchObject({
      ok: true,
      serverNames: ["gitlab"],
      commandNames: ["explain", "fix-tests"],
      skillNames: ["deploy-runbook"],
    });
    const branch = result.team!.branch!;
    // The same defect within one run: a second request opened off the same clone would
    // claim the same version and the change in it would reach nobody
    const branches = gitIn(remote, ["branch", "--list"]).trim().split("\n").map((b) => b.replace("*", "").trim());
    expect(branches.filter((b) => b !== "main")).toEqual([branch]);
    const commits = gitIn(remote, ["log", "--format=%s", `main..${branch}`]).trim().split("\n");
    expect(commits).toEqual(["feat(skill,mcp,commands): add deploy-runbook, gitlab, explain, fix-tests"]);
    expect(JSON.parse(gitIn(remote, ["show", `${branch}:.claude-plugin/plugin.json`])).version).toBe("1.0.1");
    expect(gitIn(remote, ["show", `${branch}:commands/fix-tests.md`])).toBe("Fix the tests.\n");
  });

  it("given a selected command hides a credential, when the selection runs, then it is refused and the clean ones still travel", () => {
    remote = teamRepo();
    writeCommand(userHome, "explain", "Explain something.\n");
    writeCommand(userHome, "deploy", SECRET_COMMAND);

    const result = shareSelection(select({ commands: ["explain", "deploy"] }), team(), paths(), undefined, forge);

    expect(result.team).toMatchObject({ ok: true, commandNames: ["explain"] });
    expect(result.refused).toMatchObject([
      { name: "deploy", kind: "command", reason: expect.stringContaining("github-token") },
    ]);
    const branch = result.team!.branch!;
    // not one byte of it reached the team repository, redacted or otherwise
    expect(() => gitIn(remote, ["show", `${branch}:commands/deploy.md`])).toThrow();
    expect(gitIn(remote, ["log", "-p", `main..${branch}`])).not.toContain("ghp_");
  });

  it("given every selected command carries a credential, when the selection runs, then git is never run at all", () => {
    const calls: string[][] = [];
    const recordingGit: GitRunner = (args) => {
      calls.push(args);
      return "";
    };
    writeCommand(userHome, "deploy", SECRET_COMMAND);

    const result = shareSelection(
      select({ commands: ["deploy"] }),
      { repoUrl: "git@gitlab.acme.com:team/skills.git", marketplaceName: "acme" },
      paths(),
      recordingGit,
      forge,
    );

    // the credential never reached a clone, an index, or a working tree
    expect(calls).toEqual([]);
    expect(result.team?.ok).toBe(false);
    expect(result.refused[0]!.reason).toContain("deploy.md");
  });

  it("given a collision on the run that stopped for the message, when it is reported, then the answer is put on the whole selection rather than a request of its own", () => {
    remote = teamRepo({ "commands/explain.md": "The team's own explain.\n" });
    writeCommand(userHome, "explain", "My explain.\n");
    writeCommand(userHome, "fix-tests", "Fix the tests.\n");

    const probe = shareSelectionDeciding(
      select({ commands: ["explain", "fix-tests"] }),
      team(),
      paths(),
      undefined,
      forge,
    );

    // Nothing travelled on this run, so the one-item retry would send explain by itself and
    // fix-tests in a second request - and two requests opened before either is merged claim
    // the same plugin version, which is what one request exists to prevent.
    expect(probe.team?.ok).toBe(false);
    const printed = formatShareResult(probe);
    expect(printed).not.toContain("share.js share --command explain --update explain");
    expect(printed).toContain("--update explain");
    expect(printed).toContain("the same run as the rest");
  });

  it("given an update answered on the second run, when the wording is delegated, then the commit carries that run's proposal and not the stale one", () => {
    remote = teamRepo({ "commands/explain.md": "The team's own explain.\n" });
    writeCommand(userHome, "explain", "My explain.\n");
    writeCommand(userHome, "fix-tests", "Fix the tests.\n");
    const selection = () => select({ commands: ["explain", "fix-tests"] });

    // the first run: explain collides, so the proposal it derives is about fix-tests alone
    const first = shareSelectionDeciding(selection(), team(), paths(), undefined, forge);
    // the second: the user said yes to updating explain, so the proposal now says so too
    const second = shareSelectionDeciding(selection(), team(), paths(), undefined, forge, { update: ["explain"] });

    expect(first.team?.proposedMessage).not.toBe(second.team?.proposedMessage);
    expect(second.team?.proposedMessage).toBe("feat(commands): add fix-tests; update explain");

    const sent = shareSelectionDeciding(selection(), team(), paths(), undefined, forge, {
      update: ["explain"],
      commitMessage: { delegated: second.team!.proposalHash! },
      branch: second.team!.proposedBranch!,
    });

    // what was committed is the sentence the SECOND run showed, which is the one the user
    // was asked about; delegating the wording must not commit a title nobody saw.
    expect(sent.team?.commitMessage).toBe(second.team!.proposedMessage);
    expect(gitIn(remote, ["log", "-1", "--format=%s", sent.team!.branch!]).trim()).toBe(
      "feat(commands): add fix-tests; update explain",
    );
  });

  it("given the team already has a command by that name, when it is shared, then theirs is untouched and the rest still go", () => {
    remote = teamRepo({ "commands/explain.md": "The team's own explain.\n" });
    writeCommand(userHome, "explain", "My explain.\n");
    writeCommand(userHome, "fix-tests", "Fix the tests.\n");

    const result = shareSelection(select({ commands: ["explain", "fix-tests"] }), team(), paths(), undefined, forge);

    expect(result.team).toMatchObject({ ok: true, commandNames: ["fix-tests"] });
    expect(result.refused).toMatchObject([
      { name: "explain", kind: "command", reason: expect.stringContaining("already has a command"), collision: true },
    ]);
    // the route out of it is named where the user reads it, in the CLI's own grammar:
    // --update takes a name here, so the printed command carries exactly the one name the
    // user would be consenting to, and not the rest of the selection.
    expect(formatShareResult(result)).toContain("share.js share --command explain --update explain");
    const branch = result.team!.branch!;
    expect(gitIn(remote, ["show", `${branch}:commands/explain.md`])).toBe("The team's own explain.\n");
  });

  it("given a command collides while a server travels, when they are shared, then the request still goes and the collision is reported", () => {
    remote = teamRepo({ "commands/explain.md": "The team's own explain.\n" });
    writeCommand(userHome, "explain", "My explain.\n");
    writeServers({ gitlab: { type: "http", url: "https://gitlab.com/api/v4/mcp" } });

    const result = shareSelection(select({ servers: ["gitlab"], commands: ["explain"] }), team(), paths(), undefined, forge);

    // a collision in one kind must not turn back the other: the server has nothing to do
    // with a name the team already uses for a command
    expect(result.team).toMatchObject({ ok: true, serverNames: ["gitlab"] });
    expect(result.team!.commandNames).toBeUndefined();
    expect(result.refused).toMatchObject([
      { name: "explain", kind: "command", reason: expect.stringContaining("already has a command"), collision: true },
    ]);
    const branch = result.team!.branch!;
    expect(Object.keys(JSON.parse(gitIn(remote, ["show", `${branch}:.mcp.json`])).mcpServers)).toEqual(["gitlab"]);
    expect(gitIn(remote, ["show", `${branch}:commands/explain.md`])).toBe("The team's own explain.\n");
  });

  it("given the team already has the only command selected, when it is shared, then nothing is pushed over theirs", () => {
    remote = teamRepo({ "commands/explain.md": "The team's own explain.\n" });
    writeCommand(userHome, "explain", "My explain.\n");

    const result = shareSelection(select({ commands: ["explain"] }), team(), paths(), undefined, forge);

    expect(result.team!.ok).toBe(false);
    expect(result.team!.error).toContain("already has a command");
    expect(gitIn(remote, ["branch", "--list"]).replace(/[*\s]/g, "")).toBe("main");
  });

  it("given no team repository is configured, when commands are selected, then they say why not rather than vanishing", () => {
    writeCommand(userHome, "explain", "Explain something.\n");

    const result = shareSelection(select({ commands: ["explain"] }), null, paths());

    expect(result.refused).toEqual([
      { name: "explain", kind: "command", reason: expect.stringContaining("/handbook:init") },
    ]);
    expect(result.team).toBeUndefined();
  });

  it("given a command name nothing on this machine answers to, when it is selected, then it is reported rather than dropped", () => {
    const result = shareSelection(select({ commands: ["not-here"] }), null, paths());

    expect(result.refused).toEqual([
      { name: "not-here", kind: "command", reason: "no command of that name is installed here" },
    ]);
  });
});

describe("formatShareResult", () => {
  it("given a mixed request went out, when the result is reported, then each kind is named rather than totalled", () => {
    const text = formatShareResult(
      {
        team: {
          ok: true,
          serverNames: ["gitlab"],
          skillNames: ["deploy-runbook", "repo-conventions"],
          branch: "handbook/share-deploy-runbook-and-2-more",
          prUrl: "https://example.com/mr/1",
          version: "1.0.1",
        },
        refused: [],
      },
      "acme",
    );

    expect(text).toContain("Shared with the team (3) in one merge request:");
    // named by kind, because one request now carries three kinds and "shared 3" does not
    // say whether the thing that travelled connects to something, gets typed, or is read
    expect(text).toContain("  - skills (2): deploy-runbook, repo-conventions");
    expect(text).toContain("  - MCP servers (1): gitlab");
    expect(text).toContain("plugin:acme:<name>");
    // the sharer keeps their own copy and has to remove it themselves: this tool never
    // writes to the client's config, so after the merge the same server answers to two
    // names and only the sharer can decide to tidy that up
    expect(text).toContain("never writes to ~/.claude.json");
    // the one line that explains why a merge reaches anybody at all: a shared server whose
    // plugin version did not move is merged and then fetched by nobody
    expect(text).toContain("plugin version raised to 1.0.1");
  });

  it("given nothing was selected, when the result is reported, then it says so plainly", () => {
    expect(formatShareResult({ refused: [] })).toBe("Nothing was selected, so nothing was shared.");
  });

  it("given some of the selection was refused, when the result is reported, then each refusal keeps its reason", () => {
    const text = formatShareResult({
      refused: [{ name: "incident-drill", kind: "skill", reason: "it holds a credential" }],
    });

    expect(text).toContain("Not taken (1):");
    expect(text).toContain("incident-drill - it holds a credential");
  });
});

describe("the third state: a name the team already has", () => {
  it("is read out of the real team repository rather than assumed", () => {
    // given a team repository carrying one of each kind
    remote = teamRepo({
      "skills/fix-npm-test/SKILL.md": "---\nname: fix-npm-test\ndescription: theirs\n---\n\nTheirs.\n",
      ".mcp.json": JSON.stringify({ mcpServers: { gitlab: { type: "sse", url: "https://theirs.example/sse" } } }) + "\n",
      "commands/explain.md": "---\ndescription: theirs\n---\n\nTheirs.\n",
    });

    // when the index is read from it
    const assets = teamAssets({ repoUrl: remote, marketplaceName: "acme" });

    // then every kind is found, and the skills/README.md file is not mistaken for a skill
    expect(assets).toEqual({ skills: ["fix-npm-test"], servers: ["gitlab"], commands: ["explain"] });
  });

  it("is nothing at all when the repository cannot be read, so no label is invented", () => {
    // given a repository that is not there
    // when the index is read
    const assets = teamAssets({ repoUrl: join(home, "missing.git"), marketplaceName: "acme" });

    // then the screen learns nothing rather than learning that the team has nothing
    expect(assets).toBeNull();
  });

  it("marks the local setup without withholding any of it, because an update is still a way to travel", () => {
    // given local things whose names the team already carries
    writeSkill(userHome, "fix-npm-test");
    writeSkill(userHome, "unique-skill");
    writeCommand(userHome, "explain", "---\ndescription: mine\n---\n\nMine.\n");
    writeServers({ gitlab: { type: "http", url: "https://gitlab.com/api/v4/mcp" } });

    // when the inventory is built against what the team has
    const inv = buildInventory(paths(), { skills: ["fix-npm-test"], servers: ["gitlab"], commands: ["explain"] });

    // then the matching ones are marked and still shareable, and the others are untouched
    expect(inv.skills.find((s) => s.name === "fix-npm-test")).toMatchObject({ shareable: true, onTeam: true });
    expect(inv.skills.find((s) => s.name === "unique-skill")?.onTeam).toBeUndefined();
    expect(inv.servers[0]).toMatchObject({ name: "gitlab", shareable: true, onTeam: true });
    expect(inv.commands[0]).toMatchObject({ name: "explain", shareable: true, onTeam: true });

    // and the screen says which state it is, next to the refusals but not as one
    const printed = formatInventory(inv);
    expect(printed).toContain("already on the team: picking it sends an update to their copy");
    expect(printed).not.toContain("not shareable: already on the team");
  });

  it("marks nothing when no index was fetched, so an unreachable repo cannot read as an empty one", () => {
    writeSkill(userHome, "fix-npm-test");

    const inv = buildInventory(paths());

    expect(inv.skills[0]?.onTeam).toBeUndefined();
    expect(formatInventory(inv)).not.toContain("already on the team");
  });
});

/**
 * The seam between the two commands.
 *
 * /handbook:share and /handbook:review now write skills into the SAME directory of the
 * same team repository, by two different routes and for two different reasons. Neither
 * command's own tests can see that: each one passes while believing it is alone. So the
 * cases that matter live here, between them.
 */
describe("share and review meet in one team repository", () => {
  function harvested(slug: string): CandidateMeta {
    return {
      slug,
      status: "pending",
      createdAt: "2026-09-01T00:00:00Z",
      scope: "team",
      description: "What the harvest distilled.",
      fingerprint: "fp-1",
      sessionId: "s-1",
      gate: { total: 8, scores: { reuse: 4, specificity: 4 } },
      origin: "harvest",
    };
  }

  function seedCandidate(meta: CandidateMeta): string {
    const dir = join(candidatesDir(home), meta.slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: ${meta.slug}\ndescription: ${meta.description}\n---\n\nHarvested body.\n`,
    );
    writeCandidateMeta(dir, meta);
    return dir;
  }

  it("given share already sent a skill, when review approves a harvest candidate of that name, then the team's copy survives", () => {
    remote = teamRepo();
    writeSkill(userHome, "deploy-runbook");
    const shared = shareSelection(select({ skills: ["deploy-runbook"] }), team(), paths(), undefined, forge);
    expect(shared.team).toMatchObject({ ok: true, skillNames: ["deploy-runbook"] });
    // the shared branch is merged, so the team repository really carries it now
    gitIn(remote, ["update-ref", "refs/heads/main", shared.team!.branch!]);

    seedCandidate(harvested("deploy-runbook"));
    const approved = approveAndDeliver(
      home,
      "deploy-runbook",
      project,
      "2026-09-02T00:00:00Z",
      team(),
      undefined,
      forge,
      "team",
    );

    // Nothing the team already has is rewritten by a request that did not ask to. The two
    // commands reach the same skills/<name>, so the collision guard has to hold across
    // them, not just within whichever one is under test.
    expect(approved.ok).toBe(false);
    expect(approved.error).toContain("already has a skill named");
    expect(gitIn(remote, ["show", "main:skills/deploy-runbook/SKILL.md"])).toContain("What deploy-runbook is for.");
  });

  it("given a harvest candidate is waiting, when a skill is shared, then the candidate is left pending for review", () => {
    remote = teamRepo();
    writeSkill(userHome, "deploy-runbook");
    seedCandidate(harvested("incident-drill"));

    shareSelection(select({ skills: ["deploy-runbook"] }), team(), paths(), undefined, forge);

    // What /handbook:review gates is what the HARVEST proposed, and sharing something
    // else must not decide it: the approval share carries is the user's own pick.
    expect(listCandidates(home, "pending").map((c) => c.slug)).toEqual(["incident-drill"]);
    expect(listCandidates(home, "pending")[0]!.status).toBe("pending");
  });

  it("given the session notice counts pending candidates, when review lists them, then both name the same set", () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ harvest: { lessons: true } }));
    seedCandidate(harvested("incident-drill"));
    // the shape the nine stranded skills are really in: no candidate.json, synthesized
    const strandedDir = join(candidatesDir(home), "jira-task");
    mkdirSync(strandedDir, { recursive: true });
    writeFileSync(join(strandedDir, "SKILL.md"), "---\nname: jira-task\ndescription: hand written\n---\n");

    // the two screens, each built the way its own command builds it
    const notice = sessionStartNotice(project, home)!;
    const reviewList = formatReviewQueue(reviewQueue(home));

    // A candidate the notice sends the user to review MUST be one review can show them.
    // The counts are split by origin - the harvested one leads, the rest are counted
    // together - but both halves come from the same listCandidates call, so neither
    // screen can name something the other does not have.
    expect(notice).toContain("incident-drill");
    expect(reviewList).toContain("incident-drill");
    expect(notice).toContain("1 candidate skill is awaiting your review");
    expect(notice).toContain("jira-task");
    expect(reviewList).toContain("jira-task");
    expect(reviewList).toContain("Pending candidates (2)");
  });

  it("given the lesson harvest is off, when the notice and review are built, then neither names the folded lesson and both name the rest", () => {
    seedCandidate(harvested("incident-drill"));
    const strandedDir = join(candidatesDir(home), "jira-task");
    mkdirSync(strandedDir, { recursive: true });
    writeFileSync(join(strandedDir, "SKILL.md"), "---\nname: jira-task\ndescription: hand written\n---\n");

    const notice = sessionStartNotice(project, home)!;
    const reviewList = formatReviewQueue(reviewQueue(home));

    expect(notice).not.toContain("incident-drill");
    expect(reviewList).not.toContain("incident-drill");
    expect(notice).toContain("1 older lesson candidate is folded");
    expect(reviewList).toContain("1 older lesson candidate from before the harvest was switched off");
    expect(notice).toContain("1 candidate skill is awaiting your review");
    expect(notice).toContain("jira-task");
    expect(reviewList).toContain("jira-task");
  });
});

describe("skills that answer the same request", () => {
  const ROUTE =
    'Exposes a new route through the gateway and the service behind it. Use when a ticket opens an endpoint. Triggers: "open an endpoint", "add a route".';

  function writeDescribed(root: string, name: string, description: string): void {
    const dir = join(root, ".claude", "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`);
  }

  it("given two installed skills with the same description, when the screen is printed, then each names the other as a warning", () => {
    writeDescribed(userHome, "add-route", ROUTE);
    writeDescribed(project, "open-endpoint", ROUTE);
    writeDescribed(userHome, "release-notes", "Writes the release notes. Use when a version is tagged.");

    const text = formatInventory(buildInventory(paths()));
    const skills = text.slice(text.indexOf("Skills ("), text.indexOf("Everything you pick"));

    expect(skills).toMatchInlineSnapshot(`
      "Skills (3) - the ones you pick go out as part of ONE merge request to the team repository

        1. add-route  [personal]
           Exposes a new route through the gateway and the service behind it. Use when a ticket opens an endpoint. Triggers: "open an endpoint", "add a route".
           overlaps open-endpoint: a request that reaches one may reach the other
        2. release-notes  [personal]
           Writes the release notes. Use when a version is tagged.
        3. open-endpoint  [project]
           Exposes a new route through the gateway and the service behind it. Use when a ticket opens an endpoint. Triggers: "open an endpoint", "add a route".
           overlaps add-route: a request that reaches one may reach the other

      "
    `);
  });

  it("given a skill whose description matches one the team already has, when the inventory is read, then the team's skill is named", () => {
    const teamSkills = mkdtempSync(join(tmpdir(), "handbook-team-skills-"));
    try {
      mkdirSync(join(teamSkills, "add-route"), { recursive: true });
      writeFileSync(join(teamSkills, "add-route", "SKILL.md"), `---\nname: add-route\ndescription: ${ROUTE}\n---\n\nBody.\n`);
      writeDescribed(userHome, "open-endpoint", ROUTE);

      const inv = buildInventory({ ...paths(), teamSkills });

      expect(inv.skills.map((s) => [s.name, s.overlaps])).toEqual([["open-endpoint", ["add-route"]]]);
    } finally {
      rmSync(teamSkills, { recursive: true, force: true });
    }
  });

  it("given both overlapping skills picked, when shared, then both travel and neither is refused", () => {
    remote = teamRepo();
    writeDescribed(userHome, "add-route", ROUTE);
    writeDescribed(userHome, "open-endpoint", ROUTE);

    const result = shareSelection(select({ skills: ["add-route", "open-endpoint"] }), team(), paths(), undefined, forge);

    expect(result.refused).toEqual([]);
    expect(result.team).toMatchObject({ ok: true, skillNames: ["add-route", "open-endpoint"] });
  });
});
