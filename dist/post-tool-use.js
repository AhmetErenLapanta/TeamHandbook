// src/lib/hook-io.ts
async function readStdin(stream = process.stdin) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
function parseHookInput(raw) {
  if (!raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

// src/lib/normalize.ts
import { createHash } from "node:crypto";
var ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
var MAX_LINES = 40;
var MAX_CHARS = 2e3;
function normalizeErrorText(text) {
  return text.replace(ANSI_RE, "").split("\n").slice(0, MAX_LINES).join("\n").replace(/\/(?:Users|home|private|tmp|var)\/[^\s:'"()]+/g, "<path>").replace(/0x[0-9a-fA-F]+/g, "<hex>").replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>").replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<ts>").replace(/\b\d+(?:\.\d+)?\s?m?s\b/g, "<dur>").replace(/:\d+(?::\d+)?\b/g, ":<n>").replace(/\bline \d+/gi, "line <n>").replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").trim().slice(0, MAX_CHARS);
}
var SUBCOMMAND_RE = /^[a-z][a-z0-9:_-]*$/i;
var WRAPPERS = /* @__PURE__ */ new Set(["sudo", "time", "env", "command"]);
var SUB_WITH_ARG = /* @__PURE__ */ new Set(["run", "exec", "x"]);
function commandFamily(command) {
  const segments = command.split(/&&|\|\||;|\|/).map((s) => s.trim()).filter((s) => s && !/^cd\s/.test(s) && s !== "cd");
  const segment = segments[0] ?? "";
  const tokens = segment.split(/\s+/).filter((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t) && !WRAPPERS.has(t));
  const first = tokens[0];
  if (!first) return "unknown";
  const cmd = first.split("/").pop() ?? first;
  const parts = [cmd];
  const sub = tokens[1];
  if (sub && SUBCOMMAND_RE.test(sub)) {
    parts.push(sub);
    const arg = tokens[2];
    if (SUB_WITH_ARG.has(sub) && arg && SUBCOMMAND_RE.test(arg)) {
      parts.push(arg);
    }
  }
  return parts.join(" ");
}
function fingerprint(family, normalizedError) {
  return createHash("sha256").update(`${family}\0${normalizedError}`).digest("hex").slice(0, 16);
}

// src/lib/tool-response.ts
var EXIT_CODE_KEYS = ["exit_code", "exitCode", "code", "returnCode"];
var STDOUT_TAIL_CHARS = 2e3;
function extractExitCode(response) {
  if (typeof response !== "object" || response === null) return void 0;
  const record = response;
  for (const key of EXIT_CODE_KEYS) {
    const value = record[key];
    if (typeof value === "number" && Number.isInteger(value)) return value;
  }
  return void 0;
}
function extractErrorText(response) {
  if (typeof response === "string") return response;
  if (typeof response !== "object" || response === null) return "";
  const record = response;
  const stderr = record["stderr"];
  if (typeof stderr === "string" && stderr.trim()) return stderr;
  const stdout = record["stdout"];
  if (typeof stdout === "string" && stdout.trim()) return stdout.slice(-STDOUT_TAIL_CHARS);
  return "";
}

// src/lib/session-state.ts
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
function emptySessionState(sessionId) {
  return { sessionId, openErrors: [], resolvedPairs: [] };
}
function handbookHome() {
  return process.env.TEAMHANDBOOK_HOME ?? join(homedir(), ".teamhandbook");
}
function sessionFile(sessionId, home) {
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "_");
  return join(home, "sessions", `${safe}.json`);
}
function loadSessionState(sessionId, home = handbookHome()) {
  try {
    const raw = readFileSync(sessionFile(sessionId, home), "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || !Array.isArray(parsed.openErrors)) {
      return emptySessionState(sessionId);
    }
    return {
      sessionId,
      openErrors: parsed.openErrors.map((e) => ({ ...e, edits: e.edits ?? [] })),
      resolvedPairs: Array.isArray(parsed.resolvedPairs) ? parsed.resolvedPairs : []
    };
  } catch {
    return emptySessionState(sessionId);
  }
}
function saveSessionState(state, home = handbookHome()) {
  const file = sessionFile(state.sessionId, home);
  mkdirSync(join(home, "sessions"), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2));
}
function recordFailure(state, failure, at = (/* @__PURE__ */ new Date()).toISOString()) {
  const existing = state.openErrors.find((e) => e.fingerprint === failure.fingerprint);
  if (existing) {
    existing.count += 1;
    existing.lastSeenAt = at;
    existing.command = failure.command;
    return state;
  }
  state.openErrors.push({ ...failure, count: 1, firstSeenAt: at, lastSeenAt: at, edits: [] });
  return state;
}
function attachEditToOpenErrors(state, filePath) {
  let attached = false;
  for (const error of state.openErrors) {
    if (!error.edits.includes(filePath)) {
      error.edits.push(filePath);
      attached = true;
    }
  }
  return attached;
}
function resolveOpenErrors(state, family, command, at = (/* @__PURE__ */ new Date()).toISOString()) {
  const matching = state.openErrors.filter((e) => e.family === family);
  if (matching.length === 0) return [];
  state.openErrors = state.openErrors.filter((e) => e.family !== family);
  const resolved = matching.map((e) => ({ ...e, resolvedAt: at, resolvedCommand: command }));
  state.resolvedPairs.push(...resolved);
  return resolved;
}

// src/lib/capture.ts
var EDIT_TOOLS = /* @__PURE__ */ new Set(["Edit", "Write", "MultiEdit"]);
function captureBashFailure(input, home = handbookHome()) {
  if (input.tool_name !== "Bash" || !input.session_id) return false;
  const exitCode = extractExitCode(input.tool_response);
  if (exitCode === void 0 || exitCode === 0) return false;
  const command = typeof input.tool_input?.command === "string" ? input.tool_input.command : "";
  if (!command) return false;
  const error = normalizeErrorText(extractErrorText(input.tool_response));
  const family = commandFamily(command);
  const state = loadSessionState(input.session_id, home);
  recordFailure(state, {
    fingerprint: fingerprint(family, error),
    family,
    command,
    error,
    cwd: input.cwd ?? ""
  });
  saveSessionState(state, home);
  return true;
}
function captureFileEdit(input, home = handbookHome()) {
  if (!input.session_id || !EDIT_TOOLS.has(input.tool_name ?? "")) return false;
  const filePath = typeof input.tool_input?.file_path === "string" ? input.tool_input.file_path : "";
  if (!filePath) return false;
  const state = loadSessionState(input.session_id, home);
  if (!attachEditToOpenErrors(state, filePath)) return false;
  saveSessionState(state, home);
  return true;
}
function captureBashSuccess(input, home = handbookHome()) {
  if (input.tool_name !== "Bash" || !input.session_id) return false;
  if (extractExitCode(input.tool_response) !== 0) return false;
  const command = typeof input.tool_input?.command === "string" ? input.tool_input.command : "";
  if (!command) return false;
  const state = loadSessionState(input.session_id, home);
  if (state.openErrors.length === 0) return false;
  const resolved = resolveOpenErrors(state, commandFamily(command), command);
  if (resolved.length === 0) return false;
  saveSessionState(state, home);
  return true;
}

// src/hooks/post-tool-use.ts
async function main() {
  const input = parseHookInput(await readStdin());
  if (!input) return;
  captureBashFailure(input) || captureBashSuccess(input) || captureFileEdit(input);
}
main().then(
  () => process.exit(0),
  () => process.exit(0)
);
