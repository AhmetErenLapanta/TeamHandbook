import { readFileSync } from "node:fs";

/**
 * A secret setting, from `NAME` or from the file `NAME_FILE` names: the second is how Docker
 * and Kubernetes secrets arrive, so the value stays out of the process listing, the compose
 * file and `docker inspect`. Both set is refused rather than one silently winning, and so is
 * a file that is missing or empty: an operator who pointed at a secret expects it to be used.
 * One trailing newline, the one an editor or `echo` leaves, is not part of the value.
 */
export function readSecretEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = env[name];
  const file = env[`${name}_FILE`];
  if (direct && file) throw new Error(`set ${name} or ${name}_FILE, not both`);
  if (!file) return direct || undefined;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new Error(`${name}_FILE names a file the orchestrator cannot read`);
  }
  const value = text.replace(/\r?\n$/, "");
  if (!value) throw new Error(`${name}_FILE names an empty file`);
  return value;
}
