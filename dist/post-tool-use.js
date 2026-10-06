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
var PLACEHOLDER_VALUE = /^(?:[xX]+|changeme[0-9]{0,6}|placeholder[0-9]{0,6}|dummy[a-z-]{0,10}|your[-_][a-z-]{0,16}|example[a-z-]{0,10}|redacted)$/;
var unquote = (value) => value.replace(/^["']|["']$/g, "");
function isPlaceholderAssignment(match) {
  return PLACEHOLDER_VALUE.test(unquote(match.slice(match.search(/[=:]/) + 1).trim()));
}
function isSubstitute(value) {
  const bare = unquote(value);
  return /^[$<{]/.test(bare) || /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(bare) || isFilePath(bare);
}
function isFilePath(value) {
  if (!/^(?:\.{1,2}\/|~\/|\/)/.test(value)) return false;
  return value.lastIndexOf("/") > 0 || /\.[A-Za-z0-9]{1,8}$/.test(value);
}
var lastToken = (match) => match.trim().split(/[\s=]+/).pop() ?? "";
function isWordsNotToken(match) {
  return !/[A-Z0-9+/=._~]/.test(match.replace(/^\s*bearer\s+/i, ""));
}
var SECRET_PATTERNS = [
  // Covers PEM, armored PGP ("… BLOCK-----") and ssh.com/SSH2 ("---- BEGIN SSH2
  // ENCRYPTED PRIVATE KEY ----": four dashes with spaces).
  // Deliberately NOT the generic /-----BEGIN [A-Z ]+-----/: that swallows
  // -----BEGIN CERTIFICATE-----, which is public and routine in TLS work.
  { name: "private-key", re: /-{4,5}\s?BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?\s?-{4,5}/ },
  // PuTTY .ppk keys are not PEM-armored at all. The header used to be anchored to the start
  // of a line, which excluded the two shapes a session actually shows a key file in: a diff
  // prefixes every line with `+`, and `cat -n` prefixes it with a number and a tab. Dropping
  // the anchor without asking for the rest of the FORMAT made the header's name enough, so
  // prose that merely mentions it became a secret - including two lines of this repository's
  // own source, which cost a session working on TeamHandbook its own signal.
  {
    name: "putty-key",
    re: /PuTTY-User-Key-File-\d+:[ \t]*\S|Private-Lines:[ \t]*\d|Private-MAC:[ \t]*[0-9a-fA-F]{16}/
  },
  { name: "age-key", re: /\bAGE-SECRET-KEY-1[0-9A-Z]{50,}/ },
  // Before `aws-access-key`, which would otherwise claim any line carrying the id and hide
  // that the secret half travelled with it - the credentials CSV the console hands out puts
  // them in adjacent columns and spells the header with spaces, so no keyword sits next to
  // the value. The 40-character run has no shape of its own, so it counts only in the
  // company of an id AND only when it mixes case and digits the way base64 does; a
  // lowercase sha1 in a release log does not.
  {
    name: "aws-secret-near-access-key",
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b[\s\S]{0,300}?(?=[A-Za-z0-9+/]{40}(?![A-Za-z0-9+/]))(?=[A-Za-z0-9+/]*[a-z])(?=[A-Za-z0-9+/]*[A-Z])(?=[A-Za-z0-9+/]*\d)[A-Za-z0-9+/]{40}/
  },
  { name: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { name: "github-token", re: /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}\b/ },
  { name: "gitlab-token", re: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { name: "gitlab-deploy-token", re: /\bgldt-[A-Za-z0-9_-]{20,}\b/ },
  { name: "gitlab-runner-token", re: /\bglrt-[A-Za-z0-9_-]{20,}\b/ },
  { name: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "slack-webhook", re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}/ },
  { name: "stripe-key", re: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  // Before `openai-key`: both open with `sk-`, and whichever runs first is the name the
  // redaction marker carries. Left second, an Anthropic key - the credential a Claude Code
  // plugin is likeliest to meet - reads in the log as an OpenAI key and its own rule never
  // fires, so nobody can tell from the marker whether it is covered at all.
  { name: "anthropic-api-key", re: /\bsk-ant-[a-z0-9]{3,}-[A-Za-z0-9_-]{20,}\b/ },
  // The digit is what separates an issued key from a hyphenated English phrase: every key
  // carries one and "sk-cross-validation-and-scaling" carries none.
  { name: "openai-key", re: /\bsk-(?:proj-)?(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}\b/ },
  { name: "google-api-key", re: /\bAIza[A-Za-z0-9_-]{30,}\b/ },
  { name: "npm-token", re: /\bnpm_[A-Za-z0-9]{30,}\b/ },
  // The body excludes `_`, so `hf_hub_download` - the library's own function name - is three
  // characters long to this rule rather than thirty.
  { name: "huggingface-token", re: /\bhf_[A-Za-z0-9]{30,}\b/ },
  { name: "digitalocean-token", re: /\bdop_v1_[a-f0-9]{60,}\b/ },
  // An issued token is base62 and mixes case with digits; a backup file named after the same
  // prefix is not - unless it is named in camel case with a year in it, which is why the
  // extension has to be excluded as well as the lowercase body. (The corpus carries both
  // filenames; neither is spelled out here, because a prefix followed by a contiguous run is
  // the shape this repository refuses to hold.)
  {
    name: "vault-token",
    re: /\bhvs\.(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{20,}(?!\.[A-Za-z0-9]{1,8})\b/
  },
  { name: "linear-api-key", re: /\blin_api_[A-Za-z0-9]{32,}\b/ },
  // A lookbehind rather than \b: the token's own home is inside a URL path (`/bot<id>:AA…`),
  // where the digits follow a letter and \b never matches between two word characters.
  { name: "telegram-bot-token", re: /(?<!\d)\d{8,10}:AA[A-Za-z0-9_-]{30,}\b/ },
  // Azure AD writes a fixed `8Q~` into a client secret, three characters in and thirty-four
  // from the end; the delimiters keep it from matching inside a longer run.
  {
    name: "azure-client-secret",
    re: /(?:^|[\s'"`>=:(,])[A-Za-z0-9_~.-]{3}8Q~[A-Za-z0-9_~.-]{34}(?:$|[\s'"`<),;])/
  },
  { name: "azure-storage-key", re: /\bAccountKey=[A-Za-z0-9+/]{40,}={0,2}/ },
  { name: "azure-sas-signature", re: /[?&]sig=[A-Za-z0-9%]{20,}/ },
  { name: "bearer-token", re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/i, reject: isWordsNotToken },
  { name: "basic-auth-header", re: /\bAuthorization\s*:\s*Basic\s+[A-Za-z0-9+/]{16,}=*/i },
  { name: "url-credentials", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]{3,}@/i },
  // common credential shapes the generic keyword rule misses
  { name: "db-password-env", re: /(?:\b|_)(?:PGPASSWORD|MYSQL_PWD|DB_PASS(?:WORD)?|POSTGRES_PASSWORD|REDIS_PASSWORD)\s*=\s*\S+/i },
  { name: "inline-basic-auth", re: /\bcurl\b[^\n]*\s-{1,2}(?:u|user)\s+[^\s:]+:[^\s]+/i },
  { name: "mysql-inline-password", re: /\bmysql\b[^\n]*\s-p\S+/i },
  // Fields whose NAME carries the shape. The value inside them is a bare blob nothing else
  // here could tell from a digest; the field is what makes it a credential, so the rule asks
  // for the field and lets the value be shapeless.
  // The host is what separates the file from a sentence. Asking only for the three words in
  // order made "Each machine needs login and password set before the first deploy" a
  // credential, which cost the prompt that carried it, the slice line that quoted it, and
  // the share of any skill whose documentation said it.
  //
  // The dot is a TRADE, not a definition: `machine localhost` and `machine gitlab` are
  // valid `.netrc` entries and this rule does not see them. It buys that miss because the
  // sentence shape is common and its cost is silent - a candidate dropped, a skill refused
  // with "secret" - while a single-label netrc host is a machine-local credential. The
  // corpus carries the missed shape so the trade stays visible rather than forgotten.
  {
    name: "netrc-credential",
    re: /\bmachine\s+\S*\.\S+\s+login\s+\S+\s+password\s+\S+/i,
    reject: (m) => isSubstitute(lastToken(m))
  },
  { name: "docker-auth-field", re: /["']auth["']\s*:\s*["'][A-Za-z0-9+/]{20,}={0,2}["']/ },
  { name: "kubeconfig-key-data", re: /\bclient-key-data:\s*[A-Za-z0-9+/]{40,}={0,2}/ },
  {
    name: "gcp-private-key-field",
    re: /["']private_key["']\s*:\s*["'][^"']{40,}["']/,
    reject: (m) => isSubstitute(m.slice(m.indexOf(":") + 1).trim())
  },
  {
    name: "aws-secret-key",
    re: /\baws[_-]?secret[_-]?access[_-]?key\s*[=:]\s*["']?[A-Za-z0-9+/]{30,}/i
  },
  // A credential handed to a CLI as a flag. `--token-file` and its kind are excluded by the
  // `[= ]`: a flag NAME that continues past the keyword is a different flag.
  {
    name: "cli-credential-flag",
    re: /\s--?(?:auth[_-]?token|api[_-]?key|access[_-]?token|registration[_-]?token|token|password|secret)[= ]\S{16,}/i,
    reject: (m) => isSubstitute(lastToken(m))
  },
  {
    // keyword may be preceded by a word boundary OR an underscore (AWS_SECRET_KEY=...),
    // which \b cannot match between two word chars.
    name: "assigned-secret",
    re: /(?:\b|_)(?:api[_-]?key|secret|token|passw(?:or)?d|access[_-]?key)["']?\s*[=:]\s*["']?[A-Za-z0-9+/_.-]{8,}/i,
    reject: isPlaceholderAssignment
  }
];
var GLOBAL_TWIN = new Map(
  SECRET_PATTERNS.filter((p) => p.reject).map((p) => [
    p.name,
    new RegExp(p.re.source, p.re.flags + "g")
  ])
);
function detectSecret(text) {
  return locateSecret(text)?.pattern ?? null;
}
function locateSecret(text) {
  for (const { name, re, reject } of SECRET_PATTERNS) {
    if (!reject) {
      const match = re.exec(text);
      if (match) return { pattern: name, index: match.index };
      continue;
    }
    for (const match of text.matchAll(GLOBAL_TWIN.get(name))) {
      if (!reject(match[0])) return { pattern: name, index: match.index };
    }
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
import { mkdirSync as mkdirSync3, readdirSync as readdirSync2, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join2 } from "node:path";

// src/lib/session-state.ts
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync as mkdirSync2, mkdtempSync, readFileSync, readdirSync, rmSync as rmSync2, statSync } from "node:fs";

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
function parseWorkflowTrail(value) {
  if (typeof value !== "object" || value === null) return void 0;
  const raw = value;
  if (!Array.isArray(raw.edits) || !Array.isArray(raw.fired)) return void 0;
  return {
    edits: raw.edits.filter((e) => typeof e === "string"),
    green: raw.green === true,
    masked: raw.masked === true,
    fired: raw.fired.filter((s) => s === "S1" || s === "S2")
  };
}
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
    const workflow = parseWorkflowTrail(parsed.workflow);
    const activity = typeof parsed.activity === "object" && parsed.activity !== null && Array.isArray(parsed.activity.families) && Array.isArray(parsed.activity.exts) ? { families: parsed.activity.families, exts: parsed.activity.exts } : void 0;
    return {
      sessionId,
      openErrors: parsed.openErrors.map((e) => ({ ...e, edits: e.edits ?? [] })),
      resolvedPairs: Array.isArray(parsed.resolvedPairs) ? parsed.resolvedPairs : [],
      ...activity ? { activity } : {},
      ...typeof parsed.transcriptPath === "string" ? { transcriptPath: parsed.transcriptPath } : {},
      ...typeof parsed.meaningfulToolCalls === "number" ? { meaningfulToolCalls: parsed.meaningfulToolCalls } : {},
      ...typeof parsed.harvestedAt === "string" ? { harvestedAt: parsed.harvestedAt } : {},
      ...Array.isArray(parsed.corrections) ? { corrections: parsed.corrections } : {},
      ...typeof parsed.explicitLearnPending === "boolean" ? { explicitLearnPending: parsed.explicitLearnPending } : {},
      ...workflow ? { workflow } : {}
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
  "gateAbandoned",
  "workflowSessions",
  "workflowSkippedAutonomous",
  "workflowEntrypointSeen",
  "workflowEntrypointMissing",
  "workflowDetectedShape",
  "workflowDetectedCandidate",
  "workflowSkippedHygiene"
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
    gateAbandoned: 0,
    workflowSessions: 0,
    workflowSkippedAutonomous: 0,
    workflowEntrypointSeen: 0,
    workflowEntrypointMissing: 0,
    workflowDetectedShape: 0,
    workflowDetectedCandidate: 0,
    workflowSkippedHygiene: 0
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
  mkdirSync3(home, { recursive: true });
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
    mkdirSync3(dir, { recursive: true });
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

// src/lib/usage.ts
import { readFileSync as readFileSync4 } from "node:fs";
import { basename as basename2, join as join4 } from "node:path";

// src/lib/config.ts
import { existsSync, readFileSync as readFileSync3 } from "node:fs";
import { join as join3 } from "node:path";
function configFile(home = handbookHome()) {
  return join3(home, "config.json");
}
function readConfigFile(home = handbookHome()) {
  try {
    const parsed = JSON.parse(readFileSync3(configFile(home), "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function configIsBroken(home = handbookHome()) {
  const file = configFile(home);
  if (!existsSync(file)) return false;
  try {
    const parsed = JSON.parse(readFileSync3(file, "utf8"));
    return !(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed));
  } catch {
    return true;
  }
}

// src/lib/score.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// src/lib/identity.ts
import { execFileSync } from "node:child_process";
import { homedir as homedir2, userInfo } from "node:os";
import { basename } from "node:path";
var GENERIC_ACCOUNT = /* @__PURE__ */ new Set([
  "user",
  "users",
  "username",
  "you",
  "me",
  "home",
  "root",
  "admin",
  "administrator",
  "runner",
  "ubuntu",
  "debian",
  "alpine",
  "docker",
  "container",
  "node",
  "vscode",
  "devcontainer",
  "codespace",
  "shared",
  "public",
  "dev",
  "developer",
  "test",
  "build",
  "builder",
  "ci",
  "jenkins",
  "deploy",
  "app",
  "service",
  "worker",
  "git",
  "www-data",
  "nobody"
]);
var MIN_NAME_CHARS = 4;
var HOME_PATH = new RegExp(
  "(?:\\/(?:Users|home)\\/|[A-Za-z]:\\\\{1,2}(?:Users|home)\\\\{1,2})([A-Za-z0-9._-]{1,40})",
  "g"
);
var EMAIL = /(?<![A-Za-z0-9._%+-])([A-Za-z0-9._%+-]+)@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})/g;
var ROLE_MAILBOX = /* @__PURE__ */ new Set([
  "admin",
  "bot",
  "build",
  "builder",
  "ci",
  "deploy",
  "git",
  "infra",
  "jenkins",
  "no-reply",
  "noreply",
  "ops",
  "platform",
  "release",
  "root",
  "security",
  "support",
  "team"
]);
var RESERVED_DOMAIN = /(?:^|\.)(?:example\.(?:com|net|org)|example|test|invalid|localhost)$/i;
var ROLE_MAILBOX_DOMAIN = /(?:^|\.)users\.noreply\.github\.com$/i;
var FORGE_OWNER_BEFORE = /[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\/$/;
var escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function usableName(name) {
  return name.length >= MIN_NAME_CHARS && !GENERIC_ACCOUNT.has(name.toLowerCase());
}
function gitConfig(key) {
  try {
    return execFileSync("git", ["config", "--get", key], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      timeout: 2e3
    }).trim() || null;
  } catch {
    return null;
  }
}
function gitAuthorName() {
  const name = gitConfig("user.name");
  return name && /\s/.test(name) ? name : null;
}
function readHostIdentity() {
  const candidates = [];
  try {
    candidates.push(userInfo().username);
  } catch {
  }
  try {
    candidates.push(basename(homedir2()));
  } catch {
  }
  candidates.push(gitAuthorName());
  const names = [];
  for (const name of candidates) {
    if (!name || !usableName(name)) continue;
    if (!names.some((seen) => seen.toLowerCase() === name.toLowerCase())) names.push(name);
  }
  return { names };
}
var cached = null;
function hostIdentity() {
  if (!cached) cached = readHostIdentity();
  return cached;
}
function traces(text, host) {
  const found = [];
  for (const match of text.matchAll(HOME_PATH)) {
    if (GENERIC_ACCOUNT.has((match[1] ?? "").toLowerCase())) continue;
    found.push({ class: "home-path", index: match.index, length: match[0].length, replacement: "~" });
  }
  for (const match of text.matchAll(EMAIL)) {
    const local = (match[1] ?? "").toLowerCase();
    if (ROLE_MAILBOX.has(local)) continue;
    if (RESERVED_DOMAIN.test(match[2] ?? "") || ROLE_MAILBOX_DOMAIN.test(match[2] ?? "")) continue;
    found.push({ class: "email", index: match.index, length: match[0].length, replacement: "<email>" });
  }
  if (host.names.length > 0) {
    const ordered = [...host.names].sort((a, b) => b.length - a.length);
    const names = new RegExp(`\\b(?:${ordered.map(escapeRe).join("|")})\\b`, "gi");
    for (const match of text.matchAll(names)) {
      if (FORGE_OWNER_BEFORE.test(text.slice(Math.max(0, match.index - 80), match.index))) continue;
      found.push({ class: "os-username", index: match.index, length: match[0].length, replacement: "<user>" });
    }
  }
  return found.sort((a, b) => a.index - b.index);
}
function detectIdentity(text, host = hostIdentity()) {
  return locateIdentity(text, host)?.class ?? null;
}
function locateIdentity(text, host = hostIdentity()) {
  const first = traces(text, host)[0];
  return first ? { class: first.class, index: first.index } : null;
}

// src/lib/prompt-safety.ts
var LINE_TERMINATOR_CLASS = "\\n\\r\\u000B\\u000C\\u0085\\u2028\\u2029";
var LINE_TERMINATORS = new RegExp(`\\r\\n|[${LINE_TERMINATOR_CLASS}]`);
var LABEL_BREAKS = new RegExp(`[${LINE_TERMINATOR_CLASS}]+`, "g");

// src/lib/score.ts
var execFileAsync = promisify(execFile);

// src/lib/distill.ts
function openingsOf(literal) {
  return [...literal].reduceRight((rest, ch) => `(?:${ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${rest})?`, "");
}
var CUT_SCOPE_SENTENCE = new RegExp(
  `\\s*Applies ONLY in the(?: \\S*${openingsOf(" repository - do not use it elsewhere.")})?$`
);

// src/lib/init.ts
var CONSUMER_NOTICE_HOOKS = JSON.stringify(
  {
    hooks: {
      SessionStart: [
        { hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/notice.mjs"' }] }
      ]
    }
  },
  null,
  2
);

// src/lib/usage.ts
function usageFile(home = handbookHome()) {
  return join4(home, "skill-usage.json");
}
function readSkillUsage(home = handbookHome()) {
  try {
    const parsed = JSON.parse(readFileSync4(usageFile(home), "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const usage = {};
    for (const [slug, value] of Object.entries(parsed)) {
      const entry = value;
      if (typeof entry?.count === "number" && typeof entry?.lastAt === "string") {
        usage[slug] = { count: entry.count, lastAt: entry.lastAt };
      }
    }
    return usage;
  } catch {
    return {};
  }
}
function recordSkillUse(slug, home = handbookHome(), at = (/* @__PURE__ */ new Date()).toISOString()) {
  if (!slug) return;
  const usage = readSkillUsage(home);
  const prior = usage[slug];
  usage[slug] = { count: (prior?.count ?? 0) + 1, lastAt: at };
  writeFileAtomic(usageFile(home), JSON.stringify(usage, null, 2) + "\n");
}

// src/lib/session-workflow.ts
import { createHash as createHash2, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync as appendFileSync2, mkdirSync as mkdirSync5, readFileSync as readFileSync6, realpathSync, statSync as statSync3, writeFileSync as writeFileSync3 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { basename as basename4, dirname as dirname2, join as join7, relative, resolve as resolve2, sep } from "node:path";

// src/lib/signals.ts
import { existsSync as existsSync2, appendFileSync, mkdirSync as mkdirSync4, readFileSync as readFileSync5 } from "node:fs";
import { join as join5 } from "node:path";
function signalsFile(home = handbookHome()) {
  return join5(home, "signals.jsonl");
}
function sessionSignalCount(sessionId, home = handbookHome()) {
  let raw;
  try {
    raw = readFileSync5(signalsFile(home), "utf8");
  } catch {
    return 0;
  }
  let count = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      if (JSON.parse(line)?.sessionId === sessionId) count += 1;
    } catch {
    }
  }
  return count;
}

// src/lib/git-log.ts
var MAX_OUTPUT_BYTES = 1 << 28;
var MAX_BLOB_BYTES = 1 << 20;

// src/lib/mine.ts
var LOCK = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Gemfile\.lock|composer\.lock|go\.sum|gradle\.lockfile|deno\.lock)$/;
var DOC = /(\.md|\.mdx|\.rst|\.txt|LICENSE|CHANGELOG[^/]*)$/i;
var isDocPath = (path) => DOC.test(path);
var TEST = /(^|\/)(src\/test\/|test\/|tests\/|__tests__\/|spec\/)|\.(test|spec)\.[a-z]+$|_test\.(go|py)$|Test\.(kt|java)$/;
var NOT_A_TICKET = /* @__PURE__ */ new Set([
  "UTF",
  "ISO",
  "CVE",
  "SHA",
  "RFC",
  "HTTP",
  "HTTPS",
  "MD",
  "AES",
  "RSA",
  "TLS",
  "SSL",
  "IPV",
  "UTC",
  "GMT",
  "JDK",
  "ES",
  "EC",
  "PEP",
  "ADR",
  "RGB",
  "SQL"
]);
var KEY_CANDIDATE = /\b([A-Z]{2,})-(\d+)\b/g;
function stemSuffix(base) {
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot + 1) : "";
  const parts = stem.split(/[._-]/);
  const last = parts[parts.length - 1] || stem;
  const camel = last.match(/[A-Z][a-z0-9]+|[A-Z]+(?![a-z])|[a-z0-9]+/g);
  return { suffix: camel ? camel[camel.length - 1] : last, ext };
}
function buildRoleResolver(paths, options = {}) {
  const minSiblings = options.minSiblings ?? 5;
  const mirrorShare = options.mirrorShare ?? 0.6;
  const mirrorMinFiles = options.mirrorMinFiles ?? 10;
  const all = [...paths];
  const siblings = /* @__PURE__ */ new Map();
  const areaDirs = /* @__PURE__ */ new Map();
  const topLevel = /* @__PURE__ */ new Map();
  for (const path of all) {
    const segments = path.split("/");
    if (segments.length >= 3) {
      const key = `${segments.slice(0, -2).join("/")}\0${segments[segments.length - 1]}`;
      let dirs = siblings.get(key);
      if (!dirs) siblings.set(key, dirs = /* @__PURE__ */ new Set());
      dirs.add(segments[segments.length - 2]);
      const area = areaKey(segments);
      let areas2 = areaDirs.get(area);
      if (!areas2) areaDirs.set(area, areas2 = /* @__PURE__ */ new Set());
      areas2.add(segments[segments.length - 2]);
    }
    if (segments.length >= 2) {
      const top = segments[0];
      let rest = topLevel.get(top);
      if (!rest) topLevel.set(top, rest = /* @__PURE__ */ new Set());
      rest.add(segments.slice(1).join("/"));
    }
  }
  const templates = /* @__PURE__ */ new Map();
  for (const [key, dirs] of siblings) {
    if (dirs.size < minSiblings) continue;
    const [parentPath, base] = key.split("\0");
    const grandparent = parentPath.split("/").pop() || parentPath;
    templates.set(key, `${grandparent}/*/${base}`);
  }
  const areas = /* @__PURE__ */ new Map();
  if (options.areaTemplates ?? true) {
    for (const [key, dirs] of areaDirs) {
      if (dirs.size < minSiblings) continue;
      const [parentPath, kind] = key.split("\0");
      const grandparent = parentPath.split("/").pop() || parentPath;
      areas.set(key, `${grandparent}/${kind}`);
    }
  }
  const mirrors = /* @__PURE__ */ new Set();
  for (const [name, files] of topLevel) {
    if (files.size < mirrorMinFiles) continue;
    for (const [other, otherFiles] of topLevel) {
      if (other === name || files.size > otherFiles.size) continue;
      let shared = 0;
      for (const f of files) if (otherFiles.has(f)) shared++;
      if (shared / files.size >= mirrorShare) {
        mirrors.add(name);
        break;
      }
    }
  }
  const filters = options.filters ?? true;
  const compiled = filters ? compiledRoles(all, namer(templates, areas), options.binaryPaths) : /* @__PURE__ */ new Set();
  return resolverFrom(mirrors, templates, areas, compiled, filters);
}
function restoreRoleResolver(saved) {
  return resolverFrom(new Set(saved.mirrors), new Map(saved.templates), new Map(saved.areas), new Set(saved.compiled), true);
}
function namer(templates, areas) {
  return (path) => {
    const segments = path.split("/");
    if (segments.length >= 3) {
      const key = `${segments.slice(0, -2).join("/")}\0${segments[segments.length - 1]}`;
      const template = templates.get(key) ?? areas.get(areaKey(segments));
      if (template) return template;
    }
    const base = segments[segments.length - 1];
    const parent = segments.length > 1 ? segments[segments.length - 2] : ".";
    const localized = localeFree(base);
    if (localized) return `${parent}/${localized}`;
    const { suffix, ext } = stemSuffix(base);
    return ext ? `${parent}/*${suffix}.${ext}` : `${parent}/${base}`;
  };
}
function resolverFrom(mirrors, templates, areas, compiled, filters) {
  const named = namer(templates, areas);
  const resolve3 = (path) => {
    const segments = path.split("/");
    if (filters) {
      if (TEST.test(path)) return "test";
      if (LOCK.test(path)) return "lock";
      if (CREDITS.test(path)) return "credits";
      if (segments.length >= 2 && mirrors.has(segments[0])) return "mirror";
      const role = named(path);
      if (compiled.has(role)) return "compiled";
      return role;
    }
    return named(path);
  };
  resolve3.mirrors = mirrors;
  resolve3.templates = templates;
  resolve3.areas = areas;
  resolve3.compiled = compiled;
  return resolve3;
}
var LOCALES = /* @__PURE__ */ new Set([
  "en",
  "tr",
  "de",
  "fr",
  "es",
  "it",
  "pt",
  "nl",
  "ru",
  "ar",
  "zh",
  "ja",
  "ko",
  "pl",
  "sv",
  "da",
  "fi",
  "nb",
  "cs",
  "hu",
  "ro",
  "el",
  "he",
  "uk",
  "bg",
  "hr",
  "sk",
  "sl",
  "sr",
  "et",
  "lv",
  "lt",
  "fa",
  "hi",
  "th",
  "vi"
]);
var LOCALIZED = /^(.*?[._-])?([a-z]{2})([_-][A-Z]{2})?\.([A-Za-z0-9]+)$/;
function localeFree(base) {
  const match = LOCALIZED.exec(base);
  if (!match || !LOCALES.has(match[2])) return null;
  return `${match[1] ?? ""}{locale}.${match[4]}`;
}
function areaKey(segments) {
  const { suffix, ext } = stemSuffix(segments[segments.length - 1]);
  return `${segments.slice(0, -2).join("/")}\0${ext ? `*${suffix}.${ext}` : segments[segments.length - 1]}`;
}
var CREDITS = /(^|\/)(AUTHORS|CONTRIBUTORS|MAINTAINERS|CODEOWNERS|THANKS|\.mailmap)(\.[A-Za-z]+)?$/;
function compiledRoles(paths, named, binary) {
  const compiled = /* @__PURE__ */ new Set();
  if (!binary?.size) return compiled;
  const textual = /* @__PURE__ */ new Set();
  const byStem = /* @__PURE__ */ new Map();
  for (const path of paths) {
    const role = named(path);
    const stem = role.replace(/\.[A-Za-z0-9]+$/, "");
    let roles = byStem.get(stem);
    if (!roles) byStem.set(stem, roles = /* @__PURE__ */ new Set());
    roles.add(role);
    if (!binary.has(path)) textual.add(role);
  }
  for (const roles of byStem.values()) {
    if (roles.size < 2 || ![...roles].some((role) => textual.has(role))) continue;
    for (const role of roles) if (!textual.has(role)) compiled.add(role);
  }
  return compiled;
}
var IGNORED_ROLES = /* @__PURE__ */ new Set(["test", "lock", "mirror", "credits", "compiled"]);

// src/lib/shell-command.ts
import { basename as basename3, isAbsolute, join as join6, resolve } from "node:path";
import { statSync as statSync2 } from "node:fs";
var OPERATORS = ["&&", "||", ";;", ";", "|&", "|", "&", "(", ")"];
var REDIRECTS = ["&>>", "&>", ">>", ">|", ">&", "<<<", "<<-", "<<", "<&", "<>", ">", "<"];
function simpleCommands(line) {
  const out = [];
  let current = { words: [], redirects: [], then: null };
  let word = "";
  let inWord = false;
  let pendingRedirect = null;
  const heredocs = [];
  let i = 0;
  const endWord = () => {
    if (!inWord) return;
    if (pendingRedirect) {
      if (pendingRedirect === "<<" || pendingRedirect === "<<-") {
        heredocs.push({ delimiter: word, strip: pendingRedirect === "<<-" });
      } else {
        current.redirects.push({ op: pendingRedirect, target: word });
      }
      pendingRedirect = null;
    } else {
      current.words.push(word);
    }
    word = "";
    inWord = false;
  };
  const endCommand = (then) => {
    endWord();
    if (current.words.length || current.redirects.length) {
      current.then = then;
      out.push(current);
    } else if (then && out.length) {
      out[out.length - 1].then = then;
    }
    current = { words: [], redirects: [], then: null };
  };
  const skipHeredocBodies = () => {
    while (heredocs.length && i < line.length) {
      const { delimiter, strip } = heredocs.shift();
      while (i < line.length) {
        const end = line.indexOf("\n", i);
        const text = line.slice(i, end === -1 ? line.length : end);
        i = end === -1 ? line.length : end + 1;
        if ((strip ? text.replace(/^\t+/, "") : text) === delimiter) break;
      }
    }
  };
  while (i < line.length) {
    const c = line[i];
    if (c === "\\") {
      if (line[i + 1] === "\n") {
        i += 2;
        continue;
      }
      word += line[i + 1] ?? "";
      inWord = true;
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      const stop = end === -1 ? line.length : end;
      word += line.slice(i + 1, stop);
      inWord = true;
      i = stop + 1;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === "\\" && i + 1 < line.length) {
          word += line[i + 1];
          i += 2;
        } else if (line[i] === "$" && line[i + 1] === "(") {
          const end = closingParen(line, i + 1);
          word += line.slice(i, end + 1);
          i = end + 1;
        } else {
          word += line[i];
          i++;
        }
      }
      inWord = true;
      i++;
      continue;
    }
    if (c === "$" && line[i + 1] === "(") {
      const end = closingParen(line, i + 1);
      word += line.slice(i, end + 1);
      inWord = true;
      i = end + 1;
      continue;
    }
    if (c === "`") {
      const end = line.indexOf("`", i + 1);
      const stop = end === -1 ? line.length : end;
      word += line.slice(i, stop + 1);
      inWord = true;
      i = stop + 1;
      continue;
    }
    if (c === "#" && !inWord) {
      const end = line.indexOf("\n", i);
      i = end === -1 ? line.length : end;
      continue;
    }
    if (c === "\n") {
      endCommand(";");
      i++;
      skipHeredocBodies();
      continue;
    }
    if (c === " " || c === "	") {
      endWord();
      i++;
      continue;
    }
    if (/[0-9]/.test(c) && !inWord) {
      const m = /^[0-9]+(?=[<>])/.exec(line.slice(i));
      if (m) {
        const op = REDIRECTS.find((r) => line.startsWith(r, i + m[0].length));
        endWord();
        pendingRedirect = `${m[0]}${op}`;
        i += m[0].length + op.length;
        continue;
      }
    }
    const redirect = REDIRECTS.find((r) => line.startsWith(r, i));
    if (redirect) {
      endWord();
      pendingRedirect = redirect;
      i += redirect.length;
      continue;
    }
    const operator = OPERATORS.find((o) => line.startsWith(o, i));
    if (operator) {
      endCommand(operator === "(" || operator === ")" || operator === ";;" ? ";" : operator === "|&" ? "|" : operator);
      i += operator.length;
      continue;
    }
    word += c;
    inWord = true;
    i++;
  }
  endCommand(null);
  return out;
}
function closingParen(line, open) {
  let depth = 0;
  for (let i = open; i < line.length; i++) {
    if (line[i] === "(") depth++;
    else if (line[i] === ")" && --depth === 0) return i;
  }
  return line.length - 1;
}
var WRITE_REDIRECTS = /* @__PURE__ */ new Set([">", ">>", ">|", "&>", "&>>", "1>", "1>>", "1>|"]);
var WRAPPERS2 = /* @__PURE__ */ new Set(["sudo", "command", "nohup", "time", "nice", "exec", "env", "builtin"]);
function programOf(cmd) {
  const words = [...cmd.words];
  while (words.length) {
    const first = words[0];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) words.shift();
    else if (WRAPPERS2.has(first)) words.shift();
    else if (first === "timeout") {
      words.shift();
      while (words.length && words[0].startsWith("-")) words.shift();
      words.shift();
    } else break;
  }
  return words;
}
function statusReaches(cmds, index) {
  for (let i = index; i < cmds.length - 1; i++) if (cmds[i].then !== "&&") return false;
  return true;
}
function directoryAt(cmds, index, cwd, home) {
  let dir = cwd;
  for (let i = 0; i < index; i++) {
    const words = programOf(cmds[i]);
    if (words[0] !== "cd" && words[0] !== "pushd") continue;
    const target = words[1];
    dir = target && dir ? resolvePath(target, dir, home) : null;
  }
  return dir;
}
function resolvePath(target, dir, home) {
  let path = target;
  if (path === "~" || path.startsWith("~/")) path = home + path.slice(1);
  else if (path.startsWith("$HOME/")) path = home + path.slice(5);
  else if (path.startsWith("${HOME}/")) path = home + path.slice(7);
  if (!path || /[$`*?[\]{}]/.test(path)) return null;
  if (path.startsWith("/dev/")) return null;
  return isAbsolute(path) ? resolve(path) : resolve(dir, path);
}
function isDirectory(path) {
  try {
    return statSync2(path).isDirectory();
  } catch {
    return false;
  }
}
function operands(args) {
  const out = [];
  let literal = false;
  for (const arg of args) {
    if (!literal && arg === "--") literal = true;
    else if (literal || !arg.startsWith("-") || arg === "-") out.push(arg);
  }
  return out;
}
function sedTargets(args) {
  let inPlace = false;
  let hasScript = false;
  const files = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      files.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("--in-place")) inPlace = true;
    else if (arg.startsWith("--expression=") || arg.startsWith("--file=")) hasScript = true;
    else if (arg === "--expression" || arg === "--file") {
      hasScript = true;
      i++;
    } else if (arg.startsWith("-") && arg.length > 1 && !arg.startsWith("--")) {
      for (let j = 1; j < arg.length; j++) {
        const flag = arg[j];
        if (flag === "i") {
          inPlace = true;
          if (j === arg.length - 1 && args[i + 1] === "") i++;
          break;
        }
        if (flag === "e" || flag === "f") {
          hasScript = true;
          if (j === arg.length - 1) i++;
          break;
        }
      }
    } else files.push(arg);
  }
  if (!inPlace) return [];
  return hasScript ? files : files.slice(1);
}
function copyTargets(args, dir, home) {
  const words = operands(args);
  if (words.length < 2) return [];
  const destination = resolvePath(words[words.length - 1], dir, home);
  if (!destination) return [];
  const sources = words.slice(0, -1);
  if (sources.length > 1 || isDirectory(destination)) return sources.map((s) => join6(destination, basename3(s)));
  return [destination];
}
function gitInvocation(args, dir, home) {
  let base = dir;
  let rest = args;
  while (rest.length && rest[0].startsWith("-")) {
    if (rest[0] === "-C" && rest[1]) {
      base = resolvePath(rest[1], base, home) ?? base;
      rest = rest.slice(2);
    } else rest = rest.slice(rest[0] === "-c" ? 2 : 1);
  }
  return { sub: rest[0] ?? "", rest: rest.slice(1), base };
}
function commandWrites(cmds, index, cwd, home) {
  const dir = directoryAt(cmds, index, cwd, home);
  if (!dir) return [];
  const cmd = cmds[index];
  const targets = [];
  const add = (word, base = dir) => {
    const path = resolvePath(word, base, home);
    if (path) targets.push(path);
  };
  for (const { op, target } of cmd.redirects) if (WRITE_REDIRECTS.has(op)) add(target);
  const [program, ...args] = programOf(cmd);
  switch (program ? basename3(program) : "") {
    case "tee":
      for (const file of operands(args)) add(file);
      break;
    case "sed":
    case "gsed":
      for (const file of sedTargets(args)) add(file);
      break;
    case "cp":
    case "mv":
    case "install":
      targets.push(...copyTargets(args, dir, home));
      break;
    case "git": {
      const { sub, rest, base } = gitInvocation(args, dir, home);
      if (sub === "mv") targets.push(...copyTargets(rest, base, home));
      else if (sub === "rm") for (const file of operands(rest)) add(file, base);
      break;
    }
  }
  return targets;
}

// src/lib/session-workflow.ts
var SHAPE_SHARE = 0.6;
var MIN_ROLES = 2;
var MAX_TRAIL_EDITS = 1e3;
var EDIT_TOOLS2 = /* @__PURE__ */ new Set(["Edit", "Write", "MultiEdit"]);
function workflowsFile(home = handbookHome()) {
  return join7(home, "workflows.jsonl");
}
function minedRecordFile(home = handbookHome()) {
  return join7(home, "mined-workflows.json");
}
function sessionDetectEnabled(home = handbookHome()) {
  const sessions = readConfigFile(home).sessions;
  return !configIsBroken(home) && sessions?.detect !== false;
}
function isAutonomous(entrypoint) {
  return !!entrypoint && entrypoint.startsWith("sdk");
}
function repositoryOf(dir) {
  let at = resolve2(dir);
  for (; ; ) {
    const dotgit = join7(at, ".git");
    try {
      const stat = statSync3(dotgit);
      if (stat.isDirectory()) return { repo: realpathSync(at), checkout: at, gitdir: dotgit };
      if (stat.isFile()) {
        const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync6(dotgit, "utf8"));
        if (pointer) {
          const gitdir = resolve2(at, pointer[1].trim());
          const marker = `${sep}.git${sep}worktrees${sep}`;
          const cut = gitdir.lastIndexOf(marker);
          return { repo: realpathSync(cut >= 0 ? gitdir.slice(0, cut) : at), checkout: at, gitdir };
        }
      }
    } catch {
    }
    const up = dirname2(at);
    if (up === at) return null;
    at = up;
  }
}
var diskLocator = {
  locate(path) {
    const found = repositoryOf(dirname2(path));
    if (!found) return null;
    const rel = relative(found.checkout, path).split(sep).join("/");
    if (!rel || rel.startsWith("../") || rel === ".git" || rel.startsWith(".git/")) return null;
    return { repo: found.repo, checkout: found.checkout, path: rel };
  },
  ignored(checkout, paths) {
    if (paths.length === 0) return /* @__PURE__ */ new Set();
    const result = spawnSync("git", ["-C", checkout, "check-ignore", "--stdin"], {
      input: paths.join("\n"),
      encoding: "utf8",
      timeout: 2e3
    });
    if (result.status !== 0 || typeof result.stdout !== "string") return /* @__PURE__ */ new Set();
    return new Set(result.stdout.split("\n").filter(Boolean));
  },
  branch(checkout) {
    const found = repositoryOf(checkout);
    if (!found) return null;
    try {
      const head = readFileSync6(join7(found.gitdir, "HEAD"), "utf8");
      return /^ref:\s*refs\/heads\/(.+)$/m.exec(head)?.[1]?.trim() ?? null;
    } catch {
      return null;
    }
  }
};
function loadMinedRecord(home = handbookHome()) {
  try {
    const parsed = JSON.parse(readFileSync6(minedRecordFile(home), "utf8"));
    if (parsed?.version !== 1 || !Array.isArray(parsed.repos) || !Array.isArray(parsed.shapes)) return null;
    return parsed;
  } catch {
    return null;
  }
}
function detectWorkflow(files, mined) {
  if (files.length === 0) return null;
  const resolver = mined ? restoreRoleResolver(mined.resolver) : buildRoleResolver(files.map((f) => f.path));
  const worked = new Set(files.filter((f) => !isDocPath(f.path)).map((f) => f.repo));
  const pairs = /* @__PURE__ */ new Map();
  for (const file of files) {
    if (!worked.has(file.repo)) continue;
    const role = resolver(file.path);
    if (IGNORED_ROLES.has(role)) continue;
    pairs.set(`${file.repo}\0${role}`, { repo: file.repo, role });
  }
  if (pairs.size < MIN_ROLES) return null;
  const list = [...pairs.values()];
  const shape = mined ? bestShape(list, mined) : null;
  return { match: shape ? "shape" : "candidate", shape, pairs: list };
}
function bestShape(pairs, mined) {
  const names = new Map(mined.repos.map((r) => [r.root, r]));
  const held = /* @__PURE__ */ new Set();
  for (const { repo, role } of pairs) {
    const named = names.get(repo);
    if (!named) continue;
    held.add(`${named.label}:${role}`);
    held.add(`${named.family}:${role}`);
  }
  let best = null;
  for (const shape of mined.shapes) {
    if (shape.core.length === 0) continue;
    const share = shape.core.filter((role) => held.has(role)).length / shape.core.length;
    if (share < SHAPE_SHARE) continue;
    if (!best || share > best.share || share === best.share && shape.recurrence > best.recurrence) {
      best = { id: shape.id, share, recurrence: shape.recurrence };
    }
  }
  return best?.id ?? null;
}
var PACKAGE_RUNNERS = /* @__PURE__ */ new Set(["npm", "pnpm", "yarn", "bun"]);
var SCRIPT_CHECK = /^(test|tests|t|e2e|spec|build|compile|typecheck|type-check|tsc|check)(:|$)/;
var TOOL_CHECKS = /* @__PURE__ */ new Set(["vitest", "jest", "mocha", "ava", "pytest", "py.test", "tox", "rspec", "phpunit", "tsc"]);
var SUBCOMMAND_CHECKS = {
  go: /* @__PURE__ */ new Set(["test", "build", "vet"]),
  cargo: /* @__PURE__ */ new Set(["test", "build", "check", "nextest"]),
  dotnet: /* @__PURE__ */ new Set(["test", "build"]),
  swift: /* @__PURE__ */ new Set(["test", "build"]),
  bazel: /* @__PURE__ */ new Set(["test", "build"]),
  bazelisk: /* @__PURE__ */ new Set(["test", "build"]),
  playwright: /* @__PURE__ */ new Set(["test"]),
  cypress: /* @__PURE__ */ new Set(["run"])
};
var MAVEN_PHASES = /* @__PURE__ */ new Set(["test", "verify", "compile", "package", "install"]);
var GRADLE_TASK = /(^|:)(test\w*|check|build|assemble\w*|compile\w*)$/;
var MAKE_TARGETS = /* @__PURE__ */ new Set(["test", "check", "build", "all"]);
var positional = (args) => args.filter((a) => !a.startsWith("-") && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(a));
function isCheck(cmd) {
  const [program, ...args] = programOf(cmd);
  if (!program) return false;
  const name = basename4(program);
  const words = positional(args);
  if (PACKAGE_RUNNERS.has(name)) {
    const [sub, next] = words;
    if (sub === "exec" || sub === "dlx" || sub === "x") return !!next && TOOL_CHECKS.has(basename4(next));
    const script = sub === "run" || sub === "run-script" ? next : sub;
    return !!script && SCRIPT_CHECK.test(script);
  }
  if (name === "npx" || name === "bunx") {
    const [tool, sub] = words;
    if (!tool) return false;
    const toolName = basename4(tool);
    return TOOL_CHECKS.has(toolName) || !!sub && !!SUBCOMMAND_CHECKS[toolName]?.has(sub);
  }
  if (TOOL_CHECKS.has(name)) return true;
  if (/^python[0-9.]*$/.test(name)) {
    const module = args[args.indexOf("-m") + 1];
    return args.includes("-m") && (module === "pytest" || module === "unittest");
  }
  if (name === "node") return args.includes("--test");
  if (SUBCOMMAND_CHECKS[name]) return !!words[0] && SUBCOMMAND_CHECKS[name].has(words[0]);
  if (name === "mvn" || name === "mvnw") return words.some((w) => MAVEN_PHASES.has(w));
  if (name === "gradle" || name === "gradlew") return words.some((w) => GRADLE_TASK.test(w));
  if (name === "make") return words.length === 0 || words.some((w) => MAKE_TARGETS.has(w));
  if (name === "xcodebuild") return words.some((w) => w === "test" || w === "build");
  return false;
}
function isCommit(cmd) {
  const [program, ...args] = programOf(cmd);
  return !!program && basename4(program) === "git" && gitInvocation(args, ".", ".").sub === "commit";
}
function emptyTrail() {
  return { edits: [], green: false, masked: false, fired: [] };
}
function recordWorkflowEvent(input, home = handbookHome(), deps = {}) {
  if (!input.session_id || !sessionDetectEnabled(home)) return null;
  if (isAutonomous(deps.entrypoint ?? process.env.CLAUDE_CODE_ENTRYPOINT)) return null;
  const locator = deps.locator ?? diskLocator;
  const userHome = deps.userHome ?? homedir3();
  const cwd = input.cwd ?? "";
  const steps = [];
  if (EDIT_TOOLS2.has(input.tool_name ?? "")) {
    const filePath = typeof input.tool_input?.file_path === "string" ? input.tool_input.file_path : "";
    if (filePath) steps.push({ kind: "write", path: resolve2(cwd || "/", filePath) });
  } else if (input.tool_name === "Bash") {
    const command = typeof input.tool_input?.command === "string" ? input.tool_input.command : "";
    if (!command) return null;
    const ok = isBashSuccess(input);
    const cmds = simpleCommands(command);
    cmds.forEach((cmd, index) => {
      for (const path of commandWrites(cmds, index, cwd, userHome)) steps.push({ kind: "write", path });
      if (isCheck(cmd)) steps.push({ kind: "check", green: ok, masked: !statusReaches(cmds, index) });
      if (isCommit(cmd)) steps.push({ kind: "commit", ok });
    });
  }
  if (steps.length === 0) return null;
  const state = loadSessionState(input.session_id, home);
  const trail = state.workflow ?? emptyTrail();
  let line = null;
  let changed = false;
  for (const step of steps) {
    if (step.kind === "write") {
      if (!locator.locate(step.path)) continue;
      trail.green = false;
      trail.masked = false;
      if (!trail.edits.includes(step.path) && trail.edits.length < MAX_TRAIL_EDITS) trail.edits.push(step.path);
      changed = true;
    } else if (step.kind === "check") {
      trail.green = step.green;
      trail.masked = step.masked;
      changed = true;
    } else if (step.ok && trail.green && !trail.fired.includes("S1")) {
      const found = detectTrail(trail, home, deps);
      const outcome = found && writeLine(state, trail, "S1", found, home, deps);
      if (outcome) {
        trail.fired.push("S1");
        if (outcome !== "hygiene") line = outcome;
      }
      changed = true;
    }
  }
  if (!changed) return null;
  state.workflow = trail;
  saveSessionState(state, home);
  return line;
}
function detectTrail(trail, home, deps) {
  const files = trailFiles(trail.edits, deps.locator ?? diskLocator);
  const mined = loadMinedRecord(home);
  const detection = detectWorkflow(files, mined);
  return detection ? { files, mined, detection } : null;
}
function writeLine(state, trail, signal, { files, mined, detection }, home, deps) {
  const locator = deps.locator ?? diskLocator;
  const work = workKey(files, locator, mined?.prefixes ?? []);
  const host = deps.host ?? hostIdentity();
  const material = [...files.map((f) => f.path), ...detection.pairs.map((p) => p.role), ...work ? [work] : []];
  if (material.some((text) => traced(text, host))) {
    bumpCounter("workflowSkippedHygiene", home);
    return "hygiene";
  }
  const salt = installSalt(home);
  const line = {
    ts: deps.now?.() ?? (/* @__PURE__ */ new Date()).toISOString(),
    session: saltedHash(salt, "session", state.sessionId),
    signal,
    match: detection.match,
    shape: detection.shape,
    roles: [...new Set(detection.pairs.map((p) => saltedHash(salt, "role", `${p.repo}\0${p.role}`)))].sort(),
    repos: [...new Set(detection.pairs.map((p) => saltedHash(salt, "repo", p.repo)))].sort(),
    rolesEdited: detection.pairs.length,
    signals: sessionSignalCount(state.sessionId, home) + state.resolvedPairs.length + state.openErrors.length,
    ticket: work ? saltedHash(salt, "ticket", work) : null,
    maskedCheck: trail.masked
  };
  const serialized = JSON.stringify(line);
  if (traced(serialized, host)) {
    bumpCounter("workflowSkippedHygiene", home);
    return "hygiene";
  }
  mkdirSync5(home, { recursive: true });
  appendFileSync2(workflowsFile(home), `${serialized}
`);
  return line;
}
function traced(text, host) {
  return detectIdentity(text, host) !== null || detectSecret(text) !== null;
}
function trailFiles(edits, locator) {
  const byCheckout = /* @__PURE__ */ new Map();
  for (const edit of edits) {
    const file = locator.locate(edit);
    if (!file) continue;
    const list = byCheckout.get(file.checkout) ?? [];
    list.push(file);
    byCheckout.set(file.checkout, list);
  }
  const files = [];
  for (const [checkout, list] of byCheckout) {
    const ignored = locator.ignored(checkout, list.map((f) => f.path));
    files.push(...list.filter((f) => !ignored.has(f.path)));
  }
  return files;
}
var DEFAULT_BRANCHES = /* @__PURE__ */ new Set(["main", "master", "develop", "dev", "trunk", "HEAD"]);
function workKey(files, locator, prefixes) {
  const counts = /* @__PURE__ */ new Map();
  for (const file of files) counts.set(file.checkout, (counts.get(file.checkout) ?? 0) + 1);
  const checkout = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0];
  const branch = checkout ? locator.branch(checkout) : null;
  if (!branch || DEFAULT_BRANCHES.has(branch)) return null;
  for (const match of branch.matchAll(KEY_CANDIDATE)) {
    const prefix = match[1];
    if (NOT_A_TICKET.has(prefix) || prefixes.length > 0 && !prefixes.includes(prefix)) continue;
    return match[0];
  }
  return branch;
}
function installSalt(home) {
  const file = join7(home, "workflow-salt");
  try {
    return Buffer.from(readFileSync6(file, "utf8").trim(), "hex");
  } catch {
    mkdirSync5(home, { recursive: true });
    try {
      writeFileSync3(file, randomBytes(16).toString("hex"), { flag: "wx", mode: 384 });
    } catch {
    }
    return Buffer.from(readFileSync6(file, "utf8").trim(), "hex");
  }
}
function saltedHash(salt, kind, value) {
  return createHash2("sha256").update(salt).update(kind).update("\0").update(value).digest("hex").slice(0, 16);
}

// src/hooks/post-tool-use.ts
async function main() {
  const raw = await readStdin();
  maybeDumpPayload(raw);
  const input = parseHookInput(raw);
  if (!input) return;
  bumpCounter("postToolUse");
  if (input.tool_name === "Skill") {
    const slug = typeof input.tool_input?.skill === "string" ? input.tool_input.skill : "";
    recordSkillUse(slug);
    return;
  }
  recordWorkflowEvent(input);
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
