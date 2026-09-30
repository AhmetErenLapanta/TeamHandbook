// src/cli/mine.ts
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

// src/lib/mine.ts
import { randomBytes, createHash } from "node:crypto";
import { basename } from "node:path";

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

// src/lib/git-log.ts
import { execFileSync } from "node:child_process";
var MAX_OUTPUT_BYTES = 1 << 28;
var defaultRunner = (args, cwd) => execFileSync("git", args, {
  cwd,
  encoding: "utf8",
  maxBuffer: MAX_OUTPUT_BYTES,
  stdio: ["ignore", "pipe", "pipe"]
});
var RECORD = "";
var FIELD = "";
function readCommits(repoPath, options = {}) {
  const run = options.run ?? defaultRunner;
  const args = [
    // Without this git octal-escapes any path outside ASCII, so those files would cluster as
    // separate roles from their plain-ASCII siblings.
    "-c",
    "core.quotePath=false",
    "log",
    options.ref ?? "HEAD",
    "--raw",
    "--numstat",
    `--format=${RECORD}%H${FIELD}%P${FIELD}%aE${FIELD}%aI${FIELD}%s`
  ];
  if (options.noRenames) args.push("--no-renames");
  if (options.since) args.push(`--since=${options.since}`);
  return parseLog(run(args, repoPath));
}
function resolveRef(repoPath, preferred, options = {}) {
  const run = options.run ?? defaultRunner;
  for (const ref of preferred) {
    try {
      run(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repoPath);
      return ref;
    } catch {
    }
  }
  return null;
}
function isRepository(repoPath, options = {}) {
  const run = options.run ?? defaultRunner;
  try {
    run(["rev-parse", "--git-dir"], repoPath);
    return true;
  } catch {
    return false;
  }
}
function gitFailure(error) {
  const stderr = error.stderr;
  const text = stderr ? String(stderr) : error instanceof Error ? error.message : String(error);
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => line.startsWith("fatal:")) ?? lines[0] ?? "git failed";
}
function parseLog(output) {
  const commits = [];
  for (const record of output.split(RECORD)) {
    if (!record.trim()) continue;
    const newline = record.indexOf("\n");
    const header = newline === -1 ? record : record.slice(0, newline);
    const [sha, parents, authorEmail, date, ...rest] = header.split(FIELD);
    if (!sha || date === void 0) continue;
    const subject = rest.join(FIELD);
    const files = newline === -1 ? [] : parseFileBlock(record.slice(newline + 1));
    commits.push({
      sha,
      parents: (parents ?? "").split(" ").filter(Boolean),
      authorEmail: authorEmail ?? "",
      date,
      subject,
      files
    });
  }
  return commits;
}
function parseFileBlock(block) {
  const byPath = /* @__PURE__ */ new Map();
  const order = [];
  for (const line of block.split("\n")) {
    if (!line) continue;
    if (line.startsWith(":")) {
      const fields2 = line.split("	");
      const meta = fields2[0].split(" ");
      const status = meta[meta.length - 1] ?? "";
      const path = fields2[fields2.length - 1];
      if (!path) continue;
      if (!byPath.has(path)) order.push(path);
      byPath.set(path, { status, path, added: null, removed: null });
      continue;
    }
    const fields = line.split("	");
    if (fields.length < 3) continue;
    const existing = byPath.get(renamedTo(fields.slice(2).join("	")));
    if (!existing) continue;
    existing.added = fields[0] === "-" ? null : Number(fields[0]);
    existing.removed = fields[1] === "-" ? null : Number(fields[1]);
  }
  return order.map((path) => byPath.get(path));
}
function renamedTo(path) {
  const braced = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(path);
  if (braced) return `${braced[1]}${braced[3]}${braced[4]}`.replace(/\/\/+/g, "/").replace(/^\//, "");
  const arrow = path.indexOf(" => ");
  return arrow === -1 ? path : path.slice(arrow + 4);
}

// src/lib/mine.ts
var LOCK = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Gemfile\.lock|composer\.lock|go\.sum|gradle\.lockfile|deno\.lock)$/;
var BUILD = /(^|\/)(build\.gradle(\.kts)?|settings\.gradle(\.kts)?|gradle\.properties|pom\.xml|package\.json|jsr\.json|pyproject\.toml|Cargo\.toml|go\.mod|[^/]*\.toml|gradle\/wrapper\/.*|libs\.versions\.toml)$/;
var CI = /(^|\/)(\.gitlab-ci\.yml|\.github\/|Jenkinsfile|\.circleci\/|helm\/|k8s\/|deploy\/|Dockerfile[^/]*$)/;
var DOC = /(\.md|\.mdx|\.rst|\.txt|LICENSE|CHANGELOG[^/]*)$/i;
var TEST = /(^|\/)(src\/test\/|test\/|tests\/|__tests__\/|spec\/)|\.(test|spec)\.[a-z]+$|_test\.(go|py)$|Test\.(kt|java)$/;
var FORMAT_SUBJECT = /\b(ktlint|spotless|prettier|eslint|lint|format(ting)?|fmt|import order|whitespace|typo)\b/i;
var BUMP_SUBJECT = /\b(bump|upgrade|update (deps|dependencies)|dependenc(y|ies)|version|renovate|dependabot|release v?\d|chore\(release\)|sonar)\b/i;
var RELEASE_SUBJECT = /^\s*(?:(?:bump(?:ed|s)?|release[ds]?|prepare release|version)\s+(?:to\s+)?)?v?\d+\.\d+\.\d+(?:[-+.][\w.]+)?\s*$/i;
var CONFLICT_SUBJECT = /\b(resolve[sd]? (merge )?conflicts?|merge (branch|remote)|conflict)\b/i;
var REVERT_SUBJECT = /^\s*(revert|geri al)\b|\bthis reverts commit\b/i;
var ADDITIVE_SUBJECT = /\b(add|feat|new|endpoint|field|alan|ekle)\b/i;
var CLASSIFY_DEFAULTS = {
  massChangeFiles: 80,
  massRenameFiles: 20,
  formatMinFiles: 5,
  formatMaxLinesPerFile: 3
};
function classifyCommit(commit, options = {}) {
  const o = { ...CLASSIFY_DEFAULTS, ...options };
  if (commit.parents.length > 1) return "merge";
  if (REVERT_SUBJECT.test(commit.subject)) return "revert";
  const files = commit.files;
  const n = files.length;
  if (n === 0) return "empty";
  const paths = files.map((f) => f.path);
  if (paths.every((p) => LOCK.test(p))) return "lockfile";
  if (paths.every((p) => LOCK.test(p) || BUILD.test(p))) return "version-bump";
  if (RELEASE_SUBJECT.test(commit.subject)) return "version-bump";
  if (BUMP_SUBJECT.test(commit.subject) && paths.filter((p) => LOCK.test(p) || BUILD.test(p)).length >= n / 2) {
    return "version-bump";
  }
  if (FORMAT_SUBJECT.test(commit.subject) && !ADDITIVE_SUBJECT.test(commit.subject)) return "format";
  if (isReformat(files, o)) return "format";
  if (CONFLICT_SUBJECT.test(commit.subject)) return "merge-resolution";
  if (n >= o.massRenameFiles && files.filter((f) => f.status.startsWith("R")).length / n >= 0.5) return "mass-rename";
  if (paths.every((p) => CI.test(p))) return "ci-only";
  if (paths.every((p) => DOC.test(p))) return "docs-only";
  if (n >= o.massChangeFiles) return "mass-change";
  return "work";
}
function isReformat(files, o) {
  if (files.length < o.formatMinFiles) return false;
  let touched = 0;
  for (const f of files) {
    if (f.status !== "M") return false;
    if (f.added === null || f.removed === null) return false;
    touched += f.added + f.removed;
  }
  return touched / files.length <= o.formatMaxLinesPerFile;
}
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
var ISSUE_NUMBER = /(?:^|[\s(])#(\d+)\b/;
var MERGE_BRANCH = /Merge branch '([^']+)'|Merge (?:remote-tracking )?branch "([^"]+)"|Merge pull request #\d+ from \S+/;
var CONVENTIONAL = /^([a-z]+)(?:\(([^)]+)\))?!?:/;
function learnTicketPrefixes(subjects, minDistinctNumbers = 5) {
  const numbers = /* @__PURE__ */ new Map();
  for (const subject of subjects) {
    for (const match of subject.matchAll(KEY_CANDIDATE)) {
      const prefix = match[1];
      if (NOT_A_TICKET.has(prefix)) continue;
      let seen = numbers.get(prefix);
      if (!seen) numbers.set(prefix, seen = /* @__PURE__ */ new Set());
      seen.add(match[2]);
    }
  }
  return new Set([...numbers].filter(([, seen]) => seen.size >= minDistinctNumbers).map(([prefix]) => prefix));
}
function conventionalParts(subject) {
  const match = CONVENTIONAL.exec(subject);
  if (!match) return null;
  return { type: match[1], scope: match[2] ?? null };
}
function unitKeyOf(commit, repo, prefixes) {
  for (const match of commit.subject.matchAll(KEY_CANDIDATE)) {
    if (prefixes.has(match[1])) return `${match[1]}-${match[2]}`;
  }
  const issue = ISSUE_NUMBER.exec(commit.subject);
  if (issue) return `${repo}#${issue[1]}`;
  return null;
}
function mergedBranchName(subject) {
  const match = MERGE_BRANCH.exec(subject);
  if (!match) return null;
  return match[1] ?? match[2] ?? null;
}
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
  const named = (path) => {
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
  const filters = options.filters ?? true;
  const compiled = filters ? compiledRoles(all, named, options.binaryPaths) : /* @__PURE__ */ new Set();
  const resolve = (path) => {
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
  resolve.mirrors = mirrors;
  resolve.templates = templates;
  resolve.compiled = compiled;
  return resolve;
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
function repoLabels(paths) {
  const segments = new Map(paths.map((p) => [p, p.replace(/\/+$/, "").split("/")]));
  const labels = /* @__PURE__ */ new Map();
  for (const path of paths) {
    const parts = segments.get(path);
    for (let depth = 1; depth <= parts.length; depth++) {
      const candidate = parts.slice(parts.length - depth).join("/");
      const collides = paths.some((other) => {
        if (other === path) return false;
        const otherParts = segments.get(other);
        return otherParts.slice(otherParts.length - depth).join("/") === candidate;
      });
      if (!collides) {
        labels.set(path, candidate);
        break;
      }
    }
    if (!labels.has(path)) labels.set(path, path);
  }
  return labels;
}
function repoFamilies(labels, minMembers = 3) {
  const all = [...labels];
  const bySuffix = /* @__PURE__ */ new Map();
  for (const label of all) {
    const name = basename(label);
    if (!name.includes("-")) continue;
    const suffix = name.slice(name.lastIndexOf("-") + 1);
    bySuffix.set(suffix, (bySuffix.get(suffix) ?? 0) + 1);
  }
  const families = /* @__PURE__ */ new Map();
  for (const label of all) {
    const name = basename(label);
    const suffix = name.includes("-") ? name.slice(name.lastIndexOf("-") + 1) : null;
    families.set(label, suffix && (bySuffix.get(suffix) ?? 0) >= minMembers ? `*-${suffix}` : label);
  }
  return families;
}
var MINE_DEFAULTS = {
  minRecurrence: 8,
  minProposers: 5,
  // What the cut was while it was derived, 0.6 of a floor of 8 rounded up, so decoupling it left
  // the calibrated output unchanged.
  rareRoleUnits: 5,
  minRoles: 3,
  coreShare: 0.6,
  similarity: 0.5,
  hubShare: 0.2,
  dedupeOverlap: 0.5,
  variantOverlap: 0.4,
  containment: 0.8,
  unitShare: 0.25,
  minDistinctRoles: 0,
  minTicketNumbers: 5,
  limit: 200
};
var UMBRELLA_DAYS = 180;
var UMBRELLA_COMMITS = 5;
var PREFERRED_REFS = ["origin/master", "origin/main", "master", "main", "HEAD"];
function mineShapes(repoPaths, options = {}) {
  return shapesFromUnits(collectUnits(repoPaths, options), options);
}
function collectUnits(repoPaths, options = {}) {
  const started = Date.now();
  const labels = repoLabels(repoPaths);
  const salt = randomBytes(16);
  const commitsByRepo = /* @__PURE__ */ new Map();
  const unreadable = [];
  let commitCount = 0;
  for (const repoPath of repoPaths) {
    const read = readRepository(repoPath, options);
    if ("reason" in read) {
      unreadable.push({ path: repoPath, reason: read.reason });
      continue;
    }
    commitsByRepo.set(labels.get(repoPath), read.commits);
    commitCount += read.commits.length;
  }
  const prefixes = learnTicketPrefixes(
    [...commitsByRepo.values()].flatMap((commits) => commits.map((c) => c.subject)),
    options.minTicketNumbers ?? MINE_DEFAULTS.minTicketNumbers
  );
  const excludedCommits = {};
  const units = /* @__PURE__ */ new Map();
  const allAuthors = /* @__PURE__ */ new Set();
  const allPaths = /* @__PURE__ */ new Set();
  const textPaths = /* @__PURE__ */ new Set();
  const excludedOnly = /* @__PURE__ */ new Map();
  for (const [repo, commits] of commitsByRepo) {
    for (const { commit, key, cls } of assignUnitKeys(commits, repo, prefixes, options)) {
      const author = createHash("sha256").update(salt).update(commit.authorEmail.toLowerCase()).digest("hex");
      allAuthors.add(author);
      if (cls !== "work") {
        excludedCommits[cls] = (excludedCommits[cls] ?? 0) + 1;
        let classes = excludedOnly.get(key);
        if (!classes) excludedOnly.set(key, classes = /* @__PURE__ */ new Map());
        classes.set(cls, (classes.get(cls) ?? 0) + 1);
        continue;
      }
      for (const f of commit.files) {
        allPaths.add(f.path);
        if (f.added !== null) textPaths.add(f.path);
      }
      let unit = units.get(key);
      if (!unit) {
        unit = {
          key,
          files: /* @__PURE__ */ new Map(),
          created: /* @__PURE__ */ new Map(),
          authors: /* @__PURE__ */ new Set(),
          subjects: [],
          conventionalTypes: /* @__PURE__ */ new Set(),
          commits: 0,
          firstAt: commit.date,
          lastAt: commit.date,
          touchesTest: false
        };
        units.set(key, unit);
      }
      let inRepo = unit.files.get(repo);
      if (!inRepo) unit.files.set(repo, inRepo = /* @__PURE__ */ new Set());
      for (const f of commit.files) {
        inRepo.add(f.path);
        if (f.status === "A") {
          let created = unit.created.get(repo);
          if (!created) unit.created.set(repo, created = /* @__PURE__ */ new Set());
          created.add(f.path);
        }
        if (TEST.test(f.path)) unit.touchesTest = true;
      }
      unit.authors.add(author);
      unit.subjects.push(commit.subject);
      const conventional = conventionalParts(commit.subject);
      if (conventional) unit.conventionalTypes.add(conventional.type);
      unit.commits++;
      if (commit.date < unit.firstAt) unit.firstAt = commit.date;
      if (commit.date > unit.lastAt) unit.lastAt = commit.date;
    }
  }
  const excludedUnits = {};
  const umbrellaDays = options.umbrellaDays ?? UMBRELLA_DAYS;
  const umbrellaCommits = options.umbrellaCommits ?? UMBRELLA_COMMITS;
  for (const [key, unit] of units) {
    const days = (Date.parse(unit.lastAt) - Date.parse(unit.firstAt)) / 864e5;
    if (days > umbrellaDays && unit.commits >= umbrellaCommits) {
      units.delete(key);
      excludedUnits.umbrella = (excludedUnits.umbrella ?? 0) + 1;
    }
  }
  let excludedOnlyUnits = 0;
  for (const [key, classes] of excludedOnly) {
    if (units.has(key)) continue;
    excludedOnlyUnits++;
    const [top] = [...classes].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
    excludedUnits[top] = (excludedUnits[top] ?? 0) + 1;
  }
  return {
    units,
    resolver: buildRoleResolver(allPaths, { ...options, binaryPaths: difference(allPaths, textPaths) }),
    families: repoFamilies(labels.values()),
    creditFiles: options.filters ?? true ? [...allPaths].filter((path) => CREDITS.test(path)).length : 0,
    repos: commitsByRepo.size,
    unreadable,
    commits: commitCount,
    allUnits: units.size + excludedOnlyUnits + (excludedUnits.umbrella ?? 0),
    authors: allAuthors.size,
    prefixes,
    excludedCommits,
    excludedUnits,
    readMs: Date.now() - started
  };
}
function difference(all, some) {
  const out = /* @__PURE__ */ new Set();
  for (const item of all) if (!some.has(item)) out.add(item);
  return out;
}
function shapesFromUnits(collection, options = {}) {
  const started = Date.now();
  const o = { ...MINE_DEFAULTS, ...options };
  const { units, resolver, families } = collection;
  const excludedUnits = { ...collection.excludedUnits };
  const excludedShapes = {};
  const largestCluster = {};
  const shapes = [];
  const unitList = [...units.values()];
  let workUnitsMultiRepo = 0;
  for (const unit of unitList) if (unit.files.size > 1) workUnitsMultiRepo++;
  for (const view of ["repo", "family"]) {
    const roleSets = /* @__PURE__ */ new Map();
    for (const unit of unitList) {
      const roles = rolesOf(unit, resolver, view === "family" ? families : null);
      if (roles.size === 0) {
        if (view === "repo") excludedUnits["no-role"] = (excludedUnits["no-role"] ?? 0) + 1;
        continue;
      }
      roleSets.set(unit.key, roles);
    }
    dropRareRoles(roleSets, o.rareRoleUnits);
    const hubs = hubRoles(roleSets, o.hubShare);
    const clusters = clusterUnits(roleSets, o);
    largestCluster[view] = clusters.reduce((max, c) => Math.max(max, c.length), 0);
    const unitsByRole = /* @__PURE__ */ new Map();
    for (const [key, roles] of roleSets) {
      for (const role of roles) {
        let at = unitsByRole.get(role);
        if (!at) unitsByRole.set(role, at = /* @__PURE__ */ new Set());
        at.add(key);
      }
    }
    const nameOf = (repo) => view === "family" ? families.get(repo) ?? repo : repo;
    for (const cluster of clusters) {
      const shape = buildShape(cluster, units, roleSets, unitsByRole, hubs, resolver, nameOf, view, o, excludedShapes);
      if (shape) shapes.push(shape);
    }
  }
  const ranked = dedupeShapes(shapes.sort(compareShapes), o, excludedShapes);
  const withheld = redactSubjects(ranked);
  return {
    version: 1,
    shapes: ranked.slice(0, o.limit),
    stats: {
      repos: collection.repos,
      unreadableRepos: collection.unreadable,
      commits: collection.commits,
      units: collection.allUnits,
      workUnits: unitList.length,
      workUnitsMultiRepo,
      excludedCommits: collection.excludedCommits,
      excludedUnits,
      excludedShapes,
      authors: collection.authors,
      largestCluster,
      subjectsWithheld: withheld,
      mirrors: [...resolver.mirrors].sort(),
      compiledRoles: [...resolver.compiled].sort(),
      creditFiles: collection.creditFiles,
      ticketPrefixes: [...collection.prefixes].sort(),
      shapesBeforeLimit: ranked.length,
      elapsedMs: collection.readMs + (Date.now() - started)
    }
  };
}
function readRepository(repoPath, options) {
  const ref = options.ref ?? resolveRef(repoPath, PREFERRED_REFS, { run: options.run });
  if (!ref) {
    return {
      reason: isRepository(repoPath, { run: options.run }) ? `no commits on any of ${PREFERRED_REFS.join(", ")}` : "not a git repository"
    };
  }
  try {
    return { commits: readCommits(repoPath, { ref, since: options.since, noRenames: options.noRenames, run: options.run }) };
  } catch (error) {
    return { reason: gitFailure(error) };
  }
}
function assignUnitKeys(commits, repo, prefixes, options) {
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  const keys = /* @__PURE__ */ new Map();
  for (const commit of commits) {
    const key = unitKeyOf(commit, repo, prefixes);
    if (key) keys.set(commit.sha, key);
  }
  const parents = new Set(commits.flatMap((c) => c.parents));
  const tip = commits.find((c) => !parents.has(c.sha))?.sha;
  const mainline = /* @__PURE__ */ new Set();
  for (let sha = tip; sha && !mainline.has(sha); sha = bySha.get(sha)?.parents[0]) {
    mainline.add(sha);
  }
  for (const commit of commits) {
    if (commit.parents.length < 2) continue;
    const branch = mergedBranchName(commit.subject);
    if (!branch) continue;
    const key = unitKeyOf({ ...commit, subject: branch }, repo, prefixes);
    if (!key) continue;
    let sha = commit.parents[1];
    for (let steps = 0; sha && steps < MERGE_WALK_LIMIT; steps++) {
      const branchCommit = bySha.get(sha);
      if (!branchCommit || mainline.has(sha) || branchCommit.parents.length > 1) break;
      const own = keys.get(sha);
      if (own && own !== key) break;
      keys.set(sha, key);
      sha = branchCommit.parents[0];
    }
  }
  return commits.map((commit) => ({
    commit,
    // A commit nobody can group is still a piece of work, so it becomes a unit of its own rather
    // than being dropped. It will not reach a shape unless the same file set repeats without keys.
    key: keys.get(commit.sha) ?? `${repo}@${commit.sha.slice(0, 12)}`,
    cls: options.filters === false ? unfilteredClass(commit) : classifyCommit(commit, options)
  }));
}
function unfilteredClass(commit) {
  if (commit.parents.length > 1) return "merge";
  return commit.files.length ? "work" : "empty";
}
var MERGE_WALK_LIMIT = 200;
function rolesOf(unit, resolver, families) {
  const roles = /* @__PURE__ */ new Set();
  for (const [repo, paths] of unit.files) {
    const name = families?.get(repo) ?? repo;
    for (const path of paths) {
      const role = resolver(path);
      if (IGNORED_ROLES.has(role)) continue;
      roles.add(`${name}:${role}`);
    }
  }
  return roles;
}
function clusterUnits(roleSets, options = {}) {
  const similarity = options.similarity ?? MINE_DEFAULTS.similarity;
  const hubShare = options.hubShare ?? MINE_DEFAULTS.hubShare;
  const frequency = /* @__PURE__ */ new Map();
  for (const roles of roleSets.values()) for (const role of roles) frequency.set(role, (frequency.get(role) ?? 0) + 1);
  const hubLimit = hubShare * roleSets.size;
  const order = [...roleSets.keys()].sort((a, b) => {
    const size = roleSets.get(b).size - roleSets.get(a).size;
    return size !== 0 ? size : a < b ? -1 : 1;
  });
  const clusters = [];
  const index = /* @__PURE__ */ new Map();
  for (const key of order) {
    const roles = roleSets.get(key);
    const distinctive = [...roles].filter((role) => (frequency.get(role) ?? 0) <= hubLimit);
    const lookup = distinctive.length ? distinctive : [...roles];
    const candidates = /* @__PURE__ */ new Set();
    for (const role of lookup) for (const c of index.get(role) ?? []) candidates.add(c);
    let best = -1;
    let bestScore = similarity;
    for (const c of candidates) {
      const score = averageJaccard(roles, clusters[c], roleSets);
      if (score >= bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (best === -1) {
      clusters.push([key]);
      best = clusters.length - 1;
    } else {
      clusters[best].push(key);
    }
    for (const role of lookup) {
      let at = index.get(role);
      if (!at) index.set(role, at = /* @__PURE__ */ new Set());
      at.add(best);
    }
  }
  return clusters;
}
function hubRoles(roleSets, hubShare) {
  const frequency = /* @__PURE__ */ new Map();
  for (const roles of roleSets.values()) for (const role of roles) frequency.set(role, (frequency.get(role) ?? 0) + 1);
  const limit = hubShare * roleSets.size;
  return new Set([...frequency].filter(([, n]) => n > limit).map(([role]) => role));
}
function dropRareRoles(roleSets, minUnits) {
  const frequency = /* @__PURE__ */ new Map();
  for (const roles of roleSets.values()) for (const role of roles) frequency.set(role, (frequency.get(role) ?? 0) + 1);
  for (const [key, roles] of roleSets) {
    for (const role of roles) if ((frequency.get(role) ?? 0) < minUnits) roles.delete(role);
    if (roles.size === 0) roleSets.delete(key);
  }
}
var LINKAGE_SAMPLE = 40;
function averageJaccard(roles, members, roleSets) {
  const sample = members.length <= LINKAGE_SAMPLE ? members : members.slice(0, LINKAGE_SAMPLE);
  let total = 0;
  for (const member of sample) total += jaccard(roles, roleSets.get(member));
  return total / sample.length;
}
function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const item of small) if (large.has(item)) shared++;
  return shared / (a.size + b.size - shared);
}
function buildShape(cluster, units, roleSets, unitsByRole, hubs, resolver, nameOf, view, o, excludedShapes) {
  if (cluster.length < o.minProposers) {
    excludedShapes["too-few-proposers"] = (excludedShapes["too-few-proposers"] ?? 0) + 1;
    return null;
  }
  const proposed = coreOf(cluster, roleSets, o.coreShare);
  if (proposed.length < o.minRoles) {
    excludedShapes["below-roles"] = (excludedShapes["below-roles"] ?? 0) + 1;
    return null;
  }
  const memberKeys = supportOf(proposed, unitsByRole, roleSets, o.containment, o.unitShare);
  if (memberKeys.length < o.minRecurrence) {
    const reason = supportOf(proposed, unitsByRole, roleSets, o.containment, 0).length >= o.minRecurrence ? "below-recurrence-without-oversized" : "below-recurrence";
    excludedShapes[reason] = (excludedShapes[reason] ?? 0) + 1;
    return null;
  }
  const core = coreOf(memberKeys, roleSets, o.coreShare).filter((role) => proposed.includes(role));
  if (core.length < o.minRoles) {
    excludedShapes["below-roles"] = (excludedShapes["below-roles"] ?? 0) + 1;
    return null;
  }
  const distinct = core.filter((role) => !hubs.has(role)).length;
  if (distinct < o.minDistinctRoles) {
    excludedShapes["below-distinct-roles"] = (excludedShapes["below-distinct-roles"] ?? 0) + 1;
    return null;
  }
  const members = memberKeys.map((key) => units.get(key)).sort((a, b) => fileCount(a) - fileCount(b) || (a.key < b.key ? -1 : 1));
  const coreRoles = new Set(core);
  const counts = /* @__PURE__ */ new Map();
  for (const key of memberKeys) for (const role of roleSets.get(key)) if (coreRoles.has(role)) counts.set(role, (counts.get(role) ?? 0) + 1);
  const examples = /* @__PURE__ */ new Map();
  for (const unit of members) {
    for (const [repo, paths] of unit.files) {
      for (const path of paths) {
        const role = `${nameOf(repo)}:${resolver(path)}`;
        if (!coreRoles.has(role)) continue;
        const seen = examples.get(role) ?? [];
        const example = `${repo}/${path}`;
        if (seen.length < 2 && !seen.includes(example)) seen.push(example);
        examples.set(role, seen);
      }
    }
  }
  const repos = /* @__PURE__ */ new Set();
  const authors = /* @__PURE__ */ new Set();
  let firstAt = members[0].firstAt;
  let lastAt = members[0].lastAt;
  let testUnits = 0;
  for (const unit of members) {
    for (const repo of unit.files.keys()) repos.add(repo);
    for (const author of unit.authors) authors.add(author);
    if (unit.firstAt < firstAt) firstAt = unit.firstAt;
    if (unit.lastAt > lastAt) lastAt = unit.lastAt;
    if (unit.touchesTest) testUnits++;
  }
  const coreRepos = [...new Set(core.map((role) => role.slice(0, role.indexOf(":"))))].sort();
  const coreFiles = core.map((role) => {
    const n = counts.get(role) ?? 0;
    return { role, units: n, share: Number((n / memberKeys.length).toFixed(2)), examples: examples.get(role) ?? [] };
  });
  return {
    id: createHash("sha256").update(view).update("\0").update(core.join("\n")).digest("hex").slice(0, 12),
    view,
    coreFiles,
    repos: [...repos].sort(),
    coreRepos,
    recurrence: memberKeys.length,
    authors: authors.size,
    firstAt,
    lastAt,
    // The subjects are the only place a trigger phrase can come from, so a few are kept, one per
    // unit so that a single chatty ticket cannot fill the list. They are raw user text, and
    // `redactSubjects` is what stands between them and the output file.
    sampleSubjects: [...new Set(members.map((unit) => unit.subjects[0]))],
    memberUnits: members.map((unit) => unit.key),
    testUnits,
    score: scoreOf(memberKeys.length, coreRepos.length, distinct, authors.size)
  };
}
function fileCount(unit) {
  let n = 0;
  for (const paths of unit.files.values()) n += paths.size;
  return n;
}
function coreOf(keys, roleSets, share) {
  const counts = /* @__PURE__ */ new Map();
  for (const key of keys) for (const role of roleSets.get(key)) counts.set(role, (counts.get(role) ?? 0) + 1);
  return [...counts].filter(([, n]) => n / keys.length >= share).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([role]) => role);
}
function supportOf(roles, unitsByRole, roleSets, containment, unitShare) {
  const needed = Math.max(1, Math.ceil(containment * roles.length));
  const hits = /* @__PURE__ */ new Map();
  for (const role of roles) for (const key of unitsByRole.get(role) ?? []) hits.set(key, (hits.get(key) ?? 0) + 1);
  return [...hits].filter(([key, n]) => n >= needed && n / (roleSets.get(key)?.size ?? n) >= unitShare).map(([key]) => key);
}
function scoreOf(recurrence, repos, roles, authors) {
  const support = Number(Math.log2(1 + recurrence).toFixed(2));
  return { support, repos, roles, authors, total: Number((support * repos).toFixed(2)) };
}
function compareShapes(a, b) {
  return b.score.total - a.score.total || b.score.roles - a.score.roles || b.score.authors - a.score.authors || (a.id < b.id ? -1 : 1);
}
function dedupeShapes(sorted, o, excludedShapes) {
  const kept = [];
  for (const shape of sorted) {
    const members = new Set(shape.memberUnits);
    const core = new Set(shape.coreFiles.map((file) => file.role));
    const duplicate = kept.some(({ members: other }) => jaccard(members, other) >= o.dedupeOverlap);
    if (duplicate) {
      excludedShapes["duplicate-view"] = (excludedShapes["duplicate-view"] ?? 0) + 1;
      continue;
    }
    const variant = o.variantOverlap > 0 && kept.some(
      ({ members: others, core: otherCore }) => jaccard(members, others) >= o.variantOverlap && (contains(otherCore, core) || contains(core, otherCore))
    );
    if (variant) {
      excludedShapes["variant"] = (excludedShapes["variant"] ?? 0) + 1;
      continue;
    }
    kept.push({ shape, members, core });
  }
  return kept.map(({ shape }) => shape);
}
function contains(outer, inner) {
  for (const item of inner) if (!outer.has(item)) return false;
  return true;
}
function redactSubjects(shapes) {
  const withheld = { secret: 0, email: 0 };
  for (const shape of shapes) {
    const safe = [];
    for (const subject of shape.sampleSubjects) {
      if (detectSecret(subject) !== null) {
        withheld.secret++;
        continue;
      }
      if (EMAIL.test(subject)) {
        withheld.email++;
        continue;
      }
      if (safe.length < SAMPLE_SUBJECTS) safe.push(subject);
    }
    shape.sampleSubjects = safe;
  }
  return withheld;
}
var EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/;
var SAMPLE_SUBJECTS = 5;

// src/cli/mine.ts
var USAGE = `usage: node dist/mine.js <repo>... [options]

Mines the repositories' history for recurring workflow shapes and prints them as JSON.
Reads local history only: it never fetches.

  --ref <ref>             ref to walk in every repository (default: origin/master, origin/main, master, main, HEAD)
  --since <date>          only commits after this date, as git --since understands it
  --min-recurrence <n>    units a shape needs; changes nothing else (default 8)
  --min-proposers <n>     alike units it takes to propose a shape (default 5)
  --rare-role-cut <n>     roles touched by fewer units are dropped before clustering (default 5)
  --min-roles <n>         roles a shape needs (default 3)
  --core-share <x>        share of units a role needs to be a core file (default 0.6)
  --similarity <x>        average Jaccard a unit needs to join a cluster (default 0.5)
  --hub-share <x>         a role in more than this share of units is not used to find candidates (default 0.2)
  --containment <x>       share of a shape's core a unit must touch to count as doing it (default 0.8)
  --dedupe-overlap <x>    two shapes sharing this share of their units are one (default 0.5)
  --limit <n>             shapes to print (default 200)
  --no-renames            turn rename detection off, for blobless clones
  --no-filters            keep the noise, to measure what the filters remove
  --out <file>            write the JSON here instead of to stdout`;
function number(value, name) {
  if (value === void 0) return void 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    console.error(`error: --${name} needs a number, got "${value}"`);
    process.exit(2);
  }
  return parsed;
}
function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        ref: { type: "string" },
        since: { type: "string" },
        "min-recurrence": { type: "string" },
        "min-proposers": { type: "string" },
        "rare-role-cut": { type: "string" },
        "min-roles": { type: "string" },
        "core-share": { type: "string" },
        similarity: { type: "string" },
        "hub-share": { type: "string" },
        containment: { type: "string" },
        "dedupe-overlap": { type: "string" },
        limit: { type: "string" },
        "no-renames": { type: "boolean" },
        "no-filters": { type: "boolean" },
        out: { type: "string" },
        help: { type: "boolean" }
      }
    });
  } catch (error) {
    console.error(`error: ${error.message}

${USAGE}`);
    process.exit(2);
  }
  const { values, positionals } = parsed;
  if (values.help || positionals.length === 0) {
    console.error(USAGE);
    process.exit(values.help ? 0 : 2);
  }
  const options = {
    ref: values.ref,
    since: values.since,
    minRecurrence: number(values["min-recurrence"], "min-recurrence"),
    minProposers: number(values["min-proposers"], "min-proposers"),
    rareRoleUnits: number(values["rare-role-cut"], "rare-role-cut"),
    minRoles: number(values["min-roles"], "min-roles"),
    coreShare: number(values["core-share"], "core-share"),
    similarity: number(values.similarity, "similarity"),
    hubShare: number(values["hub-share"], "hub-share"),
    containment: number(values.containment, "containment"),
    dedupeOverlap: number(values["dedupe-overlap"], "dedupe-overlap"),
    limit: number(values.limit, "limit"),
    noRenames: values["no-renames"],
    filters: values["no-filters"] ? false : void 0
  };
  for (const key of Object.keys(options)) if (options[key] === void 0) delete options[key];
  const result = mineShapes(positionals, options);
  const json = `${JSON.stringify(result, null, 2)}
`;
  if (values.out) writeFileSync(values.out, json);
  else process.stdout.write(json);
  const { stats } = result;
  for (const { path, reason } of stats.unreadableRepos) console.error(`skipped ${path}: ${reason}`);
  if (stats.repos === 0) {
    console.error("error: none of the given paths could be read");
    process.exit(1);
  }
  console.error(
    `mined ${stats.repos} repositories: ${stats.commits} commits, ${stats.workUnits} work units, ${result.shapes.length} shapes in ${(stats.elapsedMs / 1e3).toFixed(1)}s`
  );
}
main();
