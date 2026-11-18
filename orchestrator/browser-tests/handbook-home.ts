import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A stand-in person's Claude Code home for the handbook visibility suite: what a developer who works on a
 * payments API has set up, built under a scratch directory so no test ever reads or writes the real ~/.claude.
 * Every name is made up. The values planted as secrets (settings env, a credentials file, an MCP server's env
 * and header, the bearer token in a settings hook's command) are listed in PLANTED so a test can search every
 * answer and page for them: the inventory shows names, and a hook's command only with a secret withheld.
 */
export const MARKET = "team-market";
export const PAYMENTS = `payments-skills@${MARKET}`;
export const DOCS = `docs-kit@${MARKET}`;
export const STAND_IN_CLAUDE = fileURLToPath(new URL("./stand-in-handbook-claude.mjs", import.meta.url));

export const PLANTED = {
  settingsEnv: "planted-settings-env-5f1c9a7e2b",
  credentials: "planted-credentials-token-8d3e4a6c1f",
  mcpEnv: "planted-mcp-env-value-1b7d9e3a5c",
  mcpHeader: "planted-mcp-header-bearer-6a2c8e4f0d",
  hookCommand: "planted9e5b1d7a3fbearer0123456789",
  pluginMcpEnv: "planted-plugin-mcp-env-4c8a2e6b0d",
  projectMcpEnv: "planted-project-mcp-env-7f3b9d1e5a",
} as const;

export interface HandbookHome {
  root: string;
  home: string;
  /** The person's one open folder, a git repository of the fictional payments API. */
  folder: string;
  /** The stand-in CLI's own state and the log of every call it was given. */
  standIn: string;
  claude: string;
}

export const write = (file: string, text: string) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};

export const skill = (name: string, description: string, body: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
export const command = (description: string, body: string) => `---\ndescription: ${description}\n---\n\n${body}\n`;

/** The directories a plugin version keeps: its manifest, skills, commands, hooks and servers. */
export function plugin(dir: string, spec: { name: string; version: string; skills?: [string, string, string][]; commands?: [string, string][]; hooks?: Record<string, unknown>; servers?: Record<string, unknown> }) {
  write(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: spec.name, version: spec.version, description: `The ${spec.name} handbook of a made-up team.` }, null, 2));
  for (const [name, description, body] of spec.skills ?? []) write(join(dir, "skills", name, "SKILL.md"), skill(name, description, body));
  for (const [name, description] of spec.commands ?? []) write(join(dir, "commands", `${name}.md`), command(description, `Run the ${name} routine.`));
  if (spec.hooks) write(join(dir, "hooks", "hooks.json"), JSON.stringify({ hooks: spec.hooks }, null, 2));
  if (spec.servers) write(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: spec.servers }, null, 2));
}

const PAYMENTS_14 = {
  name: "payments-skills",
  version: "1.4.0",
  skills: [
    ["add-endpoint", "Add an endpoint to the payments API", "Steps for a new endpoint, the team's way (1.4.0)."],
    ["review-notes", "Write review notes for a payments change", "How the team writes review notes."],
    ["changelog", "Keep the payments changelog", "One line a change, newest first."],
  ] as [string, string, string][],
  commands: [["payments-check", "Run the payments checks"]] as [string, string][],
  servers: { "ledger-sandbox": { command: "node", args: ["ledger-sandbox.js"], env: { LEDGER_TOKEN: PLANTED.pluginMcpEnv } } },
};

/** The newer version the marketplace holds: one skill added, one changed, one removed. */
const PAYMENTS_15 = {
  ...PAYMENTS_14,
  version: "1.5.0",
  skills: [
    ["add-endpoint", "Add an endpoint to the payments API", "Steps for a new endpoint, the team's way, now with rate limits (1.5.0)."],
    ["rate-limits", "Set a rate limit on a payments endpoint", "Where limits live and how to test them."],
    ["changelog", "Keep the payments changelog", "One line a change, newest first."],
  ] as [string, string, string][],
};

const DOCS_20 = {
  name: "docs-kit",
  version: "2.0.0",
  skills: [["write-docs", "Write documentation the team can find", "Where docs go and how they are named."]] as [string, string, string][],
  commands: [["docs-lint", "Check the docs for broken links"]] as [string, string][],
  hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "echo docs-lint-hook" }] }] },
  servers: { "docs-search": { command: "node", args: ["docs-search.js"], env: { DOCS_TOKEN: PLANTED.pluginMcpEnv } } },
};

/** Whether `path` is inside this machine's real home or outside every temporary directory: a fixture never goes there. */
export function refuseRealHome(root: string): void {
  const real = (path: string) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  const here = real(root);
  const inTemp = here.startsWith(`${real(tmpdir())}${sep}`);
  const realHome = real(homedir());
  if (!inTemp || here === realHome || here.startsWith(`${realHome}/.claude`)) throw new Error(`the handbook fixture is built under a temporary directory, never in ${root}`);
}

/** The places of a home already built under `root`, for a worker that meets it again. */
export function handbookPaths(root: string): HandbookHome {
  const home = join(root, "home");
  return { root, home, folder: realpathSync(join(home, "work", "payments-api")), standIn: join(home, ".stand-in"), claude: join(root, "claude") };
}

/**
 * Builds the home: two plugins (payments-skills 1.4.0, whose marketplace copy holds 1.5.0, and docs-kit 2.0.0, which
 * brings a hook), personal skills and a command, the open folder's own skills, command, CLAUDE.md and project MCP
 * server, MCP servers of the user, project and plugin scopes, a settings file with a hook and an env value, a
 * credentials file, and one skill name (add-endpoint) that Yours and payments-skills both carry.
 */
export function buildHandbookHome(root: string): HandbookHome {
  refuseRealHome(root);
  const home = join(root, "home");
  const claudeDir = join(home, ".claude");
  const standIn = join(home, ".stand-in");

  write(join(claudeDir, "CLAUDE.md"), "# How I work\n\nSmall changes, tests first.\n");
  write(join(claudeDir, "settings.json"), JSON.stringify({ env: { PAYMENTS_DEBUG_TOKEN: PLANTED.settingsEnv }, hooks: { Stop: [{ hooks: [{ type: "command", command: `curl -s -H "Authorization: Bearer ${PLANTED.hookCommand}" https://hooks.example.invalid/stop` }] }] } }, null, 2));
  write(join(claudeDir, ".credentials.json"), JSON.stringify({ accessToken: PLANTED.credentials }));
  write(join(claudeDir, "skills", "review-checklist", "SKILL.md"), skill("review-checklist", "My checklist before I ask for a review", "Read the diff twice. Run the tests."));
  write(join(claudeDir, "skills", "release-notes", "SKILL.md"), skill("release-notes", "Draft release notes from merged changes", "Group by user-facing area."));
  write(join(claudeDir, "skills", "add-endpoint", "SKILL.md"), skill("add-endpoint", "My own way to add an endpoint", "My notes for a new endpoint."));
  write(join(claudeDir, "commands", "standup.md"), command("Write my standup from yesterday's commits", "Summarise yesterday."));
  write(join(home, ".claude.json"), JSON.stringify({ mcpServers: { postgres: { command: "node", args: ["postgres-mcp.js"], env: { PGPASSWORD: PLANTED.mcpEnv } }, jira: { type: "http", url: "https://jira.example.invalid/mcp", headers: { Authorization: `Bearer ${PLANTED.mcpHeader}` } } } }, null, 2));

  // The plugins as installed (the cache, and installed_plugins.json as Claude Code keeps it) and the marketplace's own copy,
  // which holds payments-skills at 1.5.0 as Claude Code's refresh left it: that copy is what the person is behind.
  const plugins = join(claudeDir, "plugins");
  const installed = (name: string, version: string) => join(plugins, "cache", MARKET, name, version);
  plugin(installed("payments-skills", "1.4.0"), PAYMENTS_14);
  plugin(installed("docs-kit", "2.0.0"), DOCS_20);
  write(join(plugins, "installed_plugins.json"), JSON.stringify({
    version: 2,
    plugins: {
      [PAYMENTS]: [{ scope: "user", installPath: installed("payments-skills", "1.4.0"), version: "1.4.0", installedAt: "2026-10-01T09:00:00.000Z" }],
      [DOCS]: [{ scope: "user", installPath: installed("docs-kit", "2.0.0"), version: "2.0.0", installedAt: "2026-10-01T09:00:00.000Z" }],
    },
  }, null, 2));
  const market = join(plugins, "marketplaces", MARKET);
  write(join(market, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: MARKET, owner: { name: "Stand-in Team" }, plugins: [{ name: "payments-skills", source: "./payments-skills" }, { name: "docs-kit", source: "./docs-kit" }] }, null, 2));
  plugin(join(market, "payments-skills"), PAYMENTS_15);
  plugin(join(market, "docs-kit"), DOCS_20);
  write(join(standIn, "state.json"), JSON.stringify({
    plugins: [
      { id: PAYMENTS, name: "payments-skills", version: "1.4.0", enabled: true, scope: "user" },
      { id: DOCS, name: "docs-kit", version: "2.0.0", enabled: true, scope: "user" },
    ],
  }, null, 2));

  const real = openFolder(home, claudeDir);
  return { root, home, folder: real, standIn, claude: placeStandIn(root) };
}

/** The open folder: a git repository with its own skills, command, CLAUDE.md and project-scope MCP server, and Claude Code's record of working in it, which is how the orchestrator finds it. */
export function openFolder(home: string, claudeDir: string): string {
  const folder = join(home, "work", "payments-api");
  write(join(folder, "CLAUDE.md"), "# payments-api\n\nThe made-up payments API of the stand-in team.\n");
  write(join(folder, "src", "index.js"), "export const version = 1;\n");
  write(join(folder, ".claude", "skills", "folder-checklist", "SKILL.md"), skill("folder-checklist", "The checks this folder asks for", "Run npm test before a request."));
  write(join(folder, ".claude", "commands", "deploy.md"), command("Deploy the payments API to staging", "Deploy to staging."));
  write(join(folder, ".mcp.json"), JSON.stringify({ mcpServers: { ledger: { command: "node", args: ["ledger-mcp.js"], env: { LEDGER_KEY: PLANTED.projectMcpEnv } } } }, null, 2));
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Stand In", "-c", "user.email=stand-in@example.invalid", ...args], { cwd: folder, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "Start the payments API");
  const real = realpathSync(folder);
  write(join(claudeDir, "projects", real.replace(/[^a-zA-Z0-9]/g, "-"), "session-1.jsonl"), `${JSON.stringify({ type: "summary", note: "a session in the payments API" })}\n`);
  return real;
}

export function placeStandIn(root: string): string {
  const claude = join(root, "claude");
  copyFileSync(STAND_IN_CLAUDE, claude);
  chmodSync(claude, 0o755);
  return claude;
}

/** The calls the stand-in CLI answered, one object a line, oldest first. */
export function standInCalls(built: Pick<HandbookHome, "standIn">): { call: string; args: string[]; [key: string]: unknown }[] {
  try {
    return readFileSync(join(built.standIn, "calls.log"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}
