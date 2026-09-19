import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildInventory, formatInventory, formatMigrateResult, shareSelection } from "./migrate.js";
import type { InventoryPaths, Selection } from "./migrate.js";
import { listCandidates } from "./queue.js";
import { candidatesDir } from "./skill-index.js";
import type { GitRunner } from "./init.js";
import { teamAssets } from "./publish.js";

let home: string;
let userHome: string;
let project: string;
let configFile: string;
let remote: string;

function paths(): InventoryPaths {
  return { home, userHome, cwd: project, configFile };
}

function select(overrides: Partial<Selection> = {}): Selection {
  return { skills: [], servers: [], commands: [], ...overrides };
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
  const dir = join(root, ".claude", "commands");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), body);
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

// The other shape, and the one measurement showed both of its other nets miss: the
// provider puts the secret in the endpoint itself. Nothing about this server is a literal
// in headers or env, so only the URL scan turns it back.
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

  it("given a skill already waiting in the review queue, when the inventory is read, then it is not offered again", () => {
    writeSkill(userHome, "deploy-runbook");
    shareSelection(select({ skills: ["deploy-runbook"] }), null, paths());

    const inv = buildInventory(paths());

    expect(inv.skills[0]!.shareable).toBe(false);
    expect(inv.skills[0]!.reason).toBe("already waiting in the review queue");
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

  it("given a mixed inventory, when the list is formatted, then each half says what picking it does", () => {
    writeSkill(userHome, "deploy-runbook");
    writeServers({ gitlab: { type: "http", url: "https://gitlab.com/api/v4/mcp" } });

    const text = formatInventory(buildInventory(paths()));

    expect(text).toContain("nothing leaves this machine");
    expect(text).toContain("ONE merge request");
    expect(text).toContain("Nothing is selected and nothing has been shared.");
  });
});

describe("shareSelection", () => {
  it("given nothing was selected, when the selection runs, then nothing is queued and git is never called", () => {
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
    expect(result).toEqual({ queued: [], refused: [] });
    expect(listCandidates(home, "pending")).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("given one skill was selected, when the selection runs, then it waits in the queue and nothing left the machine", () => {
    writeSkill(userHome, "deploy-runbook", { "references/checklist.md": "1. drain\n" });
    writeSkill(userHome, "repo-conventions");

    const result = shareSelection(select({ skills: ["deploy-runbook"] }), null, paths());

    expect(result.queued).toEqual(["deploy-runbook"]);
    expect(result.refused).toEqual([]);
    expect(listCandidates(home, "pending").map((c) => c.slug)).toEqual(["deploy-runbook"]);
    // the whole skill, not just its SKILL.md
    expect(readFileSync(join(candidatesDir(home), "deploy-runbook", "references", "checklist.md"), "utf8")).toContain("drain");
    // the one that was not selected stayed where it was
    expect(existsSync(join(candidatesDir(home), "repo-conventions"))).toBe(false);
  });

  it("given a few of each were selected, when the selection runs, then the skills queue and the servers go out as one request", () => {
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

    expect(result.queued).toEqual(["deploy-runbook", "repo-conventions"]);
    expect(result.refused).toEqual([]);
    expect(result.team).toMatchObject({ ok: true, serverNames: ["gitlab", "linear"], version: "1.0.1" });
    expect(listCandidates(home, "pending").map((c) => c.slug).sort()).toEqual(["deploy-runbook", "repo-conventions"]);
    // the skill nobody picked is still only on this machine
    expect(existsSync(join(candidatesDir(home), "incident-drill"))).toBe(false);
    const branch = result.team!.branch!;
    const declared = JSON.parse(gitIn(remote, ["show", `${branch}:.mcp.json`]));
    expect(Object.keys(declared.mcpServers).sort()).toEqual(["gitlab", "linear"]);
  });

  it("given two servers were selected, when they are shared, then ONE request claims ONE version rather than two claiming the same one", () => {
    remote = teamRepo();
    writeServers({
      gitlab: { type: "http", url: "https://gitlab.com/api/v4/mcp" },
      linear: { type: "sse", url: "https://mcp.linear.app/sse" },
    });

    const result = shareSelection(select({ servers: ["gitlab", "linear"] }), team(), paths(), undefined, forge);

    // The defect this guards: two requests opened off the same base
    // both write "1.0.1", git merges the identical line without a conflict, and the second
    // server lands with no version of its own, so no teammate's copy refreshes for it.
    const branches = gitIn(remote, ["branch", "--list"]).trim().split("\n").map((b) => b.replace("*", "").trim());
    expect(branches.filter((b) => b.startsWith("handbook/"))).toEqual([result.team!.branch]);
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
    expect(result.queued.sort()).toEqual(["deploy-runbook", "repo-conventions"]);
    expect(result.refused).toEqual([
      { name: "incident-drill", kind: "skill", reason: expect.stringContaining("references/queries.sql") },
    ]);
    expect(existsSync(join(candidatesDir(home), "incident-drill"))).toBe(false);
    expect(result.team).toMatchObject({ ok: true, serverNames: ["gitlab"] });
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
    expect(result.refused).toEqual([
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
    expect(result.refused).toEqual([{ name: "zapier", kind: "mcp", reason: expect.stringContaining("its URL carries") }]);
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
    expect(result.refused).toEqual([
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
    expect(gitIn(remote, ["branch", "--list"])).not.toContain("handbook/");
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

  it("given no team repository is configured, when servers are selected, then the skills still queue and the servers say why not", () => {
    writeSkill(userHome, "deploy-runbook");
    writeServers({ gitlab: { type: "http", url: "https://gitlab.com/api/v4/mcp" } });

    const result = shareSelection(select({ skills: ["deploy-runbook"], servers: ["gitlab"] }), null, paths());

    expect(result.queued).toEqual(["deploy-runbook"]);
    expect(result.refused[0]!.reason).toContain("/handbook:init");
    expect(result.team).toBeUndefined();
  });

  it("given a name nothing on this machine answers to, when it is selected, then it is reported rather than silently dropped", () => {
    const result = shareSelection(select({ skills: ["not-here"], servers: ["nor-here"] }), null, paths());

    expect(result.refused.map((r) => r.kind)).toEqual(["skill", "mcp"]);
    expect(result.queued).toEqual([]);
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

  it("given every kind was selected, when the selection runs, then ONE request carries them and claims ONE version", () => {
    remote = teamRepo();
    writeSkill(userHome, "deploy-runbook");
    writeCommand(userHome, "explain", "Explain something.\n");
    writeCommand(userHome, "fix-tests", "Fix the tests.\n");
    writeServers({ gitlab: { type: "http", url: "https://gitlab.com/api/v4/mcp" } });
    const inv = buildInventory(paths());

    const result = shareSelection(
      select({
        skills: inv.skills.map((s) => s.name),
        servers: inv.servers.map((s) => s.name),
        commands: inv.commands.map((c) => c.name),
      }),
      team(),
      paths(),
      undefined,
      forge,
    );

    expect(result.queued).toEqual(["deploy-runbook"]);
    expect(result.team).toMatchObject({ ok: true, serverNames: ["gitlab"], commandNames: ["explain", "fix-tests"] });
    const branch = result.team!.branch!;
    // Within one run: a second request opened off the same clone would
    // claim the same version and the change in it would reach nobody
    const branches = gitIn(remote, ["branch", "--list"]).trim().split("\n").map((b) => b.replace("*", "").trim());
    expect(branches.filter((b) => b.startsWith("handbook/"))).toEqual([branch]);
    const commits = gitIn(remote, ["log", "--format=%s", `main..${branch}`]).trim().split("\n");
    expect(commits).toEqual(["feat(mcp,commands): add gitlab, explain, fix-tests"]);
    expect(JSON.parse(gitIn(remote, ["show", `${branch}:.claude-plugin/plugin.json`])).version).toBe("1.0.1");
    expect(gitIn(remote, ["show", `${branch}:commands/fix-tests.md`])).toBe("Fix the tests.\n");
  });

  it("given a selected command hides a credential, when the selection runs, then it is refused and the clean ones still travel", () => {
    remote = teamRepo();
    writeCommand(userHome, "explain", "Explain something.\n");
    writeCommand(userHome, "deploy", SECRET_COMMAND);

    const result = shareSelection(select({ commands: ["explain", "deploy"] }), team(), paths(), undefined, forge);

    expect(result.team).toMatchObject({ ok: true, commandNames: ["explain"] });
    expect(result.refused).toEqual([
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

  it("given the team already has a command by that name, when it is shared, then theirs is untouched and the rest still go", () => {
    remote = teamRepo({ "commands/explain.md": "The team's own explain.\n" });
    writeCommand(userHome, "explain", "My explain.\n");
    writeCommand(userHome, "fix-tests", "Fix the tests.\n");

    const result = shareSelection(select({ commands: ["explain", "fix-tests"] }), team(), paths(), undefined, forge);

    expect(result.team).toMatchObject({ ok: true, commandNames: ["fix-tests"] });
    expect(result.refused).toEqual([
      { name: "explain", kind: "command", reason: expect.stringContaining("already has a command"), collision: true },
    ]);
    // the reason says what to do instead of leaving the user to guess why nothing happened
    expect(result.refused[0]!.reason).toContain("rename yours");
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
    expect(result.refused).toEqual([
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
    expect(gitIn(remote, ["branch", "--list"])).not.toContain("handbook/");
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

describe("formatMigrateResult", () => {
  it("given both halves ran, when the result is reported, then queued and shared are two groups rather than one total", () => {
    const text = formatMigrateResult(
      {
        queued: ["deploy-runbook", "repo-conventions"],
        team: { ok: true, serverNames: ["gitlab"], branch: "handbook/mcp-gitlab", prUrl: "https://example.com/mr/1", version: "1.0.1" },
        refused: [],
      },
      "acme",
    );

    // the selection was one dialog but it had two consequences, and a single "shared 3
    // things" line would tell the manager they sent two skills they have not sent
    expect(text).toContain("Queued for review (2) - nothing has left this machine yet:");
    expect(text).toContain("Shared with the team (1) in one merge request:");
    // named by kind, because one request now carries two kinds and "shared 1" does not
    // say whether the thing that travelled connects to something or gets typed
    expect(text).toContain("  - MCP servers (1): gitlab");
    expect(text).toContain("/handbook:review");
    expect(text).toContain("plugin:acme:<name>");
  });

  it("given nothing was selected, when the result is reported, then it says so plainly", () => {
    expect(formatMigrateResult({ queued: [], refused: [] })).toBe(
      "Nothing was selected, so nothing was queued and nothing was shared.",
    );
  });

  it("given some of the selection was refused, when the result is reported, then each refusal keeps its reason", () => {
    const text = formatMigrateResult({
      queued: ["deploy-runbook"],
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
