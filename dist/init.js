// src/lib/config.ts
import { existsSync, readFileSync as readFileSync2 } from "node:fs";
import { join as join2 } from "node:path";

// src/lib/session-state.ts
import { homedir, tmpdir } from "node:os";
import { dirname as dirname2, join } from "node:path";
import { closeSync, mkdirSync as mkdirSync2, mkdtempSync, openSync, readFileSync, readdirSync, rmSync as rmSync2, statSync } from "node:fs";

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
function handbookHome() {
  return process.env.TEAMHANDBOOK_HOME ?? join(homedir(), ".teamhandbook");
}
function handbookWorkdir(prefix, home = handbookHome()) {
  try {
    const root = join(home, "tmp");
    mkdirSync2(root, { recursive: true });
    return mkdtempSync(join(root, prefix));
  } catch {
    return mkdtempSync(join(tmpdir(), prefix));
  }
}
function removeWorkdir(dir) {
  try {
    rmSync2(dir, { recursive: true, force: true });
    return void 0;
  } catch {
    return dir;
  }
}
function inWorkdir(prefix, home, work) {
  const dir = handbookWorkdir(prefix, home);
  let result;
  try {
    result = work(dir);
  } catch (err) {
    removeWorkdir(dir);
    throw err;
  }
  const leftover = removeWorkdir(dir);
  return leftover ? { ...result, leftoverWorkdir: leftover } : result;
}
var SLEEPER = new Int32Array(new SharedArrayBuffer(4));
var SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1e3;
var SESSION_ORPHAN_MS = 3 * 60 * 60 * 1e3;

// src/lib/config.ts
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

// src/lib/init.ts
import { execFileSync as execFileSync4, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync as existsSync2, mkdirSync as mkdirSync3, readFileSync as readFileSync5, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname as dirname4, join as join5 } from "node:path";

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

// src/lib/score.ts
var execFileAsync = promisify(execFile);

// src/lib/distill.ts
function normalizeRemoteUrl(raw) {
  let s = raw.trim();
  if (!s) return null;
  if (/[\x00-\x1f\x7f]/.test(s)) return null;
  const hadProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  s = s.replace(/^[^@/]+@/, "");
  if (!hadProtocol) {
    const colon = s.indexOf(":");
    const slash2 = s.indexOf("/");
    if (colon > 0 && (slash2 === -1 || colon < slash2)) {
      s = s.slice(0, colon) + "/" + s.slice(colon + 1);
    }
  }
  s = s.replace(/\.git$/i, "").replace(/\/+$/, "");
  const slash = s.indexOf("/");
  if (slash <= 0 || slash === s.length - 1) return null;
  return s.slice(0, slash).toLowerCase() + s.slice(slash);
}
function slugifySkillName(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/g, "");
  return slug || null;
}
function openingsOf(literal) {
  return [...literal].reduceRight((rest, ch) => `(?:${ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${rest})?`, "");
}
var CUT_SCOPE_SENTENCE = new RegExp(
  `\\s*Applies ONLY in the(?: \\S*${openingsOf(" repository - do not use it elsewhere.")})?$`
);
function uniqueSlug(baseSlug, taken) {
  let slug = baseSlug;
  for (let i = 2; taken(slug); i++) slug = `${baseSlug}-${i}`;
  return slug;
}

// src/lib/forge.ts
import { execFileSync as execFileSync2 } from "node:child_process";
function hostFromUrl(url) {
  const normalized = normalizeRemoteUrl(url);
  if (!normalized) return null;
  return normalized.slice(0, normalized.indexOf("/"));
}
var FORGE_TIMEOUT_MS = 6e4;
var FORGE_CHECK_TIMEOUT_MS = 5e3;
function runForge(tool, args, cwd, timeoutMs = FORGE_TIMEOUT_MS) {
  return execFileSync2(tool, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env: nonInteractiveEnv(),
    timeout: timeoutMs
  });
}
function manualPrUrl(repoUrl, branch) {
  const normalized = normalizeRemoteUrl(repoUrl);
  if (!normalized) return null;
  const host = hostFromUrl(repoUrl);
  if (host && host.includes("github")) {
    return `https://${normalized}/pull/new/${branch}`;
  }
  return `https://${normalized}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encodeURIComponent(branch)}`;
}
function extractUrl(output) {
  return output.match(/https?:\/\/\S+/)?.[0] ?? null;
}
function forgeTool(repoUrl) {
  const host = hostFromUrl(repoUrl);
  return host && host.includes("github") ? "gh" : "glab";
}
function forgeSignInProblem(repoUrl, repoDir, forge) {
  const tool = forgeTool(repoUrl);
  const host = hostFromUrl(repoUrl);
  const attempts = host ? [["auth", "status", "--hostname", host], ["auth", "status"]] : [["auth", "status"]];
  let last = "";
  for (const args of attempts) {
    try {
      forge(tool, args, repoDir, FORGE_CHECK_TIMEOUT_MS);
      return null;
    } catch (err) {
      const e = err;
      if (e?.code === "ENOENT") return `the ${tool} CLI is not installed`;
      if (e?.code === "ETIMEDOUT") return "the forge check timed out";
      const stderr = typeof e?.stderr === "string" ? e.stderr.trim() : "";
      last = (stderr ? stderr.split("\n").at(-1) : String(e?.message ?? err)).slice(0, 160);
      if (!/unknown (flag|shorthand)/i.test(stderr)) break;
    }
  }
  return `${tool} could not confirm you are signed in${last ? `: ${last}` : ""}`;
}
var SELF_ASSIGNEE = "@me";
function webAddress(repoUrl) {
  return normalizeRemoteUrl(repoUrl)?.replace(/^([^/:]+):\d+\//, "$1/") ?? null;
}
function openedRequestUrl(output, repoUrl) {
  const web = webAddress(repoUrl);
  const at = web ? web.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : "\\S+?";
  const kind = !web ? "(?:-\\/merge_requests|pull)" : forgeTool(repoUrl) === "gh" ? "pull" : "-\\/merge_requests";
  return output.match(new RegExp(`https?:\\/\\/${at}\\/${kind}\\/\\d+(?=[\\s?#]|$)`, "i"))?.[0] ?? null;
}
function assignmentFlags(assignment) {
  return [
    ...assignment.reviewers.length ? [`--reviewer=${assignment.reviewers.join(",")}`] : [],
    ...assignment.labels.length ? [`--label=${assignment.labels.join(",")}`] : []
  ];
}
function forgeFailure(tool, err) {
  const e = err;
  if (e?.code === "ENOENT") return `the ${tool} CLI is not installed`;
  const lines = (typeof e?.stderr === "string" ? e.stderr : "").split("\n").map((line) => line.trim()).filter(Boolean);
  const said = lines.filter((line) => !/^https?:\/\/\S+$/.test(line)).at(-1) ?? lines.at(-1);
  return (said ?? String(e?.message ?? err)).slice(0, 160);
}
function outputOf(err) {
  const e = err;
  return `${typeof e?.stdout === "string" ? e.stdout : ""}
${typeof e?.stderr === "string" ? e.stderr : ""}`;
}
function existingRequest(tool, repoUrl, err) {
  const output = outputOf(err);
  if (!/(?:pull|merge) request[^\n]*already exists/i.test(output)) return null;
  const web = webAddress(repoUrl);
  const number = tool === "glab" ? output.match(/!(\d+)/)?.[1] : void 0;
  const url = openedRequestUrl(output, repoUrl) ?? (web && number ? `https://${web}/-/merge_requests/${number}` : null);
  return url ? { url, existing: true } : { url: null, existing: true, error: `a request for this branch is already open (${forgeFailure(tool, err)})` };
}
function openPr(repoUrl, branch, title, body, repoDir, forge, assignment = { reviewers: [], labels: [] }, assignee = SELF_ASSIGNEE) {
  const tool = forgeTool(repoUrl);
  const create = (extra) => extractUrl(
    tool === "gh" ? forge("gh", ["pr", "create", "--head", branch, "--title", title, "--body", body, ...extra], repoDir) : forge(
      "glab",
      ["mr", "create", "--source-branch", branch, "--title", title, "--description", body, ...extra, "--yes"],
      repoDir
    )
  );
  const listed = assignmentFlags(assignment);
  const flags = [...assignee.trim() ? [`--assignee=${assignee.trim()}`] : [], ...listed];
  try {
    return { url: create(flags) };
  } catch (err) {
    const existing = existingRequest(tool, repoUrl, err);
    if (existing) return existing;
    const reason = forgeFailure(tool, err);
    const code = err?.code;
    if (!flags.length || code === "ENOENT" || code === "ETIMEDOUT") return { url: null, error: reason };
    const opened = openedRequestUrl(outputOf(err), repoUrl);
    if (opened) return { url: opened, unassigned: reason };
    try {
      return { url: create([]), unassigned: reason };
    } catch (retryErr) {
      const existing2 = existingRequest(tool, repoUrl, retryErr);
      if (existing2) return { ...existing2, ...listed.length ? { unassigned: reason } : {} };
      const error = forgeFailure(tool, retryErr);
      return { url: null, error, ...listed.length && error !== reason ? { unassigned: reason } : {} };
    }
  }
}
function noRequestPossible(reason) {
  return `no merge request can be opened from this machine (${reason})`;
}
function forgeNotice(repoUrl, problem) {
  const byPush = forgeTool(repoUrl) === "glab" && hostFromUrl(repoUrl) !== null;
  return (byPush ? `This machine cannot open the merge request with glab (${problem}): the branch will be pushed asking GitLab to open the request itself, and a link printed if it does not.` : `This machine cannot open the merge request (${problem}): the branch will be pushed and a link printed.`) + ' For the same reason "you decide" is not an answer to the commit message here: the wording is asked of you.';
}

// src/lib/branch.ts
import { readFileSync as readFileSync3 } from "node:fs";
import { join as join3 } from "node:path";
var TICKET_KEY = /^[A-Z][A-Z0-9]+-\d+/;
function ticketKey(name) {
  return name?.trim().match(TICKET_KEY)?.[0];
}
function currentBranch(cwd, git) {
  try {
    return String(git(["symbolic-ref", "--short", "-q", "HEAD"], cwd) ?? "").trim() || void 0;
  } catch {
    return void 0;
  }
}
function branchHints(cwd, git, previous) {
  return { current: currentBranch(cwd, git), ...previous ? { previous } : {} };
}
function proposeBranch(slug, team, example, hints, taken) {
  const free = (name) => uniqueSlug(name, (candidate) => taken.has(candidate));
  const key = ticketKey(hints.current) ?? ticketKey(hints.previous);
  if (key) return { branch: free(`${key}-${slug}`) };
  const prefix = team.branchPrefix?.trim();
  if (prefix) return { branch: free(`${prefix}${slug}`) };
  const commitKey = ticketKey(team.commitPrefix);
  if (commitKey) return { branch: free(`${commitKey}-${slug}`) };
  if (example) {
    if (ticketKey(example)) return { template: `<TICKET>-${slug}`, example };
    const slash = example.lastIndexOf("/");
    if (slash > 0) return { branch: free(`${example.slice(0, slash + 1)}${slug}`) };
  }
  return { branch: free(slug) };
}
var BRANCH_NAME_MAX = 200;
function branchNameProblem(name, git, cwd) {
  if (!name.trim() || name !== name.trim()) return "it is empty or starts or ends with a space";
  if (name.length > BRANCH_NAME_MAX) return `it is longer than ${BRANCH_NAME_MAX} characters`;
  if (/\p{C}/u.test(name)) return "it carries a control character";
  const trace = branchTrace(name);
  if (trace) return trace;
  if (name.startsWith("-") || name.includes("@{")) return "git does not accept it as a branch name";
  try {
    git(["check-ref-format", "--branch", name], cwd);
  } catch {
    return "git does not accept it as a branch name";
  }
  return null;
}
function branchTrace(name) {
  const identity = detectIdentity(name);
  if (identity) return `it carries a trace of this machine (${identity}), and every teammate reads the branch list`;
  const secret = detectSecret(name);
  if (secret) return `it carries what looks like a ${secret}, and every teammate reads the branch list`;
  return null;
}
var BRANCH_EXAMPLE_MAX = 100;
function branchExampleProblem(value) {
  if (value.length > BRANCH_EXAMPLE_MAX) return `longer than ${BRANCH_EXAMPLE_MAX} characters`;
  if (/\p{C}/u.test(value)) return "carrying a control character";
  const identity = detectIdentity(value);
  if (identity) return `carrying a trace of a machine (${identity})`;
  const secret = detectSecret(value);
  if (secret) return `carrying what looks like a ${secret}`;
  return null;
}
function readTeamBranchExample(repoDir) {
  let raw;
  try {
    raw = JSON.parse(readFileSync3(join3(repoDir, TEAM_PREFIX_FILE), "utf8"))?.branchExample;
  } catch {
    return {};
  }
  if (typeof raw !== "string" || !raw.trim()) return {};
  const value = raw.trim();
  const problem = branchExampleProblem(value);
  return problem ? { problem } : { example: value };
}
var ASSIGNMENT_MAX_ENTRIES = 20;
var ASSIGNMENT_ENTRY_MAX = 100;
var USERNAME = /^@?[A-Za-z0-9._-]+$/;
var LABEL = /^[\p{L}\p{N}._:/ -]+$/u;
function assignmentEntryProblem(kind, value) {
  if (typeof value !== "string" || !value.trim()) return "not a name";
  const entry = value.trim();
  if (entry.length > ASSIGNMENT_ENTRY_MAX) return `longer than ${ASSIGNMENT_ENTRY_MAX} characters`;
  if (/\p{C}/u.test(entry)) return "carrying a control character";
  const identity = kind === "labels" ? detectIdentity(entry) : null;
  if (identity) return `carrying a trace of a machine (${identity})`;
  const secret = detectSecret(entry);
  if (secret) return `carrying what looks like a ${secret}`;
  if (kind === "reviewers" && !USERNAME.test(entry)) return "not a username";
  if (kind === "labels" && !LABEL.test(entry)) return "not a label name";
  return null;
}
function assignmentRecordProblem(recorded) {
  for (const kind of ["reviewers", "labels"]) {
    const values = recorded[kind];
    if (values === void 0) continue;
    if (values.length > ASSIGNMENT_MAX_ENTRIES) {
      return `${values.length} ${kind} cannot be recorded: more than ${ASSIGNMENT_MAX_ENTRIES}. Nothing was changed.`;
    }
    for (const [at, value] of values.entries()) {
      const problem = assignmentEntryProblem(kind, value);
      if (problem) return `${kind} entry ${at + 1} cannot be recorded: ${problem}. Nothing was changed.`;
    }
  }
  return null;
}
function readTeamFile(repoDir) {
  try {
    const raw = JSON.parse(readFileSync3(join3(repoDir, TEAM_PREFIX_FILE), "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}
function readRecordedAssignment(repoDir) {
  const raw = readTeamFile(repoDir);
  const recorded = {};
  const unreadable = [];
  for (const kind of ["reviewers", "labels"]) {
    const value = raw[kind];
    if (value === void 0) continue;
    if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) recorded[kind] = value;
    else unreadable.push(kind);
  }
  return { recorded, unreadable };
}
function readTeamAssignment(repoDir) {
  const raw = readTeamFile(repoDir);
  const assignment = { reviewers: [], labels: [] };
  const said = [];
  for (const kind of ["reviewers", "labels"]) {
    const value = raw[kind];
    if (value === void 0) continue;
    if (!Array.isArray(value)) {
      said.push(`${kind} is not a list`);
      continue;
    }
    if (value.length > ASSIGNMENT_MAX_ENTRIES) {
      said.push(`${kind} lists ${value.length} entries, more than ${ASSIGNMENT_MAX_ENTRIES}, so none of them is used`);
      continue;
    }
    const reasons = /* @__PURE__ */ new Map();
    for (const entry of value) {
      const problem = assignmentEntryProblem(kind, entry);
      if (problem) reasons.set(problem, (reasons.get(problem) ?? 0) + 1);
      else assignment[kind].push(entry.trim().replace(/^@/, ""));
    }
    if (reasons.size) said.push(`${kind}: ${[...reasons].map(([reason, count]) => `${count} ${reason}`).join(", ")}`);
  }
  return {
    assignment,
    dropped: said.length ? `${TEAM_PREFIX_FILE} holds values this request left out (${said.join("; ")}).` : null,
    reviewersRecorded: raw.reviewers !== void 0,
    labelsRecorded: raw.labels !== void 0
  };
}
function assignmentList(assignment) {
  const parts = [
    ...assignment.reviewers.length ? [`reviewers ${assignment.reviewers.map((name) => `@${name}`).join(", ")}`] : [],
    ...assignment.labels.length ? [`labels ${assignment.labels.join(", ")}`] : []
  ];
  return parts.length ? parts.join("; ") : null;
}
function requestNotes(dropped, assignment, pr, team) {
  const list = assignmentList(assignment);
  const unrecorded = [...team.reviewersRecorded ? [] : ["reviewers"], ...team.labelsRecorded ? [] : ["labels"]];
  const skipped = "GitLab does not apply the project's merge request template to a request opened through its API, which is how glab opens one: ";
  const template = unrecorded.length === 2 ? skipped + 'if that template sets reviewers or labels, record them with /handbook:init --upgrade --reviewers <a,b> --labels <x>, and if it sets none, record that with /handbook:init --upgrade --reviewers "" --labels "".' : unrecorded.length === 1 ? skipped + `if that template sets ${unrecorded[0]}, record them with /handbook:init --upgrade --${unrecorded[0]} ${unrecorded[0] === "reviewers" ? "<a,b>" : "<x>"}, and if it sets none, record that with /handbook:init --upgrade --${unrecorded[0]} "".` : null;
  const host = hostFromUrl(team.repoUrl) ?? "";
  const assignYourself = host.includes("github") ? "assign yourself on it" : host.includes("gitlab") ? "assign yourself on it if the project's template does not" : null;
  const byHand = [...assignYourself ? [assignYourself] : [], ...list ? [`add ${list}`] : []].join(", and ");
  const asked = [...list ? [list] : [], "assignee you"].join("; ");
  const refused = pr.unassigned ? `the forge refused it (${pr.unassigned})` : null;
  const correct = `if a name in ${TEAM_PREFIX_FILE} is wrong, correct it with /handbook:init --upgrade --reviewers or --labels.`;
  const opened = pr.url && !pr.existing;
  const fix = list ? `, and ${correct}` : ".";
  return [
    ...pr.existing ? ["The forge reported a request already open for this branch, so none was opened: the push is on that one."] : [],
    ...dropped ? [dropped] : [],
    ...refused && opened ? [`The request was opened without its assignment (${asked}): ${refused}. Set it on the request by hand${fix}`] : [],
    ...refused && pr.existing ? [`The assignment (${asked}) did not go: ${refused}. Set it on the open request if it lacks it${fix}`] : [],
    ...refused && !pr.url && !pr.existing ? [`The assignment (${asked}) did not go: ${refused}.${list ? ` Before it is asked for again, ${correct}` : ""}`] : [],
    ...list && pr.existing && !refused ? [`This run did not change who reviews it: add ${list} on it if it lacks them.`] : [],
    ...opened && forgeTool(team.repoUrl) === "glab" && template ? [template] : [],
    ...byHand && !pr.url && !pr.existing ? [`When you open the request, ${byHand}.`] : []
  ];
}
function requestNoteLines(notes) {
  return notes?.length ? ["", ...notes] : [];
}
function remoteHeads(git, repoDir) {
  try {
    const heads = /* @__PURE__ */ new Map();
    for (const line of String(git(["ls-remote", "--heads", "origin"], repoDir) ?? "").split("\n")) {
      const [sha, ref] = line.split("	");
      if (sha && ref?.startsWith("refs/heads/")) heads.set(ref.slice("refs/heads/".length), sha.trim());
    }
    return heads;
  } catch {
    return /* @__PURE__ */ new Map();
  }
}
function versionParts(version) {
  const parts = version.split(".").map(Number);
  return parts.length === 3 && parts.every((n) => Number.isInteger(n) && n >= 0) ? parts : null;
}
function compareVersions(a, b) {
  const x = versionParts(a);
  const y = versionParts(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}
function readPluginVersion(repoDir) {
  try {
    const version = JSON.parse(readFileSync3(join3(repoDir, ".claude-plugin", "plugin.json"), "utf8"))?.version;
    return typeof version === "string" ? version : void 0;
  } catch {
    return void 0;
  }
}
function versionedByCommit(repoDir) {
  try {
    const plugin = JSON.parse(readFileSync3(join3(repoDir, ".claude-plugin", "plugin.json"), "utf8"));
    return typeof plugin === "object" && plugin !== null && !Array.isArray(plugin) && plugin.version === void 0;
  } catch {
    return false;
  }
}
function openVersionClaims(git, repoDir, heads, current) {
  if (!current || !versionParts(current)) return [];
  try {
    const tip = String(git(["rev-parse", "HEAD"], repoDir) ?? "").trim();
    const others = [...heads].filter(([, sha]) => sha !== tip).map(([branch]) => branch);
    if (!others.length) return [];
    git(
      ["fetch", "--quiet", "--depth", "1", "origin", ...others.map((b) => `+refs/heads/${b}:refs/remotes/origin/${b}`)],
      repoDir
    );
    const claims = [];
    for (const branch of others) {
      let version;
      try {
        const manifest = git(["show", `refs/remotes/origin/${branch}:.claude-plugin/plugin.json`], repoDir);
        version = JSON.parse(String(manifest ?? ""))?.version;
      } catch {
        continue;
      }
      if (typeof version === "string" && (compareVersions(version, current) ?? 0) > 0) claims.push({ branch, version });
    }
    return claims;
  } catch {
    return [];
  }
}
function highest(versions) {
  return versions.reduce(
    (top, v) => top === void 0 || (compareVersions(v, top) ?? 0) > 0 ? v : top,
    void 0
  );
}
function versionPast(current, claims) {
  const top = versionParts(highest([current, ...claims.map((c) => c.version)]));
  return [top[0], top[1], top[2] + 1].join(".");
}
function claimMessage(claims, current, rerun) {
  const named = claims.map((c) => `"${c.branch}" (${c.version})`).join(", ");
  return `the team repository has ${claims.length === 1 ? "a branch" : "branches"} that ${claims.length === 1 ? "is" : "are"} not merged and already raise${claims.length === 1 ? "s" : ""} the plugin past ${current}: ${named}. If this request raises it to the same number and both are merged, the second one reaches nobody - the version line merges as identical and no teammate's copy refreshes for it. Either send this one as ${versionPast(current, claims)}, past ${claims.length === 1 ? "it" : "them"} - ${rerun} with \`--version-after-open\` - or stop here and merge or close ${claims.length === 1 ? "that branch" : "those branches"} first. Nothing was committed and nothing was pushed.`;
}
function shownBranch(proposal) {
  return "branch" in proposal ? `\`${proposal.branch}\`` : `\`${proposal.template}\` (branches here look like \`${proposal.example}\`: which ticket is this?)`;
}
function pushQuestion(branch, message) {
  if (branch && message !== null) {
    return `Branch ${shownBranch(branch)} \xB7 message \`${message}\` - confirm or change either.`;
  }
  if (branch) return `Branch ${shownBranch(branch)} - confirm or change it.`;
  return `Message \`${message}\` - confirm or change it.`;
}
function previewPush(git, forge, repoDir, team, slug, hints = {}) {
  const heads = remoteHeads(git, repoDir);
  const taken = new Set(heads.keys());
  const current = readPluginVersion(repoDir);
  return {
    taken,
    proposal: proposeBranch(slug, team, readTeamBranchExample(repoDir).example ?? team.branchExample, hints, taken),
    forgeProblem: forgeSignInProblem(team.repoUrl, repoDir, forge),
    ...current ? { current } : {},
    claims: openVersionClaims(git, repoDir, heads, current)
  };
}
function versionClaimProblem(preview, rerun) {
  return preview.claims.length && preview.current ? claimMessage(preview.claims, preview.current, rerun) : null;
}
function branchAnswer(choice, preview, git, repoDir, rerun) {
  if (choice.branch === void 0) {
    const unusable = "branch" in preview.proposal ? branchNameProblem(preview.proposal.branch, git, repoDir) : null;
    return unusable ? {
      shown: null,
      said: `branch name required: the branch this would propose cannot be used (${unusable}), so ask the user for one and ${rerun} with \`--branch <name>\`.`
    } : {
      shown: preview.proposal,
      said: `branch name required: nothing is pushed under a name the user has not seen. Show it to them with the message, then ${rerun} with \`--branch <name>\`: the one above if they confirmed it, or the one they gave.`
    };
  }
  const problem = branchNameProblem(choice.branch, git, repoDir);
  if (problem && branchTrace(choice.branch)) {
    return {
      shown: null,
      said: `the branch given cannot be used: ${problem}. Ask for another and ${rerun} with \`--branch <name>\`.`
    };
  }
  if (problem) {
    return {
      shown: { branch: choice.branch },
      said: `"${choice.branch}" cannot be the branch: ${problem}. Ask for another and ${rerun} with \`--branch <name>\`.`
    };
  }
  if (preview.taken.has(choice.branch)) {
    return {
      shown: { branch: choice.branch },
      said: `the team repository already has a branch named "${choice.branch}", which may carry an open request of its own, so nothing was pushed over it and no other name was picked for you. Ask for another name and ${rerun} with \`--branch <name>\`, or merge or delete that branch first.`
    };
  }
  return { shown: null, said: null };
}
function decidePush(input) {
  const { git, repoDir, team, choice, message, proposedMessage, rerun } = input;
  const preview = previewPush(git, input.forge, repoDir, team, input.slug, choice.hints);
  const { forgeProblem } = preview;
  const decided = decideCommitSubject(
    message,
    proposedMessage,
    input.messagePrefix,
    rerun,
    forgeProblem ? noRequestPossible(forgeProblem) : void 0
  );
  const { shown: branchShown, said: branchSaid } = branchAnswer(choice, preview, git, repoDir, rerun);
  const claimSaid = choice.versionAfterOpen ? null : versionClaimProblem(preview, rerun);
  if (!("error" in decided) && !branchSaid && !claimSaid) {
    return { ok: true, branch: choice.branch, subject: decided.subject, claims: preview.claims, forgeProblem };
  }
  const asksMessage = "error" in decided && message.message === void 0 && message.delegated === void 0 && commitMessageProblem(proposedMessage) === null;
  const asked = branchShown || asksMessage ? [pushQuestion(branchShown, asksMessage ? proposedMessage : null)] : [];
  return {
    ok: false,
    error: [
      ...asked,
      ..."error" in decided ? [decided.error] : [],
      ...branchSaid ? [branchSaid] : [],
      ...claimSaid ? [claimSaid] : [],
      // On the screen that asks, before anything is pushed: the user learns how the request
      // will reach the forge while they can still do something about it, not after the push.
      ...asked.length && forgeProblem ? [forgeNotice(team.repoUrl, forgeProblem)] : []
    ].join("\n"),
    ...branchShown && "branch" in branchShown ? { proposedBranch: branchShown.branch } : {},
    proposedMessage,
    proposalHash: proposalFingerprint(proposedMessage)
  };
}
function requestPushOptions(repoUrl, forgeProblem, title, labels = []) {
  if (!forgeProblem || forgeTool(repoUrl) !== "glab" || !hostFromUrl(repoUrl)) return [];
  return [
    "-o",
    "merge_request.create",
    "-o",
    `merge_request.title=${title}`,
    "-o",
    "merge_request.remove_source_branch",
    ...labels.flatMap((label) => ["-o", `merge_request.label=${label}`])
  ];
}
function pushBranch(git, repoDir, ref, options = []) {
  const push = (extra) => String(git(["push", ...extra, "origin", ref], repoDir) ?? "");
  if (!options.length) return { output: push([]), optionsSent: false };
  try {
    return { output: push(options), optionsSent: true };
  } catch (err) {
    if (!/does not support push options/i.test(String(err instanceof Error ? err.message : err))) throw err;
    return { output: push([]), optionsSent: false };
  }
}
function openRequest(repoUrl, branch, title, body, repoDir, forge, forgeProblem, pushed) {
  const manualUrl = manualPrUrl(repoUrl, branch) ?? void 0;
  const { assignment, dropped, reviewersRecorded, labelsRecorded } = readTeamAssignment(repoDir);
  const team = { repoUrl, reviewersRecorded, labelsRecorded };
  const withNotes = (outcome, notes) => notes.length ? { ...outcome, requestNotes: notes } : outcome;
  if (!forgeProblem) {
    const pr = openPr(repoUrl, branch, title, body, repoDir, forge, assignment);
    const notes = requestNotes(dropped, assignment, pr, team);
    return withNotes(
      pr.url ? { prUrl: pr.url } : { ...pr.existing ? {} : { manualUrl }, ...pr.error ? { prError: pr.error } : {} },
      notes
    );
  }
  const url = pushed.optionsSent ? openedRequestUrl(pushed.output, repoUrl) : null;
  if (url) {
    const reviewers = assignmentList({ reviewers: assignment.reviewers, labels: [] });
    const notes = [
      ...dropped ? [dropped] : [],
      `GitLab opened the request from the push and assigned it to the account that pushed, unless the project's default template assigns someone else; if a request for this branch was already open, GitLab updated that one instead, set its title from this push and changed no assignee${reviewers ? `; no push option sets reviewers, so add ${reviewers} by hand` : ""}.`
    ];
    return withNotes({ prUrl: url, unattachedDescription: body }, notes);
  }
  const prError = pushed.optionsSent ? `${forgeProblem}, and GitLab did not report opening a request for the push` : forgeProblem;
  return withNotes({ manualUrl, prError }, requestNotes(dropped, assignment, { url: null }, team));
}
function pushFailure(repoUrl, branch, subject, err, rerun, commitPrefixFix) {
  const fix = [
    "Nothing reached the repository.",
    pushQuestion({ branch }, subject),
    `Ask for a name the rule accepts, then ${rerun} with \`--branch <name>\`.`
  ].join("\n");
  const error = pushFailureReason(repoUrl, branch, err, fix, commitPrefixFix);
  return pushRuleSubject(String(err instanceof Error ? err.message : err)) === "branch-name" ? { error, proposedBranch: branch, proposedMessage: subject } : { error };
}
function unattachedDescriptionLines(description) {
  if (!description) return [];
  return [
    "",
    "GitLab reported the request for the push, and a push cannot carry its description. Paste this into it:",
    "",
    ...description.split("\n").map((line) => line ? `    ${line}` : "")
  ];
}

// src/lib/git-errors.ts
import { execFileSync as execFileSync3 } from "node:child_process";
function probeCredentials() {
  const run = (cmd, args) => execFileSync3(cmd, args, { encoding: "utf8", timeout: 5e3, stdio: ["ignore", "pipe", "pipe"], env: nonInteractiveEnv() });
  try {
    run("gh", ["--version"]);
  } catch {
    return { ghInstalled: false, ghAuthenticated: false };
  }
  try {
    run("gh", ["auth", "status"]);
    return { ghInstalled: true, ghAuthenticated: true };
  } catch {
    return { ghInstalled: true, ghAuthenticated: false };
  }
}
function credentialAdvice(url, creds) {
  if (!url.startsWith("http")) {
    return "This is an SSH URL, so it needs a key this forge recognises: `ssh-keygen -t ed25519`, then add ~/.ssh/id_ed25519.pub to your account's SSH keys.";
  }
  if (!creds.ghInstalled) {
    return "Install the GitHub CLI and sign in once: `brew install gh` then `gh auth login`. Run both in your own terminal, not here - the login is interactive.";
  }
  if (!creds.ghAuthenticated) {
    return "The GitHub CLI is installed but not signed in. Run `gh auth login` in your own terminal - the login is interactive, so it cannot happen from inside a session.";
  }
  return "The GitHub CLI is signed in, so the account it is signed in as is probably not the one with access. Check with `gh auth status`, and ask whoever set the handbook up to add that account.";
}
function cloneFailureReason(url, err, creds = probeCredentials()) {
  const raw = String(err instanceof Error ? err.message : err);
  const text = raw.toLowerCase();
  const detail = raw.split("\n").find((l) => l.trim())?.slice(0, 120) ?? "";
  if (text.includes("could not read username") || text.includes("terminal prompts disabled") || text.includes("authentication failed")) {
    return `cannot sign in to ${url} - this machine has no git credentials for it. A team handbook is normally a private repo, so this is the usual first step, not a fault. ` + credentialAdvice(url, creds) + " You also need to have been given access to the repository itself; the two are separate.";
  }
  if (text.includes("permission denied (publickey)") || text.includes("host key verification")) {
    return `SSH refused by ${url} - the key this machine offers is not registered on that host, or no key is loaded. Add your public key to the forge account, or use the HTTPS URL with credentials.`;
  }
  if (text.includes("repository not found") || text.includes("not found") || text.includes("does not exist")) {
    return `${url} is not there, or your account cannot see it. A private repo answers exactly the same way as a typo, so check the URL first, then whether you have been given access.`;
  }
  if (text.includes("could not resolve host") || text.includes("network") || text.includes("timed out")) {
    return `cannot reach ${url} from this machine (network or DNS): ${detail}`;
  }
  return `git clone failed for ${url}: ${detail}`;
}

// src/lib/display-path.ts
import { homedir as homedir3 } from "node:os";
import { sep } from "node:path";
function displayPath(path, userHome = homedir3()) {
  if (typeof path !== "string") return String(path);
  if (!userHome) return path;
  if (path === userHome) return "~";
  if (path.startsWith(userHome + sep)) return `~${path.slice(userHome.length)}`;
  return path;
}

// src/lib/plugin-root.ts
import { readFileSync as readFileSync4 } from "node:fs";
import { dirname as dirname3, join as join4 } from "node:path";
import { fileURLToPath } from "node:url";
function pluginRoot() {
  const here = dirname3(fileURLToPath(import.meta.url));
  for (const up of ["..", "../.."]) {
    try {
      const parsed = JSON.parse(readFileSync4(join4(here, up, ".claude-plugin", "plugin.json"), "utf8"));
      if (parsed && typeof parsed === "object") return join4(here, up);
    } catch {
    }
  }
  return null;
}
function productVersion(root = pluginRoot()) {
  if (!root) return null;
  try {
    const parsed = JSON.parse(readFileSync4(join4(root, "package.json"), "utf8"));
    return typeof parsed?.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

// src/lib/init.ts
var REMOTE_HELPER = /^[A-Za-z][A-Za-z0-9+.-]*::/;
function assertSafeGitUrl(url) {
  const u = url.trim();
  if (!u || u.startsWith("-") || REMOTE_HELPER.test(u) || /[\r\n\0]/.test(u)) {
    throw new Error(`unsafe or unsupported git URL: ${url}`);
  }
}
var DEFAULT_BRANCH_PREFIX = "handbook/";
var SCAFFOLD_COMMIT_TITLE = "chore: scaffold team skill base";
function commitMessagePrefix(prefix) {
  return prefix?.trim() ? `${prefix.trim()} ` : "";
}
function teamCommitPrefix(config) {
  return commitMessagePrefix(config?.commitPrefix);
}
function proposalFingerprint(proposal) {
  return createHash("sha256").update(proposal).digest("hex").slice(0, 8);
}
var COMMIT_MESSAGE_MAX = 200;
function commitMessageProblem(value) {
  if (!value.trim()) return "it is empty";
  if (/\p{C}/u.test(value)) return "it carries a control character, and a newline would end the title early";
  const secret = detectSecret(value);
  if (secret) return `it carries what looks like a ${secret}, and the team repository is read by everyone on the team`;
  return null;
}
function commitSubject(prefix, message) {
  const subject = message.trim();
  return prefix && !subject.startsWith(prefix) ? `${prefix}${subject}` : subject;
}
function decideCommitSubject(choice, proposal, prefix, rerun, unavailable) {
  if (choice.message !== void 0 && choice.delegated !== void 0) {
    return {
      error: "--message and --delegate-message answer the same question in different ways: --message is the wording the user approved, --delegate-message is them saying you decide. Pass one of them."
    };
  }
  if (choice.delegated !== void 0 && !/^[0-9a-f]{8}$/.test(choice.delegated)) {
    return {
      error: `"${choice.delegated}" is not the fingerprint of a proposed message. Delegating names the sentence the user was shown, which the run that asked for it printed beside the proposal, so ${rerun} with no message flag to see both. Nothing was committed.`
    };
  }
  if (choice.message !== void 0) {
    const problem = commitMessageProblem(choice.message);
    if (problem) return { error: `that commit message cannot be a commit title: ${problem}. Nothing was committed.` };
    const subject = commitSubject(prefix, choice.message);
    const ceiling = Math.max(COMMIT_MESSAGE_MAX, proposal.length);
    if (subject.length > ceiling) {
      return {
        error: `that commit message cannot be a commit title: it is longer than ${ceiling} characters. Nothing was committed.`
      };
    }
    return { subject };
  }
  const unusable = commitMessageProblem(proposal);
  if (unusable) {
    return {
      error: `the commit message this would propose cannot be a commit title: ${unusable}. There is nothing to show and nothing to delegate, so ask the user for the wording and ${rerun} with \`--message "<their wording>"\`. Nothing was committed.`
    };
  }
  if (choice.delegated !== void 0) {
    if (unavailable) return { error: delegationImpossible(unavailable, rerun) };
    if (choice.delegated === proposalFingerprint(proposal)) return { subject: proposal };
    return {
      error: `the message you delegated is not the one this would commit any more: it now says "${proposal}" (${proposalFingerprint(proposal)}), and the answer named ${choice.delegated}. Show the user the new one, then ${rerun}. Nothing was committed.`
    };
  }
  const ask = `commit message required: nothing is committed here with a message the user has not seen. This one would be "${proposal}". Show it to them, then ${rerun} with \`--message "<their wording>"\` once they have approved or edited it`;
  if (unavailable) {
    return {
      error: `${ask}. "You decide" is not an answer here, because ${unavailable}. Nothing was committed and nothing was pushed.`
    };
  }
  return {
    error: `${ask}, or with \`--delegate-message ${proposalFingerprint(proposal)}\` if they answered that you decide. Nothing was committed and nothing was pushed.`
  };
}
function delegationImpossible(unavailable, rerun) {
  return `"you decide" is an answer about the merge request, and ${unavailable}. Nothing was committed. Ask the user for the wording and ${rerun} with \`--message "<their wording>"\`.`;
}
function loadTeamConfig(home = handbookHome()) {
  const team = readConfigFile(home).team;
  if (team && typeof team.repoUrl === "string" && typeof team.marketplaceName === "string") {
    return team;
  }
  return null;
}
var BrokenConfigError = class extends Error {
  constructor(home) {
    super(
      `${displayPath(join5(home, "config.json"))} exists but is not valid JSON. TeamHandbook will not rewrite it, because doing so would silently discard settings you wrote - including the privacy switches, which are currently failing closed. Fix the JSON (or delete the file) and try again.`
    );
    this.name = "BrokenConfigError";
  }
};
function saveTeamConfig(team, home = handbookHome()) {
  if (configIsBroken(home)) throw new BrokenConfigError(home);
  const config = readConfigFile(home);
  config.team = team;
  writeFileAtomic(join5(home, "config.json"), JSON.stringify(config, null, 2) + "\n");
}
function repoNameFromUrl(url) {
  const normalized = normalizeRemoteUrl(url);
  if (!normalized) return null;
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  return name || null;
}
var BUMP_SCRIPT = `import { readFileSync, writeFileSync } from "node:fs";

const file = ".claude-plugin/plugin.json";
const plugin = JSON.parse(readFileSync(file, "utf8"));
const parts = plugin.version.split(".").map(Number);
parts[2] += 1;
plugin.version = parts.join(".");
writeFileSync(file, JSON.stringify(plugin, null, 2) + "\\n");
console.log(\`bumped plugin version to \${plugin.version}\`);
`;
var githubWorkflow = (bump) => `name: version-bump

# Bumps the plugin version on every merge to main. The version string is Claude Code's
# update signal: without a bump, teammates keep serving the cached marketplace copy.
on:
  push:
    branches: [main]

jobs:
  bump:
    if: "!startsWith(github.event.head_commit.message, '${bump}')"
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: node scripts/bump-version.mjs
      - run: |
          git config user.name "handbook-ci"
          git config user.email "handbook-ci@users.noreply.github.com"
          git commit -am "${bump}"
          git push
`;
var gitlabCi = (bump) => `# Bumps the plugin version on every merge to the default branch. The version string is
# Claude Code's update signal: without a bump, teammates keep serving the cached copy.
# Requires a project access token with write_repository scope stored in the
# TEAMHANDBOOK_CI_TOKEN CI/CD variable (Settings > CI/CD > Variables).
version-bump:
  image: node:22
  rules:
    # only run when the CI token exists - otherwise skip (don't fail the pipeline)
    - if: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH && $CI_COMMIT_MESSAGE !~ /^${bump}/ && $TEAMHANDBOOK_CI_TOKEN'
  script:
    - node scripts/bump-version.mjs
    - git config user.name "handbook-ci"
    - git config user.email "handbook-ci@noreply.invalid"
    - git commit -am "${bump}"
    - git push "https://oauth2:\${TEAMHANDBOOK_CI_TOKEN}@\${CI_SERVER_HOST}/\${CI_PROJECT_PATH}.git" "HEAD:\${CI_DEFAULT_BRANCH}"
`;
var UPDATES_BY_COMMIT = `\`.claude-plugin/plugin.json\` carries no version, so Claude Code versions the plugin
by the commit it installs: everything merged here - a skill, a server, a command, an
edit to this README - reaches a teammate's copy when their marketplace updates.`;
var UPDATES_BY_VERSION = `Every skill arrives as a merge request that also raises the version in
\`.claude-plugin/plugin.json\`. That version is Claude Code's signal that the plugin
moved, but a teammate's copy only picks it up when their marketplace updates, so
anything committed here by hand reaches nobody unless it raises the version too.`;
var SWITCH_POINTER = `
\`/handbook:init --upgrade --commit-versioning\` takes the version line out, after
which every merge reaches teammates without raising anything.`;
var README_BEGIN = "<!-- teamhandbook:begin -->";
var README_END = "<!-- teamhandbook:end -->";
var SWITCH_TO_COMMIT = `### Moving to versioning by commit

Taking the version line out ends the bump: no request raises anything, two requests
cannot claim the same number, and a commit made here by hand reaches teammates like
any other merge. In order:

1. Everyone who shares to this repository updates TeamHandbook to 0.31.0 or later
   first: \`/plugin marketplace update teamhandbook\`, then \`/reload-plugins\`. An older
   copy raises a version on every share, which puts the line back. A copy older than 0.29.0 also does not read
   \`scaffoldVersion\` in \`.teamhandbook.json\`, the record that stops an older copy
   from refreshing this scaffold back, so after the switch its \`--upgrade\` offers to
   put \`"version": "0.1.0"\` back and delete that record.
2. Merge or close the open requests that raise the version. Each one changes the line
   the switch deletes, so whichever of the two is merged second conflicts in
   \`.claude-plugin/plugin.json\`. Requests that leave that file alone merge as they are.
3. Run \`/handbook:init --upgrade --commit-versioning\`, read the plan, and send it.
4. Once it is merged, every teammate whose marketplace does not auto-update runs the
   two commands above.

A request that still conflicts after the switch is resolved by keeping the side without
the version line. Keeping the other side puts the repository back on the bump.`;
var KEEP_BY_COMMIT = `### Keeping it versioned by commit

\`.claude-plugin/plugin.json\` stays without a \`version\` line. A request that adds one
back - a share from a TeamHandbook whose \`/handbook:init --upgrade\` does not know
\`--commit-versioning\`, or an older request merged with its side of a conflict kept -
puts the repository back on the bump, where a merge that raises nothing reaches nobody.
Take that line out of the request before merging it. A TeamHandbook older than 0.29.0
does not read \`scaffoldVersion\` in \`.teamhandbook.json\`, so it is not stopped from
refreshing this scaffold back: everyone who works on this repository runs 0.31.0 or later.`;
function readmeFor(name, url, byCommit, withCi) {
  return `# ${name}

Your team's shared setup: skills, MCP servers, and slash commands your team has
approved through TeamHandbook.

${README_BEGIN}
<!-- Edit outside these markers; TeamHandbook 0.32.0 or newer rewrites only what is between them, an older one replaces the whole file when it refreshes it. -->

This repository is a Claude Code plugin marketplace; every merge reaches each
subscribed teammate when their marketplace updates.

## Access

If this repository is private, each teammate needs two separate things: access to the
repository (ask whoever set it up), and git credentials on their own machine. The second
is a one-time interactive sign-in they run themselves, for example
\`brew install gh && gh auth login\` for GitHub over HTTPS, or an SSH key registered with
the forge. Without it the commands below fail with a bare git error, because a plugin
can never stop to ask for a password.

## Consume the handbook (no TeamHandbook needed)

\`\`\`
/plugin marketplace add ${url}
/plugin install ${name}@${name}
\`\`\`

## Produce for the handbook (TeamHandbook engine required)

\`\`\`
/handbook:join ${url}
\`\`\`

## How updates flow

${byCommit ? UPDATES_BY_COMMIT : UPDATES_BY_VERSION + (withCi ? "" : SWITCH_POINTER)}
Skills live under \`skills/\`, one directory per skill (\`SKILL.md\` plus the
\`grounded-case.json\` evidence it was distilled from).

Nothing here needs CI, an access token, or the right to push to a protected branch.

### Getting new skills

If auto-update is off for this marketplace, a merge reaches you only after these two:

\`\`\`
/plugin marketplace update ${name}
/reload-plugins
\`\`\`

To stop doing it by hand, turn auto-update on for this marketplace from the \`/plugin\`
menu. When you announce a merge to the team, include these two commands.

${byCommit ? `${KEEP_BY_COMMIT}

` : withCi ? "" : `${SWITCH_TO_COMMIT}

`}### Who reviews a request

TeamHandbook adds the reviewers and labels listed in \`.teamhandbook.json\` to the
requests it opens here, and adds none while it lists none. \`glab\` and \`gh\` send both
with the request. A request GitLab opens from a push takes the labels; no push option
sets reviewers, so those are printed for you to add. A request you open from the printed
link takes neither until you add them, and the result lists them. To change them, run
\`/handbook:init --upgrade --reviewers <a,b> --labels <x>\`. GitLab does not apply the
project's merge request template to a request opened through its API, which is how
\`glab\` opens one, so reviewers or labels that template sets reach the requests
\`glab\` opens only once they are listed here. A request GitLab opens from a push, or
one you open on its web page, does get that template.

This plugin ships a tiny dependency-free SessionStart hook that shows consumers a
"N new skills/servers/commands" notice; it records what it has already shown you under
\`~/.teamhandbook-consumer\` (remove it any time with \`rm -rf ~/.teamhandbook-consumer\`).
It makes no network calls and needs no TeamHandbook engine, so it reads only the copy
already installed: the notice appears after an update, it does not cause one.

${README_END}
`;
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
var CONSUMER_NOTICE_SCRIPT = `#!/usr/bin/env node
// Prints "<plugin>: N new skill(s) since your last session" - no dependencies, no
// TeamHandbook engine required. Best-effort: any error exits 0 silently.
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
try {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  let name = "team-skills";
  try { name = JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8")).name || name; } catch {}
  const current = readdirSync(join(root, "skills"), { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name).sort();
  // A merged MCP server raises the plugin version and reaches every copy, once its
  // marketplace updates, exactly as a skill does. Counting only skills would make that
  // arrive in silence: the teammate would have a new server connected to their machine
  // and no notice that it happened, which is half of what this plugin promises. Both
  // shapes seen in the field are read here - a {"mcpServers": {...}} wrapper and a bare
  // server map - and this deliberately duplicates the reader in TeamHandbook's own
  // mcp.ts, because this script ships inside the team's plugin and is not allowed to
  // import anything.
  let servers = [];
  try {
    const parsed = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
    const map = parsed && typeof parsed.mcpServers === "object" && parsed.mcpServers ? parsed.mcpServers : parsed;
    if (map && typeof map === "object") servers = Object.keys(map).sort();
  } catch {}
  // Slash commands merge the same way a skill or server does - one MR, one version bump,
  // picked up by every subscribed copy when its marketplace updates - so they get the
  // same notice. Read directly from commands/ rather than importing TEAM_COMMANDS_DIR,
  // for the same reason mcp.ts is not imported above: this script ships inside the
  // team's plugin, with no dependencies.
  // A subdirectory is a namespace segment, commands/git/sync.md being git:sync, so a
  // command shared from a subdirectory is announced like any other instead of arriving
  // in silence.
  function commandNames(dir, namespace) {
    let found = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) found = found.concat(commandNames(join(dir, e.name), namespace + e.name + ":"));
      else if (e.isFile() && e.name.endsWith(".md")) found.push(namespace + e.name.slice(0, -3));
    }
    return found;
  }
  let commands = [];
  try {
    commands = commandNames(join(root, "commands"), "").sort();
  } catch {}
  const seenDir = join(homedir(), ".teamhandbook-consumer");
  const seenFile = join(seenDir, name + ".json");
  let prior = null;
  try { prior = JSON.parse(readFileSync(seenFile, "utf8")); } catch {}
  mkdirSync(seenDir, { recursive: true });
  writeFileSync(seenFile, JSON.stringify({ skills: current, servers, commands }));
  // An earlier copy of this script stored a bare array of skill names. Reading that as
  // "no servers seen yet" would announce every server the team already had as new, so
  // the one session after an upgrade reports skills only.
  const priorSkills = Array.isArray(prior) ? prior : prior && Array.isArray(prior.skills) ? prior.skills : null;
  const priorServers = Array.isArray(prior) ? servers : prior && Array.isArray(prior.servers) ? prior.servers : null;
  // Same problem one field later: a record written before commands existed (bare array,
  // or the {skills, servers} shape) has no .commands at all. Falling back to the current
  // list rather than null means "nothing seen yet" is never mistaken for "everything is
  // new" - it reads as an empty diff instead, exactly like priorServers above.
  const priorCommands = Array.isArray(prior) ? commands : prior && Array.isArray(prior.commands) ? prior.commands : commands;
  const freshSkills = priorSkills ? current.filter((s) => !priorSkills.includes(s)) : [];
  const freshServers = priorServers ? servers.filter((s) => !priorServers.includes(s)) : [];
  const freshCommands = commands.filter((c) => !priorCommands.includes(c));
  const parts = [];
  if (freshSkills.length) parts.push(freshSkills.length + " new skill(s)");
  if (freshServers.length) parts.push(freshServers.length + " new MCP server(s)");
  if (freshCommands.length) parts.push(freshCommands.length + " new command(s)");
  // "X and Y" reads fine, but a skill and a server and a command in the same session
  // only became possible once commands joined this notice, and "X and Y and Z" is not
  // how English lists three things. The Oxford comma before the last item is what makes
  // three (or more) read naturally; two items still just get "X and Y".
  function englishList(items) {
    if (items.length < 3) return items.join(" and ");
    return items.slice(0, -1).join(", ") + ", and " + items[items.length - 1];
  }
  if (parts.length) {
    // A plugin's own commands are typed as /<plugin-name>:<command-name>, not bare
    // /<command-name> - Claude Code namespaces every installed plugin's commands this
    // way, and this repo's own README (and share.ts's post-share message) never shows
    // a bare form. Printing the bare name here would hand the teammate a command that
    // does not resolve, defeating the point of announcing it at all.
    const named = freshSkills
      .concat(freshServers.map((s) => s + " (MCP)"))
      .concat(freshCommands.map((c) => "/" + name + ":" + c))
      .join(", ");
    console.log(name + ": " + englishList(parts) + " since your last session: " + named + ".");
  }
} catch {}
process.exit(0);
`;
var TEAM_PREFIX_FILE = ".teamhandbook.json";
var COMMIT_PREFIX_MAX = 64;
function commitPrefixProblem(value) {
  if (value.length > COMMIT_PREFIX_MAX) return `longer than ${COMMIT_PREFIX_MAX} characters`;
  if (/\p{C}/u.test(value)) return "carrying a control character";
  return null;
}
function readTeamCommitPrefix(repoDir) {
  let raw;
  try {
    raw = JSON.parse(readFileSync5(join5(repoDir, TEAM_PREFIX_FILE), "utf8"))?.commitPrefix;
  } catch {
    return {};
  }
  if (typeof raw !== "string") return {};
  const value = raw.trim();
  const problem = commitPrefixProblem(value);
  return problem ? { problem } : { prefix: value };
}
function skeletonFiles(name, url, host, commitPrefix = "", withCi = false, branchExample, assignment = {}, scaffoldVersion, version) {
  const pluginVersion = version ?? (withCi ? "0.1.0" : void 0);
  const files = {
    "hooks/hooks.json": CONSUMER_NOTICE_HOOKS + "\n",
    "hooks/notice.mjs": CONSUMER_NOTICE_SCRIPT,
    ".claude-plugin/marketplace.json": JSON.stringify(
      {
        name,
        owner: { name: `${name} maintainers` },
        plugins: [
          {
            name,
            source: "./",
            description: "Skills, MCP servers, and slash commands your team has approved through TeamHandbook."
          }
        ]
      },
      null,
      2
    ) + "\n",
    ".claude-plugin/plugin.json": JSON.stringify(
      {
        name,
        description: "Skills, MCP servers, and slash commands your team has approved through TeamHandbook.",
        // Only for a repository that raises a number on every merge. Without one, Claude
        // Code versions the plugin by commit and every merge reaches teammates, with no
        // version line for two requests to conflict on and none for a merge to forget.
        ...pluginVersion !== void 0 ? { version: pluginVersion } : {}
      },
      null,
      2
    ) + "\n",
    "README.md": readmeFor(name, url, pluginVersion === void 0, withCi),
    "skills/README.md": "Approved skills land here, one directory per skill (SKILL.md + grounded-case.json).\n",
    // Written even when there is no prefix, because "" and "absent" are different answers:
    // "" is this team saying its forge asks for nothing, while an absent file is a
    // repository that predates this record and knows nothing either way. A teammate who
    // read the second as the first would regenerate the CI job without the team's prefix.
    [TEAM_PREFIX_FILE]: JSON.stringify(
      {
        commitPrefix: commitPrefix.trim(),
        // Only when someone recorded one: a key written empty would read as an answer.
        ...branchExample ? { branchExample } : {},
        // Written as given, an empty list included: [] is the team saying nobody, while a
        // key left out is a team that has not said.
        ...assignment.reviewers !== void 0 ? { reviewers: assignment.reviewers } : {},
        ...assignment.labels !== void 0 ? { labels: assignment.labels } : {},
        // Which TeamHandbook release wrote the scaffold, so an older copy refuses to refresh
        // it back rather than undoing what a newer one wrote (upgrade.ts).
        ...scaffoldVersion ? { scaffoldVersion } : {},
        comment: "Written by TeamHandbook. commitPrefix is what this project's forge requires at the front of a commit message; /handbook:join reads it, so a teammate's first share satisfies that rule instead of being refused by it. reviewers and labels, when present, go with the requests TeamHandbook opens here as far as the way each is opened allows: gh and glab send both, a request GitLab opens from a push takes the labels, and a request left to a link takes neither; the result names what is left to add. An empty list adds none."
      },
      null,
      2
    ) + "\n"
  };
  if (withCi) {
    files["scripts/bump-version.mjs"] = BUMP_SCRIPT;
    const bump = `${commitMessagePrefix(commitPrefix)}ci: bump plugin version`;
    if (host && host.includes("github")) {
      files[".github/workflows/version-bump.yml"] = githubWorkflow(bump);
    } else {
      files[".gitlab-ci.yml"] = gitlabCi(bump);
    }
  }
  return files;
}
function writeSkeletonPreserving(dir, files) {
  const written = [];
  const skipped = [];
  for (const [path, content] of Object.entries(files)) {
    const target = join5(dir, path);
    let existing = "";
    try {
      existing = readFileSync5(target, "utf8");
    } catch {
    }
    if (existing.trim()) {
      skipped.push(path);
      continue;
    }
    mkdirSync3(dirname4(target), { recursive: true });
    writeFileSync2(target, content);
    written.push(path);
  }
  return { written, skipped };
}
function nonInteractiveEnv(base = process.env) {
  return {
    ...base,
    GIT_TERMINAL_PROMPT: "0",
    GLAB_NO_PROMPT: "1",
    GH_PROMPT_DISABLED: "1",
    NO_COLOR: "1",
    GLAB_SEND_TELEMETRY: "0",
    GLAB_CHECK_UPDATE: "false",
    GH_TELEMETRY: "0"
  };
}
var GIT_TIMEOUT_MS = 12e4;
function summarizeGitStderr(stderr, tailLines = 3) {
  const lines = stderr.split("\n").map((line) => line.trimEnd()).filter((line) => line.trim());
  const explanations = lines.filter((line) => line.trim().startsWith("remote:"));
  const tail = lines.slice(-tailLines).filter((line) => !explanations.includes(line));
  return [...explanations, ...tail].join("\n");
}
function pushReplying(args, cwd) {
  const run = spawnSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env: nonInteractiveEnv(),
    timeout: GIT_TIMEOUT_MS
  });
  if (run.error) throw run.error;
  if (run.status !== 0) {
    throw Object.assign(new Error(`Command failed: git ${args.join(" ")}`), {
      status: run.status,
      stdout: run.stdout,
      stderr: run.stderr
    });
  }
  return `${run.stdout}${run.stderr}`;
}
function runGit(args, cwd) {
  try {
    if (args[0] === "push") return pushReplying(args, cwd);
    return execFileSync4("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      env: nonInteractiveEnv(),
      timeout: GIT_TIMEOUT_MS
    });
  } catch (err) {
    const stderr = err?.stderr;
    if (typeof stderr === "string" && stderr.trim()) {
      throw new Error(`git ${args[0]} failed: ${summarizeGitStderr(stderr)}`);
    }
    throw err;
  }
}
function gitIdentityArgs(git) {
  const read = (key) => {
    try {
      return String(git(["config", key], process.cwd()) ?? "").trim();
    } catch {
      return "";
    }
  };
  const name = read("user.name");
  const email = read("user.email");
  if (!name || !email) return null;
  return ["-c", `user.name=${name}`, "-c", `user.email=${email}`];
}
var INIT_BRANCH_PREFIX_FIX = 'Re-run with a prefix that fits, for example --branch-prefix "TEAM-1-", and it is remembered for every skill shared later.';
var INIT_COMMIT_PREFIX_FIX = 'Re-run with a prefix that satisfies it, for example --commit-prefix "TEAM-1", and it is remembered for every skill shared later.';
function teamCommitPrefixFix(team, retry, source = "config") {
  const known = team.commitPrefix?.trim();
  if (known === "") {
    return `The team repository records that no prefix is needed (${TEAM_PREFIX_FILE}), so this commit had none, and the rule now says otherwise. Correct "commitPrefix" in that file in the repository and run \`/handbook:join <url>\` again, which re-reads it - that is what fixes it for everyone. To unblock only this machine, set "commitPrefix" under "team" in ~/.teamhandbook/config.json, then ${retry}.`;
  }
  if (known && source === "repository") {
    return `The prefix the team repository records in ${TEAM_PREFIX_FILE}, "${known}", does not satisfy that rule; this machine has none of its own and used that one. Correct the record with \`/handbook:init --upgrade --commit-prefix "<the prefix the rule requires>"\`, which fixes it for everyone who shares after; to unblock only this machine, set "commitPrefix" under "team" in ~/.teamhandbook/config.json, then ${retry}.`;
  }
  if (known && source === "flag") {
    return `The prefix given with --commit-prefix, "${known}", does not satisfy that rule. It is used for this run only, so nothing on this machine or in the repository needs correcting.`;
  }
  if (known) {
    return `The prefix this machine uses, "${known}", does not satisfy that rule. Correct "commitPrefix" under "team" in ~/.teamhandbook/config.json, and have whoever ran /handbook:init record the right one in the repository with \`/handbook:init --upgrade\` so no teammate hits this, then ${retry}.`;
  }
  return `This machine does not know the team's commit-message prefix: /handbook:join reads it from the repository, and this one does not record it (no "commitPrefix" in ${TEAM_PREFIX_FILE}). Whoever ran /handbook:init can add it there once with \`/handbook:init --upgrade\`, and every share after that picks it up; or set "commitPrefix" under "team" in ~/.teamhandbook/config.json to a prefix that satisfies the rule, then ${retry}.`;
}
var IDENTITY_RULES = [
  /(author|committer)'s email/i,
  /committer email '[^']*' is not verified/i,
  /you cannot push commits for/i,
  /(author|committer) '[^']*' is not a member of team/i,
  /author name is inconsistent/i
];
function refusesTheIdentity(raw) {
  if (IDENTITY_RULES.some((rule) => rule.test(raw))) return true;
  return /author|committer/i.test(raw) && /email|not a .* user|restricted/i.test(raw);
}
function pushRuleSubject(raw) {
  if (/\bbranch name\b/i.test(raw)) return "branch-name";
  if (/\bcommit message\b/i.test(raw)) return "commit-message";
  if (refusesTheIdentity(raw)) return "identity";
  return null;
}
function pushFailureReason(url, branch, err, branchPrefixFix = INIT_BRANCH_PREFIX_FIX, commitPrefixFix = INIT_COMMIT_PREFIX_FIX) {
  const raw = String(err instanceof Error ? err.message : err);
  const text = raw.toLowerCase();
  const detail = raw.split("\n").find((l) => l.trim())?.slice(0, 140) ?? "";
  const remoteSaid = raw.split("\n").filter((l) => l.includes("remote:")).map((l) => l.slice(l.indexOf("remote:") + "remote:".length).trim().replace(/^GitLab:\s*/i, "")).filter(Boolean);
  const pattern = raw.match(/does not follow the pattern\s*'([^']+)'/)?.[1];
  const forbidden = raw.match(/contains the forbidden pattern\s*'([^']+)'/)?.[1];
  const subject = pushRuleSubject(raw);
  if (subject === "branch-name") {
    return `${url} rejected the branch NAME "${branch}". It said: ${remoteSaid[0] ?? detail} Nothing is wrong with your access. ${branchPrefixFix}`;
  }
  if (text.includes("protected") || text.includes("not allowed to push")) {
    return `${url} refused the push to ${branch}: ${remoteSaid[0]?.replace(/\.$/, "") ?? "that branch is protected"}. Ask for the role that lets you write there, or have someone who has it push once.`;
  }
  if (subject === "commit-message" && forbidden) {
    return `${url} rejected the commit MESSAGE, not the contents: ${remoteSaid[0] ?? detail} That is a pattern the project BANS rather than one it requires, so no prefix satisfies it; the commit title itself has to stop matching it.`;
  }
  if (subject === "commit-message" && /commit message does not follow the pattern/i.test(raw)) {
    return `${url} rejected the commit MESSAGE, not the contents: ${remoteSaid[0] ?? detail} ${commitPrefixFix}`;
  }
  if (subject === "identity") {
    const said = remoteSaid[0] ?? detail;
    return `${url} rejected the commit AUTHOR, not the branch name or the contents: ${said} ` + // only when the quote lost it: a 140-character fallback truncates the rule away
    (pattern && !said.includes(pattern) ? `The address it accepts matches ${pattern}. ` : "") + "Every commit is made with your own `git config user.name/user.email` as they resolve in the directory this ran from, so set those to the identity your forge knows you by.";
  }
  if (pattern) {
    return `${url} refused the push to ${branch} against a rule requiring ${pattern}, without saying which rule: ${remoteSaid.join(" ") || detail} Check the branch name, the commit message and the commit author's email against it - one of the three is what it is measuring.`;
  }
  if (text.includes("pre-receive hook declined")) {
    return `${url} refused the push to ${branch} through a server-side rule: ${remoteSaid.join(" ") || detail}`;
  }
  if (text.includes("non-fast-forward") || text.includes("fetch first") || text.includes("rejected")) {
    return `${url} moved while this ran; nothing was changed. Re-run /handbook:init and it will pick the new state up.`;
  }
  return `pushing the scaffold to ${branch} on ${url} failed: ${detail}`;
}
function initTeamRepo(url, name, home = handbookHome(), git = runGit, now = (/* @__PURE__ */ new Date()).toISOString(), forge = runForge, branchPrefix = DEFAULT_BRANCH_PREFIX, commitPrefix = "", withCi = false, commitMessage = {}, assignment = {}) {
  if (!url.trim()) return { ok: false, error: "a git URL is required" };
  const assignmentProblem = assignmentRecordProblem(assignment);
  if (assignmentProblem) return { ok: false, error: assignmentProblem };
  const prefixProblem = commitPrefixProblem(commitPrefix.trim());
  if (prefixProblem) {
    return { ok: false, error: `that commit-message prefix cannot be used: it is ${prefixProblem}. Nothing was changed.` };
  }
  try {
    assertSafeGitUrl(url);
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err) };
  }
  const marketplaceName = slugifySkillName(name ?? repoNameFromUrl(url) ?? "");
  if (!marketplaceName) {
    return { ok: false, error: `cannot derive a marketplace name from "${url}"; pass --name` };
  }
  if (configIsBroken(home)) {
    return { ok: false, error: new BrokenConfigError(home).message };
  }
  if (loadTeamConfig(home)) {
    return {
      ok: false,
      // Leaving used to be the only thing this could say, and it is the wrong advice for
      // the common reason someone arrives here: their scaffold is behind the version they
      // just installed. Leaving and re-initializing means a SECOND repository, which is a
      // loss dressed as a fix, so the refresh is named first and leaving keeps its real
      // job - pointing this machine at a different team.
      error: `a team repository is already configured. To bring its scaffold up to this version, run \`/handbook:init --upgrade\` - it shows what would change and writes nothing until you pick. To point at a DIFFERENT team, run /handbook:leave (or edit ${displayPath(join5(home, "config.json"))}) first.`
    };
  }
  const identity = gitIdentityArgs(git);
  if (!identity) {
    return {
      ok: false,
      error: 'git user.name/user.email is not set - the scaffold commit would have an author your forge is likely to reject. Run `git config --global user.name "Your Name"` and `git config --global user.email you@example.com`, then re-run.'
    };
  }
  const proposal = commitSubject(commitMessagePrefix(commitPrefix), SCAFFOLD_COMMIT_TITLE);
  return inWorkdir("handbook-init-", home, (workdir) => {
    const repoDir = join5(workdir, "repo");
    try {
      git(["clone", "--", url, repoDir], workdir);
    } catch (err) {
      return { ok: false, error: cloneFailureReason(url, err) };
    }
    let branch;
    try {
      branch = String(git(["symbolic-ref", "--short", "HEAD"], repoDir) ?? "").trim();
    } catch {
      branch = "";
    }
    if (!branch) {
      return { ok: false, error: `cannot tell which branch ${url} uses by default; push a first commit to it and re-run` };
    }
    let isEmptyRepo;
    try {
      isEmptyRepo = !String(git(["rev-parse", "--verify", "HEAD"], repoDir) ?? "").trim();
    } catch {
      isEmptyRepo = true;
    }
    if (existsSync2(join5(repoDir, ".claude-plugin", "marketplace.json"))) {
      return {
        ok: false,
        error: `${url} is already a handbook - run /handbook:join ${url} to point this machine at it instead of scaffolding it again`
      };
    }
    const stopped = (error) => ({
      ok: false,
      error,
      proposedMessage: proposal,
      proposalHash: proposalFingerprint(proposal)
    });
    const unavailable = isEmptyRepo ? `${url} has no commits yet, so the scaffold goes straight to ${branch} and there is no merge request to open` : commitMessage.message === void 0 ? (() => {
      const blocked = forgeSignInProblem(url, repoDir, forge);
      return blocked ? noRequestPossible(blocked) : null;
    })() : null;
    const decided = decideCommitSubject(
      commitMessage,
      proposal,
      commitMessagePrefix(commitPrefix),
      "run /handbook:init again",
      unavailable ?? void 0
    );
    if ("error" in decided) return stopped(decided.error);
    const { skipped } = writeSkeletonPreserving(
      repoDir,
      skeletonFiles(marketplaceName, url, hostFromUrl(url), commitPrefix, withCi, void 0, assignment, productVersion() ?? void 0)
    );
    const scaffoldBranch = `${branchPrefix}scaffold`;
    const direct = isEmptyRepo;
    try {
      if (!direct) git(["checkout", "-b", scaffoldBranch], repoDir);
      git(["add", "-A"], repoDir);
      git([...identity, "commit", "-m", decided.subject], repoDir);
      pushBranch(git, repoDir, direct ? `HEAD:${branch}` : `HEAD:${scaffoldBranch}`);
    } catch (err) {
      return { ok: false, error: pushFailureReason(url, direct ? branch : scaffoldBranch, err) };
    }
    let prUrl = null;
    let prError;
    let notes = [];
    let alreadyOpen = false;
    if (!direct) {
      const { assignment: assigned, dropped, reviewersRecorded, labelsRecorded } = readTeamAssignment(repoDir);
      const opened = openPr(
        url,
        scaffoldBranch,
        "chore: set up the team handbook",
        `Scaffolds this repository as a Claude Code marketplace so approved skills can be distributed from it: marketplace manifest, plugin manifest${withCi ? ", the version-bump CI," : ","} and a \`skills/\` directory.

Opened by TeamHandbook.`,
        repoDir,
        forge,
        assigned
      );
      prUrl = opened.url;
      prError = opened.error;
      alreadyOpen = opened.existing === true;
      notes = requestNotes(dropped, assigned, opened, { repoUrl: url, reviewersRecorded, labelsRecorded });
    }
    saveTeamConfig(
      {
        repoUrl: url,
        marketplaceName,
        initializedAt: now,
        ...branchPrefix !== DEFAULT_BRANCH_PREFIX ? { branchPrefix } : {},
        ...commitPrefix ? { commitPrefix: commitPrefix.trim() } : {}
      },
      home
    );
    return {
      ok: true,
      name: marketplaceName,
      url,
      home,
      branch: direct ? branch : scaffoldBranch,
      defaultBranch: branch,
      merged: direct,
      skipped,
      withCi,
      commitMessage: decided.subject,
      ...prUrl ? { prUrl } : {},
      ...prError ? { prError } : {},
      ...notes.length ? { requestNotes: notes } : {},
      ...!direct && !prUrl && !alreadyOpen ? { manualUrl: manualPrUrl(url, scaffoldBranch) ?? void 0 } : {}
    };
  });
}
function formatInitSuccess(result) {
  const isGitHub = !!result.url && (hostFromUrl(result.url) ?? "").includes("github");
  return [
    "Team skill base initialized.",
    "",
    `  repository:  ${result.url}`,
    `  marketplace: ${result.name}`,
    ...result.merged ? [
      `  pushed:      marketplace skeleton${result.withCi ? " + version-bump CI" : ""}, straight to ${result.branch} (the repo was empty)`
    ] : [
      `  pushed:      marketplace skeleton${result.withCi ? " + version-bump CI" : ""} to branch ${result.branch}`,
      result.prUrl ? `  request:     ${result.prUrl}` : `  request:     open it here - ${result.manualUrl ?? `push ${result.branch} and open a request against ${result.defaultBranch}`}`,
      ...result.prError ? [`               (could not open it automatically: ${result.prError})`] : [],
      `  NOT LIVE until that is merged into ${result.defaultBranch}. Share the message below after it is.`
    ],
    ...result.leftoverWorkdir ? [`  note:        could not remove the scratch clone at ${displayPath(result.leftoverWorkdir)}; it is safe to delete`] : [],
    // Silence is the wrong signal here: a team whose README already said something
    // keeps it, and then the join instructions live nowhere unless they are told.
    ...result.skipped?.length ? [
      `  left alone: ${result.skipped.join(", ")} (already had content)`,
      "               the handbook README explains how teammates join - if yours was kept,",
      "               copy that section across from skills/README.md or this output."
    ] : [],
    // What the commit says, for the same reason every other path here prints it: the
    // wording may be the user's own, and it may have gained the team's prefix on the way.
    ...result.commitMessage ? [`  commit:      ${result.commitMessage}`] : [],
    `  config:      team repo saved to ${displayPath(join5(result.home ?? "", "config.json"))}`,
    ...requestNoteLines(result.requestNotes),
    "",
    // A handbook is normally private, and a private repo needs two separate things
    // from each teammate: access to the repo, and credentials on their machine. The
    // first person to try this had neither, had never used GitHub, and met a raw git
    // error. Nothing here had told the champion there was anything to arrange.
    "BEFORE you share this, give each teammate access to the repository. If it is",
    "private they also need git credentials on their own machine, which is a one-time",
    "interactive login they have to run themselves. Send them this:",
    "",
    "  ---------------------------------------------------------------",
    `  Our team handbook lives at ${result.url} and I have given you access.`,
    "",
    "  If you have never pushed to this host from this machine, sign in once,",
    "  in your own terminal (it opens a browser):",
    "",
    isGitHub ? "    brew install gh && gh auth login        # GitHub over HTTPS" : "    brew install glab && glab auth login    # GitLab over HTTPS,",
    ...isGitHub ? [] : ["                                            # or add an SSH key to your account"],
    "",
    "  Then, in Claude Code:",
    "",
    "  To USE the team's skills:",
    `    /plugin marketplace add ${result.url}`,
    `    /plugin install ${result.name}@${result.name}`,
    "",
    "  To also CONTRIBUTE your own:",
    `    /handbook:join ${result.url}`,
    "  ---------------------------------------------------------------",
    "",
    "A public handbook needs none of the sign-in step: anyone can clone it. Private is",
    "the right default for team knowledge, so the login is the price of that choice."
  ].join("\n");
}

// src/lib/upgrade.ts
import { existsSync as existsSync4, mkdirSync as mkdirSync5, readFileSync as readFileSync7, writeFileSync as writeFileSync4 } from "node:fs";
import { dirname as dirname6, join as join7 } from "node:path";

// src/lib/publish.ts
import { existsSync as existsSync3, lstatSync, mkdirSync as mkdirSync4, readdirSync as readdirSync2, readFileSync as readFileSync6, rmSync as rmSync3, writeFileSync as writeFileSync3 } from "node:fs";
import { dirname as dirname5, join as join6, relative } from "node:path";
function symlinkOnPath(repoDir, path) {
  let current = repoDir;
  for (const part of path.split("/")) {
    current = join6(current, part);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      return null;
    }
    if (stat.isSymbolicLink()) return relative(repoDir, current);
  }
  return null;
}
function bumpPluginVersion(repoDir, past = []) {
  const file = join6(repoDir, ".claude-plugin", "plugin.json");
  if (symlinkOnPath(repoDir, ".claude-plugin/plugin.json")) return null;
  try {
    const plugin = JSON.parse(readFileSync6(file, "utf8"));
    if (plugin.version === void 0) return null;
    const current = String(plugin.version);
    const parts = current.split(".").map(Number);
    if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
    parts[2] = (parts[2] ?? 0) + 1;
    plugin.version = past.length ? versionPast(current, past) : parts.join(".");
    writeFileSync3(file, JSON.stringify(plugin, null, 2) + "\n");
    return plugin.version;
  } catch {
    return null;
  }
}
function commitPrefixForPush(team, repoDir) {
  if (typeof team.commitPrefix === "string") return { team, prefix: teamCommitPrefix(team), source: "config" };
  const recorded = readTeamCommitPrefix(repoDir);
  if (recorded.prefix === void 0) return { team, prefix: teamCommitPrefix(team), source: "config" };
  return {
    team: { ...team, commitPrefix: recorded.prefix },
    prefix: commitMessagePrefix(recorded.prefix),
    source: "repository"
  };
}

// src/lib/upgrade.ts
var PLUGIN_MANIFEST = ".claude-plugin/plugin.json";
var MARKETPLACE_MANIFEST = ".claude-plugin/marketplace.json";
var CI_MARKER = "scripts/bump-version.mjs";
var TEAM_OWNED_DIRS = ["skills/", "commands/", "agents/"];
var TEAM_OWNED_FILES = [".mcp.json"];
function isTeamOwned(path) {
  return TEAM_OWNED_DIRS.some((dir) => path.startsWith(dir)) || TEAM_OWNED_FILES.includes(path);
}
function readIfPresent(file) {
  try {
    return readFileSync7(file, "utf8");
  } catch {
    return null;
  }
}
function parseObject(text) {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}
function mergePluginManifest(existing, fresh, byCommit = false) {
  if (existing === null) return fresh;
  const current = parseObject(existing);
  if (!current) return null;
  const next = JSON.parse(fresh);
  delete next.version;
  const merged = { ...current, ...next };
  if (byCommit) delete merged.version;
  return JSON.stringify(merged, null, 2) + "\n";
}
function isOwnPlugin(entry) {
  return typeof entry === "object" && entry !== null && entry.source === "./";
}
function mergeMarketplaceManifest(existing, fresh) {
  if (existing === null) return fresh;
  const current = parseObject(existing);
  if (!current) return null;
  const next = JSON.parse(fresh);
  const merged = { ...current };
  for (const [key, value] of Object.entries(next)) if (!(key in merged)) merged[key] = value;
  const own = next.plugins?.find(isOwnPlugin);
  if (Array.isArray(current.plugins) && own) {
    let found = false;
    const kept = current.plugins.map((entry) => {
      if (!isOwnPlugin(entry)) return entry;
      found = true;
      return { ...entry, ...own };
    });
    merged.plugins = found ? kept : [...current.plugins, own];
  }
  return JSON.stringify(merged, null, 2) + "\n";
}
function mergeTeamFile(existing, fresh) {
  if (existing === null) return fresh;
  const current = parseObject(existing);
  if (!current) return null;
  return JSON.stringify({ ...current, ...JSON.parse(fresh) }, null, 2) + "\n";
}
function readTeamFileObject(repoDir) {
  const text = readIfPresent(join7(repoDir, TEAM_PREFIX_FILE));
  return text === null ? null : parseObject(text);
}
var SCAFFOLD_VERSION_KEY = "scaffoldVersion";
var UPDATE_THIS_COPY = "Update this copy of TeamHandbook first - run `/plugin marketplace update teamhandbook` and then `/reload-plugins` - and run the refresh again.";
function releaseParts(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match ? match.slice(1).map(Number) : null;
}
function scaffoldVersionProblem(recorded, running) {
  const own = running === null ? null : releaseParts(running);
  if (!own) {
    return `This copy of TeamHandbook cannot read its own version, so it cannot tell whether the scaffold in this repository is newer than it. Nothing was changed. ${UPDATE_THIS_COPY}`;
  }
  if (recorded === void 0) return null;
  const theirs = typeof recorded === "string" ? releaseParts(recorded) : null;
  if (!theirs) {
    return `${TEAM_PREFIX_FILE} records the scaffold as written by a version this copy cannot read, which is what a newer TeamHandbook would leave. Nothing was changed. ${UPDATE_THIS_COPY}`;
  }
  for (const [at, part] of theirs.entries()) {
    if (part < own[at]) return null;
    if (part > own[at]) {
      return `The scaffold in this repository was last written by TeamHandbook ${recorded}, and this copy is ${running}, so refreshing it from here would undo what ${recorded} changed. Nothing was changed. ${UPDATE_THIS_COPY}`;
    }
  }
  return null;
}
function refreshingRelease(repoDir) {
  const running = productVersion();
  const problem = scaffoldVersionProblem(readTeamFileObject(repoDir)?.[SCAFFOLD_VERSION_KEY], running);
  return problem ? { error: problem } : { release: running };
}
function stampMissing(stamp) {
  const why = stamp.blocked ?? `${TEAM_PREFIX_FILE} is not among the files sent, and the repository has none yet`;
  return `nothing records that TeamHandbook ${stamp.release} wrote this scaffold - ${why} - so an older copy is not stopped from undoing it.`;
}
function scaffoldStamp(repoDir, candidates, release) {
  if (!(TEAM_PREFIX_FILE in candidates.files)) {
    return { release, blocked: `${TEAM_PREFIX_FILE} is not offered here (see above)` };
  }
  return existsSync4(join7(repoDir, TEAM_PREFIX_FILE)) ? { release } : { release, ifSent: true };
}
function stampScaffoldVersion(repoDir, release) {
  const current = readTeamFileObject(repoDir);
  if (!current || current[SCAFFOLD_VERSION_KEY] === release) return false;
  const stamped = { ...current, [SCAFFOLD_VERSION_KEY]: release };
  writeFileSync4(join7(repoDir, TEAM_PREFIX_FILE), JSON.stringify(stamped, null, 2) + "\n");
  return true;
}
var PREFIX_PROBE = "ZZTEAMHANDBOOKPREFIXPROBEZZ";
function commitPrefixIsKnown(team) {
  if (typeof team.commitPrefix === "string") return true;
  return !!team.initializedAt;
}
function prefixDependentPaths(team, withCi) {
  const host = hostFromUrl(team.repoUrl);
  const plain = skeletonFiles(team.marketplaceName, team.repoUrl, host, "", withCi);
  const probed = skeletonFiles(team.marketplaceName, team.repoUrl, host, PREFIX_PROBE, withCi);
  return new Set(Object.keys(plain).filter((path) => plain[path] !== probed[path]));
}
function productSection(lines) {
  const at = (marker) => lines.flatMap((line, index) => line.trim() === marker ? [index] : []);
  const begins = at(README_BEGIN);
  const ends = at(README_END);
  if (begins.length !== 1 || ends.length !== 1 || ends[0] < begins[0]) return null;
  return { begin: begins[0], end: ends[0] };
}
var MARKER_LIKE = /^<!--.*teamhandbook/i;
function linesThatGo(before, after) {
  const kept = Array.from({ length: before.length + 1 }, () => new Uint32Array(after.length + 1));
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      kept[i][j] = before[i] === after[j] ? kept[i + 1][j + 1] + 1 : Math.max(kept[i + 1][j], kept[i][j + 1]);
    }
  }
  const gone = [];
  for (let i = 0, j = 0; i < before.length; ) {
    if (j < after.length && before[i] === after[j]) {
      i++;
      j++;
    } else if (j < after.length && kept[i][j + 1] >= kept[i + 1][j]) {
      j++;
    } else {
      if (before[i].trim()) gone.push(before[i]);
      i++;
    }
  }
  return gone;
}
function mergeReadme(existing, fresh) {
  if (existing === null) return { content: fresh };
  const pieces = existing.split(/(\r?\n)/);
  const lines = pieces.filter((_, index) => index % 2 === 0);
  const ends = pieces.filter((_, index) => index % 2 === 1);
  const crlf = ends.filter((end) => end === "\r\n").length;
  const eol = crlf > ends.length - crlf ? "\r\n" : "\n";
  const next = fresh.split("\n");
  const theirs = productSection(lines);
  const ours = productSection(next);
  if (theirs && ours) {
    const section = next.slice(ours.begin, ours.end + 1);
    const inside = linesThatGo(lines.slice(theirs.begin, theirs.end + 1), section);
    const kept = (from, to) => lines.slice(from, to).map((line, at) => line + (ends[from + at] ?? "")).join("");
    const written = section.map((line, at) => line + (at < section.length - 1 ? eol : ends[theirs.end] ?? "")).join("");
    return {
      content: kept(0, theirs.begin) + written + kept(theirs.end + 1, lines.length),
      ...inside.length ? { inside } : {}
    };
  }
  const marked = lines.some((line) => MARKER_LIKE.test(line.trim()));
  return { content: next.join(eol), whole: { reason: marked ? "broken" : "unmarked", lost: linesThatGo(lines, next) } };
}
function upgradeCandidates(repoDir, team, branchExample, assignment = {}, commitPrefix, commitVersioning = false) {
  const withCi = existsSync4(join7(repoDir, CI_MARKER));
  const recordedExample = readTeamBranchExample(repoDir);
  const example = branchExample ?? recordedExample.example;
  const rawExample = readTeamFileObject(repoDir)?.branchExample;
  const exampleProblem = branchExample !== void 0 || rawExample === void 0 ? null : recordedExample.problem ?? (typeof rawExample === "string" ? null : "not a branch name");
  const { recorded: lists, unreadable } = readRecordedAssignment(repoDir);
  const assigned = { ...lists, ...assignment };
  const uncarried = unreadable.filter((kind) => assignment[kind] === void 0);
  const recordedPrefix = readTeamCommitPrefix(repoDir);
  const recorded = recordedPrefix.prefix;
  const rawPrefix = readTeamFileObject(repoDir)?.commitPrefix;
  const prefixProblem = commitPrefix !== void 0 || rawPrefix === void 0 ? null : recordedPrefix.problem ?? (typeof rawPrefix === "string" ? null : "not a prefix");
  const prefix = commitPrefix?.trim() ?? recorded ?? team.commitPrefix?.trim() ?? "";
  const generated = skeletonFiles(
    team.marketplaceName,
    team.repoUrl,
    hostFromUrl(team.repoUrl),
    prefix,
    withCi,
    example,
    assigned,
    void 0,
    commitVersioning ? void 0 : readPluginVersion(repoDir)
  );
  const known = commitPrefix !== void 0 || recorded !== void 0 || commitPrefixIsKnown(team);
  const unknownPrefix = known ? /* @__PURE__ */ new Set() : prefixDependentPaths(team, withCi);
  const files = {};
  const linked = [];
  const withheld = [];
  let readmeWhole;
  let readmeInside;
  for (const [path, content] of Object.entries(generated)) {
    if (isTeamOwned(path)) continue;
    const link = symlinkOnPath(repoDir, path);
    if (link) {
      linked.push({
        path,
        reason: `the repository carries a symbolic link at "${link}". Nothing in the scaffold is a link, so this is not a file a refresh can write, and following it would write outside the repository.`
      });
      continue;
    }
    if (path === TEAM_PREFIX_FILE && (uncarried.length || exampleProblem || prefixProblem)) {
      const held = [
        ...prefixProblem ? [`its "commitPrefix" is ${prefixProblem}`] : [],
        ...uncarried.length ? [`it holds ${uncarried.map((kind) => `"${kind}"`).join(" and ")} as something other than a list of names`] : [],
        // Described, never quoted, for the reason branchTrace gives.
        ...exampleProblem ? [`its "branchExample" is ${exampleProblem}`] : []
      ];
      const flags = [
        ...prefixProblem ? ["--commit-prefix"] : [],
        ...uncarried.map((kind) => `--${kind}`),
        ...exampleProblem ? ["--branch-example"] : []
      ];
      withheld.push({
        path,
        reason: `${held.join(", and ")}, so regenerating it would delete what the team recorded there. Correct it in the repository by hand, or record a new one on the same run with ${flags.join(" and ")}.`
      });
      continue;
    }
    if (unknownPrefix.has(path)) {
      withheld.push({
        path,
        reason: `it embeds the team's commit-message prefix, and neither this machine nor the repository records what it is - only the machine that ran /handbook:init was ever told. Regenerating it here would write the file with no prefix at all, which is a different answer from the team's, so it is not offered on this machine. Anyone who knows the prefix the team's forge requires can give it with --commit-prefix "<prefix>" on the plan and again on the run that sends it.`
      });
      continue;
    }
    if (path === "README.md") {
      const readme = mergeReadme(readIfPresent(join7(repoDir, path)), content);
      files[path] = readme.content;
      if (readme.whole) readmeWhole = readme.whole;
      if (readme.inside) readmeInside = readme.inside;
      continue;
    }
    const merged = path === PLUGIN_MANIFEST ? mergePluginManifest(readIfPresent(join7(repoDir, path)), content, commitVersioning) : path === MARKETPLACE_MANIFEST ? mergeMarketplaceManifest(readIfPresent(join7(repoDir, path)), content) : path === TEAM_PREFIX_FILE ? mergeTeamFile(readIfPresent(join7(repoDir, path)), content) : content;
    if (merged !== null) files[path] = merged;
  }
  return { files, linked, withheld, ...readmeWhole ? { readmeWhole } : {}, ...readmeInside ? { readmeInside } : {} };
}
var REFRESH_COMMIT_TITLE = "chore: refresh the team handbook scaffold";
function recordsAsked(choice) {
  return choice.branchExample !== void 0 || choice.reviewers !== void 0 || choice.labels !== void 0;
}
function assignmentAsked(choice) {
  return {
    ...choice.reviewers !== void 0 ? { reviewers: choice.reviewers } : {},
    ...choice.labels !== void 0 ? { labels: choice.labels } : {}
  };
}
var REFRESH_SLUG = "refresh-scaffold";
function classify(repoDir, candidates) {
  return Object.entries(candidates).map(([path, content]) => {
    const existing = readIfPresent(join7(repoDir, path));
    if (existing === null) return { path, state: "absent" };
    return { path, state: existing === content ? "current" : "differs" };
  });
}
function refreshable(files) {
  return files.filter((file) => file.state !== "current").map((file) => file.path);
}
function unreadableManifests(repoDir, candidates) {
  const explained = new Set([...candidates.linked, ...candidates.withheld].map((file) => file.path));
  return [PLUGIN_MANIFEST, MARKETPLACE_MANIFEST, TEAM_PREFIX_FILE].filter(
    (path) => !(path in candidates.files) && !explained.has(path) && readIfPresent(join7(repoDir, path)) !== null
  );
}
function versionPlan(repoDir, toCommit = false) {
  const raw = readIfPresent(join7(repoDir, PLUGIN_MANIFEST));
  if (raw === null) {
    return {
      blocked: existsSync4(join7(repoDir, CI_MARKER)) ? `the repository has no ${PLUGIN_MANIFEST}, so there is no version to raise. Sending that file adds it at 0.1.0, the version the repository's version-bump job raises from.` : `the repository has no ${PLUGIN_MANIFEST}, so there is no version to raise. Sending that file adds it without one, and from then on the repository is versioned by commit.`
    };
  }
  const manifest = parseObject(raw);
  if (!manifest) {
    return { blocked: `${PLUGIN_MANIFEST} in this repository is not valid JSON, so the refresh cannot read a version there or raise one.` };
  }
  const current = typeof manifest.version === "string" ? manifest.version : void 0;
  if (manifest.version === void 0 || toCommit) return { ...current ? { current } : {}, byCommit: true };
  const parts = (current ?? "").split(".").map(Number);
  if (!current || parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
    return {
      ...current ? { current } : {},
      blocked: `the plugin version ${JSON.stringify(manifest.version)} is not a three-part MAJOR.MINOR.PATCH number, so it cannot be raised - and without a raise, no teammate's copy refreshes for this. Set a three-part version in ${PLUGIN_MANIFEST} by hand first.`
    };
  }
  return { current, next: [parts[0], parts[1], (parts[2] ?? 0) + 1].join(".") };
}
function cloneForUpgrade(git, team, repoDir, workdir) {
  try {
    git(["clone", "--depth", "1", "--", team.repoUrl, repoDir], workdir);
  } catch (err) {
    return `git clone failed (is ${team.repoUrl} reachable?): ${String(err instanceof Error ? err.message : err)}`;
  }
  if (!existsSync4(join7(repoDir, MARKETPLACE_MANIFEST))) {
    return `${team.repoUrl} carries no ${MARKETPLACE_MANIFEST}, so it is not a handbook this can refresh. Check the repository in your config, or run /handbook:init against a repository that should become one.`;
  }
  return null;
}
function writeCandidates(repoDir, candidates, paths) {
  for (const path of paths) {
    const link = symlinkOnPath(repoDir, path);
    if (link) {
      return `"${path}" cannot be written: the repository carries a symbolic link at "${link}", and following it would write outside the repository. Nothing was changed.`;
    }
  }
  for (const path of paths) {
    const target = join7(repoDir, path);
    mkdirSync5(dirname6(target), { recursive: true });
    writeFileSync4(target, candidates[path]);
  }
  return null;
}
function stage(git, repoDir, paths) {
  git(["add", "-A"], repoDir);
  const staged = new Set(
    String(git(["diff", "--cached", "--name-only"], repoDir) ?? "").split("\n").map((line) => line.trim()).filter(Boolean)
  );
  return { missing: paths.filter((path) => !staged.has(path)) };
}
function ignoredPathsMessage(missing) {
  return `${missing.join(", ")} cannot be committed to this repository - git refused to stage it, which a \`.gitignore\` rule in the team repo is what normally does. Nothing was changed. Take that path out of the repository's .gitignore, or leave it out of the refresh.`;
}
function trackedModes(git, repoDir) {
  const modes = /* @__PURE__ */ new Map();
  try {
    for (const line of String(git(["ls-files", "--stage"], repoDir) ?? "").split("\n")) {
      const match = line.match(/^(\d{6}) [0-9a-f]+ \d\t(.*)$/);
      if (match) modes.set(match[2], match[1]);
    }
  } catch {
  }
  return modes;
}
function checkIgnore(git, repoDir, paths) {
  try {
    return String(git(["check-ignore", "--", ...paths], repoDir) ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}
function planUpgrade(team, git = runGit, forge = runForge, choice = {}) {
  try {
    assertSafeGitUrl(team.repoUrl);
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err) };
  }
  const prefixError = commitPrefixFlagError(choice.commitPrefix);
  if (prefixError) return { ok: false, error: prefixError };
  const workdir = handbookWorkdir("handbook-upgrade-");
  const repoDir = join7(workdir, "repo");
  const scratch = join7(workdir, "candidate");
  try {
    const cloneError = cloneForUpgrade(git, team, repoDir, workdir);
    if (cloneError) return { ok: false, error: cloneError };
    const running = refreshingRelease(repoDir);
    if ("error" in running) return { ok: false, error: running.error };
    const exampleError = branchExampleError(choice.branchExample, git, repoDir);
    if (exampleError) return { ok: false, error: exampleError };
    const versioningError = commitVersioningError(choice, repoDir);
    if (versioningError) return { ok: false, error: versioningError };
    const candidates = upgradeCandidates(
      repoDir,
      team,
      choice.branchExample,
      assignmentAsked(choice),
      choice.commitPrefix,
      choice.commitVersioning
    );
    const files = classify(repoDir, candidates.files);
    const paths = refreshable(files);
    const unreadable = unreadableManifests(repoDir, candidates);
    const pushPrefix = refreshPushPrefix(team, choice, repoDir);
    const proposedMessage = commitSubject(pushPrefix.prefix, REFRESH_COMMIT_TITLE);
    const preview = previewPush(git, forge, repoDir, pushPrefix.team, REFRESH_SLUG, choice.hints);
    const versionClaim = choice.commitVersioning ? null : versionClaimProblem(preview, "run the refresh again");
    const openRaises = choice.commitVersioning ? preview.claims.map((claim) => `"${claim.branch}" (${claim.version})`) : [];
    const answer = branchAnswer(choice, preview, git, repoDir, "run the refresh again");
    const branch = choice.branch !== void 0 && !answer.said ? { branch: choice.branch } : answer.shown;
    const branchProblem = choice.branch !== void 0 || !answer.shown ? answer.said : null;
    const plan = {
      ok: true,
      url: team.repoUrl,
      files,
      withCi: existsSync4(join7(repoDir, CI_MARKER)),
      version: versionPlan(repoDir, choice.commitVersioning),
      proposedMessage,
      proposalHash: proposalFingerprint(proposedMessage),
      stamp: scaffoldStamp(repoDir, candidates, running.release),
      ...choice.commitPrefix !== void 0 ? { commitPrefix: choice.commitPrefix.trim() } : {},
      ...choice.commitVersioning ? { commitVersioning: true, marketplaceName: team.marketplaceName } : {},
      ...branch ? { branch } : {},
      ...branchProblem ? { branchProblem } : {},
      ...preview.forgeProblem ? { forgeProblem: preview.forgeProblem } : {},
      ...versionClaim ? { versionClaim } : {},
      ...openRaises.length ? { openRaises } : {},
      ...!choice.branchExample && !readTeamBranchExample(repoDir).example ? { asksBranchExample: true } : {},
      ...candidates.linked.length ? { linked: candidates.linked } : {},
      ...candidates.withheld.length ? { withheld: candidates.withheld } : {},
      ...unreadable.length ? { unreadable } : {},
      ...candidates.readmeWhole && paths.includes("README.md") ? { readmeWhole: candidates.readmeWhole } : {},
      ...candidates.readmeInside && paths.includes("README.md") ? { readmeInside: candidates.readmeInside } : {}
    };
    if (!paths.length) return plan;
    try {
      const ignored = checkIgnore(git, repoDir, paths);
      if (ignored.length) plan.ignored = ignored;
      const modes = trackedModes(git, repoDir);
      const cacheinfo = [];
      for (const path of paths) {
        const file = join7(scratch, path);
        mkdirSync5(dirname6(file), { recursive: true });
        writeFileSync4(file, candidates.files[path]);
        const sha = String(git(["hash-object", "-w", "--", file], repoDir) ?? "").trim();
        cacheinfo.push("--cacheinfo", `${modes.get(path) ?? "100644"},${sha},${path}`);
      }
      git(["update-index", "--add", ...cacheinfo], repoDir);
      plan.stat = String(git(["diff", "--cached", "--stat"], repoDir) ?? "").trimEnd();
      plan.diff = String(git(["diff", "--cached"], repoDir) ?? "");
    } catch {
    }
    return plan;
  } finally {
    removeWorkdir(workdir);
  }
}
function refreshPushPrefix(team, choice, repoDir) {
  if (choice.commitPrefix === void 0) return commitPrefixForPush(team, repoDir);
  const given = choice.commitPrefix.trim();
  return { team: { ...team, commitPrefix: given }, prefix: commitMessagePrefix(given), source: "flag" };
}
var SHELL_ACTIVE = /["`$\\!]/;
function commitPrefixFlagError(prefix) {
  if (prefix === void 0) return null;
  if (!prefix.trim()) {
    return "--commit-prefix needs the prefix the team's forge requires; an empty one is not something this records. Nothing was changed.";
  }
  const problem = commitPrefixProblem(prefix.trim()) ?? (SHELL_ACTIVE.test(prefix) ? "carrying a quote, a backtick, a dollar sign, a backslash or an exclamation mark" : null);
  return problem ? `that commit-message prefix cannot be used: it is ${problem}. Nothing was changed.` : null;
}
function branchExampleError(example, git, repoDir) {
  if (example === void 0) return null;
  const problem = branchNameProblem(example, git, repoDir);
  if (!problem) return null;
  const named = branchTrace(example) ? "that example" : `"${example}"`;
  return `${named} cannot be recorded as the example branch name: ${problem}. Nothing was changed.`;
}
function commitVersioningError(choice, repoDir) {
  if (!choice.commitVersioning) return null;
  if (existsSync4(join7(repoDir, CI_MARKER))) {
    return `--commit-versioning cannot be used while this repository runs the version-bump job: ${CI_MARKER} raises the version on every merge and fails on a manifest without one. Take the job and that script out of the repository first. Nothing was changed.`;
  }
  if (versionedByCommit(repoDir)) {
    return `this repository is already versioned by commit: ${PLUGIN_MANIFEST} carries no version, so --commit-versioning has nothing to take out. Nothing was changed.`;
  }
  if (versionPlan(repoDir).current === void 0) {
    return `--commit-versioning takes the version line out of ${PLUGIN_MANIFEST}, and this repository has no such file with a version this can read. Nothing was changed.`;
  }
  return null;
}
function applyUpgrade(team, paths, git = runGit, forge = runForge, commitMessage = {}, choice = {}) {
  if (!paths.length && !recordsAsked(choice) && !choice.commitVersioning) {
    return { ok: false, error: "no file was named, so nothing was refreshed and nothing was pushed" };
  }
  const assignmentProblem = assignmentRecordProblem(assignmentAsked(choice));
  if (assignmentProblem) return { ok: false, error: assignmentProblem };
  const prefixError = commitPrefixFlagError(choice.commitPrefix);
  if (prefixError) return { ok: false, error: prefixError };
  try {
    assertSafeGitUrl(team.repoUrl);
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err) };
  }
  const identity = gitIdentityArgs(git);
  if (!identity) {
    return {
      ok: false,
      error: 'git user.name/user.email is not set - the refresh commit would have an author your forge is likely to reject. Run `git config --global user.name "Your Name"` and `git config --global user.email you@example.com`, then try again.'
    };
  }
  const workdir = handbookWorkdir("handbook-upgrade-");
  const repoDir = join7(workdir, "repo");
  try {
    const cloneError = cloneForUpgrade(git, team, repoDir, workdir);
    if (cloneError) return { ok: false, error: cloneError };
    const running = refreshingRelease(repoDir);
    if ("error" in running) return { ok: false, error: running.error };
    const exampleError = branchExampleError(choice.branchExample, git, repoDir);
    if (exampleError) return { ok: false, error: exampleError };
    const versioningError = commitVersioningError(choice, repoDir);
    if (versioningError) return { ok: false, error: versioningError };
    const candidates = upgradeCandidates(
      repoDir,
      team,
      choice.branchExample,
      assignmentAsked(choice),
      choice.commitPrefix,
      choice.commitVersioning
    );
    const states = new Map(classify(repoDir, candidates.files).map((file) => [file.path, file.state]));
    if (recordsAsked(choice) && !paths.includes(TEAM_PREFIX_FILE) && states.get(TEAM_PREFIX_FILE) !== "current") {
      paths = [...paths, TEAM_PREFIX_FILE];
    }
    if (choice.commitVersioning && !paths.includes(PLUGIN_MANIFEST)) paths = [...paths, PLUGIN_MANIFEST];
    if (!paths.length) {
      return { ok: false, error: `${TEAM_PREFIX_FILE} already records that, so nothing was changed.` };
    }
    for (const path of paths) {
      const withheld = [...candidates.linked, ...candidates.withheld].find((file) => file.path === path);
      if (withheld) return { ok: false, error: `"${path}" is not offered here: ${withheld.reason}` };
      if (!(path in candidates.files)) {
        return {
          ok: false,
          error: `"${path}" is not a scaffold file this can refresh. Run the plan again and copy a path from it; the team's own skills, commands and MCP settings are never touched.`
        };
      }
      if (states.get(path) === "current") {
        return { ok: false, error: `"${path}" already matches this version, so nothing was changed.` };
      }
    }
    const version = versionPlan(repoDir, choice.commitVersioning);
    const stamp = scaffoldStamp(repoDir, candidates, running.release);
    const stamps = !stamp.blocked && (!stamp.ifSent || paths.includes(TEAM_PREFIX_FILE));
    const title = REFRESH_COMMIT_TITLE;
    const pushPrefix = refreshPushPrefix(team, choice, repoDir);
    const messagePrefix = pushPrefix.prefix;
    const decided = decidePush({
      git,
      forge,
      repoDir,
      team: pushPrefix.team,
      slug: REFRESH_SLUG,
      // The switch raises nothing, so an open branch's number is not one it can collide with.
      choice: choice.commitVersioning ? { ...choice, versionAfterOpen: true } : choice,
      message: commitMessage,
      proposedMessage: commitSubject(messagePrefix, title),
      messagePrefix,
      rerun: "run the refresh again"
    });
    if (!decided.ok) return decided;
    const { branch } = decided;
    let pushed;
    let raised = null;
    let byCommit = false;
    let written = paths;
    try {
      git(["checkout", "-b", branch], repoDir);
      const writeError = writeCandidates(repoDir, candidates.files, paths);
      if (writeError) return { ok: false, error: writeError };
      if (stamps && stampScaffoldVersion(repoDir, running.release) && !paths.includes(TEAM_PREFIX_FILE)) {
        written = [...paths, TEAM_PREFIX_FILE];
      }
      if (version.next) raised = bumpPluginVersion(repoDir, decided.claims);
      byCommit = versionedByCommit(repoDir);
      const { missing } = stage(git, repoDir, written);
      if (missing.length) return { ok: false, error: ignoredPathsMessage(missing) };
      git([...identity, "commit", "-m", decided.subject], repoDir);
      pushed = pushBranch(
        git,
        repoDir,
        branch,
        requestPushOptions(team.repoUrl, decided.forgeProblem, decided.subject, readTeamAssignment(repoDir).assignment.labels)
      );
    } catch (err) {
      return {
        ok: false,
        ...pushFailure(
          team.repoUrl,
          branch,
          decided.subject,
          err,
          "run the refresh again",
          // The one route that works on this run whoever recorded what: a refresh takes the
          // prefix the forge requires as a flag, and the files it writes record it.
          `${teamCommitPrefixFix(pushPrefix.team, "run this again", pushPrefix.source)} ${pushPrefix.source === "flag" ? "Run" : "Or run"} the refresh again with --commit-prefix "<the prefix the rule requires>", which this commit and the files it refreshes carry.`
        )
      };
    }
    const removed = byCommit && version.current !== void 0;
    const request = openRequest(
      team.repoUrl,
      branch,
      title,
      [
        "Refreshes the scaffold files this repository received from `/handbook:init` to the version",
        "TeamHandbook ships today. Nothing under `skills/`, `commands/`, `agents/` or `.mcp.json` is",
        "touched; in the two manifests the team's own entries are carried across.",
        "",
        ...raised ? ["The plugin version is raised rather than reset, so teammates' copies pick this up."] : removed ? [
          "This takes the version line out of `.claude-plugin/plugin.json`: from this merge on the",
          "repository is versioned by commit, and every merge reaches teammates' copies when their",
          "marketplace updates. Open requests that raise the version conflict with this one; merge or",
          "close them first."
        ] : byCommit ? ["The repository is versioned by commit, so this merge is what teammates' copies update to."] : ["The plugin version is not raised: " + (version.blocked ?? "nothing here can raise it.")],
        "",
        "Files in this request:",
        ...written.map((path) => `- \`${path}\``),
        "",
        "Opened by TeamHandbook."
      ].join("\n"),
      repoDir,
      forge,
      decided.forgeProblem,
      pushed
    );
    return {
      ok: true,
      url: team.repoUrl,
      refreshed: written,
      branch,
      commitMessage: decided.subject,
      ...raised ? { version: raised } : {},
      ...removed ? { versionLineRemoved: true } : {},
      ...byCommit ? { versionedByCommit: true } : {},
      ...raised || byCommit ? {} : version.blocked ? { versionNotRaised: version.blocked } : {},
      ...stamps ? {} : { scaffoldNotRecorded: stampMissing(stamp) },
      ...request
    };
  } finally {
    removeWorkdir(workdir);
  }
}
function withheldLines(files) {
  return files.flatMap((file) => [`  ${"NOT OFFERED".padEnd(16)} ${file.path}`, `                   ${file.reason}`]);
}
function refreshAudience(plan) {
  const files = plan.files ?? [];
  if (files.some((file) => file.path === PLUGIN_MANIFEST && file.state === "absent")) {
    return `Teammates receive nothing you share until this is merged: the repository has no ${PLUGIN_MANIFEST}, so no share can raise the version their copies update on.`;
  }
  const paths = refreshable(files);
  const who = [
    ...paths.includes(TEAM_PREFIX_FILE) ? ["teammates who join after you"] : [],
    ...paths.some((path) => path.startsWith("hooks/")) ? ["the notice teammates see when new skills arrive"] : [],
    ...paths.includes("README.md") ? ["people reading the repository's README"] : [],
    ...plan.commitVersioning ? ["how every merge reaches teammates' copies"] : [],
    ...paths.some((path) => path.startsWith(".claude-plugin/")) ? ["how the plugin is described in teammates' plugin list"] : [],
    ...paths.some((path) => path === CI_MARKER || path.endsWith(".yml")) ? ["the repository's version-bump job"] : []
  ];
  const listed = who.length <= 1 ? who.join("") : `${who.slice(0, -1).join(", ")} and ${who.at(-1)}`;
  return `This only matters to ${listed || "the scaffold itself"}; you can skip it and keep sharing.`;
}
function formatUpgradePlan(plan) {
  const files = plan.files ?? [];
  const paths = refreshable(files);
  const lines = [...paths.length ? [refreshAudience(plan), ""] : [], `Team handbook scaffold at ${plan.url}`, ""];
  for (const file of files) {
    const label = file.state === "current" ? "up to date" : file.state === "absent" ? "NOT IN THE REPO" : "DIFFERS";
    lines.push(`  ${label.padEnd(16)} ${file.path}`);
  }
  lines.push(...withheldLines(plan.linked ?? []), ...withheldLines(plan.withheld ?? []));
  for (const path of plan.unreadable ?? []) {
    lines.push(
      `  ${"SKIPPED".padEnd(16)} ${path}`,
      "                   it is not valid JSON, so what the team put in it could not be read and",
      "                   carried across. Fix the JSON by hand and run this again."
    );
  }
  if (!paths.length) {
    lines.push("", "Nothing to refresh - every scaffold file already matches this version.", ...branchExampleQuestion(plan));
    return lines.join("\n");
  }
  lines.push(
    "",
    `${paths.length} file(s) can be refreshed. A DIFFERS file may be an old scaffold or an edit your team`,
    "made on purpose - nothing records which, so read the diff before choosing it.",
    "",
    "The team's own content is never part of this: skills/, commands/, agents/ and .mcp.json are",
    "not offered and cannot be written, and inside the two manifests the team's own entries - the",
    `${plan.commitVersioning || plan.version?.byCommit ? "fields the team added" : "plugin version"}, any extra plugins, the marketplace owner - are carried across, not replaced.`
  );
  if (plan.readmeWhole) lines.push("", ...readmeWholeLines(plan.readmeWhole));
  if (plan.readmeInside) {
    lines.push(
      "",
      "Leave README.md out to keep it as it is. Between its TeamHandbook markers these lines are not in the",
      "refreshed section and go - an older product line or one the team wrote there; outside them nothing changes:",
      ...plan.readmeInside.map((line) => `  - ${line}`)
    );
  }
  const version = plan.version ?? {};
  if (plan.commitVersioning && version.current !== void 0) {
    lines.push("", ...commitVersioningSwitch(version.current, plan.marketplaceName ?? "<marketplace>", plan.openRaises ?? []));
  } else if (version.byCommit) {
    lines.push(
      "",
      `This repository is versioned by commit: ${PLUGIN_MANIFEST} carries no version, so there is none to raise,`,
      "and the merge itself is what teammates' copies update to when their marketplace updates."
    );
  } else if (version.next) {
    lines.push(
      "",
      `The merge request also raises the plugin version, ${version.current} -> ${version.next}, the way every share does.`,
      "Without that, no teammate's copy refreshes for this."
    );
  } else if (version.blocked) {
    lines.push("", `WARNING: ${version.blocked}`);
  }
  const stamp = plan.stamp;
  if (stamp?.blocked) {
    lines.push("", `WARNING: ${stampMissing(stamp)}`);
  } else if (stamp?.ifSent) {
    lines.push(
      "",
      `Sending ${TEAM_PREFIX_FILE} also records there that TeamHandbook ${stamp.release} wrote this scaffold, so an`,
      "older copy at 0.29.0 or later refuses to refresh it back; one older than 0.29.0 does not read the record.",
      "Without that file nothing records it."
    );
  } else if (stamp) {
    lines.push(
      "",
      `It also records in ${TEAM_PREFIX_FILE} that TeamHandbook ${stamp.release} wrote this scaffold, so an older`,
      "copy at 0.29.0 or later refuses to refresh it back; one older than 0.29.0 does not read the record."
    );
  }
  if (plan.ignored?.length) {
    lines.push("", `WARNING: ${ignoredPathsMessage(plan.ignored)}`, "The diff below does not show it.");
  }
  if (plan.stat) lines.push("", plan.stat);
  if (plan.diff) lines.push("", plan.diff.trimEnd());
  lines.push(
    "",
    "Nothing has been changed, in this repository or on this machine. To send a refresh, name",
    "each file you want:",
    "",
    `  ${paths.map((path) => `--file ${path}`).join(" ")}` + (plan.commitPrefix !== void 0 ? ` --commit-prefix "${plan.commitPrefix}"` : "") + (plan.commitVersioning ? " --commit-versioning" : ""),
    ...plan.commitPrefix !== void 0 ? ["", "--commit-prefix is used for this run only and saved nowhere, so it goes on that run too."] : [],
    ...plan.commitVersioning ? ["", "--commit-versioning is used for this run only and saved nowhere, so it goes on that run too."] : []
  );
  if (plan.proposedMessage) {
    lines.push(
      "",
      pushQuestion(plan.branch ?? null, plan.proposedMessage),
      `That request goes out on that branch and commits as "${plan.proposedMessage}". Pass the branch with`,
      `--branch "<name>" - the one above, if it is confirmed - and the message with --message "<your wording>"` + (plan.forgeProblem ? "." : `, or --delegate-message ${plan.proposalHash} to use the one above as it stands - the fingerprint is what ties that answer to this exact sentence.`),
      ...plan.branchProblem ? [plan.branchProblem] : [],
      ...plan.forgeProblem ? [forgeNotice(plan.url ?? "", plan.forgeProblem)] : []
    );
  }
  if (plan.versionClaim) lines.push("", `WARNING: ${plan.versionClaim}`);
  lines.push(...branchExampleQuestion(plan));
  return lines.join("\n");
}
function commitVersioningSwitch(current, marketplace, open) {
  return [
    `This request switches the repository to versioning by commit: it takes "version": "${current}" out of`,
    `${PLUGIN_MANIFEST}, nothing raises a version after it, and every merge reaches teammates' copies when`,
    "their marketplace updates.",
    "Open requests that raise the version conflict with this commit - they change the line it deletes - so",
    "merge or close them first. One merged after it conflicts in plugin.json: keep the side without the",
    "version line.",
    ...open.length ? [`Open now: ${open.join(", ")}.`] : [],
    "Once this is merged, each teammate moves to the new scheme with:",
    `  /plugin marketplace update ${marketplace}`,
    "  /reload-plugins",
    "A TeamHandbook older than 0.31.0 still raises a version when it shares, which puts the line back:",
    "have everyone who shares to this repository update to 0.31.0 or later first (`/plugin marketplace update",
    "teamhandbook`, then `/reload-plugins`). One older than 0.29.0 also",
    `does not read "scaffoldVersion" in ${TEAM_PREFIX_FILE}, so nothing stops it refreshing this scaffold back.`
  ];
}
function readmeWholeLines(whole) {
  const why = whole.reason === "broken" ? "README.md's TeamHandbook markers are not each on a line of their own, once and in order, so a refresh replaces it whole." : "README.md carries no TeamHandbook markers, so a refresh replaces it whole.";
  return [
    why,
    "Leave README.md out to keep the file as it is.",
    ...whole.lost.length ? ["These lines go:", ...whole.lost.map((line) => `  - ${line}`)] : ["No line of the current file goes."],
    whole.reason === "broken" ? `With ${README_BEGIN} and ${README_END} each once, on lines of their own, around TeamHandbook's part, a refresh rewrites only what is between them.` : "Once the refresh that adds the markers is merged, a refresh rewrites only what is between them and everything outside stays."
  ];
}
function branchExampleQuestion(plan) {
  if (!plan.asksBranchExample) return [];
  return [
    "",
    "What does a branch name look like in this repository? e.g. TEAM-123-short-description",
    `Answer with --branch-example "<one branch name>" to record it in ${TEAM_PREFIX_FILE} for everyone, or leave it out:`,
    "branches are still proposed and confirmed one push at a time."
  ];
}
function formatUpgradeResult(result) {
  return [
    "Scaffold refresh opened.",
    "",
    `  repository:  ${result.url}`,
    `  refreshed:   ${result.refreshed?.join(", ")}`,
    `  branch:      ${result.branch}`,
    ...result.commitMessage ? [`  commit:      ${result.commitMessage}`] : [],
    ...result.version ? [`  version:     raised to ${result.version}`] : [],
    ...result.versionLineRemoved ? ["  version:     line taken out - once this is merged, the repository is versioned by commit"] : result.versionedByCommit ? ["  version:     none to raise - the repository is versioned by commit, so the merge is what teammates update to"] : [],
    ...result.versionNotRaised ? [`  version:     NOT raised. ${result.versionNotRaised}`] : [],
    ...result.scaffoldNotRecorded ? [`  scaffold:    ${result.scaffoldNotRecorded}`] : [],
    result.prUrl ? `  request:     ${result.prUrl}` : `  request:     open it here - ${result.manualUrl ?? `push ${result.branch} and open a request against the default branch`}`,
    ...result.prError ? [`               (could not open it automatically: ${result.prError})`] : [],
    "",
    "Nothing reaches anyone until that is merged.",
    ...requestNoteLines(result.requestNotes),
    ...unattachedDescriptionLines(result.unattachedDescription)
  ].join("\n");
}

// src/cli/init.ts
function usage() {
  console.error(
    "usage: init.js <git-url> [--name <marketplace-name>] [--branch-prefix <prefix>] [--commit-prefix <prefix>] [--with-ci] [--message <commit message>] [--delegate-message <fingerprint>] [--reviewers <a,b>] [--labels <a,b>]\n       init.js --upgrade [--file <scaffold-path>]... [--message <commit message>] [--delegate-message <fingerprint>] [--branch <name>] [--branch-hint <name>] [--version-after-open] [--branch-example <branch name>] [--reviewers <a,b>] [--labels <a,b>] [--commit-prefix <prefix>] [--commit-versioning]"
  );
  process.exit(2);
}
function valueOf(args, flag) {
  const at = args.indexOf(flag);
  if (at === -1) return void 0;
  const value = args[at + 1];
  if (!value || value.startsWith("--")) usage();
  return value;
}
function assignmentFrom(args) {
  const listOf = (flag) => {
    const at = args.indexOf(flag);
    if (at === -1) return void 0;
    const value = args[at + 1];
    if (value === void 0 || value.startsWith("--")) usage();
    const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
    if (!entries.length && value !== "") usage();
    return entries;
  };
  const reviewers = listOf("--reviewers");
  const labels = listOf("--labels");
  return {
    ...reviewers !== void 0 ? { reviewers } : {},
    ...labels !== void 0 ? { labels } : {}
  };
}
function commitMessageFrom(args) {
  const message = valueOf(args, "--message");
  const delegated = valueOf(args, "--delegate-message");
  return {
    ...message !== void 0 ? { message } : {},
    ...delegated !== void 0 ? { delegated } : {}
  };
}
function upgrade(args) {
  const files = [];
  const commitMessage = commitMessageFrom(args);
  const branch = valueOf(args, "--branch");
  const hint = valueOf(args, "--branch-hint");
  const branchExample = valueOf(args, "--branch-example");
  const commitPrefix = valueOf(args, "--commit-prefix");
  const assignment = assignmentFrom(args);
  const choice = {
    ...branch !== void 0 ? { branch } : {},
    ...commitPrefix !== void 0 ? { commitPrefix } : {},
    ...branchExample !== void 0 ? { branchExample } : {},
    ...assignment,
    ...args.includes("--version-after-open") ? { versionAfterOpen: true } : {},
    // Taking the version line out is a choice made for this run, never a default and never
    // saved: a refresh does not rewrite what the team has unless asked to.
    ...args.includes("--commit-versioning") ? { commitVersioning: true } : {},
    hints: branchHints(process.cwd(), runGit, hint)
  };
  for (let i = 0; i < args.length; i++) {
    if (["--upgrade", "--version-after-open", "--commit-versioning"].includes(args[i])) continue;
    const valued = [
      "--message",
      "--delegate-message",
      "--branch",
      "--branch-hint",
      "--branch-example",
      "--reviewers",
      "--labels",
      "--commit-prefix"
    ];
    if (valued.includes(args[i])) {
      i++;
      continue;
    }
    if (args[i] !== "--file") usage();
    const value = args[++i];
    if (!value || value.startsWith("--")) usage();
    files.push(value);
  }
  if (configIsBroken()) {
    console.error(
      "error: TeamHandbook's config.json is not valid JSON, so it cannot tell which repository your team uses. Fix the JSON (or delete the file) and try again."
    );
    process.exit(1);
  }
  const team = loadTeamConfig();
  if (!team) {
    console.error(
      "error: no team repository is configured, so there is no scaffold to refresh. Run /handbook:init <url> to create one, or /handbook:join <url> to point at your team's."
    );
    process.exit(1);
  }
  if (!files.length && branchExample === void 0 && !Object.keys(assignment).length) {
    const plan = planUpgrade(team, void 0, void 0, choice);
    if (!plan.ok) {
      console.error(`error: ${plan.error}`);
      process.exit(1);
    }
    console.log(formatUpgradePlan(plan));
    return;
  }
  const result = applyUpgrade(team, files, void 0, void 0, commitMessage, choice);
  if (!result.ok) {
    console.error(`error: ${result.error}`);
    process.exit(1);
  }
  console.log(formatUpgradeResult(result));
}
function main() {
  const args = process.argv.slice(2);
  if (args.includes("--upgrade")) return upgrade(args);
  let url;
  let name;
  let branchPrefix;
  let commitPrefix;
  let withCi = false;
  const commitMessage = commitMessageFrom(args);
  const assignment = assignmentFrom(args);
  for (let i = 0; i < args.length; i++) {
    if (["--message", "--delegate-message", "--reviewers", "--labels"].includes(args[i])) {
      i++;
    } else if (args[i] === "--name") {
      name = args[++i];
      if (!name) usage();
    } else if (args[i] === "--branch-prefix") {
      branchPrefix = args[++i];
      if (!branchPrefix) usage();
    } else if (args[i] === "--commit-prefix") {
      commitPrefix = args[++i];
      if (!commitPrefix) usage();
    } else if (args[i] === "--with-ci") {
      withCi = true;
    } else if (!url) {
      url = args[i];
    } else {
      usage();
    }
  }
  if (!url) usage();
  const result = initTeamRepo(
    url,
    name,
    void 0,
    void 0,
    void 0,
    void 0,
    branchPrefix,
    commitPrefix,
    withCi,
    commitMessage,
    assignment
  );
  if (!result.ok) {
    console.error(`error: ${result.error}`);
    process.exit(1);
  }
  console.log(formatInitSuccess(result));
}
main();
