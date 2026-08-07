const EXIT_CODE_KEYS = ["exit_code", "exitCode", "code", "returnCode"];
const STDOUT_TAIL_CHARS = 2000;

export function extractExitCode(response: unknown): number | undefined {
  if (typeof response !== "object" || response === null) return undefined;
  const record = response as Record<string, unknown>;
  for (const key of EXIT_CODE_KEYS) {
    const value = record[key];
    if (typeof value === "number" && Number.isInteger(value)) return value;
  }
  return undefined;
}

export function extractErrorText(response: unknown): string {
  if (typeof response === "string") return response;
  if (typeof response !== "object" || response === null) return "";
  const record = response as Record<string, unknown>;
  const stderr = record["stderr"];
  if (typeof stderr === "string" && stderr.trim()) return stderr;
  const stdout = record["stdout"];
  if (typeof stdout === "string" && stdout.trim()) return stdout.slice(-STDOUT_TAIL_CHARS);
  return "";
}
