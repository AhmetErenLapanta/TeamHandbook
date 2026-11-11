import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { auditServer } from "../plugin.js";
import { runProcess, startProcess } from "./isolation.js";

/**
 * What a person's own Claude Code brings to a task that runs as them, read for the task form and
 * the Integrations page by names alone: their commands and skills, their plugins and their MCP
 * servers. Nothing read here is stored, logged or sent anywhere but the answer.
 */
export interface PersonalSetup {
  /** Skills and slash commands together: the CLI's own list does not tell them apart. Built-in commands are left out. */
  commands: { name: string; description: string; argumentHint: string }[];
  plugins: { name: string; marketplace: string; version: string; enabled: boolean; scope: string }[];
  /**
   * A server by name, kind and where it is defined; `asksForValue` when its definition carries a
   * credential. A plugin's server the list names without its definition is of an unknown kind, and
   * whether it asks for a value is unknown (null). Never a command, an argument, an address, a
   * header or a value.
   */
  mcpServers: { name: string; kind: "stdio" | "http" | "unknown"; scope: "user" | "project" | "plugin"; asksForValue: boolean | null }[];
  /** Whether the person keeps a CLAUDE.md of their own, which every session of theirs loads; whether it is there, never what it says. */
  claudeMd: boolean;
  readAt: string;
}

export const PERSONAL_PROBE_TIMEOUT_MS = 30_000;

const INITIALIZE_ID = "teamhandbook-probe-initialize";

/**
 * The person's commands, as the CLI itself lists them in its answer to `initialize`, the first
 * control request of a stream-json session, which needs no model turn. The run reads the user's
 * settings alone, with every hook off and no MCP server (which also keeps claude.ai's connectors
 * from syncing), and is ended as soon as it answers. Only the answer's `commands` are kept: the
 * same answer names the account and its organization, and every other line is dropped unread.
 * Read from the CLI's own code in 2.1.317, never by running it.
 */
async function commandsOf(program: string, env: Record<string, string>, cwd: string, timeoutMs: number): Promise<PersonalSetup["commands"] | null> {
  const stop = new AbortController();
  let commands: PersonalSetup["commands"] | null = null;
  const args = [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence",
    "--setting-sources", "user", "--settings", JSON.stringify({ disableAllHooks: true }), "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: {} }),
  ];
  const started = startProcess({ program, args, env, cwd }, {
    timeoutMs,
    signal: stop.signal,
    onLine: (stream, line) => {
      if (stream !== "stdout" || commands) return;
      let frame: { type?: unknown; response?: { request_id?: unknown; response?: { commands?: unknown } } };
      try {
        frame = JSON.parse(line);
      } catch {
        return;
      }
      if (frame.type !== "control_response" || frame.response?.request_id !== INITIALIZE_ID) return;
      const listed = Array.isArray(frame.response.response?.commands) ? frame.response.response.commands : [];
      commands = listed.flatMap((item: Record<string, unknown>) =>
        item && typeof item.name === "string" && item.builtin !== true ? [{ name: item.name, description: typeof item.description === "string" ? item.description : "", argumentHint: typeof item.argumentHint === "string" ? item.argumentHint : "" }] : [],
      );
      stop.abort();
    },
  });
  // Stdin stays open until the answer, so the CLI does not end before it gives one; it is ended then, or at the timeout.
  started.write(JSON.stringify({ type: "control_request", request_id: INITIALIZE_ID, request: { subtype: "initialize" } }) + "\n");
  await started.outcome;
  return commands;
}

/** The person's plugins as `claude plugin list --json` lists them, which reads their servers without connecting them; paths are left out. */
async function pluginsOf(program: string, env: Record<string, string>, cwd: string, timeoutMs: number): Promise<{ plugins: PersonalSetup["plugins"]; servers: PersonalSetup["mcpServers"] } | null> {
  const listed = await runProcess({ program, args: ["plugin", "list", "--json"], env, cwd }, { timeoutMs, signal: new AbortController().signal, onLine: () => {} });
  if (listed.code !== 0) return null;
  let items: unknown;
  try {
    items = JSON.parse(listed.stdout);
  } catch {
    return null;
  }
  const installed = Array.isArray(items) ? items : Array.isArray((items as { installed?: unknown })?.installed) ? (items as { installed: unknown[] }).installed : [];
  const plugins: PersonalSetup["plugins"] = [];
  const servers: PersonalSetup["mcpServers"] = [];
  for (const item of installed as Record<string, unknown>[]) {
    if (!item || typeof item.id !== "string") continue;
    const at = item.id.lastIndexOf("@");
    plugins.push({ name: at > 0 ? item.id.slice(0, at) : item.id, marketplace: at > 0 ? item.id.slice(at + 1) : "", version: typeof item.version === "string" ? item.version : "unknown", enabled: item.enabled === true, scope: typeof item.scope === "string" ? item.scope : "user" });
    const named = item.mcpServers;
    const entries: [unknown, unknown][] = Array.isArray(named) ? named.map((s) => [typeof s === "string" ? s : (s as { name?: unknown })?.name, null]) : named && typeof named === "object" ? Object.entries(named) : [];
    for (const [name, config] of entries) {
      if (typeof name !== "string") continue;
      const defined = config && typeof config === "object" && ("command" in config || "url" in config);
      servers.push(defined ? serverOf(name, config, "plugin") : { name, kind: "unknown", scope: "plugin", asksForValue: null });
    }
  }
  return { plugins, servers };
}

/** One server's definition as a name, a kind and whether it carries a credential, read and dropped. */
function serverOf(name: string, config: unknown, scope: "user" | "project" | "plugin"): PersonalSetup["mcpServers"][number] {
  const audit = auditServer(config);
  const kind = audit.transport === "http" || audit.transport === "sse" || audit.transport === "streamable-http" ? "http" : "stdio";
  return { name, kind, scope, asksForValue: (audit.reason !== undefined && audit.reason !== "unsupported-shape") || audit.requiresEnv.length > 0 };
}

/** The servers a JSON file names under `mcpServers`, or none: the rest of the file, an account among it, is never kept. */
async function serversIn(file: string, scope: "user" | "project"): Promise<PersonalSetup["mcpServers"]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return [];
  }
  const servers = (parsed as { mcpServers?: unknown } | null)?.mcpServers;
  return servers && typeof servers === "object" && !Array.isArray(servers) ? Object.entries(servers).map(([name, config]) => serverOf(name, config, scope)) : [];
}

/**
 * The global config file the CLI keeps the user's MCP servers in, by its own rule: a legacy
 * `.config.json` in the config folder first, then `.claude.json` in CLAUDE_CONFIG_DIR or the home.
 */
async function globalConfig(env: Record<string, string | undefined>): Promise<string> {
  const legacy = join(env.CLAUDE_CONFIG_DIR || join(env.HOME ?? "", ".claude"), ".config.json");
  if (await readFile(legacy).then(() => true, () => false)) return legacy;
  return join(env.CLAUDE_CONFIG_DIR || env.HOME || "", ".claude.json");
}

/**
 * Reads what the person's Claude Code brings, as described on PersonalSetup; null when its CLI
 * does not answer, so the form shows nothing rather than a guess. `folders` are the projects the
 * person opened, whose `.mcp.json` servers are listed by name.
 */
export async function probePersonalSetup(program: string, env: Record<string, string>, cwd: string, folders: readonly string[] = [], timeoutMs = PERSONAL_PROBE_TIMEOUT_MS): Promise<PersonalSetup | null> {
  const memory = join(env.CLAUDE_CONFIG_DIR || join(env.HOME ?? "", ".claude"), "CLAUDE.md");
  const [commands, plugins, user, claudeMd] = await Promise.all([commandsOf(program, env, cwd, timeoutMs), pluginsOf(program, env, cwd, timeoutMs), globalConfig(env).then((file) => serversIn(file, "user")), stat(memory).then((found) => found.isFile(), () => false)]);
  if (!commands) return null;
  const project = (await Promise.all(folders.map((folder) => serversIn(join(folder, ".mcp.json"), "project")))).flat();
  return { commands, plugins: plugins?.plugins ?? [], mcpServers: [...user, ...project, ...(plugins?.servers ?? [])], claudeMd, readAt: new Date().toISOString() };
}
