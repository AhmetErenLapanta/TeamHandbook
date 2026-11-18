import { isAbsolute } from "node:path";
import { ChangeRefused } from "../changes.js";

export type McpScope = "user" | "local" | "project";

const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const SCOPES: readonly McpScope[] = ["user", "local", "project"];
const MAX_PAIRS = 20;
const MAX_VALUE = 4096;
const MAX_ARGS = 50;
const MAX_ARG = 1000;
const HIDDEN = "••••";

/** A text with no control character a command line or a header would be broken by. */
const plain = (text: string): boolean => !/[\p{C}]/u.test(text);

export interface McpAddInput {
  name: string;
  reach: "http" | "stdio";
  scope: McpScope;
  /** The id of a folder the orchestrator lists, for the scopes that belong to a folder. */
  folder: string | null;
  url: string | null;
  command: string | null;
  args: string[];
  env: { name: string; value: string }[];
  headers: { name: string; value: string }[];
}

const refuse = (message: string): never => {
  throw new ChangeRefused(message);
};

export const cleanMcpName = (raw: unknown): string => (typeof raw === "string" && NAME.test(raw) ? raw : refuse("a server's name is letters, digits, dash and underscore, up to 64"));

export function cleanScope(raw: unknown): McpScope {
  return SCOPES.includes(raw as McpScope) ? (raw as McpScope) : refuse("the scope is user, local or project");
}

function pairs(raw: unknown, what: string, namePattern: RegExp): { name: string; value: string }[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_PAIRS) return refuse(`${what} is a list of at most ${MAX_PAIRS} name and value pairs`);
  return raw.map((p) => {
    const item = p as { name?: unknown; value?: unknown };
    if (typeof item.name !== "string" || !namePattern.test(item.name)) return refuse(`a ${what} name is not in the form the command takes`);
    // A line break or a NUL in a value would end the header or the variable early and smuggle in another.
    if (typeof item.value !== "string" || !item.value || item.value.length > MAX_VALUE || /[\r\n\0]/.test(item.value)) return refuse(`the value of ${item.name} is empty, too long or has a line break`);
    return { name: item.name, value: item.value };
  });
}

/** The input of an add, checked in full before anything runs. */
export function cleanMcpAdd(body: Record<string, unknown>): McpAddInput {
  const reach = body.reach === "http" || body.reach === "stdio" ? body.reach : refuse("it is reached over http or by a local command");
  const scope = cleanScope(body.scope);
  const folder = typeof body.folder === "string" && body.folder ? body.folder : null;
  if (scope !== "user" && !folder) refuse("choose the folder it is for");
  let url: string | null = null;
  let command: string | null = null;
  let args: string[] = [];
  if (reach === "http") {
    // The person's own Claude Code reaches it, not the orchestrator, so a server on this machine or a private network is theirs to add; the address itself is still held to a plain web address.
    try {
      const parsed = new URL(String(body.url ?? ""));
      if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username || parsed.password || String(body.url).length > 2048 || !plain(String(body.url))) refuse("the address is a web address with no user name or password");
      url = parsed.toString();
    } catch (err) {
      if (err instanceof ChangeRefused) throw err;
      refuse("the address is not a URL");
    }
  } else {
    if (typeof body.command !== "string" || !body.command.trim() || body.command.length > 500 || !plain(body.command)) refuse("name the command to run");
    command = String(body.command).trim();
    const given = body.args ?? [];
    if (!Array.isArray(given) || given.length > MAX_ARGS || given.some((a) => typeof a !== "string" || a.length > MAX_ARG || /[\0\r\n]/.test(a))) refuse("the arguments are a list of at most 50 short texts");
    args = given as string[];
  }
  const env = pairs(body.env, "environment variable", ENV_NAME);
  const headers = pairs(body.headers, "header", HEADER_NAME);
  if (reach === "http" && env.length) refuse("a server reached over http takes headers, not environment variables");
  if (reach === "stdio" && headers.length) refuse("a server run as a command takes environment variables, not headers");
  return { name: cleanMcpName(body.name), reach, scope, folder: scope === "user" ? null : folder, url, command, args, env, headers };
}

/**
 * The arguments of `claude mcp add`. The server's own arguments follow `--`, so a command that
 * begins with a dash is a command and never a flag. With `hidden`, every value is dots: the line
 * the page shows before anything runs.
 */
export function mcpAddArgs(input: McpAddInput, hidden = false): string[] {
  const shown = (value: string) => (hidden ? HIDDEN : value);
  const base = ["mcp", "add", "-s", input.scope, "-t", input.reach, input.name];
  if (input.reach === "http") return [...base, input.url!, ...input.headers.flatMap((h) => ["-H", `${h.name}: ${shown(h.value)}`])];
  return [...base, ...input.env.flatMap((e) => ["-e", `${e.name}=${shown(e.value)}`]), "--", input.command!, ...input.args];
}

export const mcpRemoveArgs = (name: string, scope: McpScope): string[] => ["mcp", "remove", "-s", scope, name];

/** The command as a line to read, shell-quoted only where a space needs it. */
export function commandLine(args: string[]): string {
  return ["claude", ...args].map((a) => (/^[\w@%+=:,./-]+$/.test(a) || a === HIDDEN ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(" ");
}

/** The folder a scope belongs to, as the orchestrator knows it: a listed folder's own path, never one a browser sent. */
export function folderPath(repo: { url: string } | undefined): string {
  return repo && isAbsolute(repo.url) ? repo.url : refuse("that is not a folder on this machine");
}
