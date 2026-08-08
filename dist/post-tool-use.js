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
var ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
var OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
var ESC_RE = /\x1b[()][A-Za-z0-9]|\x1b[@-Z\\-_]/g;
var MAX_LINES = 40;
var MAX_CHARS = 2e3;
function normalizeErrorText(text) {
  return text.replace(/\r\n?/g, "\n").replace(OSC_RE, "").replace(ANSI_RE, "").replace(ESC_RE, "").split("\n").slice(0, MAX_LINES).join("\n").replace(/\/(?:Users|home|private|tmp|var)\/[^\s:'"()]+/g, "<path>").replace(/0x[0-9a-fA-F]+/g, "<hex>").replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>").replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<ts>").replace(/\[\d{1,2}:\d{2}(?::\d{2})?\]/g, "[<time>]").replace(/\b\d+(?:\.\d+)?\s?(?:ms|s|m|h)\b/g, "<dur>").replace(/\bin \d+m \d+(?:\.\d+)?s?\b/g, "in <dur>").replace(/:\d+(?::\d+)?\b/g, ":<n>").replace(/\bline \d+/gi, "line <n>").replace(/\bport \d+/gi, "port <n>").replace(/\b(process|pid|worker)\s+\d+/gi, "$1 <n>").replace(/\b\d{2,}\b/g, "<n>").replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").trim().slice(0, MAX_CHARS);
}
var SUBCOMMAND_RE = /^[a-z][a-z0-9:_-]*$/i;
var WRAPPERS = /* @__PURE__ */ new Set(["sudo", "time", "env", "command", "nice", "xargs", "npx", "bunx"]);
var WRAPPERS_WITH_ARG = /* @__PURE__ */ new Set(["timeout", "nice"]);
var SUB_WITH_ARG = /* @__PURE__ */ new Set(["run", "exec", "x"]);
function commandFamily(command) {
  const segments = command.split(/&&|\|\||;|\|/).map((s) => s.trim().replace(/^[([{]\s*/, "").replace(/[)\]}]\s*$/, "").trim()).filter((s) => s && !/^cd\s/.test(s) && s !== "cd");
  const segment = segments[segments.length - 1] ?? "";
  let tokens = segment.split(/\s+/).filter((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
  while (tokens.length > 0 && (WRAPPERS.has(tokens[0]) || WRAPPERS_WITH_ARG.has(tokens[0]))) {
    const head = tokens[0];
    tokens = tokens.slice(1);
    if (WRAPPERS_WITH_ARG.has(head)) {
      while (tokens.length > 0 && /^-|^\d/.test(tokens[0])) tokens = tokens.slice(1);
    }
  }
  const first = tokens[0];
  if (!first) return "unknown";
  const cmd = first.split("/").pop() ?? first;
  const parts = [cmd];
  const rest = tokens.slice(1).filter((t) => !t.startsWith("-"));
  const sub = rest[0];
  if (sub && SUBCOMMAND_RE.test(sub)) {
    parts.push(sub);
    const arg = rest[1];
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
var EXIT_CODE_KEYS = ["code", "exit_code", "exitCode", "returnCode"];
var STDOUT_TAIL_CHARS = 2e3;
var EXIT_CODE_TEXT = /\bexit code[:\s]+(\d{1,3})\b/i;
function contentBlocksText(response) {
  if (!Array.isArray(response)) return null;
  const parts = response.map((b) => b && typeof b === "object" ? b["text"] : b).filter((t) => typeof t === "string");
  return parts.length ? parts.join("\n") : null;
}
function extractExitCode(response) {
  const blocks = contentBlocksText(response);
  if (blocks !== null) return extractExitCode(blocks);
  if (typeof response === "string") {
    const m2 = response.match(EXIT_CODE_TEXT);
    return m2 ? Number(m2[1]) : void 0;
  }
  if (typeof response !== "object" || response === null) return void 0;
  const record = response;
  for (const key of EXIT_CODE_KEYS) {
    const value = record[key];
    if (typeof value === "number" && Number.isInteger(value)) return value;
  }
  if (record["interrupted"] === true) return 130;
  const text = [record["stderr"], record["stdout"], record["text"]].filter((v) => typeof v === "string").join("\n");
  const m = text.match(EXIT_CODE_TEXT);
  return m ? Number(m[1]) : void 0;
}
var INTERRUPT_CODES = /* @__PURE__ */ new Set([124, 130, 137, 143, 144, 145]);
function isInterrupt(response) {
  if (typeof response === "object" && response !== null) {
    if (response["interrupted"] === true) return true;
  }
  const code = extractExitCode(response);
  return code !== void 0 && INTERRUPT_CODES.has(code);
}
function extractErrorText(response) {
  const blocks = contentBlocksText(response);
  if (blocks !== null) return blocks.slice(-STDOUT_TAIL_CHARS);
  if (typeof response === "string") return response;
  if (typeof response !== "object" || response === null) return "";
  const record = response;
  const stderr = record["stderr"];
  if (typeof stderr === "string" && stderr.trim()) return stderr;
  const stdout = record["stdout"];
  if (typeof stdout === "string" && stdout.trim()) return stdout.slice(-STDOUT_TAIL_CHARS);
  const text = record["text"];
  if (typeof text === "string" && text.trim()) return text.slice(-STDOUT_TAIL_CHARS);
  return "";
}

// src/lib/session-state.ts
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, rmSync as rmSync2 } from "node:fs";

// src/lib/fs-atomic.ts
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
var seq = 0;
function writeFileAtomic(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${seq++}-${process.hrtime.bigint().toString(36)}`;
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

// src/lib/session-state.ts
var EDIT_ATTACH_WINDOW_MS = 15 * 60 * 1e3;
var MAX_EDITS_PER_ERROR = 20;
var MAX_OPEN_ERRORS = 50;
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
  writeFileAtomic(sessionFile(state.sessionId, home), JSON.stringify(state, null, 2));
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
  if (state.openErrors.length > MAX_OPEN_ERRORS) {
    state.openErrors.sort((a, b) => a.lastSeenAt.localeCompare(b.lastSeenAt));
    state.openErrors = state.openErrors.slice(-MAX_OPEN_ERRORS);
  }
  return state;
}
function attachEditToOpenErrors(state, filePath, at = (/* @__PURE__ */ new Date()).toISOString()) {
  const cutoff = new Date(at).getTime() - EDIT_ATTACH_WINDOW_MS;
  let attached = false;
  for (const error of state.openErrors) {
    const seen = new Date(error.lastSeenAt).getTime();
    if (Number.isFinite(seen) && seen < cutoff) continue;
    if (error.edits.length >= MAX_EDITS_PER_ERROR) continue;
    if (!error.edits.includes(filePath)) {
      error.edits.push(filePath);
      attached = true;
    }
  }
  return attached;
}
function resolveOpenErrors(state, family, command, cwd = "", at = (/* @__PURE__ */ new Date()).toISOString()) {
  const sameCwd = (e) => cwd === "" || e.cwd === "" || e.cwd === cwd;
  const matching = state.openErrors.filter((e) => e.family === family && sameCwd(e));
  if (matching.length === 0) return [];
  state.openErrors = state.openErrors.filter((e) => !(e.family === family && sameCwd(e)));
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
  if (isInterrupt(input.tool_response)) return false;
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
  const resolved = resolveOpenErrors(state, commandFamily(command), command, input.cwd ?? "");
  if (resolved.length === 0) return false;
  saveSessionState(state, home);
  return true;
}

// src/lib/counters.ts
import { mkdirSync as mkdirSync2, readdirSync, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join2 } from "node:path";
var FIELDS = [
  "redactionBlocked",
  "postToolUse",
  "bashFailuresCaptured",
  "pairsResolved"
];
function countersFile(home = handbookHome()) {
  return join2(home, "counters.json");
}
function readCounters(home = handbookHome()) {
  const base = { redactionBlocked: 0, postToolUse: 0, bashFailuresCaptured: 0, pairsResolved: 0 };
  try {
    const parsed = JSON.parse(readFileSync2(countersFile(home), "utf8"));
    for (const f of FIELDS) base[f] = Number(parsed?.[f]) || 0;
  } catch {
  }
  return base;
}
function bumpCounter(field, home = handbookHome(), by = 1) {
  const counters = readCounters(home);
  counters[field] += by;
  mkdirSync2(home, { recursive: true });
  writeFileAtomic(countersFile(home), JSON.stringify(counters, null, 2));
  return counters;
}
var DEBUG_DUMP_CAP = 50;
function maybeDumpPayload(raw, home = handbookHome()) {
  if (!process.env.TEAMHANDBOOK_DEBUG) return;
  try {
    const dir = join2(home, "debug");
    mkdirSync2(dir, { recursive: true });
    const n = readdirSync(dir).length;
    if (n >= DEBUG_DUMP_CAP) return;
    writeFileSync2(join2(dir, `payload-${String(n).padStart(4, "0")}-${process.pid}.json`), raw, { flag: "wx" });
  } catch {
  }
}

// src/hooks/post-tool-use.ts
async function main() {
  const raw = await readStdin();
  maybeDumpPayload(raw);
  const input = parseHookInput(raw);
  if (!input) return;
  bumpCounter("postToolUse");
  if (captureBashFailure(input)) {
    bumpCounter("bashFailuresCaptured");
    return;
  }
  if (captureBashSuccess(input)) {
    bumpCounter("pairsResolved");
    return;
  }
  captureFileEdit(input);
}
main().then(
  () => process.exit(0),
  () => process.exit(0)
);
