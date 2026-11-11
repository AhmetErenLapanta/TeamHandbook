import { gitAsyncMaybe } from "../git.js";
import { detectSecret } from "../plugin.js";

/**
 * A repository's task environment, kept in the repository and changed only by a reviewed
 * request like any other file there: the command that prepares a checkout, and the domains the
 * agent and the team's tests may reach. The setup step gets the network; the agent gets the list.
 */
export const ENVIRONMENT_FILE = ".teamhandbook/environment.json";

export interface TaskEnvironment {
  setup: { command: string; network: boolean } | null;
  /** The only domains the agent's and the tests' traffic may reach; null leaves the network as the orchestrator sets it. */
  allowedDomains: string[] | null;
}

const DOMAIN = /^(?:\*\.)?(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const MAX_DOMAINS = 100;
const MAX_COMMAND = 1_000;

function keysOnly(value: Record<string, unknown>, allowed: string[], where: string): string | null {
  const extra = Object.keys(value).filter((k) => !allowed.includes(k));
  return extra.length ? `${where} has ${extra.map((k) => JSON.stringify(k)).join(", ")}, which the orchestrator does not read` : null;
}

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/**
 * The environment a file describes, or the reason it is not one. A key the orchestrator does not
 * read is refused rather than skipped: a misspelled `allowedDomains` read as nothing would run
 * the agent with the whole network the team meant to take away.
 */
export function parseEnvironment(text: string): TaskEnvironment | { refused: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { refused: `${ENVIRONMENT_FILE} is not valid JSON` };
  }
  if (!isObject(raw)) return { refused: `${ENVIRONMENT_FILE} is not a JSON object` };
  const top = keysOnly(raw, ["setup", "agent"], ENVIRONMENT_FILE);
  if (top) return { refused: top };
  let setup: TaskEnvironment["setup"] = null;
  if (raw.setup !== undefined) {
    if (!isObject(raw.setup)) return { refused: "setup is an object with a command" };
    const keys = keysOnly(raw.setup, ["command", "network"], "setup");
    if (keys) return { refused: keys };
    const command = raw.setup.command;
    if (typeof command !== "string" || !command.trim() || command.length > MAX_COMMAND || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(command)) {
      return { refused: `setup.command is a shell command of at most ${MAX_COMMAND} characters` };
    }
    // The file is read into every task's log; a credential belongs in the orchestrator's secrets, by name.
    const secret = detectSecret(command);
    if (secret) return { refused: `setup.command looks like it contains a secret (${secret}); refer to it by an environment variable's name instead` };
    if (raw.setup.network !== undefined && typeof raw.setup.network !== "boolean") return { refused: "setup.network is true or false" };
    setup = { command: command.trim(), network: raw.setup.network !== false };
  }
  let allowedDomains: string[] | null = null;
  if (raw.agent !== undefined) {
    if (!isObject(raw.agent)) return { refused: "agent is an object with allowedDomains" };
    const keys = keysOnly(raw.agent, ["allowedDomains"], "agent");
    if (keys) return { refused: keys };
    const domains = raw.agent.allowedDomains;
    // A name whose last part is all digits reads as an address, which a list of names holds nothing against.
    if (!Array.isArray(domains) || domains.length > MAX_DOMAINS || !domains.every((d) => typeof d === "string" && DOMAIN.test(d) && !/\.\d+$/.test(d))) {
      return { refused: `agent.allowedDomains is a list of at most ${MAX_DOMAINS} domain names, each one written plainly or as *.example.com` };
    }
    allowedDomains = [...new Set((domains as string[]).map((d) => d.toLowerCase()))];
  }
  return { setup, allowedDomains };
}

/** The environment at the commit a task checks out; null when the repository keeps none. */
export async function readEnvironment(mirror: string, sha: string): Promise<TaskEnvironment | { refused: string } | null> {
  const text = await gitAsyncMaybe(["show", `${sha}:${ENVIRONMENT_FILE}`], mirror);
  return text === null ? null : parseEnvironment(text);
}
