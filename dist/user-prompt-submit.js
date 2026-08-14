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

// src/lib/corrections.ts
var MIN_CHARS = 12;
var MAX_CHARS = 600;
function isDeveloperProse(text) {
  return !text.startsWith("/") && !text.startsWith("<") && !text.startsWith("[");
}
function couldTeach(prompt) {
  const text = prompt.trim();
  return text.length >= MIN_CHARS && text.length <= MAX_CHARS && isDeveloperProse(text);
}
var MAX_CORRECTIONS = 40;
var MAX_TEXT_CHARS = 400;
function noteCorrection(notes, prompt, at = (/* @__PURE__ */ new Date()).toISOString()) {
  if (!couldTeach(prompt)) return null;
  const full = prompt.trim();
  if (detectSecret(full)) return null;
  const text = full.slice(0, MAX_TEXT_CHARS);
  if (notes.some((n) => n.text === text)) return null;
  const next = [...notes, { at, text }];
  return next.length > MAX_CORRECTIONS ? next.slice(-MAX_CORRECTIONS) : next;
}

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

// src/lib/capture.ts
function captureCorrection(input, home = handbookHome()) {
  if (!input.session_id || typeof input.prompt !== "string") return false;
  const state = loadSessionState(input.session_id, home);
  const next = noteCorrection(state.corrections ?? [], input.prompt);
  if (!next) return false;
  state.corrections = next;
  if (input.transcript_path) state.transcriptPath = input.transcript_path;
  saveSessionState(state, home);
  return true;
}

// src/hooks/user-prompt-submit.ts
async function main() {
  const input = parseHookInput(await readStdin());
  if (!input) return;
  captureCorrection(input);
}
main().then(
  () => process.exit(0),
  () => process.exit(0)
);
