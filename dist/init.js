// src/lib/config.ts
import { existsSync, readFileSync as readFileSync2 } from "node:fs";
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
import { existsSync as existsSync2, mkdirSync as mkdirSync3, readFileSync as readFileSync4, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname as dirname2, join as join4 } from "node:path";

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
function openPr(repoUrl, branch, title, body, repoDir, forge) {
  const host = hostFromUrl(repoUrl);
  try {
    const out = forgeTool(repoUrl) === "gh" ? forge("gh", ["pr", "create", "--head", branch, "--title", title, "--body", body], repoDir) : forge(
      "glab",
      ["mr", "create", "--source-branch", branch, "--title", title, "--description", body, "--yes"],
      repoDir
    );
    return { url: extractUrl(out) };
  } catch (err) {
    const e = err;
    const tool = forgeTool(repoUrl);
    let reason;
    if (e?.code === "ENOENT") reason = `the ${tool} CLI is not installed`;
    else {
      const stderr = typeof e?.stderr === "string" ? e.stderr.trim() : "";
      reason = (stderr ? stderr.split("\n").at(-1) : String(e?.message ?? err)).slice(0, 160);
    }
    return { url: null, error: reason };
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
function requestPushOptions(repoUrl, forgeProblem, title) {
  if (!forgeProblem || forgeTool(repoUrl) !== "glab" || !hostFromUrl(repoUrl)) return [];
  return ["-o", "merge_request.create", "-o", `merge_request.title=${title}`, "-o", "merge_request.remove_source_branch"];
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
function openedRequestUrl(output) {
  return output.match(/https?:\/\/\S+?\/-\/merge_requests\/\d+(?=\s|$)/)?.[0] ?? null;
}
function openRequest(repoUrl, branch, title, body, repoDir, forge, forgeProblem, pushed) {
  const manualUrl = manualPrUrl(repoUrl, branch) ?? void 0;
  if (!forgeProblem) {
    const pr = openPr(repoUrl, branch, title, body, repoDir, forge);
    return pr.url ? { prUrl: pr.url } : { manualUrl, ...pr.error ? { prError: pr.error } : {} };
  }
  if (pushed.optionsSent) {
    const url = openedRequestUrl(pushed.output);
    if (url) return { prUrl: url, unattachedDescription: body };
    return { manualUrl, prError: `${forgeProblem}, and GitLab did not report opening a request for the push` };
  }
  return { manualUrl, prError: forgeProblem };
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
    "GitLab opened the request from the push, and a push cannot carry its description. Paste this into it:",
    "",
    ...description.split("\n").map((line) => line ? `    ${line}` : "")
  ];
}

// src/lib/git-errors.ts
import { execFileSync as execFileSync3 } from "node:child_process";
function probeCredentials() {
  const run = (cmd, args) => execFileSync3(cmd, args, { encoding: "utf8", timeout: 5e3, stdio: ["ignore", "pipe", "pipe"] });
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
      `${displayPath(join4(home, "config.json"))} exists but is not valid JSON. TeamHandbook will not rewrite it, because doing so would silently discard settings you wrote - including the privacy switches, which are currently failing closed. Fix the JSON (or delete the file) and try again.`
    );
    this.name = "BrokenConfigError";
  }
};
function saveTeamConfig(team, home = handbookHome()) {
  if (configIsBroken(home)) throw new BrokenConfigError(home);
  const config = readConfigFile(home);
  config.team = team;
  writeFileAtomic(join4(home, "config.json"), JSON.stringify(config, null, 2) + "\n");
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
function readmeFor(name, url) {
  return `# ${name}

Your team's shared setup: skills, MCP servers, and slash commands your team has
approved through TeamHandbook. This repository is a Claude Code plugin marketplace;
every merge reaches all subscribed teammates automatically.

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

Every skill arrives as a merge request that also raises the version in
\`.claude-plugin/plugin.json\`. That version is Claude Code's signal that the plugin
moved: merge the request and each teammate's marketplace copy refreshes on its own.
Skills live under \`skills/\`, one directory per skill (\`SKILL.md\` plus the
\`grounded-case.json\` evidence it was distilled from).

Nothing here needs CI, an access token, or the right to push to a protected branch. If
skills also arrive by hand in this repository, \`/handbook:init --with-ci\` scaffolds a
job that bumps the version on merge instead, together with the script it runs.

This plugin ships a tiny dependency-free SessionStart hook that shows consumers a
"N new skills/servers/commands" notice; it records what it has already shown you under
\`~/.teamhandbook-consumer\` (remove it any time with \`rm -rf ~/.teamhandbook-consumer\`).
It makes no network calls and needs no TeamHandbook engine.
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
  // A merged MCP server raises the plugin version and refreshes every copy exactly as a
  // skill does. Counting only skills would make that arrive in silence: the teammate
  // would have a new server connected to their machine and no notice that it happened,
  // which is half of what this plugin promises. Both shapes seen in the field are read
  // here - a {"mcpServers": {...}} wrapper and a bare server map - and this deliberately
  // duplicates the reader in TeamHandbook's own mcp.ts, because this script ships inside
  // the team's plugin and is not allowed to import anything.
  let servers = [];
  try {
    const parsed = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
    const map = parsed && typeof parsed.mcpServers === "object" && parsed.mcpServers ? parsed.mcpServers : parsed;
    if (map && typeof map === "object") servers = Object.keys(map).sort();
  } catch {}
  // Slash commands merge the same way a skill or server does - one MR, one version bump,
  // every subscribed copy refreshed - so they get the same notice. Read directly from
  // commands/*.md rather than importing TEAM_COMMANDS_DIR, for the same reason mcp.ts is
  // not imported above: this script ships inside the team's plugin, with no dependencies.
  let commands = [];
  try {
    commands = readdirSync(join(root, "commands"), { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => e.name.slice(0, -3))
      .sort();
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
    raw = JSON.parse(readFileSync4(join4(repoDir, TEAM_PREFIX_FILE), "utf8"))?.commitPrefix;
  } catch {
    return {};
  }
  if (typeof raw !== "string") return {};
  const value = raw.trim();
  const problem = commitPrefixProblem(value);
  return problem ? { problem } : { prefix: value };
}
function skeletonFiles(name, url, host, commitPrefix = "", withCi = false, branchExample) {
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
        version: "0.1.0"
      },
      null,
      2
    ) + "\n",
    "README.md": readmeFor(name, url),
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
        comment: "Written by TeamHandbook. commitPrefix is what this project's forge requires at the front of a commit message; /handbook:join reads it, so a teammate's first share satisfies that rule instead of being refused by it."
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
    const target = join4(dir, path);
    let existing = "";
    try {
      existing = readFileSync4(target, "utf8");
    } catch {
    }
    if (existing.trim()) {
      skipped.push(path);
      continue;
    }
    mkdirSync3(dirname2(target), { recursive: true });
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
    NO_COLOR: "1"
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
function teamCommitPrefixFix(team, retry) {
  const known = team.commitPrefix?.trim();
  if (known === "") {
    return `The team repository records that no prefix is needed (${TEAM_PREFIX_FILE}), so this commit had none, and the rule now says otherwise. Correct "commitPrefix" in that file in the repository and run \`/handbook:join <url>\` again, which re-reads it - that is what fixes it for everyone. To unblock only this machine, set "commitPrefix" under "team" in ~/.teamhandbook/config.json, then ${retry}.`;
  }
  if (known) {
    return `The prefix this machine uses, "${known}", does not satisfy that rule. Correct "commitPrefix" under "team" in ~/.teamhandbook/config.json, and have whoever ran /handbook:init record the right one in the repository with \`/handbook:init --upgrade\` so no teammate hits this, then ${retry}.`;
  }
  return `This machine does not know the team's commit-message prefix: /handbook:join reads it from the repository, and this one does not record it (no ${TEAM_PREFIX_FILE}). Whoever ran /handbook:init can add it there once with \`/handbook:init --upgrade\`, and every share after that picks it up; or set "commitPrefix" under "team" in ~/.teamhandbook/config.json to a prefix that satisfies the rule, then ${retry}.`;
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
function initTeamRepo(url, name, home = handbookHome(), git = runGit, now = (/* @__PURE__ */ new Date()).toISOString(), forge = runForge, branchPrefix = DEFAULT_BRANCH_PREFIX, commitPrefix = "", withCi = false, commitMessage = {}) {
  if (!url.trim()) return { ok: false, error: "a git URL is required" };
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
      error: `a team repository is already configured. To bring its scaffold up to this version, run \`/handbook:init --upgrade\` - it shows what would change and writes nothing until you pick. To point at a DIFFERENT team, run /handbook:leave (or edit ${displayPath(join4(home, "config.json"))}) first.`
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
  const workdir = handbookWorkdir("handbook-init-");
  const repoDir = join4(workdir, "repo");
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
  if (existsSync2(join4(repoDir, ".claude-plugin", "marketplace.json"))) {
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
    skeletonFiles(marketplaceName, url, hostFromUrl(url), commitPrefix, withCi)
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
  if (!direct) {
    const opened = openPr(
      url,
      scaffoldBranch,
      "chore: set up the team handbook",
      `Scaffolds this repository as a Claude Code marketplace so approved skills can be distributed from it: marketplace manifest, plugin manifest${withCi ? ", the version-bump CI," : ","} and a \`skills/\` directory.

Opened by TeamHandbook.`,
      repoDir,
      forge
    );
    prUrl = opened.url;
    prError = opened.error;
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
    ...!direct && !prUrl ? { manualUrl: manualPrUrl(url, scaffoldBranch) ?? void 0 } : {}
  };
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
    `  config:      team repo saved to ${displayPath(join4(result.home ?? "", "config.json"))}`,
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
import { existsSync as existsSync4, lstatSync, mkdirSync as mkdirSync5, readFileSync as readFileSync6, rmSync as rmSync4, writeFileSync as writeFileSync4 } from "node:fs";
import { dirname as dirname3, join as join6, relative } from "node:path";

// src/lib/publish.ts
import { existsSync as existsSync3, mkdirSync as mkdirSync4, readdirSync as readdirSync2, readFileSync as readFileSync5, rmSync as rmSync3, writeFileSync as writeFileSync3 } from "node:fs";
import { join as join5 } from "node:path";
function bumpPluginVersion(repoDir, past = []) {
  const file = join5(repoDir, ".claude-plugin", "plugin.json");
  try {
    const plugin = JSON.parse(readFileSync5(file, "utf8"));
    const current = String(plugin.version ?? "0.1.0");
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
    return readFileSync6(file, "utf8");
  } catch {
    return null;
  }
}
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
function parseObject(text) {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}
function mergePluginManifest(existing, fresh) {
  if (existing === null) return fresh;
  const current = parseObject(existing);
  if (!current) return null;
  const next = JSON.parse(fresh);
  const merged = { ...current, ...next };
  if (typeof current.version === "string") merged.version = current.version;
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
function upgradeCandidates(repoDir, team, branchExample) {
  const withCi = existsSync4(join6(repoDir, CI_MARKER));
  const example = branchExample ?? readTeamBranchExample(repoDir).example;
  const recorded = commitPrefixIsKnown(team) ? void 0 : readTeamCommitPrefix(repoDir).prefix;
  const prefix = recorded ?? team.commitPrefix?.trim() ?? "";
  const generated = skeletonFiles(team.marketplaceName, team.repoUrl, hostFromUrl(team.repoUrl), prefix, withCi, example);
  const known = commitPrefixIsKnown(team) || recorded !== void 0;
  const unknownPrefix = known ? /* @__PURE__ */ new Set() : prefixDependentPaths(team, withCi);
  const files = {};
  const linked = [];
  const withheld = [];
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
    if (unknownPrefix.has(path)) {
      withheld.push({
        path,
        reason: "it embeds the team's commit-message prefix, and neither this machine nor the repository records what it is - only the machine that ran /handbook:init was ever told. Regenerating it here would write the file with no prefix at all, which is a different answer from the team's, so it is not offered on this machine."
      });
      continue;
    }
    const merged = path === PLUGIN_MANIFEST ? mergePluginManifest(readIfPresent(join6(repoDir, path)), content) : path === MARKETPLACE_MANIFEST ? mergeMarketplaceManifest(readIfPresent(join6(repoDir, path)), content) : content;
    if (merged !== null) files[path] = merged;
  }
  return { files, linked, withheld };
}
var REFRESH_COMMIT_TITLE = "chore: refresh the team handbook scaffold";
var REFRESH_SLUG = "refresh-scaffold";
function classify(repoDir, candidates) {
  return Object.entries(candidates).map(([path, content]) => {
    const existing = readIfPresent(join6(repoDir, path));
    if (existing === null) return { path, state: "absent" };
    return { path, state: existing === content ? "current" : "differs" };
  });
}
function refreshable(files) {
  return files.filter((file) => file.state !== "current").map((file) => file.path);
}
function unreadableManifests(repoDir, candidates) {
  const explained = new Set([...candidates.linked, ...candidates.withheld].map((file) => file.path));
  return [PLUGIN_MANIFEST, MARKETPLACE_MANIFEST].filter(
    (path) => !(path in candidates.files) && !explained.has(path) && readIfPresent(join6(repoDir, path)) !== null
  );
}
function versionPlan(repoDir) {
  const raw = readIfPresent(join6(repoDir, PLUGIN_MANIFEST));
  const manifest = raw === null ? null : parseObject(raw);
  const current = manifest && typeof manifest.version === "string" ? manifest.version : void 0;
  if (!current) {
    return {
      blocked: `${PLUGIN_MANIFEST} in this repository declares no version this can read, so the refresh cannot raise one and no teammate's copy will pick it up. Refreshing that file itself puts a version there, and every refresh after it raises that.`
    };
  }
  const parts = current.split(".").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
    return {
      current,
      blocked: `the plugin version "${current}" is not a three-part MAJOR.MINOR.PATCH number, so it cannot be raised - and without a raise, no teammate's copy refreshes for this. Set a three-part version in ${PLUGIN_MANIFEST} by hand first.`
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
  if (!existsSync4(join6(repoDir, MARKETPLACE_MANIFEST))) {
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
    const target = join6(repoDir, path);
    mkdirSync5(dirname3(target), { recursive: true });
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
  const workdir = handbookWorkdir("handbook-upgrade-");
  const repoDir = join6(workdir, "repo");
  const scratch = join6(workdir, "candidate");
  try {
    const cloneError = cloneForUpgrade(git, team, repoDir, workdir);
    if (cloneError) return { ok: false, error: cloneError };
    const exampleError = branchExampleError(choice.branchExample, git, repoDir);
    if (exampleError) return { ok: false, error: exampleError };
    const candidates = upgradeCandidates(repoDir, team, choice.branchExample);
    const files = classify(repoDir, candidates.files);
    const paths = refreshable(files);
    const unreadable = unreadableManifests(repoDir, candidates);
    const preview = previewPush(git, forge, repoDir, team, REFRESH_SLUG, choice.hints);
    const versionClaim = versionClaimProblem(preview, "run the refresh again");
    const answer = branchAnswer(choice, preview, git, repoDir, "run the refresh again");
    const branch = choice.branch !== void 0 && !answer.said ? { branch: choice.branch } : answer.shown;
    const branchProblem = choice.branch !== void 0 || !answer.shown ? answer.said : null;
    const plan = {
      ok: true,
      url: team.repoUrl,
      files,
      withCi: existsSync4(join6(repoDir, CI_MARKER)),
      version: versionPlan(repoDir),
      proposedMessage: commitSubject(teamCommitPrefix(team), REFRESH_COMMIT_TITLE),
      proposalHash: proposalFingerprint(commitSubject(teamCommitPrefix(team), REFRESH_COMMIT_TITLE)),
      ...branch ? { branch } : {},
      ...branchProblem ? { branchProblem } : {},
      ...preview.forgeProblem ? { forgeProblem: preview.forgeProblem } : {},
      ...versionClaim ? { versionClaim } : {},
      ...!choice.branchExample && !readTeamBranchExample(repoDir).example ? { asksBranchExample: true } : {},
      ...candidates.linked.length ? { linked: candidates.linked } : {},
      ...candidates.withheld.length ? { withheld: candidates.withheld } : {},
      ...unreadable.length ? { unreadable } : {}
    };
    if (!paths.length) return plan;
    try {
      const ignored = checkIgnore(git, repoDir, paths);
      if (ignored.length) plan.ignored = ignored;
      const modes = trackedModes(git, repoDir);
      const cacheinfo = [];
      for (const path of paths) {
        const file = join6(scratch, path);
        mkdirSync5(dirname3(file), { recursive: true });
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
    rmSync4(workdir, { recursive: true, force: true });
  }
}
function branchExampleError(example, git, repoDir) {
  if (example === void 0) return null;
  const problem = branchNameProblem(example, git, repoDir);
  if (!problem) return null;
  const named = branchTrace(example) ? "that example" : `"${example}"`;
  return `${named} cannot be recorded as the example branch name: ${problem}. Nothing was changed.`;
}
function applyUpgrade(team, paths, git = runGit, forge = runForge, commitMessage = {}, choice = {}) {
  if (!paths.length && choice.branchExample === void 0) {
    return { ok: false, error: "no file was named, so nothing was refreshed and nothing was pushed" };
  }
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
  const repoDir = join6(workdir, "repo");
  try {
    const cloneError = cloneForUpgrade(git, team, repoDir, workdir);
    if (cloneError) return { ok: false, error: cloneError };
    const exampleError = branchExampleError(choice.branchExample, git, repoDir);
    if (exampleError) return { ok: false, error: exampleError };
    const candidates = upgradeCandidates(repoDir, team, choice.branchExample);
    const states = new Map(classify(repoDir, candidates.files).map((file) => [file.path, file.state]));
    if (choice.branchExample !== void 0 && !paths.includes(TEAM_PREFIX_FILE) && states.get(TEAM_PREFIX_FILE) !== "current") {
      paths = [...paths, TEAM_PREFIX_FILE];
    }
    if (!paths.length) {
      return { ok: false, error: `${TEAM_PREFIX_FILE} already records that example, so nothing was changed.` };
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
    const version = versionPlan(repoDir);
    const title = REFRESH_COMMIT_TITLE;
    const messagePrefix = teamCommitPrefix(team);
    const decided = decidePush({
      git,
      forge,
      repoDir,
      team,
      slug: REFRESH_SLUG,
      choice,
      message: commitMessage,
      proposedMessage: commitSubject(messagePrefix, title),
      messagePrefix,
      rerun: "run the refresh again"
    });
    if (!decided.ok) return decided;
    const { branch } = decided;
    let pushed;
    let raised = null;
    try {
      git(["checkout", "-b", branch], repoDir);
      const writeError = writeCandidates(repoDir, candidates.files, paths);
      if (writeError) return { ok: false, error: writeError };
      if (version.next) raised = bumpPluginVersion(repoDir, decided.claims);
      const { missing } = stage(git, repoDir, paths);
      if (missing.length) return { ok: false, error: ignoredPathsMessage(missing) };
      git([...identity, "commit", "-m", decided.subject], repoDir);
      pushed = pushBranch(git, repoDir, branch, requestPushOptions(team.repoUrl, decided.forgeProblem, decided.subject));
    } catch (err) {
      return {
        ok: false,
        ...pushFailure(team.repoUrl, branch, decided.subject, err, "run the refresh again", teamCommitPrefixFix(team, "run this again"))
      };
    }
    const request = openRequest(
      team.repoUrl,
      branch,
      title,
      [
        "Refreshes the scaffold files this repository received from `/handbook:init` to the version",
        "TeamHandbook ships today. Nothing under `skills/`, `commands/`, `agents/` or `.mcp.json` is",
        "touched; in the two manifests the team's own entries are carried across, and the plugin",
        "version is raised rather than reset, so teammates' copies pick this up.",
        "",
        "Files in this request:",
        ...paths.map((path) => `- \`${path}\``),
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
      refreshed: paths,
      branch,
      commitMessage: decided.subject,
      ...raised ? { version: raised } : {},
      ...raised ? {} : version.blocked ? { versionNotRaised: version.blocked } : {},
      ...request
    };
  } finally {
    rmSync4(workdir, { recursive: true, force: true });
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
    "plugin version, any extra plugins, the marketplace owner - are carried across, not replaced."
  );
  const version = plan.version ?? {};
  if (version.next) {
    lines.push(
      "",
      `The merge request also raises the plugin version, ${version.current} -> ${version.next}, the way every share does.`,
      "Without that, no teammate's copy refreshes for this."
    );
  } else if (version.blocked) {
    lines.push("", `WARNING: ${version.blocked}`);
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
    `  ${paths.map((path) => `--file ${path}`).join(" ")}`
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
    ...result.versionNotRaised ? [`  version:     NOT raised. ${result.versionNotRaised}`] : [],
    result.prUrl ? `  request:     ${result.prUrl}` : `  request:     open it here - ${result.manualUrl ?? `push ${result.branch} and open a request against the default branch`}`,
    ...result.prError ? [`               (could not open it automatically: ${result.prError})`] : [],
    "",
    "Nothing reaches anyone until that is merged.",
    ...unattachedDescriptionLines(result.unattachedDescription)
  ].join("\n");
}

// src/cli/init.ts
function usage() {
  console.error(
    "usage: init.js <git-url> [--name <marketplace-name>] [--branch-prefix <prefix>] [--commit-prefix <prefix>] [--with-ci] [--message <commit message>] [--delegate-message <fingerprint>]\n       init.js --upgrade [--file <scaffold-path>]... [--message <commit message>] [--delegate-message <fingerprint>] [--branch <name>] [--branch-hint <name>] [--version-after-open] [--branch-example <branch name>]"
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
  const choice = {
    ...branch !== void 0 ? { branch } : {},
    ...branchExample !== void 0 ? { branchExample } : {},
    ...args.includes("--version-after-open") ? { versionAfterOpen: true } : {},
    hints: branchHints(process.cwd(), runGit, hint)
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--upgrade" || args[i] === "--version-after-open") continue;
    if (["--message", "--delegate-message", "--branch", "--branch-hint", "--branch-example"].includes(args[i])) {
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
  if (!files.length && branchExample === void 0) {
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
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--message" || args[i] === "--delegate-message") {
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
    commitMessage
  );
  if (!result.ok) {
    console.error(`error: ${result.error}`);
    process.exit(1);
  }
  console.log(formatInitSuccess(result));
}
main();
