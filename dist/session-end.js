// src/hooks/session-end.ts
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

// src/lib/pipeline.ts
import { spawn } from "node:child_process";
import {
  appendFileSync as appendFileSync2,
  mkdirSync as mkdirSync5,
  readdirSync as readdirSync3,
  readFileSync as readFileSync5,
  renameSync as renameSync2,
  rmSync as rmSync3,
  statSync as statSync2,
  utimesSync,
  writeFileSync as writeFileSync3
} from "node:fs";
import { basename as basename2, join as join5 } from "node:path";

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
  return traces(text, host)[0]?.class ?? null;
}

// src/lib/prompt-safety.ts
var LINE_TERMINATOR_CLASS = "\\n\\r\\u000B\\u000C\\u0085\\u2028\\u2029";
var LINE_TERMINATORS = new RegExp(`\\r\\n|[${LINE_TERMINATOR_CLASS}]`);
var LABEL_BREAKS = new RegExp(`[${LINE_TERMINATOR_CLASS}]+`, "g");

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
  for (const { name, re, reject } of SECRET_PATTERNS) {
    if (!reject) {
      if (re.test(text)) return name;
      continue;
    }
    for (const match of text.matchAll(GLOBAL_TWIN.get(name))) {
      if (!reject(match[0])) return name;
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

// src/lib/signals.ts
import { existsSync as existsSync2, appendFileSync, mkdirSync as mkdirSync4, readFileSync as readFileSync4 } from "node:fs";
import { join as join4 } from "node:path";

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

// src/lib/signals.ts
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
  return join4(home, "signals.jsonl");
}
function ledgerFingerprintCounts(home = handbookHome()) {
  const counts = /* @__PURE__ */ new Map();
  let raw;
  try {
    raw = readFileSync4(signalsFile(home), "utf8");
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
  mkdirSync4(home, { recursive: true });
  const lines = clean.map((s) => JSON.stringify(s)).join("\n") + "\n";
  appendFileSync(signalsFile(home), lines);
}
function signalFromPair(pair, sessionId, ts, fileExists = existsSync2) {
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
function flushSessionEnd(sessionId, home = handbookHome(), ts = (/* @__PURE__ */ new Date()).toISOString(), fileExists = existsSync2) {
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
    raw = readFileSync4(signalsFile(home), "utf8");
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
    raw = readFileSync4(signalsFile(home), "utf8");
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

// src/lib/pipeline.ts
function pendingDir(home = handbookHome()) {
  return join5(home, "pending");
}
function enqueueHarvestJob(job, home = handbookHome()) {
  mkdirSync5(pendingDir(home), { recursive: true });
  const session = job.sessionId.replace(/[^A-Za-z0-9_-]/g, "_");
  const base = `${session}-${Date.now()}`;
  let file = join5(pendingDir(home), `${base}.json`);
  for (let i = 0; i < 50; i++) {
    try {
      writeFileSync3(file, JSON.stringify(job), { flag: "wx" });
      return file;
    } catch {
      file = join5(pendingDir(home), `${base}-x${i}.json`);
    }
  }
  return null;
}
var STALE_CLAIM_MS = 10 * 60 * 1e3;
var LOG_ROTATE_BYTES = 512 * 1024;
var MARKER_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1e3;
function spawnPipelineRunner(runnerScript, spawnFn = spawn) {
  const child = spawnFn(process.execPath, [runnerScript], {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
}

// src/lib/session-workflow.ts
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync as appendFileSync3, mkdirSync as mkdirSync6, readFileSync as readFileSync6, realpathSync, statSync as statSync3, writeFileSync as writeFileSync4 } from "node:fs";
import { basename as basename3, dirname as dirname2, join as join6, relative, resolve, sep } from "node:path";

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
  return join6(home, "workflows.jsonl");
}
function minedRecordFile(home = handbookHome()) {
  return join6(home, "mined-workflows.json");
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
    const dotgit = join6(at, ".git");
    try {
      const stat = statSync3(dotgit);
      if (stat.isDirectory()) return { repo: realpathSync(at), checkout: at, gitdir: dotgit };
      if (stat.isFile()) {
        const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync6(dotgit, "utf8"));
        if (pointer) {
          const gitdir = resolve(at, pointer[1].trim());
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
      const head = readFileSync6(join6(found.gitdir, "HEAD"), "utf8");
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
function finishWorkflowSession(input, state, home = handbookHome(), deps = {}) {
  if (!input.session_id || !sessionDetectEnabled(home)) return null;
  if (isAutonomous(deps.entrypoint ?? process.env.CLAUDE_CODE_ENTRYPOINT)) {
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
  appendFileSync3(workflowsFile(home), `${serialized}
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
  const file = join6(home, "workflow-salt");
  try {
    return Buffer.from(readFileSync6(file, "utf8").trim(), "hex");
  } catch {
    mkdirSync6(home, { recursive: true });
    try {
      writeFileSync4(file, randomBytes(16).toString("hex"), { flag: "wx", mode: 384 });
    } catch {
    }
    return Buffer.from(readFileSync6(file, "utf8").trim(), "hex");
  }
}
function saltedHash(salt, kind, value) {
  return createHash("sha256").update(salt).update(kind).update("\0").update(value).digest("hex").slice(0, 16);
}

// src/hooks/session-end.ts
async function main() {
  const input = parseHookInput(await readStdin());
  if (!input?.session_id) return;
  const state = loadSessionState(input.session_id);
  const substance = sessionHasSubstance(state);
  const alreadyHarvested = !!state.harvestedAt;
  const transcriptPath = state.transcriptPath ?? input.transcript_path;
  finishWorkflowSession(input, state);
  flushSessionEnd(input.session_id);
  if (!substance || alreadyHarvested) return;
  if (!gateAutoEnabled() || !loadHarvestConfig().enabled || !lessonHarvestEnabled()) return;
  const pairs = ledgerPairsForSession(input.session_id);
  const counts = ledgerFingerprintCounts();
  const recurrence = {};
  for (const pair of pairs) recurrence[pair.fingerprint] = counts.get(pair.fingerprint) ?? 1;
  enqueueHarvestJob({
    sessionId: input.session_id,
    cwd: input.cwd ?? pairs[0]?.cwd ?? "",
    ...transcriptPath ? { transcriptPath } : {},
    evidence: {
      pairs,
      ...state.activity ? { work: state.activity } : {},
      ...state.corrections?.length ? { corrections: state.corrections } : {},
      recurrence
    }
  });
  spawnPipelineRunner(fileURLToPath(new URL("./run-pipeline.js", import.meta.url)));
}
main().then(
  () => process.exit(0),
  () => process.exit(0)
);
