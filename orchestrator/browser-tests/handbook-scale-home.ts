import { join } from "node:path";
import { command, MARKET, openFolder, placeStandIn, PLANTED, plugin, refuseRealHome, skill, write } from "./handbook-home.js";
import type { HandbookHome } from "./handbook-home.js";

export const CATALOG = "claude-plugins-official";
export const SCALE_PLUGINS_ON = ["docs-kit", "ledger-kit", "release-train"];
export const SIGN_IN_WAITING = ["notion", "plugin_release-train_notion", "gitlab", "plugin_incident-kit_atlassian", "linear", "figma", "sentry"];
export const CATALOG_SIZE = 400;

const TOPICS = ["review", "release", "estimate", "triage", "handoff", "refactor", "rollout", "audit", "pairing", "retro", "naming", "testing", "tracing", "caching", "migration", "pagination", "retries", "locking", "metrics", "alerts"];
const PLUGINS: { name: string; skills: number; commands: number; hooks?: boolean; server?: string }[] = [
  { name: "payments-skills", skills: 4, commands: 1 },
  { name: "docs-kit", skills: 3, commands: 1, hooks: true, server: "docs-search" },
  { name: "review-tools", skills: 6, commands: 2 },
  { name: "ledger-kit", skills: 6, commands: 1, hooks: true, server: "ledger-sandbox" },
  { name: "release-train", skills: 5, commands: 2, server: "plugin-notion" },
  { name: "data-notes", skills: 7, commands: 1 },
  { name: "api-style", skills: 5, commands: 2 },
  { name: "infra-notes", skills: 6, commands: 1, hooks: true },
  { name: "onboarding-kit", skills: 4, commands: 3 },
  { name: "test-helpers", skills: 7, commands: 1 },
  { name: "incident-kit", skills: 5, commands: 2, server: "plugin-atlassian" },
  { name: "design-notes", skills: 4, commands: 2 },
];
const NOT_INSTALLED = ["queue-kit", "mobile-notes", "search-kit", "billing-notes", "audit-kit", "cache-kit", "export-notes", "import-kit", "sync-notes", "report-kit"];

const named = (prefix: string, i: number) => `${prefix}-${TOPICS[i % TOPICS.length]}${i >= TOPICS.length ? `-${Math.floor(i / TOPICS.length) + 1}` : ""}`;
const FOLDED = (name: string) => `---\nname: ${name}\ndescription: >-\n  Use when a change to ${name} is about to be reviewed,\n  and the notes of the last review are still open.\n---\n\nRead the open notes first, then the diff.\n`;

const catalogDescription = (i: number) => (i % 7 === 0 ? `Keeps ${TOPICS[i % TOPICS.length]} notes for a made-up team in one place, with a template for each kind of change, a checklist per release, a weekly summary of what was left open, and links to the places where the decisions were taken.` : `Helps with ${TOPICS[i % TOPICS.length]} work.`);

export function buildScaleHome(root: string): HandbookHome {
  refuseRealHome(root);
  const home = join(root, "home");
  const claudeDir = join(home, ".claude");
  const standIn = join(home, ".stand-in");
  const hook = (command: string, matcher?: string) => [{ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command }] }];

  write(join(claudeDir, "CLAUDE.md"), "# How I work\n\nSmall changes, tests first.\n\n## Reviews\n\nRead the diff twice.\n");
  write(join(claudeDir, "settings.json"), JSON.stringify({
    env: { PAYMENTS_DEBUG_TOKEN: PLANTED.settingsEnv },
    hooks: {
      PreToolUse: hook("echo guard-bash", "Bash"),
      PostToolUse: hook("echo format-after-edit", "Edit|Write"),
      Stop: hook(`curl -s -H "Authorization: Bearer ${PLANTED.hookCommand}" https://hooks.example.invalid/stop`),
      SessionStart: hook("echo session-banner"),
    },
  }, null, 2));
  write(join(claudeDir, ".credentials.json"), JSON.stringify({ accessToken: PLANTED.credentials }));
  for (let i = 0; i < 31; i += 1) {
    const name = named("my", i);
    write(join(claudeDir, "skills", name, "SKILL.md"), i % 3 === 0 ? FOLDED(name) : skill(name, `My way of ${TOPICS[i % TOPICS.length]}`, `Notes for ${name}.`));
  }
  for (let i = 0; i < 12; i += 1) write(join(claudeDir, "commands", `${named("run", i)}.md`), command(`Run my ${TOPICS[i % TOPICS.length]} routine`, "Do the routine."));
  const servers = Object.fromEntries(["postgres", "jira", "notion", "gitlab", "linear", "figma", "sentry"].map((name) => [name, { command: "node", args: [`${name}-mcp.js`], env: { [`${name.toUpperCase()}_TOKEN`]: PLANTED.mcpEnv } }]));
  write(join(home, ".claude.json"), JSON.stringify({ mcpServers: servers }, null, 2));

  const plugins = join(claudeDir, "plugins");
  const market = join(plugins, "marketplaces", MARKET);
  const catalog = join(plugins, "marketplaces", CATALOG);
  const installed: Record<string, unknown> = {};
  const state = PLUGINS.map((spec) => {
    const id = `${spec.name}@${MARKET}`;
    const body = {
      name: spec.name,
      version: "1.0.0",
      skills: Array.from({ length: spec.skills }, (_, i): [string, string, string] => [named(spec.name.split("-")[0]!, i), `A skill of ${spec.name}`, `Notes of ${spec.name}.`]),
      commands: Array.from({ length: spec.commands }, (_, i): [string, string] => [named("do", i), `A command of ${spec.name}`]),
      ...(spec.hooks ? { hooks: { PreToolUse: hook(`echo ${spec.name}-hook`) } } : {}),
      ...(spec.server ? { servers: { [spec.server]: { command: "node", args: [`${spec.server}.js`], env: { PLUGIN_TOKEN: PLANTED.pluginMcpEnv } } } } : {}),
    };
    const dir = join(plugins, "cache", MARKET, spec.name, "1.0.0");
    plugin(dir, body);
    plugin(join(market, spec.name), body);
    installed[id] = [{ scope: "user", installPath: dir, version: "1.0.0", installedAt: "2026-10-01T09:00:00.000Z" }];
    return { id, name: spec.name, version: "1.0.0", enabled: SCALE_PLUGINS_ON.includes(spec.name), scope: "user" };
  });
  const ownDir = join(plugins, "cache", "teamhandbook", "handbook", "1.0.0");
  plugin(ownDir, { name: "handbook", version: "1.0.0", skills: [["learn-from-session", "TeamHandbook's own skill", "Notes."]] });
  installed["handbook@teamhandbook"] = [{ scope: "user", installPath: ownDir, version: "1.0.0", installedAt: "2026-10-01T09:00:00.000Z" }];
  state.push({ id: "handbook@teamhandbook", name: "handbook", version: "1.0.0", enabled: true, scope: "user" });
  const own = join(plugins, "cache", "teamhandbook", "handbook", "1.0.0");
  plugin(own, { name: "handbook", version: "1.0.0", skills: [["handbook-learn", "Keeps a lesson of a session", "Notes."]] });
  installed["handbook@teamhandbook"] = [{ scope: "user", installPath: own, version: "1.0.0", installedAt: "2026-10-01T09:00:00.000Z" }];
  state.push({ id: "handbook@teamhandbook", name: "handbook", version: "1.0.0", enabled: true, scope: "user" });
  write(join(plugins, "installed_plugins.json"), JSON.stringify({ version: 2, plugins: installed }, null, 2));
  for (const name of NOT_INSTALLED) plugin(join(market, name), { name, version: "0.3.0", skills: [[`${name}-guide`, `A skill of ${name}`, "Notes."]] });
  write(join(market, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: MARKET, owner: { name: "Stand-in Team" }, plugins: [...PLUGINS.map((p) => p.name), ...NOT_INSTALLED].map((name) => ({ name, source: `./${name}`, description: `The ${name} handbook of a made-up team.` })) }, null, 2));
  const names = Array.from({ length: CATALOG_SIZE }, (_, i) => `${TOPICS[i % TOPICS.length]}-${["kit", "tools", "notes", "helper", "guide", "pack", "desk", "lab", "flow", "base", "map", "log", "board", "check", "gate", "line", "rail", "mate", "set", "box"][Math.floor(i / TOPICS.length)]}`);
  write(join(catalog, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: CATALOG, owner: { name: "Stand-in Catalog" }, plugins: names.map((name, i) => ({ name, source: { source: "github", repo: `example-org/${name}` }, description: catalogDescription(i) })) }, null, 2));
  write(join(standIn, "state.json"), JSON.stringify({ plugins: state }, null, 2));
  write(join(standIn, "sign-in.json"), JSON.stringify(SIGN_IN_WAITING));

  return { root, home, folder: openFolder(home, claudeDir), standIn, claude: placeStandIn(root) };
}
