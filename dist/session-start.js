// src/hooks/session-start.ts
import { fileURLToPath } from "node:url";

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

// src/lib/notify.ts
import { existsSync as existsSync4, readFileSync as readFileSync9, readdirSync as readdirSync5 } from "node:fs";

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

// src/lib/notify.ts
import { join as join10 } from "node:path";

// src/lib/session-state.ts
import { homedir, tmpdir } from "node:os";
import { dirname as dirname2, join } from "node:path";
import { closeSync, mkdirSync as mkdirSync2, mkdtempSync, openSync, readFileSync, readdirSync, rmSync as rmSync2, statSync } from "node:fs";
var EDIT_ATTACH_WINDOW_MS = 15 * 60 * 1e3;
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
      ...typeof parsed.harvestedBytes === "number" ? { harvestedBytes: parsed.harvestedBytes } : {},
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
var LOCK_WAIT_MS = 2e3;
var LOCK_STALE_MS = 1e4;
var LOCK_RETRY_MS = 10;
var SLEEPER = new Int32Array(new SharedArrayBuffer(4));
function withSessionLock(sessionId, fn, home = handbookHome(), waitMs = LOCK_WAIT_MS) {
  if (!sessionId) return fn();
  const lock = `${sessionFile(sessionId, home)}.lock`;
  const held = acquireLock(lock, waitMs);
  try {
    return fn();
  } finally {
    if (held) rmSync2(lock, { force: true });
  }
}
function acquireLock(lock, waitMs) {
  const deadline = Date.now() + waitMs;
  for (; ; ) {
    try {
      mkdirSync2(dirname2(lock), { recursive: true });
      closeSync(openSync(lock, "wx"));
      return true;
    } catch (err) {
      if (err?.code !== "EEXIST") return false;
    }
    try {
      if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
        rmSync2(lock, { force: true });
        continue;
      }
    } catch {
      continue;
    }
    if (Date.now() >= deadline) return false;
    Atomics.wait(SLEEPER, 0, 0, LOCK_RETRY_MS);
  }
}
var SUBSTANCE_MIN_TOOL_CALLS = 5;
function sessionHasSubstance(state) {
  if (state.resolvedPairs.length > 0) return true;
  const activity = state.activity;
  if (activity && activity.families.length > 0 && activity.exts.length > 0) return true;
  return (state.meaningfulToolCalls ?? 0) >= SUBSTANCE_MIN_TOOL_CALLS;
}
function deleteSessionState(sessionId, home = handbookHome()) {
  rmSync2(sessionFile(sessionId, home), { force: true });
}
var SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1e3;
var SESSION_ORPHAN_MS = 3 * 60 * 60 * 1e3;
function orphanedSessionIds(home = handbookHome(), now = Date.now()) {
  return sessionIdsUntouchedFor(SESSION_ORPHAN_MS, home, now);
}
function deadSessionIds(home = handbookHome(), now = Date.now()) {
  return sessionIdsUntouchedFor(SESSION_MAX_AGE_MS, home, now);
}
function sessionIdsUntouchedFor(ageMs, home, now) {
  const dir = join(home, "sessions");
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const ids = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      if (now - statSync(join(dir, entry)).mtimeMs > ageMs) {
        ids.push(entry.replace(/\.json$/, ""));
      }
    } catch {
    }
  }
  return ids;
}
function cleanupStaleSessionFiles(home = handbookHome(), now = Date.now()) {
  const dir = join(home, "sessions");
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    try {
      const file = join(dir, entry);
      if (now - statSync(file).mtimeMs > SESSION_MAX_AGE_MS) {
        rmSync2(file, { force: true });
        removed += 1;
      }
    } catch {
    }
  }
  return removed;
}

// src/lib/config.ts
import { existsSync, readFileSync as readFileSync2 } from "node:fs";
import { join as join2 } from "node:path";
function configFile(home = handbookHome()) {
  return join2(home, "config.json");
}
function readConfigFile(home = handbookHome()) {
  try {
    const parsed = JSON.parse(readFileSync2(configFile(home), "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function configIsBroken(home = handbookHome()) {
  const file = configFile(home);
  if (!existsSync(file)) return false;
  try {
    const parsed = JSON.parse(readFileSync2(file, "utf8"));
    return !(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed));
  } catch {
    return true;
  }
}

// src/lib/counters.ts
import { mkdirSync as mkdirSync3, readdirSync as readdirSync2, readFileSync as readFileSync3, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join3 } from "node:path";
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
  return join3(home, "counters.json");
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
    const parsed = JSON.parse(readFileSync3(countersFile(home), "utf8"));
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

// src/lib/init.ts
import { homedir as homedir3 } from "node:os";
import { dirname as dirname3, join as join6 } from "node:path";

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

// src/lib/queue.ts
import { existsSync as existsSync2, mkdirSync as mkdirSync4, readFileSync as readFileSync5, readdirSync as readdirSync4 } from "node:fs";
import { basename as basename2, join as join5 } from "node:path";

// src/lib/skill-index.ts
import { readdirSync as readdirSync3, readFileSync as readFileSync4 } from "node:fs";
import { join as join4 } from "node:path";
function candidatesDir(home = handbookHome()) {
  return join4(home, "candidates");
}
var BLOCK_SCALAR = /^[|>][-+]?\d*$/;
function foldBlockScalar(lines, start, folded) {
  const body = [];
  let i = start;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") {
      body.push("");
      continue;
    }
    if (!/^\s/.test(line)) break;
    body.push(line.trim());
  }
  while (body.length && body.at(-1) === "") body.pop();
  const value = folded ? body.reduce((text, line) => line === "" ? `${text}
` : text === "" || text.endsWith("\n") ? text + line : `${text} ${line}`, "") : body.join("\n");
  return { value, next: i - 1 };
}
function parseSkillFrontmatter(md) {
  const match = md.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fields = /* @__PURE__ */ new Map();
  const lines = match[1].split("\n");
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z-]+):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if (BLOCK_SCALAR.test(value)) {
      const block = foldBlockScalar(lines, i + 1, value.startsWith(">"));
      value = block.value;
      i = block.next;
    } else if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    fields.set(kv[1], value);
  }
  const name = fields.get("name");
  const description = fields.get("description");
  if (!name || !description) return null;
  const scope = fields.get("scope");
  return { name, description, ...scope ? { scope } : {} };
}
function isDecidedCandidate(dir, entry) {
  try {
    const meta = JSON.parse(readFileSync4(join4(dir, entry, "candidate.json"), "utf8"));
    return meta?.status === "rejected" || meta?.status === "approved";
  } catch {
    return false;
  }
}
function listExistingSkills(dirs) {
  const byName = /* @__PURE__ */ new Map();
  for (const dir of dirs) {
    let entries;
    try {
      entries = readdirSync3(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (isDecidedCandidate(dir, entry)) continue;
      let raw;
      try {
        raw = readFileSync4(join4(dir, entry, "SKILL.md"), "utf8");
      } catch {
        continue;
      }
      const summary = parseSkillFrontmatter(raw);
      if (summary && !byName.has(summary.name)) byName.set(summary.name, summary);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
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

// src/lib/queue.ts
var STATUSES = ["pending", "approved", "rejected", "archived"];
function candidateMetaFile(dir) {
  return join5(dir, "candidate.json");
}
function synthesizeMeta(dir) {
  let md;
  try {
    md = readFileSync5(join5(dir, "SKILL.md"), "utf8");
  } catch {
    return null;
  }
  const summary = parseSkillFrontmatter(md);
  if (!summary) return null;
  let grounded = {};
  try {
    grounded = JSON.parse(readFileSync5(join5(dir, "grounded-case.json"), "utf8"));
  } catch {
  }
  const gate = grounded.gate;
  return {
    slug: basename2(dir),
    status: "pending",
    createdAt: typeof grounded.capturedAt === "string" ? grounded.capturedAt : "",
    scope: summary.scope ?? "team",
    description: summary.description,
    fingerprint: typeof grounded.fingerprint === "string" ? grounded.fingerprint : "",
    sessionId: "",
    gate: gate && typeof gate.total === "number" ? gate : null
  };
}
function readCandidateMeta(dir) {
  try {
    const parsed = JSON.parse(readFileSync5(candidateMetaFile(dir), "utf8"));
    if (typeof parsed === "object" && parsed !== null && STATUSES.includes(parsed.status) && typeof parsed.description === "string" && typeof parsed.scope === "string") {
      return {
        ...parsed,
        slug: basename2(dir),
        createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : ""
      };
    }
  } catch {
  }
  return synthesizeMeta(dir);
}
function listCandidates(home = handbookHome(), status) {
  const base = candidatesDir(home);
  let entries;
  try {
    entries = readdirSync4(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const metas = entries.filter((e) => e.isDirectory()).map((e) => readCandidateMeta(join5(base, e.name))).filter((m) => m !== null);
  const filtered = status ? metas.filter((m) => m.status === status) : metas;
  return filtered.sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || a.slug.localeCompare(b.slug)
  );
}

// src/lib/score.ts
var execFileAsync = promisify(execFile);
function gateAutoEnabled(home = handbookHome()) {
  if (configIsBroken(home)) return false;
  const gate = readConfigFile(home).gate;
  return gate?.auto !== false;
}

// src/lib/distill.ts
function openingsOf(literal) {
  return [...literal].reduceRight((rest, ch) => `(?:${ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${rest})?`, "");
}
var CUT_SCOPE_SENTENCE = new RegExp(
  `\\s*Applies ONLY in the(?: \\S*${openingsOf(" repository - do not use it elsewhere.")})?$`
);

// src/lib/init.ts
function loadTeamConfig(home = handbookHome()) {
  const team = readConfigFile(home).team;
  if (team && typeof team.repoUrl === "string" && typeof team.marketplaceName === "string") {
    return team;
  }
  return null;
}
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
function marketplacesRoot() {
  return join6(homedir3(), ".claude", "plugins", "marketplaces");
}
function teamSkillsDir(home = handbookHome(), root = marketplacesRoot()) {
  const team = loadTeamConfig(home);
  return team ? join6(root, team.marketplaceName, "skills") : null;
}

// src/lib/transcript.ts
var PER_USER_CAP = 1e3;
var USER_HEAD = 700;
var USER_TAIL = PER_USER_CAP - USER_HEAD;
var ROLE_LABEL = new RegExp(`(^|[${LINE_TERMINATOR_CLASS}])(User|Assistant)(\\s*:)`, "gi");
var WRAPPED_LINE_MIN = 24;
var BLOB_LINE = new RegExp(`^[A-Za-z0-9+/]{${WRAPPED_LINE_MIN},}={0,2}$`);

// src/lib/harvest.ts
var defaultHarvestConfig = {
  enabled: true,
  // Measured, not assumed: on an identical prompt from a real session, haiku
  // proposed the developer's stated rule 1 time in 3 and sonnet 3 in 3. That is one
  // prompt, three runs per model - too little to put a rate on, and all the evidence
  // this default rests on. The whole product is "every session teaches it something";
  // a default that stays silent two thirds of the time fails that. One call per
  // session, and {"harvest": {"model": "haiku"}} is still there for whoever wants it
  // cheaper.
  model: "sonnet",
  maxPerSession: 3,
  minScore: 4,
  transcriptCharCap: 4e4,
  // Latency is dominated by how much the model writes, not by the slice: a 31k-char
  // prompt returning nothing took 9s, a 6k one returning a full skill took 25s. Three
  // items is the cap, so ~75s is the realistic ceiling - and a timeout here does not
  // degrade to a smaller answer, it burns an attempt and can park the session in
  // abandoned.jsonl. This is the value the yield measurement was run at.
  timeoutMs: 18e4
};
function lessonHarvestEnabled(home = handbookHome()) {
  const harvest = readConfigFile(home).harvest;
  return !configIsBroken(home) && harvest?.lessons === true;
}
function loadHarvestConfig(home = handbookHome()) {
  const harvest = readConfigFile(home).harvest;
  const num = (v, fallback) => typeof v === "number" && v > 0 ? v : fallback;
  return {
    // fail closed on a broken config - see configIsBroken
    enabled: !configIsBroken(home) && harvest?.enabled !== false,
    model: typeof harvest?.model === "string" ? harvest.model : defaultHarvestConfig.model,
    maxPerSession: num(harvest?.maxPerSession, defaultHarvestConfig.maxPerSession),
    minScore: typeof harvest?.minScore === "number" && harvest.minScore >= 0 && harvest.minScore <= 10 ? harvest.minScore : defaultHarvestConfig.minScore,
    transcriptCharCap: num(harvest?.transcriptCharCap, defaultHarvestConfig.transcriptCharCap),
    timeoutMs: num(harvest?.timeoutMs, defaultHarvestConfig.timeoutMs)
  };
}

// src/lib/review-list.ts
function isOlderLesson(meta) {
  return meta.origin === "harvest";
}
function reviewQueue(home = handbookHome()) {
  const pending = listCandidates(home, "pending");
  if (lessonHarvestEnabled(home)) return { listed: pending, olderLessons: [], draftsFirst: false };
  const rest = pending.filter((meta) => !isOlderLesson(meta));
  return {
    listed: [...rest.filter((meta) => meta.origin === "mine"), ...rest.filter((meta) => meta.origin !== "mine")],
    olderLessons: pending.filter(isOlderLesson),
    draftsFirst: true
  };
}

// src/lib/usage.ts
import { readFileSync as readFileSync8 } from "node:fs";
import { basename as basename4, join as join9 } from "node:path";

// src/lib/session-workflow.ts
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync as appendFileSync2, mkdirSync as mkdirSync6, readFileSync as readFileSync7, realpathSync, statSync as statSync2, writeFileSync as writeFileSync3 } from "node:fs";
import { basename as basename3, dirname as dirname4, join as join8, relative, resolve, sep } from "node:path";

// src/lib/signals.ts
import { existsSync as existsSync3, appendFileSync, mkdirSync as mkdirSync5, readFileSync as readFileSync6 } from "node:fs";
import { join as join7 } from "node:path";
function sanitizeSignalsForPersistence(signals) {
  let redacted = 0;
  const clean = signals.map((s) => {
    if (s.secretRedacted || !signalSecret(s)) return s;
    redacted += 1;
    return {
      ts: s.ts,
      sessionId: s.sessionId,
      kind: "weak",
      fingerprint: s.fingerprint,
      family: "",
      command: "",
      error: "",
      cwd: "",
      count: s.count,
      edits: [],
      secretRedacted: true
    };
  });
  return { clean, redacted };
}
function signalsFile(home = handbookHome()) {
  return join7(home, "signals.jsonl");
}
function ledgerFingerprintCounts(home = handbookHome()) {
  const counts = /* @__PURE__ */ new Map();
  let raw;
  try {
    raw = readFileSync6(signalsFile(home), "utf8");
  } catch {
    return counts;
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed?.fingerprint === "string") {
        counts.set(parsed.fingerprint, (counts.get(parsed.fingerprint) ?? 0) + 1);
      }
    } catch {
    }
  }
  return counts;
}
function appendSignals(signals, home = handbookHome()) {
  if (signals.length === 0) return;
  const { clean, redacted } = sanitizeSignalsForPersistence(signals);
  if (redacted > 0) incrementRedactionBlocked(home, redacted);
  mkdirSync5(home, { recursive: true });
  const lines = clean.map((s) => JSON.stringify(s)).join("\n") + "\n";
  appendFileSync(signalsFile(home), lines);
}
function signalFromPair(pair, sessionId, ts, fileExists = existsSync3) {
  const persistedEdits = pair.edits.filter(fileExists);
  return {
    ts,
    sessionId,
    kind: persistedEdits.length > 0 ? "candidate" : "weak",
    fingerprint: pair.fingerprint,
    family: pair.family,
    command: pair.command,
    error: pair.error,
    cwd: pair.cwd,
    count: pair.count,
    edits: persistedEdits,
    resolvedCommand: pair.resolvedCommand,
    resolvedAt: pair.resolvedAt
  };
}
function signalFromOpenError(error, sessionId, ts) {
  return {
    ts,
    sessionId,
    kind: "weak",
    fingerprint: error.fingerprint,
    family: error.family,
    command: error.command,
    error: error.error,
    cwd: error.cwd,
    count: error.count,
    edits: error.edits
  };
}
function flushResolvedPairs(sessionId, home = handbookHome(), ts = (/* @__PURE__ */ new Date()).toISOString(), fileExists = existsSync3) {
  const state = loadSessionState(sessionId, home);
  if (state.resolvedPairs.length === 0) return [];
  const signals = state.resolvedPairs.map((p) => signalFromPair(p, sessionId, ts, fileExists));
  appendSignals(signals, home);
  state.resolvedPairs = [];
  saveSessionState(state, home);
  return signals;
}
function flushSessionEnd(sessionId, home = handbookHome(), ts = (/* @__PURE__ */ new Date()).toISOString(), fileExists = existsSync3) {
  const state = loadSessionState(sessionId, home);
  const signals = [
    ...state.resolvedPairs.map((p) => signalFromPair(p, sessionId, ts, fileExists)),
    ...state.openErrors.map((e) => signalFromOpenError(e, sessionId, ts))
  ];
  appendSignals(signals, home);
  deleteSessionState(sessionId, home);
  return signals;
}
function sessionSignalCount(sessionId, home = handbookHome()) {
  let raw;
  try {
    raw = readFileSync6(signalsFile(home), "utf8");
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
function ledgerPairsForSession(sessionId, home = handbookHome()) {
  let raw;
  try {
    raw = readFileSync6(signalsFile(home), "utf8");
  } catch {
    return [];
  }
  const pairs = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed.sessionId !== sessionId || !parsed.resolvedCommand || parsed.secretRedacted) continue;
    pairs.push({
      fingerprint: parsed.fingerprint,
      family: parsed.family,
      command: parsed.command,
      error: parsed.error,
      resolvedCommand: parsed.resolvedCommand,
      edits: parsed.edits ?? [],
      ...parsed.cwd ? { cwd: parsed.cwd } : {}
    });
  }
  return pairs;
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
  const resolve2 = (path) => {
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
  resolve2.mirrors = mirrors;
  resolve2.templates = templates;
  resolve2.areas = areas;
  resolve2.compiled = compiled;
  return resolve2;
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

// src/lib/session-workflow.ts
var SHAPE_SHARE = 0.6;
var MIN_ROLES = 2;
function workflowsFile(home = handbookHome()) {
  return join8(home, "workflows.jsonl");
}
function minedRecordFile(home = handbookHome()) {
  return join8(home, "mined-workflows.json");
}
function sessionDetectEnabled(home = handbookHome()) {
  const sessions = readConfigFile(home).sessions;
  return !configIsBroken(home) && sessions?.detect !== false;
}
function isAutonomous(entrypoint) {
  return !!entrypoint && entrypoint.startsWith("sdk");
}
function repositoryOf(dir) {
  let at = resolve(dir);
  for (; ; ) {
    const dotgit = join8(at, ".git");
    try {
      const stat = statSync2(dotgit);
      if (stat.isDirectory()) return { repo: realpathSync(at), checkout: at, gitdir: dotgit };
      if (stat.isFile()) {
        const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync7(dotgit, "utf8"));
        if (pointer) {
          const gitdir = resolve(at, pointer[1].trim());
          const marker = `${sep}.git${sep}worktrees${sep}`;
          const cut = gitdir.lastIndexOf(marker);
          return { repo: realpathSync(cut >= 0 ? gitdir.slice(0, cut) : at), checkout: at, gitdir };
        }
      }
    } catch {
    }
    const up = dirname4(at);
    if (up === at) return null;
    at = up;
  }
}
var diskLocator = {
  locate(path) {
    const found = repositoryOf(dirname4(path));
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
      const head = readFileSync7(join8(found.gitdir, "HEAD"), "utf8");
      return /^ref:\s*refs\/heads\/(.+)$/m.exec(head)?.[1]?.trim() ?? null;
    } catch {
      return null;
    }
  }
};
function loadMinedRecord(home = handbookHome()) {
  try {
    const parsed = JSON.parse(readFileSync7(minedRecordFile(home), "utf8"));
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
function finishWorkflowSession(input, state, home = handbookHome(), deps = {}) {
  if (!input.session_id || !sessionDetectEnabled(home)) return null;
  const entrypoint = deps.entrypoint ?? process.env.CLAUDE_CODE_ENTRYPOINT;
  bumpCounter(entrypoint ? "workflowEntrypointSeen" : "workflowEntrypointMissing", home);
  if (isAutonomous(entrypoint)) {
    bumpCounter("workflowSkippedAutonomous", home);
    return null;
  }
  bumpCounter("workflowSessions", home);
  const trail = state.workflow;
  if (!trail?.edits.length) return null;
  const found = detectTrail(trail, home, deps);
  if (!found) return null;
  bumpCounter(found.detection.match === "shape" ? "workflowDetectedShape" : "workflowDetectedCandidate", home);
  if (!trail.green || trail.fired.includes("S2")) return null;
  const outcome = writeLine(state, trail, "S2", found, home, deps);
  return outcome === "hygiene" ? null : outcome;
}
function retireDeadSessions(home = handbookHome(), now = Date.now(), deps = {}) {
  const ids = deadSessionIds(home, now);
  for (const id of ids) {
    withSessionLock(
      id,
      () => {
        finishWorkflowSession({ session_id: id }, loadSessionState(id, home), home, { ...deps, entrypoint: "" });
        flushSessionEnd(id, home);
      },
      home
    );
  }
  return ids.length;
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
  mkdirSync6(home, { recursive: true });
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
  const file = join8(home, "workflow-salt");
  try {
    return Buffer.from(readFileSync7(file, "utf8").trim(), "hex");
  } catch {
    mkdirSync6(home, { recursive: true });
    try {
      writeFileSync3(file, randomBytes(16).toString("hex"), { flag: "wx", mode: 384 });
    } catch {
    }
    return Buffer.from(readFileSync7(file, "utf8").trim(), "hex");
  }
}
function saltedHash(salt, kind, value) {
  return createHash("sha256").update(salt).update(kind).update("\0").update(value).digest("hex").slice(0, 16);
}

// src/lib/usage.ts
var DAY = /^\d{4}-\d{2}-\d{2}$/;
function usageFile(home = handbookHome()) {
  return join9(home, "skill-usage.json");
}
function readSkillUsage(home = handbookHome()) {
  try {
    const parsed = JSON.parse(readFileSync8(usageFile(home), "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const usage = {};
    for (const [slug, value] of Object.entries(parsed)) {
      const entry = value;
      if (typeof entry?.count === "number" && typeof entry?.lastAt === "string") {
        const days = dayCounts(entry.days);
        usage[slug] = { count: entry.count, lastAt: entry.lastAt, ...days ? { days } : {} };
      }
    }
    return usage;
  } catch {
    return {};
  }
}
function dayCounts(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const days = {};
  for (const [day, count] of Object.entries(value)) {
    if (DAY.test(day) && typeof count === "number") days[day] = count;
  }
  return days;
}
function handbookSkills(home = handbookHome()) {
  const delivered = listCandidates(home, "approved").filter((c) => c.deliveredMode === "personal" || c.deliveredMode === "solo").map((c) => c.deliveredTo ? basename4(c.deliveredTo) : c.slug);
  const teamDir = teamSkillsDir(home);
  const fromTeam = teamDir ? listExistingSkills([teamDir]).map((s) => s.name) : [];
  return [.../* @__PURE__ */ new Set([...delivered, ...fromTeam])];
}
function summarizeUsage(usage, known) {
  const relevant = known.filter((slug) => usage[slug]);
  const totalUses = relevant.reduce((sum, slug) => sum + usage[slug].count, 0);
  const top = relevant.map((slug) => ({ slug, count: usage[slug].count })).sort((a, b) => b.count - a.count)[0];
  return { fired: relevant.length, totalUses, topSkill: top ?? null };
}

// src/lib/notify.ts
function loadNotifyConfig(home = handbookHome()) {
  const notify = readConfigFile(home).notify;
  return {
    sessionStart: notify?.sessionStart !== false,
    heartbeat: notify?.heartbeat !== false
  };
}
function welcomeMarkerFile(home) {
  return join10(home, "welcomed");
}
function isFirstRun(home = handbookHome()) {
  const marker = welcomeMarkerFile(home);
  if (existsSync4(marker)) return false;
  writeFileAtomic(marker, (/* @__PURE__ */ new Date()).toISOString() + "\n");
  return true;
}
function heartbeatSnapshotFile(home) {
  return join10(home, "notified-counters.json");
}
function heartbeatDelta(home = handbookHome()) {
  const current = readCounters(home);
  let prior = { bashFailuresCaptured: 0, pairsResolved: 0, gateErrors: 0 };
  try {
    const parsed = JSON.parse(readFileSync9(heartbeatSnapshotFile(home), "utf8"));
    prior = {
      bashFailuresCaptured: Number(parsed?.bashFailuresCaptured) || 0,
      pairsResolved: Number(parsed?.pairsResolved) || 0,
      gateErrors: Number(parsed?.gateErrors) || 0
    };
  } catch {
  }
  writeFileAtomic(
    heartbeatSnapshotFile(home),
    JSON.stringify(
      {
        bashFailuresCaptured: current.bashFailuresCaptured,
        pairsResolved: current.pairsResolved,
        gateErrors: current.gateErrors
      },
      null,
      2
    ) + "\n"
  );
  return {
    failures: Math.max(0, current.bashFailuresCaptured - prior.bashFailuresCaptured),
    pairs: Math.max(0, current.pairsResolved - prior.pairsResolved),
    gateErrors: Math.max(0, current.gateErrors - prior.gateErrors)
  };
}
var TEAM_NUDGE_APPROVALS = 3;
function teamNudgeMarkerFile(home) {
  return join10(home, "nudged-team");
}
function digestMarkerFile(home) {
  return join10(home, "last-digest");
}
function foldedLessonsMarkerFile(home) {
  return join10(home, "noticed-folded-lessons");
}
function foldedLessonsToAnnounce(home, folded) {
  let announced = 0;
  try {
    announced = Number.parseInt(readFileSync9(foldedLessonsMarkerFile(home), "utf8"), 10) || 0;
  } catch {
  }
  if (folded === announced) return 0;
  writeFileAtomic(foldedLessonsMarkerFile(home), `${folded}
`);
  return folded > announced ? folded : 0;
}
var DIGEST_INTERVAL_MS = 7 * 24 * 60 * 60 * 1e3;
function weeklyDigest(home = handbookHome(), now = Date.now()) {
  const marker = digestMarkerFile(home);
  let since = 0;
  try {
    since = Date.parse(readFileSync9(marker, "utf8").trim());
  } catch {
    writeFileAtomic(marker, new Date(now).toISOString() + "\n");
    return null;
  }
  if (!Number.isFinite(since) || now - since < DIGEST_INTERVAL_MS) return null;
  writeFileAtomic(marker, new Date(now).toISOString() + "\n");
  const decided = listCandidates(home).filter(
    (c) => c.decidedAt && Date.parse(c.decidedAt) >= since
  );
  const kept = decided.filter(
    (c) => c.status === "approved" && (c.deliveredMode === "personal" || c.deliveredMode === "solo")
  ).length;
  const shared = decided.filter((c) => c.status === "approved" && c.deliveredMode === "team").length;
  const pending = listCandidates(home, "pending").length;
  if (kept + shared + pending === 0) return null;
  const parts = [];
  if (kept > 0) parts.push(`${kept} skill${kept === 1 ? "" : "s"} kept`);
  if (shared > 0) parts.push(`${shared} shared with the team`);
  if (pending > 0) parts.push(`${pending} waiting for your call`);
  const usage = summarizeUsage(readSkillUsage(home), handbookSkills(home));
  if (usage.totalUses > 0) {
    parts.push(
      `your skills fired ${usage.totalUses} time${usage.totalUses === 1 ? "" : "s"}` + (usage.topSkill ? ` (${usage.topSkill.slug} most of all)` : "")
    );
  }
  return `TeamHandbook - your week: ${parts.join(", ")}. Run /handbook:status for the full picture.`;
}
function pendingTeamNudge(home = handbookHome()) {
  if (loadTeamConfig(home)) return null;
  if (existsSync4(teamNudgeMarkerFile(home))) return null;
  const approved = listCandidates(home, "approved").length;
  if (approved < TEAM_NUDGE_APPROVALS) return null;
  writeFileAtomic(teamNudgeMarkerFile(home), (/* @__PURE__ */ new Date()).toISOString() + "\n");
  return `handbook: ${approved} approved skills live only on this machine - one /handbook:init shares them with your team (teammates get every future merge automatically).`;
}
function pendingHarvestCount(home = handbookHome()) {
  let entries;
  try {
    entries = readdirSync5(join10(home, "pending"));
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    if (!entry.includes(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync9(join10(home, "pending", entry), "utf8"));
      if (parsed && typeof parsed === "object" && typeof parsed.sessionId === "string") total += 1;
    } catch {
    }
  }
  return total;
}
function seenSkillsFile(home = handbookHome()) {
  return join10(home, "seen-skills.json");
}
function readSeenSkills(home) {
  try {
    const parsed = JSON.parse(readFileSync9(seenSkillsFile(home), "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}
function diffNewSkills(dir, currentNames, home = handbookHome()) {
  const state = readSeenSkills(home);
  const prior = state[dir];
  state[dir] = [...currentNames].sort();
  writeFileAtomic(seenSkillsFile(home), JSON.stringify(state, null, 2) + "\n");
  if (!Array.isArray(prior)) return [];
  const priorSet = new Set(prior);
  return currentNames.filter((name) => !priorSet.has(name)).sort();
}
function buildSessionStartSummary(inputs) {
  const {
    pending,
    pendingPreviews = [],
    harvested = null,
    harvestedNothing = false,
    newSkills,
    firstRun = false,
    heartbeat = null,
    keptSkills = 0,
    teamNudge = null,
    digest = null,
    scoring = 0,
    foldedLessons = 0
  } = inputs;
  const lines = [];
  if (inputs.configBroken) {
    lines.push(
      "handbook: ~/.teamhandbook/config.json could not be parsed - automatic harvesting is OFF until it is valid JSON (failing closed on purpose). Run /handbook:doctor."
    );
  }
  if (firstRun) {
    lines.push(
      'TeamHandbook is active - it learns from the corrections you give, the procedures you complete, and the traps you hit. After each session where you did real work, it reads that session (your prompts included, secrets redacted) through your OWN claude CLI and tells you at your next session start what it learned - you decide whether to keep it, put it in the repo, or share it with the team. Nothing installs or ships without your say-so. Turn the reading off entirely with ~/.teamhandbook/config.json \u2192 {"harvest": {"enabled": false}}. Want to see the whole loop in two minutes instead of waiting? Run /handbook:demo. And /handbook:doctor once confirms TeamHandbook can reach your claude CLI.'
    );
  }
  if (harvested) {
    const score = harvested.total !== null ? `, ${harvested.total}/10` : "";
    const more = harvested.more > 0 ? ` (+${harvested.more} more)` : "";
    const repeats = (harvested.taughtBefore ?? 0) + 1;
    const waited = harvested.oldestDays ?? 0;
    const waiting = waited >= 2 ? `, the oldest waiting ${waited} days` : "";
    const lead = repeats > 1 ? `TeamHandbook learned something you have now told Claude in ${repeats} sessions` : harvested.more > 0 ? `TeamHandbook has ${harvested.more + 1} skills waiting for your call${waiting}, newest first` : "TeamHandbook learned from your last session";
    lines.push(
      `${lead}: "${harvested.name}" (${harvested.kind}${score})${more} - keep it for yourself, add it to this project, or share it with the team: run /handbook:review.`
    );
  }
  if (pending > 0) {
    const noun = pending === 1 ? "candidate skill is" : "candidate skills are";
    const preview = pendingPreviews.length > 0 ? ` (${pendingPreviews.join("; ")})` : "";
    const repeated = inputs.pendingRepeats ?? 0;
    const nag = repeated > 0 ? ` - you have told Claude one of these in ${repeated} sessions now, and it is still waiting: run /handbook:review.` : " - run /handbook:review to approve or reject.";
    lines.push(`handbook: ${pending} ${noun} awaiting your review${preview}${nag}`);
  }
  if (foldedLessons > 0) {
    lines.push(
      `handbook: ${foldedLessons} older lesson ${foldedLessons === 1 ? "candidate is" : "candidates are"} folded; archive or show them in /handbook:review.`
    );
  }
  if (harvestedNothing && !harvested && pending === 0 && scoring === 0) {
    lines.push(
      "handbook: read your last session and found nothing worth keeping - that's a normal answer, not a failure. Run /handbook:learn if there was something it missed."
    );
  }
  if (scoring > 0 && pending === 0 && !harvested) {
    lines.push(
      `handbook: harvesting your last session${scoring === 1 ? "" : ` (${scoring} sessions)`} in the background - check /handbook:review shortly.`
    );
  }
  if (newSkills.length > 0) {
    const noun = newSkills.length === 1 ? "new skill" : "new skills";
    lines.push(
      `handbook: ${newSkills.length} ${noun} available since your last session here: ${newSkills.join(", ")}.`
    );
  }
  if (teamNudge) lines.push(teamNudge);
  if (digest) lines.push(digest);
  if (heartbeat && heartbeat.gateErrors > 0) {
    lines.push(
      `handbook: ${heartbeat.gateErrors} gate run${heartbeat.gateErrors === 1 ? "" : "s"} failed since your last session (claude may be logged out, missing, or rate-limited) - run /handbook:doctor.`
    );
  }
  if (!firstRun && lines.length === 0) {
    const parts = [];
    if (heartbeat && heartbeat.failures > 0) {
      parts.push(`${heartbeat.failures} failure${heartbeat.failures === 1 ? "" : "s"} watched`);
    }
    if (heartbeat && heartbeat.pairs > 0) {
      parts.push(`${heartbeat.pairs} error\u2192fix pair${heartbeat.pairs === 1 ? "" : "s"} captured`);
    }
    if (keptSkills > 0) parts.push(`${keptSkills} skill${keptSkills === 1 ? "" : "s"} kept so far`);
    lines.push(
      parts.length > 0 ? `handbook: on, nothing waiting for you - ${parts.join(", ")}.` : "handbook: on, nothing waiting for you yet."
    );
  }
  return lines.length > 0 ? lines.join("\n") : null;
}
function lastHarvestFoundNothing(home) {
  let raw;
  try {
    raw = readFileSync9(join10(home, "pipeline.log"), "utf8");
  } catch {
    return false;
  }
  const lines = raw.split("\n").filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const run = JSON.parse(lines[i]);
      if (!run?.harvest) continue;
      return !run.harvest.skipped && Array.isArray(run.written) && run.written.length === 0 && !run.errored;
    } catch {
    }
  }
  return false;
}
function oldestPendingDays(candidates, now = Date.now()) {
  const times = candidates.map((c) => Date.parse(c.createdAt)).filter((t) => Number.isFinite(t));
  if (times.length === 0) return 0;
  return Math.floor((now - Math.min(...times)) / 864e5);
}
function sessionStartNotice(cwd, home = handbookHome(), marketplacesRootDir) {
  const config = loadNotifyConfig(home);
  if (!config.sessionStart) return null;
  const queue = reviewQueue(home);
  const harvestedPending = queue.draftsFirst ? [] : queue.listed.filter((c) => c.origin === "harvest");
  const rest = queue.listed.filter((c) => c.origin !== "harvest");
  const top = harvestedPending.sort(
    (a, b) => (b.taughtBefore ?? 0) - (a.taughtBefore ?? 0) || (b.gate?.total ?? -1) - (a.gate?.total ?? -1)
  )[0];
  const harvested = top ? {
    name: top.slug,
    kind: top.kind ?? "skill",
    total: top.gate?.total ?? null,
    more: harvestedPending.length - 1,
    oldestDays: oldestPendingDays(harvestedPending),
    ...top.taughtBefore ? { taughtBefore: top.taughtBefore } : {}
  } : null;
  const pendingRepeats = Math.max(0, ...rest.map((c) => c.taughtBefore ? c.taughtBefore + 1 : 0));
  const pendingPreviews = rest.slice(0, 2).map((c) => `${c.slug} - ${c.description.slice(0, 60)}`);
  const watchedDirs = [join10(cwd, ".claude", "skills")];
  const teamDir = teamSkillsDir(home, marketplacesRootDir);
  if (teamDir) watchedDirs.push(teamDir);
  const newSkills = watchedDirs.flatMap((dir) => diffNewSkills(dir, listExistingSkills([dir]).map((s) => s.name), home)).sort();
  return buildSessionStartSummary({
    pending: rest.length,
    pendingPreviews,
    pendingRepeats,
    harvested,
    newSkills,
    firstRun: isFirstRun(home),
    heartbeat: config.heartbeat ? heartbeatDelta(home) : null,
    teamNudge: pendingTeamNudge(home),
    harvestedNothing: lastHarvestFoundNothing(home),
    digest: weeklyDigest(home),
    configBroken: configIsBroken(home),
    scoring: pendingHarvestCount(home),
    keptSkills: listCandidates(home, "approved").length,
    foldedLessons: foldedLessonsToAnnounce(home, queue.olderLessons.length)
  });
}

// src/lib/pipeline.ts
import { spawn } from "node:child_process";
import {
  appendFileSync as appendFileSync3,
  mkdirSync as mkdirSync7,
  readdirSync as readdirSync6,
  readFileSync as readFileSync10,
  renameSync as renameSync2,
  rmSync as rmSync3,
  statSync as statSync3,
  utimesSync,
  writeFileSync as writeFileSync4
} from "node:fs";
import { basename as basename5, join as join11 } from "node:path";
function pendingDir(home = handbookHome()) {
  return join11(home, "pending");
}
function enqueueHarvestJob(job, home = handbookHome()) {
  mkdirSync7(pendingDir(home), { recursive: true });
  const session = job.sessionId.replace(/[^A-Za-z0-9_-]/g, "_");
  const base = `${session}-${Date.now()}`;
  let file = join11(pendingDir(home), `${base}.json`);
  for (let i = 0; i < 50; i++) {
    try {
      writeFileSync4(file, JSON.stringify(job), { flag: "wx" });
      return file;
    } catch {
      file = join11(pendingDir(home), `${base}-x${i}.json`);
    }
  }
  return null;
}
var STALE_CLAIM_MS = 10 * 60 * 1e3;
function hasPendingHarvestJobs(home = handbookHome()) {
  const dir = pendingDir(home);
  let entries;
  try {
    entries = readdirSync6(dir);
  } catch {
    return false;
  }
  return entries.some((entry) => {
    if (entry.endsWith(".json")) return true;
    if (!/^.+\.json\.claimed-\d+$/.test(entry)) return false;
    try {
      return Date.now() - statSync3(join11(dir, entry)).mtimeMs > STALE_CLAIM_MS;
    } catch {
      return false;
    }
  });
}
function salvageOrphans(currentSessionId, home = handbookHome()) {
  const harvesting = gateAutoEnabled(home) && loadHarvestConfig(home).enabled && lessonHarvestEnabled(home);
  let enqueued = 0;
  for (const id of orphanedSessionIds(home)) {
    if (id === currentSessionId) continue;
    withSessionLock(
      id,
      () => {
        const state = loadSessionState(id, home);
        flushResolvedPairs(id, home);
        if (!harvesting || state.harvestedAt) return;
        if (!sessionHasSubstance(state)) return;
        const pairs = ledgerPairsForSession(id, home);
        const counts = ledgerFingerprintCounts(home);
        const recurrence = {};
        for (const pair of pairs) recurrence[pair.fingerprint] = counts.get(pair.fingerprint) ?? 1;
        enqueueHarvestJob(
          {
            sessionId: id,
            cwd: pairs[0]?.cwd ?? "",
            ...state.transcriptPath ? { transcriptPath: state.transcriptPath } : {},
            evidence: {
              pairs,
              ...state.activity ? { work: state.activity } : {},
              ...state.corrections?.length ? { corrections: state.corrections } : {},
              recurrence
            }
          },
          home
        );
        const fresh = loadSessionState(id, home);
        fresh.harvestedAt = (/* @__PURE__ */ new Date()).toISOString();
        const bytes = transcriptBytes(state.transcriptPath);
        if (bytes !== void 0) fresh.harvestedBytes = bytes;
        saveSessionState(fresh, home);
        enqueued += 1;
      },
      home
    );
  }
  return harvesting && (enqueued > 0 || hasPendingHarvestJobs(home));
}
function transcriptBytes(path) {
  if (!path) return void 0;
  try {
    return statSync3(path).size;
  } catch {
    return void 0;
  }
}
var LOG_ROTATE_BYTES = 512 * 1024;
var MARKER_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1e3;
function spawnPipelineRunner(runnerScript, spawnFn = spawn) {
  const child = spawnFn(process.execPath, [runnerScript], {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
}

// src/hooks/session-start.ts
async function main() {
  const input = parseHookInput(await readStdin());
  if (salvageOrphans(input?.session_id)) {
    spawnPipelineRunner(fileURLToPath(new URL("./run-pipeline.js", import.meta.url)));
  }
  retireDeadSessions();
  cleanupStaleSessionFiles();
  const notice = sessionStartNotice(input?.cwd ?? process.cwd());
  if (notice) console.log(notice);
}
main().then(
  () => process.exit(0),
  () => process.exit(0)
);
