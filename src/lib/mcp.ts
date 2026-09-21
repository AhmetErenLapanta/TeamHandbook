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

export type McpRefusal = "credential-field" | "secret-pattern" | "url-token" | "unsupported-shape";

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


// A token embedded in the URL is the one credential shape BOTH nets above were measured to
// miss, and it is not exotic: Zapier, Composio, Smithery and Pipedream all hand out a
// server URL with the secret in a path segment or a query value, and `claude mcp add`
// writes it exactly as given. Such a server passed as "migratable", and the merge request
// then printed the endpoint under a promise that no credential travelled.
//
// Be honest about what this is. Unlike the headers/env rule, this is NOT a structural
// guarantee - it is a heuristic, a pattern race of the kind this file otherwise refuses to
// enter, and it is here only because the alternative was a written guarantee that is
// false. It catches an opaque high-entropy segment; it will miss a credential that is
// short, or lowercase-with-hyphens, or that reads like a word. Everything downstream of it
// states its claim in terms of what was actually checked, never "this holds no secret".
//
// The thresholds are measured, not guessed, against two sets: five real-provider URLs that
// must be caught and ten that must pass (seven public endpoint shapes plus every live
// {type,url} server on the machine this was written on).
//   - 12 characters is the LARGEST minimum that still catches all five: Smithery's
//     `?profile=abc123def456` is exactly 12, so 13 lets it through. A smaller minimum only
//     adds false positives, and nothing measured needed one.
//   - letters AND digits together, because a word-shaped segment (`mcp`, `composio`,
//     `streamable-http`) is a route, not a secret.
//   - separators are the tie-breaker: `streamable-http-v1` is 18 characters with a digit
//     and must pass, while `NjM4YTk5ZTQtYjk2Mi00` is hyphenated too. Mixed case separates
//     them - base64 carries it, a route name does not - so a hyphenated all-lowercase
//     segment passes and an unseparated one (`abc123def456`) does not.
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIN_TOKEN_CHARS = 12;
const HEX_TOKEN_CHARS = 16;

function tokenLike(value: string): boolean {
  if (UUID_SHAPE.test(value)) return true;
  if (value.length >= HEX_TOKEN_CHARS && /^[0-9a-f]+$/i.test(value)) return true;
  if (value.length < MIN_TOKEN_CHARS) return false;
  if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) return false;
  const mixedCase = /[a-z]/.test(value) && /[A-Z]/.test(value);
  return mixedCase || !/[-_.]/.test(value);
}

/** Where a token appears to be embedded in this URL, or null. */
export function urlToken(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null; // not a URL we can take apart; detectSecret still saw the raw string
  }
  for (const segment of parsed.pathname.split("/")) {
    if (!segment) continue;
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      // a malformed escape is not a reason to stop looking at the rest
    }
    if (tokenLike(decoded)) return `path segment "${decoded}"`;
  }
  for (const [key, value] of parsed.searchParams) {
    if (tokenLike(value)) return `query parameter "${key}"`;
  }
  return null;
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
  // Second net. It reaches where the structural rule cannot - `url` carrying `user:pass@`
  // is the measured example - and the structural rule reaches where its keyword list does
  // not. Neither stands in for the other, and the two together are still not exhaustive:
  // the URL shape below is one both of them missed.
  const pattern = detectSecret(JSON.stringify(config));
  if (pattern) {
    return { ...base, transport, startsProcess, reason: "secret-pattern", detail: pattern };
  }
  const embedded = typeof config.url === "string" ? urlToken(config.url) : null;
  if (embedded) {
    return { ...base, transport, startsProcess, reason: "url-token", detail: embedded };
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
  if (audit.reason === "url-token") {
    return (
      `"${name}" is not shareable as written: its URL carries what looks like a credential ` +
      `(${audit.detail}). Providers that put the secret in the endpoint hand every teammate ` +
      "the manager's own access, so this stays here. Ask the provider for a URL without the " +
      "token, or pass the credential in a header as a ${VAR} reference."
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
/** The map a .mcp.json keeps its servers in, under either shape mergeServersIntoMcpJson
 * preserves. One definition, so a reader and the writer cannot disagree about which keys
 * of a file are server names. */
function serverMap(parsed: Record<string, unknown>): Record<string, unknown> {
  return isPlainObject(parsed.mcpServers) ? parsed.mcpServers : parsed;
}

/** The servers a team's .mcp.json already declares. Best-effort by design: an unreadable
 * or absent file means "nothing is known", never "nothing is there" - the caller uses this
 * to label a screen, and the refusal that matters is made against the real file later. */
export function declaredServerNames(existing: string | null): string[] {
  if (!existing || !existing.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(existing);
    return isPlainObject(parsed) ? Object.keys(serverMap(parsed)) : [];
  } catch {
    return [];
  }
}

export function mergeServersIntoMcpJson(
  existing: string | null,
  servers: McpServerEntry[],
  // Per name, never per request: a publisher shown two refusals and consenting to one of
  // them must not have the other replaced by the same answer.
  replaceExisting: (name: string) => boolean = () => false,
): { merged: string; collided: string[]; replaced: string[] } {
  let target: Record<string, unknown> = {};
  let document: Record<string, unknown> | null = null;
  if (existing !== null && existing.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch {
      // Never rewrite a file we cannot read: the servers the team already depends on are
      // in there, and replacing them with ours would be the loudest possible bug. This
      // throws rather than joining the per-server refusals below because it is a property
      // of the repository, not of any one server: no selection can be salvaged from it.
      throw new Error(
        ".mcp.json in the team repository is not valid JSON. Fix it there first; " +
          "TeamHandbook will not overwrite a file it cannot read.",
      );
    }
    if (!isPlainObject(parsed)) {
      throw new Error(".mcp.json in the team repository is not a JSON object.");
    }
    document = parsed;
    target = serverMap(parsed);
  }
  // The file is parsed once for the whole selection. Merging one server at a time would
  // re-read a document the previous merge had already rewritten, and the shape detection
  // above only holds against the file the team actually wrote.
  const collided: string[] = [];
  const replaced: string[] = [];
  for (const server of servers) {
    if (Object.prototype.hasOwnProperty.call(target, server.name)) {
      // The default. Replacing is possible, but only for a caller that was refused once
      // and came back saying so: nothing infers consent from the fact that a name matched.
      if (!replaceExisting(server.name)) {
        collided.push(server.name);
        continue;
      }
      replaced.push(server.name);
    }
    if (document === null) {
      // A file we create uses the documented wrapper.
      document = { mcpServers: target };
    }
    target[server.name] = server.config;
  }
  return { merged: JSON.stringify(document ?? { mcpServers: {} }, null, 2) + "\n", collided, replaced };
}

/** One server at a time. A collision is its only outcome, so it throws. */
export function mergeServerIntoMcpJson(
  existing: string | null,
  name: string,
  config: Record<string, unknown>,
): string {
  const { merged, collided } = mergeServersIntoMcpJson(existing, [{ name, scope: "user", config }]);
  if (collided.length) {
    throw new Error(
      `the team repository already declares an MCP server named "${name}". ` +
        "Rename yours, or edit the team's .mcp.json directly.",
    );
  }
  return merged;
}

/** The short form for a list, where refusalMessage's three sentences of advice do not fit. */
export function refusalSummary(audit: McpAudit): string {
  if (audit.reason === "credential-field") return `${audit.detail} holds a literal value`;
  if (audit.reason === "url-token") return `its URL carries what looks like a credential (${audit.detail})`;
  return String(audit.detail);
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
      : `not shareable: ${refusalSummary(audit)}`;
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
