import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { detectSecret } from "./secrets.js";

// Reading the manager's own Claude Code setup, and deciding which of its MCP servers may
// travel to a team repository at all.
//
// ~/.claude.json is the live client's state file. This module opens it READ-ONLY and never
// writes to it: it belongs to the running process, and a plugin rewriting it would race the
// very client it is trying to configure. Sharing a server does not remove the local one.

export type McpScope = "user" | "project";

export interface McpServerEntry {
  name: string;
  scope: McpScope;
  config: Record<string, unknown>;
}

export type McpRefusal = "credential-field" | "secret-pattern" | "unsupported-shape";

export interface McpAudit {
  migratable: boolean;
  reason?: McpRefusal;
  // the exact key that refused it, so the manager knows what to rewrite instead of
  // guessing which of six headers was the problem
  detail?: string;
  // variables the teammate's environment must supply for this server to start
  requiresEnv: string[];
  // true when enabling the plugin starts a process on every teammate's machine
  startsProcess: boolean;
  transport: string;
}

/**
 * A `headers.*` or `env.*` value may travel ONLY when it is a pure `${VAR}` reference:
 * the NAME of the secret is shared, the secret itself stays on this machine.
 *
 * The rule is structural on purpose. `detectSecret` was measured against eight real and
 * synthetic server shapes and missed five: `headers.Cookie`, a 16-character opaque
 * `Bearer`, `env.NOTION_KEY: "secret_..."`, and tokens passed through `args`. Every miss
 * had the same cause - the key name was not in its keyword list - so the fix that
 * suggests itself is to add the missing names. That loses the race permanently: the next
 * server calls its credential something the list has never seen, and a miss here is
 * fail-OPEN, which means a live credential committed to a repository the whole team can
 * read. So this does not ask "does the value look like a secret". It asks the manager to
 * prove it is not one, and the only proof that scales is a reference to something this
 * file does not contain.
 *
 * `${VAR:-fallback}` is deliberately NOT accepted: the fallback is a literal, and a
 * literal is exactly what must not travel.
 */
const PURE_VAR_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

// Fields whose values are credentials often enough that a literal in one is never worth
// the benefit of the doubt.
const CREDENTIAL_BEARING_FIELDS = ["headers", "env"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Where Claude Code keeps the live configuration this command reads. CLAUDE_CONFIG_DIR is
 * honoured because the client honours it; a developer who moved their config would
 * otherwise be told they have no servers at all.
 */
export function claudeConfigFile(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR?.trim();
  return join(dir || homedir(), ".claude.json");
}

/**
 * The MCP servers configured for THIS machine and THIS project, newest scope winning.
 *
 * Deliberately not every project in the file: a manager's ~/.claude.json holds the servers
 * of every repository they have ever opened, and offering another team's internal server
 * for sharing here is how a URL ends up in the wrong handbook. User scope applies
 * everywhere, the current project's scope applies here, and that is the setup a teammate
 * is being handed.
 *
 * Fails closed on an unreadable file, mirroring config.ts: a file we cannot parse is not
 * an empty setup, it is an unknown one.
 */
export function readLocalServers(
  file: string = claudeConfigFile(),
  cwd: string = process.cwd(),
): McpServerEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  if (!isPlainObject(parsed)) return [];
  const byName = new Map<string, McpServerEntry>();
  const collect = (map: unknown, scope: McpScope): void => {
    if (!isPlainObject(map)) return;
    for (const [name, config] of Object.entries(map)) {
      if (!name.trim() || !isPlainObject(config)) continue;
      // project scope overwrites user scope for the same name, which is the server the
      // client actually resolves in this directory
      byName.set(name, { name, scope, config });
    }
  };
  collect(parsed.mcpServers, "user");
  const projects = isPlainObject(parsed.projects) ? parsed.projects : {};
  const here = projects[cwd];
  collect(isPlainObject(here) ? here.mcpServers : undefined, "project");
  return [...byName.values()];
}

function transportOf(config: Record<string, unknown>): string {
  if (typeof config.type === "string" && config.type.trim()) return config.type.trim();
  return typeof config.command === "string" ? "stdio" : "unknown";
}

/**
 * May this server be written into the team repository, and what does a reviewer have to
 * be told about it?
 *
 * Refusing is the whole answer for a credential-bearing server; redaction is not. A server
 * carried over with `Authorization: "[REDACTED]"` fails to connect on every teammate's
 * machine, so redacting would ship something broken while reporting success. The manager
 * is told which key to rewrite as `${VAR}` instead - a one-line edit that leaves the team
 * with a server that actually works.
 */
export function auditServer(config: unknown): McpAudit {
  const base = { migratable: false, requiresEnv: [], startsProcess: false, transport: "unknown" };
  if (!isPlainObject(config)) return { ...base, reason: "unsupported-shape", detail: "not an object" };
  const transport = transportOf(config);
  const startsProcess = typeof config.command === "string" && config.command.trim() !== "";
  const hasUrl = typeof config.url === "string" && config.url.trim() !== "";
  if (!startsProcess && !hasUrl) {
    return { ...base, transport, reason: "unsupported-shape", detail: "no command and no url" };
  }
  const requiresEnv: string[] = [];
  for (const field of CREDENTIAL_BEARING_FIELDS) {
    const values = config[field];
    if (values === undefined) continue;
    if (!isPlainObject(values)) {
      return { ...base, transport, startsProcess, reason: "unsupported-shape", detail: field };
    }
    for (const [key, value] of Object.entries(values)) {
      const reference = typeof value === "string" ? PURE_VAR_REFERENCE.exec(value) : null;
      if (!reference) {
        return {
          ...base,
          transport,
          startsProcess,
          reason: "credential-field",
          detail: `${field}.${key}`,
        };
      }
      if (!requiresEnv.includes(reference[1]!)) requiresEnv.push(reference[1]!);
    }
  }
  // Second net, not a replacement for the first. The structural rule cannot see a
  // credential that lives outside headers and env - `url` carrying `user:pass@` is the
  // measured example - and detectSecret cannot see one whose key it does not recognise.
  // Each covers what the other misses; neither is allowed to stand in for the other.
  const pattern = detectSecret(JSON.stringify(config));
  if (pattern) {
    return { ...base, transport, startsProcess, reason: "secret-pattern", detail: pattern };
  }
  return { migratable: true, requiresEnv, startsProcess, transport };
}

export function refusalMessage(name: string, audit: McpAudit): string {
  if (audit.reason === "credential-field") {
    return (
      `"${name}" is not shareable as written: ${audit.detail} holds a literal value. ` +
      "Anything in headers or env that is not a plain ${VAR} reference is treated as a " +
      "credential and stays on this machine. Rewrite it as ${VAR} (the name travels, the " +
      "value does not), then run this again."
    );
  }
  if (audit.reason === "secret-pattern") {
    return (
      `"${name}" is not shareable: its definition contains what looks like a ${audit.detail}. ` +
      "Move the credential into an environment variable and reference it as ${VAR}."
    );
  }
  return `"${name}" is not a server this command can share (${audit.detail ?? "unsupported shape"}).`;
}

/**
 * The team repository declares its servers in a root `.mcp.json`, which is how every
 * plugin in the field does it (28 of them on this machine; zero declare servers inline in
 * plugin.json). Verified against Claude Code 2.1.271: `claude mcp list` reports
 * plugin-declared servers from both the `{"mcpServers": {...}}` wrapper and a bare server
 * map as Connected, and the official reference documents the wrapper.
 *
 * Which means an existing file's shape has to be preserved rather than normalised. Adding
 * an `mcpServers` key to a file written as a bare map would turn that map's entries into
 * siblings of a wrapper - the team's working server silently stops being a declaration.
 */
export function mergeServerIntoMcpJson(
  existing: string | null,
  name: string,
  config: Record<string, unknown>,
): string {
  let target: Record<string, unknown> = {};
  let document: Record<string, unknown> | null = null;
  if (existing !== null && existing.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch {
      // Never rewrite a file we cannot read: the servers the team already depends on are
      // in there, and replacing them with ours would be the loudest possible bug.
      throw new Error(
        ".mcp.json in the team repository is not valid JSON. Fix it there first; " +
          "TeamHandbook will not overwrite a file it cannot read.",
      );
    }
    if (!isPlainObject(parsed)) {
      throw new Error(".mcp.json in the team repository is not a JSON object.");
    }
    document = parsed;
    target = isPlainObject(parsed.mcpServers) ? parsed.mcpServers : parsed;
  }
  if (Object.prototype.hasOwnProperty.call(target, name)) {
    throw new Error(
      `the team repository already declares an MCP server named "${name}". ` +
        "Rename yours, or edit the team's .mcp.json directly.",
    );
  }
  target[name] = config;
  if (document === null) {
    // A file we create uses the documented wrapper.
    document = { mcpServers: { [name]: config } };
  }
  return JSON.stringify(document, null, 2) + "\n";
}

/**
 * The read-only first screen: every server this machine could share, and for the ones it
 * cannot, why not.
 *
 * Listing the refused servers matters more than listing the shareable ones. A manager who
 * sees only what is offered assumes the rest does not exist; a manager who sees
 * "headers.Authorization holds a literal value" knows there is one edit between them and
 * sharing it.
 */
export function formatServerList(entries: McpServerEntry[]): string {
  if (!entries.length) {
    return (
      "No MCP servers are configured for this machine or this project, so there is nothing " +
      "to share yet. Add one the way you normally would (claude mcp add), then run this again."
    );
  }
  const lines = ["Your MCP servers, as Claude Code has them here:", ""];
  for (const entry of entries) {
    const audit = auditServer(entry.config);
    const state = audit.migratable
      ? audit.startsProcess
        ? "shareable (starts a process on every teammate's machine)"
        : "shareable"
      : `not shareable: ${audit.reason === "credential-field" ? `${audit.detail} holds a literal value` : audit.detail}`;
    const needs = audit.requiresEnv.length ? `, needs ${audit.requiresEnv.join(", ")}` : "";
    lines.push(`  ${entry.name}  [${entry.scope}, ${audit.transport}]  ${state}${needs}`);
  }
  lines.push(
    "",
    "Nothing has been shared. Anything in headers or env that is not a plain ${VAR}",
    "reference stays here: the name of a secret can travel, the secret itself cannot.",
  );
  return lines.join("\n");
}
