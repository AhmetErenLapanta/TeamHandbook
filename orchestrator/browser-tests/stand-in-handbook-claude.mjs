#!/usr/bin/env node
// The handbook suite's stand-in for the Claude Code CLI. It reads and writes only under $HOME (a stand-in home built by
// handbook-home.ts) and runs no model and no network. It answers what the orchestrator asks of a person's Claude Code:
//   --version, auth status --json
//   plugin list --json | plugin marketplace update [<name>] | plugin update <id> | plugin enable|disable <id>
//   -p, the way a task runs it (a stream-json session): the `initialize` control request answers the person's commands,
//   and a task's first turn is a launch the stand-in writes down: the skills and MCP servers a session started with those
//   arguments loads by Claude Code's documented rules (setting sources, --settings enabledPlugins and permissions.deny,
//   --disallowedTools Skill(...), --strict-mcp-config), so a scenario reads what the orchestrator handed it.
// Every call is appended to $HOME/.stand-in/calls.log as one JSON object, so a scenario sees exactly which commands ran.
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const home = process.env.HOME ?? "";
const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(home, ".claude");
const standIn = join(home, ".stand-in");
const stateFile = join(standIn, "state.json");
const log = (entry) => {
  mkdirSync(standIn, { recursive: true });
  appendFileSync(join(standIn, "calls.log"), `${JSON.stringify(entry)}\n`);
};
const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};
const state = () => readJson(stateFile) ?? { plugins: [] };
const save = (next) => {
  mkdirSync(standIn, { recursive: true });
  writeFileSync(stateFile, JSON.stringify(next, null, 2));
};
const say = (frame) => console.log(JSON.stringify(frame));
const valueOf = (flag) => args.flatMap((arg, i) => (arg === flag && args[i + 1] ? [args[i + 1]] : []));
const dirs = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : []);
const files = (dir, ext) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(ext)) : []);
const pluginDir = (p) => join(claudeDir, "plugins", "cache", p.id.slice(p.id.indexOf("@") + 1), p.name, p.version);

if (args[0] === "--version") {
  console.log("2.1.322 (Claude Code)");
  process.exit(0);
}
if (args[0] === "auth") {
  console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }));
  process.exit(0);
}

if (args[0] === "plugin") {
  const [, verb, ...rest] = args;
  const current = state();
  if (verb === "list" && args.includes("--json")) {
    log({ call: "plugin list", args });
    console.log(JSON.stringify(current.plugins.map((p) => ({ id: p.id, version: p.version, scope: p.scope, enabled: p.enabled, mcpServers: readJson(join(pluginDir(p), ".mcp.json"))?.mcpServers ?? {} }))));
    process.exit(0);
  }
  if (verb === "marketplace" && rest[0] === "update") {
    log({ call: "plugin marketplace update", args });
    console.log("Updated marketplace");
    process.exit(0);
  }
  const pluginsDir = join(claudeDir, "plugins");
  const recordFile = join(pluginsDir, "installed_plugins.json");
  const marketplaceCopy = (id) => join(pluginsDir, "marketplaces", id.slice(id.indexOf("@") + 1), id.slice(0, id.indexOf("@")));
  const versionOf = (dir) => readJson(join(dir, ".claude-plugin", "plugin.json"))?.version;
  const record = () => readJson(recordFile) ?? { version: 2, plugins: {} };
  const keep = (id, version) => {
    const market = id.slice(id.indexOf("@") + 1);
    const name = id.slice(0, id.indexOf("@"));
    const installPath = join(pluginsDir, "cache", market, name, version);
    cpSync(marketplaceCopy(id), installPath, { recursive: true });
    writeFileSync(recordFile, JSON.stringify({ ...record(), plugins: { ...record().plugins, [id]: [{ scope: "user", installPath, version, installedAt: "2026-11-12T09:00:00.000Z" }] } }, null, 2));
  };
  if (verb === "update") {
    const id = rest[0];
    const plugin = current.plugins.find((p) => p.id === id);
    log({ call: "plugin update", args });
    if (!plugin) {
      console.error(`${id} is not installed`);
      process.exit(1);
    }
    const latest = versionOf(marketplaceCopy(id));
    if (!latest || latest === plugin.version) {
      console.error(`${id} is already at the latest version (${plugin.version})`);
      process.exit(1);
    }
    keep(id, latest);
    save({ ...current, plugins: current.plugins.map((p) => (p.id === id ? { ...p, version: latest } : p)) });
    console.log(`Updated ${id} to ${latest}`);
    process.exit(0);
  }
  if (verb === "uninstall") {
    log({ call: "plugin uninstall", args });
    const { [rest[0]]: _gone, ...left } = record().plugins;
    writeFileSync(recordFile, JSON.stringify({ ...record(), plugins: left }, null, 2));
    save({ ...current, plugins: current.plugins.filter((p) => p.id !== rest[0]) });
    console.log(`Uninstalled ${rest[0]}`);
    process.exit(0);
  }
  if (verb === "install") {
    log({ call: "plugin install", args });
    const known = versionOf(marketplaceCopy(rest[0]));
    if (!known || current.plugins.some((p) => p.id === rest[0])) {
      console.error(`${rest[0]} cannot be installed`);
      process.exit(1);
    }
    keep(rest[0], known);
    save({ ...current, plugins: [...current.plugins, { id: rest[0], name: rest[0].slice(0, rest[0].indexOf("@")), version: known, enabled: true, scope: "user" }] });
    console.log(`Installed ${rest[0]}`);
    process.exit(0);
  }
  if (verb === "enable" || verb === "disable") {
    log({ call: `plugin ${verb}`, args });
    save({ ...current, plugins: current.plugins.map((p) => (p.id === rest[0] ? { ...p, enabled: verb === "enable" } : p)) });
    console.log(`${verb === "enable" ? "Enabled" : "Disabled"} ${rest[0]}`);
    process.exit(0);
  }
  log({ call: "plugin other", args });
  console.error("the stand-in Claude Code does not know that plugin command");
  process.exit(1);
}

// `claude mcp list | add <name> ... | remove <name>` for the user scope, in the global config file; the call is written down
// as given (an `-e KEY=value` among its arguments is the person's own typing, which the stand-in's log keeps and the orchestrator's must not).
if (args[0] === "mcp") {
  const [, verb] = args;
  // The server's name is the first word that is no option and no option's value, as the CLI reads it wherever the options stand.
  const withValue = new Set(["-s", "--scope", "-e", "--env", "-t", "--transport", "-H", "--header"]);
  const words = [];
  for (let i = 2; i < (args.includes("--") ? args.indexOf("--") : args.length); i += 1) {
    if (withValue.has(args[i])) i += 1;
    else if (!args[i].startsWith("-")) words.push(args[i]);
  }
  const name = words[0];
  const file = join(home, ".claude.json");
  const config = readJson(file) ?? {};
  log({ call: `mcp ${verb}`, args });
  if (verb === "list") {
    console.log(Object.keys(config.mcpServers ?? {}).map((n) => `${n}: connected`).join("\n"));
    process.exit(0);
  }
  if (verb === "remove") {
    if (!config.mcpServers?.[name]) {
      console.error(`No MCP server named ${name}`);
      process.exit(1);
    }
    delete config.mcpServers[name];
    writeFileSync(file, JSON.stringify(config, null, 2));
    console.log(`Removed MCP server ${name}`);
    process.exit(0);
  }
  if (verb === "add") {
    const env = valueOf("-e").concat(valueOf("--env")).map((pair) => pair.split("=")).reduce((all, [k, ...v]) => ({ ...all, [k]: v.join("=") }), {});
    const command = args.includes("--") ? args.slice(args.indexOf("--") + 1) : [];
    writeFileSync(file, JSON.stringify({ ...config, mcpServers: { ...(config.mcpServers ?? {}), [name]: { command: command[0] ?? "node", args: command.slice(1), env } } }, null, 2));
    console.log(`Added MCP server ${name}`);
    process.exit(0);
  }
  console.error("the stand-in Claude Code does not know that mcp command");
  process.exit(1);
}

if (!args.includes("-p")) {
  console.error("the handbook suite's stand-in claude runs nothing but a task");
  process.exit(1);
}

// ---- A session: what it loads, by the arguments it was started with.
const settingsFlag = valueOf("--settings").map((raw) => safeParse(raw) ?? readJson(raw)).filter(Boolean);
function safeParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
const sources = (valueOf("--setting-sources")[0] ?? "user,project,local").split(",").map((s) => s.trim());
const flagSettings = settingsFlag.length ? Object.assign({}, ...settingsFlag.map((s) => s)) : {};
const denyRules = [...(flagSettings.permissions?.deny ?? []), ...valueOf("--disallowedTools").flatMap((list) => list.split(","))];
const denied = new Set([
  ...denyRules.flatMap((rule) => {
    const found = /^Skill\((.+)\)$/.exec(rule.trim());
    return found ? [found[1]] : [];
  }),
  ...Object.entries(flagSettings.skillOverrides ?? {}).flatMap(([name, mode]) => (mode === "off" ? [name] : [])),
]);
const deniedServers = new Set([
  ...(flagSettings.deniedMcpServers ?? []).flatMap((entry) => (typeof entry?.serverName === "string" ? [entry.serverName] : [])),
  ...denyRules.flatMap((rule) => {
    const found = /^mcp__(.+)__\*$/.exec(rule.trim());
    return found ? [found[1]] : [];
  }),
]);
const enabledByFlag = flagSettings.enabledPlugins ?? {};

function loadedFor(cwd) {
  const current = state();
  const skills = [];
  // A plugin's skill is called, and refused, as `<plugin>:<name>`; one of the person's own or the folder's by its plain name, so a plain deny never closes a plugin's.
  const add = (dir, source, prefix = "") => dirs(dir).forEach((name) => existsSync(join(dir, name, "SKILL.md")) && !denied.has(`${prefix}${name}`) && skills.push({ name, call: `${prefix}${name}`, source }));
  if (sources.includes("user")) add(join(claudeDir, "skills"), "yours");
  if (sources.includes("project")) add(join(cwd, ".claude", "skills"), `folder:${cwd}`);
  const plugins = current.plugins.filter((p) => p.enabled && enabledByFlag[p.id] !== false);
  for (const p of plugins) add(join(pluginDir(p), "skills"), `plugin:${p.id}`, `${p.name}:`);
  const servers = [];
  const strict = args.includes("--strict-mcp-config");
  const named = (map, source) => Object.keys(map ?? {}).forEach((name) => !deniedServers.has(name) && servers.push({ name, source }));
  if (strict) named(safeParse(valueOf("--mcp-config")[0] ?? "{}")?.mcpServers, "flag");
  else {
    named(readJson(join(home, ".claude.json"))?.mcpServers, "yours");
    if (sources.includes("project")) named(readJson(join(cwd, ".mcp.json"))?.mcpServers, `folder:${cwd}`);
    for (const p of plugins) named(readJson(join(pluginDir(p), ".mcp.json"))?.mcpServers, `plugin:${p.id}`);
  }
  return { skills, servers, plugins: plugins.map((p) => p.id) };
}

const commandsHere = (cwd) => {
  const current = state();
  const list = [
    ...files(join(claudeDir, "commands"), ".md").map((f) => ({ name: f.slice(0, -3), source: "yours" })),
    ...files(join(cwd, ".claude", "commands"), ".md").map((f) => ({ name: f.slice(0, -3), source: `folder:${cwd}` })),
    ...current.plugins.filter((p) => p.enabled).flatMap((p) => files(join(pluginDir(p), "commands"), ".md").map((f) => ({ name: `${p.name}:${f.slice(0, -3)}`, source: `plugin:${p.id}` }))),
  ];
  return list.map(({ name }) => ({ name, description: "", argumentHint: "", builtin: false }));
};

const frames = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const twoWay = valueOf("--input-format")[0] === "stream-json";
const textOf = (content) => (typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part?.text ?? "").join("\n") : "");
let prompt = "";
if (twoWay) {
  for (;;) {
    const read = await frames.next();
    if (read.done) process.exit(0);
    const frame = safeParse(read.value);
    if (!frame) continue;
    if (frame.type === "control_request" && frame.request?.subtype === "initialize") {
      say({ type: "control_response", response: { subtype: "success", request_id: frame.request_id, response: { commands: commandsHere(process.cwd()) } } });
      continue;
    }
    if (frame.type === "user") {
      prompt = textOf(frame.message?.content);
      break;
    }
  }
} else {
  const all = [];
  for await (const line of createInterface({ input: process.stdin })) all.push(line);
  prompt = all.join("\n");
}

const cwd = process.cwd();
const loaded = loadedFor(cwd);
log({ call: "launch", args: args.filter((a) => a !== prompt), cwd, loaded, settings: { enabledPlugins: flagSettings.enabledPlugins ?? null, skillOverrides: flagSettings.skillOverrides ?? null, deniedMcpServers: flagSettings.deniedMcpServers ?? null, deny: denyRules.filter((r) => /^(Skill|mcp__)/.test(r)) } });
const session_id = "stand-in-handbook-session";
const waitingForSignIn = readJson(join(standIn, "sign-in.json")) ?? [];
const mcpServers = [...loaded.servers.filter((s) => !waitingForSignIn.includes(s.name)).map((s) => ({ name: s.name, status: "connected" })), ...waitingForSignIn.map((name) => ({ name, status: "needs-auth" }))];
say({ type: "system", subtype: "init", cwd, tools: ["Read", "Edit", "Write", "Skill"], permissionMode: valueOf("--permission-mode")[0] ?? "default", session_id, mcp_servers: mcpServers });

// A skill the prompt asks for is called when the session loaded it, by the name it is called by (a plugin's as <plugin>:<name>, a plain name meaning the person's or the folder's); one it did not load is not.
let n = 0;
for (const [, name] of prompt.matchAll(/^stand-in: use-skill (\S+)$/gm)) {
  if (!loaded.skills.some((s) => s.call === name)) continue;
  n += 1;
  say({ type: "assistant", message: { content: [{ type: "tool_use", id: `toolu-skill-${n}`, name: "Skill", input: { skill: name } }] }, session_id });
  say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `toolu-skill-${n}`, content: `Launching skill: ${name}` }] }, session_id });
}
// Something to open a request with.
mkdirSync(dirname(join(cwd, "handbook-note.md")), { recursive: true });
writeFileSync(join(cwd, "handbook-note.md"), "A note the stand-in agent left.\n");
say({ type: "result", subtype: "success", is_error: false, result: "Done.", num_turns: 1, total_cost_usd: 0.01, usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 20 }, permission_denials: [], terminal_reason: "completed", session_id });
process.exit(0);
