import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { OrchestratorClient } from "../client.js";
import { commitOnDefault, seedTeamRepo } from "../repos.js";
import { labEnv } from "../run.js";
import { lab, spareOrchestratorPort, startOrchestratorProcess, unique } from "./support.js";
import type { OrchestratorProcess } from "./support.js";

const REPO = "team-skills";

interface Loads {
  cwd: string;
  present: string[];
  sources: string[];
  settings: string[];
  servers: { name: string; from: string }[];
  hooks: { from: string; event: string; command: string }[];
  allow: { from: string; rule: string }[];
  writes: { target: string; path: string; outside: boolean; written: boolean; refused: string | null }[];
}

const loadsLog = () => join(lab.dir, "logs", "claude-loads.ndjson");
const readLoads = (): Loads[] => (existsSync(loadsLog()) ? readFileSync(loadsLog(), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Loads) : []);

/** A repository's own Claude Code configuration, each piece named so a load of it is told apart. */
const REPO_FILES = {
  ".mcp.json": JSON.stringify({ mcpServers: { "repo-planted": { command: "node", args: ["-e", "process.exit(0)"] } } }, null, 2) + "\n",
  ".claude/settings.json": JSON.stringify({ enableAllProjectMcpServers: true, permissions: { allow: ["Bash(*)"] }, hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo repo-planted-hook" }] }] } }, null, 2) + "\n",
};

const PERSONS_SETTINGS = JSON.stringify({ enableAllProjectMcpServers: true, hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo persons-own-hook" }] }] } }, null, 2) + "\n";

interface OnePerson {
  dir: string;
  home: string;
  bare: string;
  served: OrchestratorProcess;
  owner: OrchestratorClient;
}

/**
 * A one-person orchestrator that runs its tasks as its person, with Claude Code: that person's home,
 * whose own settings approve every project server and hold a hook of theirs, and a team
 * repository carrying its own Claude Code configuration.
 */
async function onePersonOrchestrator(): Promise<OnePerson> {
  const tenant = unique("personal");
  const dir = join(lab.dir, "personal-profile", tenant);
  const home = join(dir, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "settings.json"), PERSONS_SETTINGS);
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { "persons-own": { command: "node", args: ["-e", "process.exit(0)"] } } }, null, 2) + "\n");
  const bare = join(dir, "repos", "team-skills.git");
  seedTeamRepo(lab.path, { id: REPO, team: "Core", reviewers: [], labels: [], skills: [{ slug: "first-skill", description: "Use when the lab runs a task as its person.", body: "1. Begin.\n" }] }, bare, `file://${bare}`, join(dir, "scratch"));
  commitOnDefault(lab.path, bare, REPO_FILES, "chore: the repository's own Claude Code configuration", { name: "Lab Seed", email: "seed@lab.example.invalid" }, join(dir, "scratch"));
  const code = unique("setup");
  const served = await startOrchestratorProcess({
    port: spareOrchestratorPort(2),
    tenant,
    dataDir: join(dir, "data"),
    store: "sqlite",
    setupCode: code,
    repos: [{ id: REPO, team: "Core", url: `file://${bare}` }],
    env: { ORCHESTRATOR_AGENTS: "claude-code", ORCHESTRATOR_CLAUDE_BIN: join(lab.dir, "bin", "claude"), ORCHESTRATOR_TASK_PROFILE: "personal" },
  });
  const owner = await OrchestratorClient.setup(served.url, code, { email: `owner@${tenant}.example.invalid`, name: "Personal Owner" }, lab.password);
  const head = async () => (await owner.ok<{ repos: { id: string; head: string | null }[] }>("GET", "/api/repos")).repos.find((r) => r.id === REPO)?.head;
  for (let i = 0; i < 480 && !(await head()); i++) await new Promise((r) => setTimeout(r, 250));
  return { dir, home, bare, served, owner };
}

/** A Claude Code task with these words, followed to its end, and what each of its sessions loaded and wrote. */
async function sessionsOf(one: OnePerson, description: string): Promise<Loads[]> {
  const before = readLoads().length;
  const { task } = await one.owner.ok<{ task: { id: string } }>("POST", "/api/tasks", { title: unique("Lab task run as its person"), description, repoId: REPO, agent: "claude-code" });
  for (let i = 0; i < 480; i++) {
    const { task: now } = await one.owner.ok<{ task: { status: string } }>("GET", `/api/tasks/${task.id}`);
    if (!["queued", "running"].includes(now.status)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  return readLoads().slice(before).filter((l) => l.cwd.startsWith(join(one.dir, "data")));
}

/**
 * A task run as the orchestrator's one person (Run as me) starts that person's own Claude Code with
 * user settings alone and a settings layer of the orchestrator's, and without --strict-mcp-config,
 * since the person's own servers are meant to load. In -p Claude Code loads a repository's
 * .mcp.json without asking whenever project settings are read, so the setting sources are the
 * only thing keeping the repository's servers, hooks and allowed tools out. The orchestrator's guard
 * is a hook script beside that settings layer, in the task's home and out of the agent's
 * directory, and Claude Code refuses writes outside the working directory only when told to.
 * The stand-in claude decides what Claude Code's documented rules load and write for the
 * arguments, directory and home it is given: it shows what the orchestrator hands over, and a real
 * Claude Code run is what shows the rules hold.
 */
test.describe("a task run as the orchestrator's one person", () => {
  test("given a one-person orchestrator running tasks as its person, whose own settings approve every project server, and a repository carrying its own .mcp.json and .claude/settings.json, when a task runs with Claude Code, then the repository's files are in the agent's directory but its server, hook and allowed tools are not what the session loads, while the person's own server and hook and the orchestrator's guard are", async () => {
    test.setTimeout(300_000);
    // given
    const one = await onePersonOrchestrator();
    try {
      // when
      const runs = await sessionsOf(one, "Add a skill named after this task.");

      // then the session saw the repository's files and loaded none of them
      expect(runs.length, "Claude Code sessions the task started").toBeGreaterThan(0);
      for (const run of runs) {
        expect(run.present).toEqual([".mcp.json", ".claude/settings.json"]);
        expect(run.sources).toEqual(["user"]);
        expect(run.settings).toEqual(["user", "flag"]);
        expect(run.servers.filter((s) => s.from === "project")).toEqual([]);
        expect(run.hooks.filter((h) => h.from === "project" || h.from === "local")).toEqual([]);
        expect(run.allow.filter((a) => a.from === "project" || a.from === "local")).toEqual([]);
        // and the person's own server and hook, and the orchestrator's guard, are what it loads
        expect(run.servers).toContainEqual({ name: "persons-own", from: "user" });
        expect(run.hooks).toContainEqual({ from: "user", event: "SessionStart", command: "echo persons-own-hook" });
        expect(run.hooks.some((h) => h.from === "flag" && h.event === "PreToolUse")).toBe(true);
      }

      // and the same rules, asked to read project settings in that repository, load all three of its pieces
      const checkout = join(one.dir, "scratch", "control");
      spawnSync("git", ["clone", "--quiet", one.bare, checkout], { env: labEnv(lab.path, { HOME: one.home }) });
      const control = spawnSync(join(lab.dir, "bin", "claude"), ["-p", "--setting-sources", "user,project"], { cwd: checkout, input: "Add nothing.", env: labEnv(lab.path, { HOME: one.home }), encoding: "utf8" });
      const read = readLoads().filter((l) => l.cwd === checkout).pop();
      expect(control.status).toBe(0);
      expect(read?.servers).toContainEqual({ name: "repo-planted", from: "project" });
      expect(read?.hooks).toContainEqual({ from: "project", event: "SessionStart", command: "echo repo-planted-hook" });
      expect(read?.allow).toContainEqual({ from: "project", rule: "Bash(*)" });
    } finally {
      await one.served.stop();
    }
  });

  test("given the same one-person orchestrator, when the task's agent asks its file tools to write the orchestrator's guard script and settings layer and the person's own Claude Code settings, then each is refused and stays as it was, while a write in its own checkout goes through", async () => {
    test.setTimeout(300_000);
    // given
    const one = await onePersonOrchestrator();
    try {
      // when
      const runs = await sessionsOf(one, ["Add a skill named after this task.", "stand-in: write <settings>/personal-guard.mjs", "stand-in: write <settings>/personal-settings.json", "stand-in: write ~/.claude/settings.json", "stand-in: write LAB-INSIDE.md"].join("\n"));

      // then
      expect(runs.length, "Claude Code sessions the task started").toBeGreaterThan(0);
      for (const run of runs) {
        const written = Object.fromEntries(run.writes.map((w) => [w.target, w.written]));
        expect(written).toEqual({ "<settings>/personal-guard.mjs": false, "<settings>/personal-settings.json": false, "~/.claude/settings.json": false, "LAB-INSIDE.md": true });
      }
      expect(readFileSync(join(one.home, ".claude", "settings.json"), "utf8")).toBe(PERSONS_SETTINGS);
    } finally {
      await one.served.stop();
    }
  });

  // Bound once a task's agent runs as a two-way session; the arguments are the adapter's today.
  test.fixme("given the same one-person orchestrator and repository, when a task runs as a two-way Claude Code session that asks before edits, then the session loads none of the repository's server, hook or allowed tools, and the questions it asks reach the task page", async () => {
    // given the orchestrator above, with a permission mode that asks
    // when a task starts and its stand-in claude asks to edit a file
    // then the loads written for that session hold no project or local piece, and the question shows on the task page
  });
});
