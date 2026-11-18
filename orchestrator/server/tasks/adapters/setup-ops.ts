/**
 * The commands that change a person's own Claude Code setup, at their click: Claude Code's own,
 * each read from its `--help` (2.1.322), so a change made here is the change their terminal would
 * make and nothing is written into their profile by hand. Only what the CLI has a command for is
 * here: it has none that turns an MCP server, a single skill, a command or a hook off, and none
 * that moves a server to another scope. OpenCode has no command of this kind at all
 * (ADAPTOR-sozlesme.md).
 */
export type SetupOp = "plugin.enable" | "plugin.disable" | "plugin.update" | "plugin.uninstall" | "plugin.install" | "mcp.remove";

/** Where a plugin is installed and where a server is configured, as each command's own `--scope` names them. */
export type SetupScope = "user" | "project" | "local";

const SCOPES: readonly string[] = ["user", "project", "local"];

/** A plugin as the CLI takes it, `name` or `name@marketplace`; it starts with a letter or a digit, so it is never read as an option. */
const PLUGIN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(@[A-Za-z0-9][A-Za-z0-9._-]{0,99})?$/;
const SERVER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

const PLUGIN_VERB: Record<Exclude<SetupOp, "mcp.remove">, string> = { "plugin.enable": "enable", "plugin.disable": "disable", "plugin.update": "update", "plugin.uninstall": "uninstall", "plugin.install": "install" };

/**
 * The arguments Claude Code is run with for one change, with no shell between, or null for a target
 * or a scope that is not one: the caller then runs nothing. A plugin command answers in one JSON
 * line (`--json`). An update or an install whose marketplace names a command of its own is not
 * confirmed here (no `-y`): the CLI refuses and reports the command, which is shown to the person.
 * An install takes no scope and lands in the person's own.
 */
export function claudeSetupArgs(op: SetupOp, target: string, scope?: SetupScope): string[] | null {
  if (scope !== undefined && !SCOPES.includes(scope)) return null;
  const scoped = scope ? ["--scope", scope] : [];
  if (op === "mcp.remove") return SERVER.test(target) ? ["mcp", "remove", target, ...scoped] : null;
  if (!PLUGIN.test(target) || (op === "plugin.install" && scope !== undefined)) return null;
  return ["plugin", PLUGIN_VERB[op], target, ...scoped, "--json"];
}

/** A server to add: reached over HTTP at an address, or started as a local command; its secret values go with it once and are kept nowhere here. */
export type McpServerToAdd = { name: string; scope: SetupScope } & ({ over: "http"; url: string; headers?: readonly [name: string, value: string][] } | { over: "stdio"; command: string; args?: readonly string[]; env?: readonly [name: string, value: string][] });

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
const HEADER_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;
/** A value on one line: a line break or a NUL has no place in an argument, a header or a variable. */
const oneLine = (value: string) => value.length > 0 && value.length <= 4000 && !/[\r\n\0]/.test(value);

/**
 * The arguments of `claude mcp add` for one server, in the two forms its own help shows
 * (`--transport http <name> <url> --header "Name: value"`, and `<name> -e KEY=value -- <command>
 * [args...]`), or null for a name, an address or a value that is not one. Claude Code takes an env
 * or header value only in its arguments (2.1.322 has no stdin or file form), where it stays while
 * the command runs, as when the person types it in a terminal; the caller keeps it out of every
 * log and masks the CLI's output with it.
 */
export function claudeMcpAddArgs(server: McpServerToAdd): string[] | null {
  if (!SERVER.test(server.name) || !SCOPES.includes(server.scope)) return null;
  const head = ["mcp", "add", "--scope", server.scope];
  if (server.over === "http") {
    const url = URL.canParse(server.url) ? new URL(server.url) : null;
    const headers = server.headers ?? [];
    if (!url || (url.protocol !== "https:" && url.protocol !== "http:") || !headers.every(([name, value]) => HEADER_NAME.test(name) && oneLine(value))) return null;
    return [...head, "--transport", "http", server.name, url.href, ...headers.flatMap(([name, value]) => ["--header", `${name}: ${value}`])];
  }
  const env = server.env ?? [];
  const args = server.args ?? [];
  if (!oneLine(server.command) || !args.every(oneLine) || !env.every(([name, value]) => ENV_NAME.test(name) && oneLine(value))) return null;
  return [...head, server.name, ...env.flatMap(([name, value]) => ["-e", `${name}=${value}`]), "--", server.command, ...args];
}
