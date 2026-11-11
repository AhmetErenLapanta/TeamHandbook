import { readFileSync, statSync } from "node:fs";
import { parseEnv } from "node:util";

/**
 * `--env-file <file>`: settings to start with, one KEY=value a line; the service starts the
 * orchestrator from ~/.handbook-orchestrator/service.env. The file holds whatever the person puts
 * in it, tokens included, so it is read only when nobody else on this machine can read or change it.
 */

export type EnvFileRead = { env: Record<string, string> } | { refused: string };

export function readEnvFile(file: string, uid: number | undefined = process.getuid?.()): EnvFileRead {
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return { refused: `${file} does not exist (handbook-orchestrator service install writes the service's own)` };
  }
  if (!stat.isFile()) return { refused: `${file} is not a file` };
  if (uid !== undefined && stat.uid !== uid) return { refused: `${file} belongs to another user; it is read only from your own file` };
  if (stat.mode & 0o077) return { refused: `others on this machine can reach ${file}; close it with: chmod 600 ${JSON.stringify(file)}` };
  return { env: parseEnv(readFileSync(file, "utf8")) as Record<string, string> };
}

/**
 * The settings a start adds to its environment. The file's win over the inherited ones, unlike
 * node's own --env-file, because launchd starts an agent with its own short PATH, which would
 * otherwise hide claude, opencode and git; the command line's flags win over the file, so the
 * service's --no-open stands whatever the file sets.
 */
export function startSettings(plan: { env: Record<string, string>; envFile?: string }, read: (file: string) => EnvFileRead = readEnvFile): EnvFileRead {
  if (!plan.envFile) return { env: plan.env };
  const file = read(plan.envFile);
  return "refused" in file ? file : { env: { ...file.env, ...plan.env } };
}
