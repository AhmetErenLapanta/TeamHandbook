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
var STDOUT_TAIL_CHARS = 2e3;
var EXIT_CODE_KEYS = ["code", "exit_code", "exitCode", "returnCode"];
var EXIT_CODE_TEXT = /\bexit code[:\s]+(\d{1,3})\b/i;
var INTERRUPT_CODES = /* @__PURE__ */ new Set([124, 130, 137, 143, 144, 145]);
function extractExitCode(response) {
  if (Array.isArray(response)) return extractExitCode(contentBlocksText(response));
  if (typeof response === "string") {
    const m = response.match(EXIT_CODE_TEXT);
    return m ? Number(m[1]) : void 0;
  }
  if (typeof response !== "object" || response === null) return void 0;
  const record = response;
  for (const key of EXIT_CODE_KEYS) {
    const value = record[key];
    if (typeof value === "number" && Number.isInteger(value)) return value;
  }
  return void 0;
}
function bashFailure(input) {
  if (input.hook_event_name === "PostToolUseFailure") {
    const text = typeof input.error === "string" ? input.error : "";
    const code2 = extractExitCode(text);
    return {
      errorText: text,
      interrupted: input.is_interrupt === true || code2 !== void 0 && INTERRUPT_CODES.has(code2)
    };
  }
  const code = extractExitCode(input.tool_response);
  if (code !== void 0 && code !== 0) {
    return { errorText: errorTextFromResponse(input.tool_response), interrupted: INTERRUPT_CODES.has(code) };
  }
  return null;
}
function isBashSuccess(input) {
  if (input.hook_event_name === "PostToolUseFailure") return false;
  if (typeof input.error === "string" && input.error.trim()) return false;
  const r = input.tool_response;
  const code = extractExitCode(r);
  if (code !== void 0) return code === 0;
  if (typeof r !== "object" || r === null || Array.isArray(r)) return false;
  const record = r;
  const hasResultShape = ["stdout", "stderr", "interrupted"].some((k) => k in record);
  return hasResultShape && record["interrupted"] !== true;
}
function contentBlocksText(response) {
  if (!Array.isArray(response)) return "";
  return response.map((b) => b && typeof b === "object" ? b["text"] : b).filter((t) => typeof t === "string").join("\n");
}
function errorTextFromResponse(response) {
  if (typeof response === "string") return response;
  if (Array.isArray(response)) return contentBlocksText(response).slice(-STDOUT_TAIL_CHARS);
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

// src/lib/secrets.ts
var SECRET_PATTERNS = [
  // Covers PEM, armored PGP ("… BLOCK-----") and ssh.com/SSH2 ("---- BEGIN SSH2
  // ENCRYPTED PRIVATE KEY ----": four dashes with spaces).
  // Deliberately NOT the generic /-----BEGIN [A-Z ]+-----/: that swallows
  // -----BEGIN CERTIFICATE-----, which is public and routine in TLS work.
  { name: "private-key", re: /-{4,5}\s?BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?\s?-{4,5}/ },
  // PuTTY .ppk keys are not PEM-armored at all
  { name: "putty-key", re: /^\s*(?:PuTTY-User-Key-File-\d|Private-Lines:|Private-MAC:)/m },
  { name: "age-key", re: /\bAGE-SECRET-KEY-1[0-9A-Z]{50,}/ },
  { name: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { name: "github-token", re: /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}\b/ },
  { name: "gitlab-token", re: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { name: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "slack-webhook", re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}/ },
  { name: "stripe-key", re: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  { name: "openai-key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: "google-api-key", re: /\bAIza[A-Za-z0-9_-]{30,}\b/ },
  { name: "npm-token", re: /\bnpm_[A-Za-z0-9]{30,}\b/ },
  { name: "bearer-token", re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/i },
  { name: "basic-auth-header", re: /\bAuthorization\s*:\s*Basic\s+[A-Za-z0-9+/]{16,}=*/i },
  { name: "url-credentials", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]{3,}@/i },
  // common credential shapes the generic keyword rule misses
  { name: "db-password-env", re: /(?:\b|_)(?:PGPASSWORD|MYSQL_PWD|DB_PASS(?:WORD)?|POSTGRES_PASSWORD|REDIS_PASSWORD)\s*=\s*\S+/i },
  { name: "inline-basic-auth", re: /\bcurl\b[^\n]*\s-{1,2}(?:u|user)\s+[^\s:]+:[^\s]+/i },
  { name: "mysql-inline-password", re: /\bmysql\b[^\n]*\s-p\S+/i },
  {
    // keyword may be preceded by a word boundary OR an underscore (AWS_SECRET_KEY=...),
    // which \b cannot match between two word chars.
    name: "assigned-secret",
    re: /(?:\b|_)(?:api[_-]?key|secret|token|passw(?:or)?d|access[_-]?key)["']?\s*[=:]\s*["']?[A-Za-z0-9+/_.-]{8,}/i
  }
];
function detectSecret(text) {
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(text)) return name;
  }
  return null;
}
function signalSecret(fields) {
  return detectSecret(
    [
      fields.command ?? "",
      fields.error ?? "",
      fields.resolvedCommand ?? "",
      ...fields.edits ?? [],
      fields.task?.goal ?? "",
      ...fields.task?.steps ?? [],
      fields.task?.verification ?? ""
    ].join("\n")
  );
}

// src/lib/counters.ts
import { mkdirSync as mkdirSync2, readdirSync as readdirSync2, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join2 } from "node:path";

// src/lib/session-state.ts
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, readdirSync, rmSync as rmSync2, statSync } from "node:fs";

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
    const activity = typeof parsed.activity === "object" && parsed.activity !== null && Array.isArray(parsed.activity.families) && Array.isArray(parsed.activity.exts) ? { families: parsed.activity.families, exts: parsed.activity.exts } : void 0;
    return {
      sessionId,
      openErrors: parsed.openErrors.map((e) => ({ ...e, edits: e.edits ?? [] })),
      resolvedPairs: Array.isArray(parsed.resolvedPairs) ? parsed.resolvedPairs : [],
      ...activity ? { activity } : {},
      ...typeof parsed.transcriptPath === "string" ? { transcriptPath: parsed.transcriptPath } : {},
      ...typeof parsed.meaningfulToolCalls === "number" ? { meaningfulToolCalls: parsed.meaningfulToolCalls } : {},
      ...typeof parsed.harvestedAt === "string" ? { harvestedAt: parsed.harvestedAt } : {},
      ...Array.isArray(parsed.corrections) ? { corrections: parsed.corrections } : {}
    };
  } catch {
    return emptySessionState(sessionId);
  }
}
function saveSessionState(state, home = handbookHome()) {
  writeFileAtomic(sessionFile(state.sessionId, home), JSON.stringify(state, null, 2));
}
var SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1e3;
var SESSION_ORPHAN_MS = 3 * 60 * 60 * 1e3;
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
    if (!error.edits.includes(filePath)) {
      error.edits.push(filePath);
      if (error.edits.length > MAX_EDITS_PER_ERROR) error.edits.shift();
      attached = true;
    }
  }
  return attached;
}
function resolveOpenErrors(state, family, command, cwd = "", at = (/* @__PURE__ */ new Date()).toISOString()) {
  const sameCwd = (e) => cwd === "" || e.cwd === "" || e.cwd === cwd;
  const matching = state.openErrors.filter((e) => e.family === family && sameCwd(e));
  if (matching.length === 0) return [];
  matching.sort((a, b) => a.lastSeenAt.localeCompare(b.lastSeenAt));
  const target = matching[matching.length - 1];
  state.openErrors = state.openErrors.filter((e) => e !== target);
  const resolved = [{ ...target, resolvedAt: at, resolvedCommand: command }];
  state.resolvedPairs.push(...resolved);
  return resolved;
}

// src/lib/counters.ts
var FIELDS = [
  "redactionBlocked",
  "postToolUse",
  "bashFailuresCaptured",
  "pairsResolved",
  "gateErrors",
  "gateAbandoned"
];
function countersFile(home = handbookHome()) {
  return join2(home, "counters.json");
}
function readCounters(home = handbookHome()) {
  const base = {
    redactionBlocked: 0,
    postToolUse: 0,
    bashFailuresCaptured: 0,
    pairsResolved: 0,
    gateErrors: 0,
    gateAbandoned: 0
  };
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
function incrementRedactionBlocked(home = handbookHome(), by = 1) {
  return bumpCounter("redactionBlocked", home, by);
}
var DEBUG_DUMP_CAP = 50;
function maybeDumpPayload(raw, home = handbookHome()) {
  if (!process.env.TEAMHANDBOOK_DEBUG) return;
  try {
    const dir = join2(home, "debug");
    mkdirSync2(dir, { recursive: true });
    const n = readdirSync2(dir).length;
    if (n >= DEBUG_DUMP_CAP) return;
    writeFileSync2(join2(dir, `payload-${String(n).padStart(4, "0")}-${process.pid}.json`), raw, { flag: "wx" });
  } catch {
  }
}

// src/lib/capture.ts
var EDIT_TOOLS = /* @__PURE__ */ new Set(["Edit", "Write", "MultiEdit"]);
var GENERIC_FAMILIES = /* @__PURE__ */ new Set([
  "ls",
  "cat",
  "cd",
  "pwd",
  "echo",
  "grep",
  "find",
  "head",
  "tail",
  "which",
  "mkdir",
  "rm",
  "cp",
  "mv",
  "touch",
  "chmod",
  "sed",
  "awk",
  "wc",
  "sleep",
  "git status",
  "git diff",
  "git log",
  "git add"
]);
function bashCommand(input) {
  return typeof input.tool_input?.command === "string" ? input.tool_input.command : "";
}
function recordActivity(input, home = handbookHome()) {
  if (!input.session_id) return false;
  let family = "";
  let ext = "";
  if (input.tool_name === "Bash") {
    const command = bashCommand(input);
    if (!command) return false;
    if (signalSecret({ command })) return false;
    family = commandFamily(command);
    if (GENERIC_FAMILIES.has(family) || family === "unknown") return false;
  } else if (EDIT_TOOLS.has(input.tool_name ?? "")) {
    const filePath = typeof input.tool_input?.file_path === "string" ? input.tool_input.file_path : "";
    const m = filePath.match(/\.([A-Za-z0-9]+)$/);
    if (!m) return false;
    if (signalSecret({ edits: [filePath] })) return false;
    ext = `.${m[1].toLowerCase()}`;
  } else {
    return false;
  }
  const state = loadSessionState(input.session_id, home);
  state.meaningfulToolCalls = (state.meaningfulToolCalls ?? 0) + 1;
  if (input.transcript_path) state.transcriptPath = input.transcript_path;
  const activity = state.activity ?? { families: [], exts: [] };
  let fresh = true;
  if (family && !activity.families.includes(family)) activity.families.push(family);
  else if (ext && !activity.exts.includes(ext)) activity.exts.push(ext);
  else fresh = false;
  state.activity = activity;
  saveSessionState(state, home);
  return fresh;
}
function captureBashFailure(input, home = handbookHome()) {
  if (input.tool_name !== "Bash" || !input.session_id) return false;
  const failure = bashFailure(input);
  if (!failure || failure.interrupted) return false;
  const command = bashCommand(input);
  if (!command) return false;
  const error = normalizeErrorText(failure.errorText);
  if (signalSecret({ command, error })) {
    incrementRedactionBlocked(home);
    return false;
  }
  const family = commandFamily(command);
  const state = loadSessionState(input.session_id, home);
  if (input.transcript_path) state.transcriptPath = input.transcript_path;
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
  if (signalSecret({ edits: [filePath] })) {
    incrementRedactionBlocked(home);
    return false;
  }
  const state = loadSessionState(input.session_id, home);
  if (!attachEditToOpenErrors(state, filePath)) return false;
  saveSessionState(state, home);
  return true;
}
function captureBashSuccess(input, home = handbookHome()) {
  if (input.tool_name !== "Bash" || !input.session_id) return 0;
  if (!isBashSuccess(input)) return 0;
  const command = bashCommand(input);
  if (!command) return 0;
  const state = loadSessionState(input.session_id, home);
  if (state.openErrors.length === 0) return 0;
  if (signalSecret({ resolvedCommand: command })) {
    incrementRedactionBlocked(home);
    return 0;
  }
  const resolved = resolveOpenErrors(state, commandFamily(command), command, input.cwd ?? "");
  if (resolved.length === 0) return 0;
  saveSessionState(state, home);
  return resolved.length;
}

// src/hooks/post-tool-use.ts
async function main() {
  const raw = await readStdin();
  maybeDumpPayload(raw);
  const input = parseHookInput(raw);
  if (!input) return;
  bumpCounter("postToolUse");
  recordActivity(input);
  if (captureBashFailure(input)) {
    bumpCounter("bashFailuresCaptured");
    return;
  }
  const resolved = captureBashSuccess(input);
  if (resolved > 0) {
    bumpCounter("pairsResolved", handbookHome(), resolved);
    return;
  }
  captureFileEdit(input);
}
main().then(
  () => process.exit(0),
  () => process.exit(0)
);
