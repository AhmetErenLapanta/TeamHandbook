// src/cli/share.ts
import { resolve as toAbsolutePath } from "node:path";

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
import { execFileSync as execFileSync2 } from "node:child_process";
import { existsSync as existsSync2, mkdirSync as mkdirSync3, readFileSync as readFileSync3, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname as dirname2, join as join3 } from "node:path";

// src/lib/score.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);

// src/lib/skill-index.ts
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
function uniqueSlug(baseSlug, taken) {
  let slug = baseSlug;
  for (let i = 2; taken(slug); i++) slug = `${baseSlug}-${i}`;
  return slug;
}

// src/lib/forge.ts
import { execFileSync } from "node:child_process";
function hostFromUrl(url) {
  const normalized = normalizeRemoteUrl(url);
  if (!normalized) return null;
  return normalized.slice(0, normalized.indexOf("/"));
}
var FORGE_TIMEOUT_MS = 6e4;
function runForge(tool, args, cwd) {
  return execFileSync(tool, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env: nonInteractiveEnv(),
    timeout: FORGE_TIMEOUT_MS
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
function openPr(repoUrl, branch, title, body, repoDir, forge) {
  const host = hostFromUrl(repoUrl);
  try {
    const out = host && host.includes("github") ? forge("gh", ["pr", "create", "--head", branch, "--title", title, "--body", body], repoDir) : forge(
      "glab",
      ["mr", "create", "--source-branch", branch, "--title", title, "--description", body, "--yes"],
      repoDir
    );
    return { url: extractUrl(out) };
  } catch (err) {
    const e = err;
    const tool = host && host.includes("github") ? "gh" : "glab";
    let reason;
    if (e?.code === "ENOENT") reason = `the ${tool} CLI is not installed`;
    else {
      const stderr = typeof e?.stderr === "string" ? e.stderr.trim() : "";
      reason = (stderr ? stderr.split("\n").at(-1) : String(e?.message ?? err)).slice(0, 160);
    }
    return { url: null, error: reason };
  }
}

// src/lib/display-path.ts
import { homedir as homedir2 } from "node:os";
import { sep } from "node:path";
function displayPath(path, userHome = homedir2()) {
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
function commitMessagePrefix(prefix) {
  return prefix?.trim() ? `${prefix.trim()} ` : "";
}
function teamCommitPrefix(config) {
  return commitMessagePrefix(config?.commitPrefix);
}
function teamBranchPrefix(config) {
  return config?.branchPrefix?.trim() || DEFAULT_BRANCH_PREFIX;
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
      `${displayPath(join3(home, "config.json"))} exists but is not valid JSON. TeamHandbook will not rewrite it, because doing so would silently discard settings you wrote - including the privacy switches, which are currently failing closed. Fix the JSON (or delete the file) and try again.`
    );
    this.name = "BrokenConfigError";
  }
};
function saveTeamConfig(team, home = handbookHome()) {
  if (configIsBroken(home)) throw new BrokenConfigError(home);
  const config = readConfigFile(home);
  config.team = team;
  writeFileAtomic(join3(home, "config.json"), JSON.stringify(config, null, 2) + "\n");
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
var TEAM_PREFIX_FILE = ".teamhandbook.json";
var COMMIT_PREFIX_MAX = 64;
function commitPrefixProblem(value) {
  if (value.length > COMMIT_PREFIX_MAX) return `longer than ${COMMIT_PREFIX_MAX} characters`;
  if (new RegExp("\\p{C}", "u").test(value)) return "carrying a control character";
  return null;
}
function readTeamCommitPrefix(repoDir) {
  let raw;
  try {
    raw = JSON.parse(readFileSync3(join3(repoDir, TEAM_PREFIX_FILE), "utf8"))?.commitPrefix;
  } catch {
    return {};
  }
  if (typeof raw !== "string") return {};
  const value = raw.trim();
  const problem = commitPrefixProblem(value);
  return problem ? { problem } : { prefix: value };
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
function runGit(args, cwd) {
  try {
    return execFileSync2("git", args, {
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
    return `${url} rejected the branch NAME "${branch}": this project requires branch names ${pattern ? `matching ${pattern}` : "of a shape it did not quote"}. Nothing is wrong with your access. ${branchPrefixFix}`;
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

// src/lib/share.ts
import { readdirSync as readdirSync6, statSync as statSync2 } from "node:fs";
import { homedir as homedir5 } from "node:os";
import { basename as basename3, join as join9 } from "node:path";

// src/lib/mcp.ts
import { readFileSync as readFileSync4 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { join as join4 } from "node:path";
var PURE_VAR_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
var CREDENTIAL_BEARING_FIELDS = ["headers", "env"];
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function claudeConfigFile() {
  const dir = process.env.CLAUDE_CONFIG_DIR?.trim();
  return join4(dir || homedir3(), ".claude.json");
}
function readLocalServers(file = claudeConfigFile(), cwd = process.cwd()) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync4(file, "utf8"));
  } catch {
    return [];
  }
  if (!isPlainObject(parsed)) return [];
  const byName = /* @__PURE__ */ new Map();
  const collect = (map, scope) => {
    if (!isPlainObject(map)) return;
    for (const [name, config] of Object.entries(map)) {
      if (!name.trim() || !isPlainObject(config)) continue;
      byName.set(name, { name, scope, config });
    }
  };
  collect(parsed.mcpServers, "user");
  const projects = isPlainObject(parsed.projects) ? parsed.projects : {};
  const here = projects[cwd];
  collect(isPlainObject(here) ? here.mcpServers : void 0, "project");
  return [...byName.values()];
}
function transportOf(config) {
  if (typeof config.type === "string" && config.type.trim()) return config.type.trim();
  return typeof config.command === "string" ? "stdio" : "unknown";
}
var UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var MIN_TOKEN_CHARS = 12;
var HEX_TOKEN_CHARS = 16;
function tokenLike(value) {
  if (UUID_SHAPE.test(value)) return true;
  if (value.length >= HEX_TOKEN_CHARS && /^[0-9a-f]+$/i.test(value)) return true;
  if (value.length < MIN_TOKEN_CHARS) return false;
  if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) return false;
  const mixedCase = /[a-z]/.test(value) && /[A-Z]/.test(value);
  return mixedCase || !/[-_.]/.test(value);
}
function urlToken(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  for (const segment of parsed.pathname.split("/")) {
    if (!segment) continue;
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
    }
    if (tokenLike(decoded)) return `path segment "${decoded}"`;
  }
  for (const [key, value] of parsed.searchParams) {
    if (tokenLike(value)) return `query parameter "${key}"`;
  }
  return null;
}
function auditServer(config) {
  const base = { migratable: false, requiresEnv: [], startsProcess: false, transport: "unknown" };
  if (!isPlainObject(config)) return { ...base, reason: "unsupported-shape", detail: "not an object" };
  const transport = transportOf(config);
  const startsProcess = typeof config.command === "string" && config.command.trim() !== "";
  const hasUrl = typeof config.url === "string" && config.url.trim() !== "";
  if (!startsProcess && !hasUrl) {
    return { ...base, transport, reason: "unsupported-shape", detail: "no command and no url" };
  }
  const requiresEnv = [];
  for (const field of CREDENTIAL_BEARING_FIELDS) {
    const values = config[field];
    if (values === void 0) continue;
    if (!isPlainObject(values)) {
      return { ...base, transport, startsProcess, reason: "unsupported-shape", detail: field };
    }
    for (const [key, value] of Object.entries(values)) {
      const reference = typeof value === "string" ? PURE_VAR_REFERENCE.exec(value) : null;
      if (!reference) {
        return {
          ...base,
          transport,
          startsProcess,
          reason: "credential-field",
          detail: `${field}.${key}`
        };
      }
      if (!requiresEnv.includes(reference[1])) requiresEnv.push(reference[1]);
    }
  }
  const pattern = detectSecret(JSON.stringify(config));
  if (pattern) {
    return { ...base, transport, startsProcess, reason: "secret-pattern", detail: pattern };
  }
  const embedded = typeof config.url === "string" ? urlToken(config.url) : null;
  if (embedded) {
    return { ...base, transport, startsProcess, reason: "url-token", detail: embedded };
  }
  return { migratable: true, requiresEnv, startsProcess, transport };
}
function refusalMessage(name, audit) {
  if (audit.reason === "credential-field") {
    return `"${name}" is not shareable as written: ${audit.detail} holds a literal value. Anything in headers or env that is not a plain \${VAR} reference is treated as a credential and stays on this machine. Rewrite it as \${VAR} (the name travels, the value does not), then run this again.`;
  }
  if (audit.reason === "url-token") {
    return `"${name}" is not shareable as written: its URL carries what looks like a credential (${audit.detail}). Providers that put the secret in the endpoint hand every teammate the manager's own access, so this stays here. Ask the provider for a URL without the token, or pass the credential in a header as a \${VAR} reference.`;
  }
  if (audit.reason === "secret-pattern") {
    return `"${name}" is not shareable: its definition contains what looks like a ${audit.detail}. Move the credential into an environment variable and reference it as \${VAR}.`;
  }
  return `"${name}" is not a server this command can share (${audit.detail ?? "unsupported shape"}).`;
}
function serverMap(parsed) {
  return isPlainObject(parsed.mcpServers) ? parsed.mcpServers : parsed;
}
function declaredServerNames(existing) {
  if (!existing || !existing.trim()) return [];
  try {
    const parsed = JSON.parse(existing);
    return isPlainObject(parsed) ? Object.keys(serverMap(parsed)) : [];
  } catch {
    return [];
  }
}
function mergeServersIntoMcpJson(existing, servers, replaceExisting = () => false) {
  let target = {};
  let document = null;
  if (existing !== null && existing.trim()) {
    let parsed;
    try {
      parsed = JSON.parse(existing);
    } catch {
      throw new Error(
        ".mcp.json in the team repository is not valid JSON. Fix it there first; TeamHandbook will not overwrite a file it cannot read."
      );
    }
    if (!isPlainObject(parsed)) {
      throw new Error(".mcp.json in the team repository is not a JSON object.");
    }
    document = parsed;
    target = serverMap(parsed);
  }
  const collided = [];
  const replaced = [];
  for (const server of servers) {
    if (Object.prototype.hasOwnProperty.call(target, server.name)) {
      if (!replaceExisting(server.name)) {
        collided.push(server.name);
        continue;
      }
      replaced.push(server.name);
    }
    if (document === null) {
      document = { mcpServers: target };
    }
    target[server.name] = server.config;
  }
  return { merged: JSON.stringify(document ?? { mcpServers: {} }, null, 2) + "\n", collided, replaced };
}
function refusalSummary(audit) {
  if (audit.reason === "credential-field") return `${audit.detail} holds a literal value`;
  if (audit.reason === "url-token") return `its URL carries what looks like a credential (${audit.detail})`;
  return String(audit.detail);
}

// src/lib/queue.ts
import { mkdirSync as mkdirSync5, readFileSync as readFileSync5, readdirSync as readdirSync3 } from "node:fs";
import { basename, join as join6 } from "node:path";

// src/lib/skill-files.ts
import { copyFileSync, mkdirSync as mkdirSync4, readdirSync as readdirSync2, writeFileSync as writeFileSync3 } from "node:fs";
import { dirname as dirname3, join as join5 } from "node:path";
function isQueueBookkeeping(name) {
  return name.startsWith("candidate.json");
}
function listSkillFiles(dir) {
  const files = [];
  const skipped = [];
  const walk = (current, prefix) => {
    let entries;
    try {
      entries = readdirSync2(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (prefix === "" && isQueueBookkeeping(entry.name)) continue;
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join5(current, entry.name), rel);
      else if (entry.isFile()) files.push(rel);
      else skipped.push(rel);
    }
  };
  walk(dir, "");
  return { files, skipped };
}
function copySkillPayload(srcDir, destDir, skillMd, files = listSkillFiles(srcDir).files) {
  mkdirSync4(destDir, { recursive: true });
  writeFileSync3(join5(destDir, "SKILL.md"), skillMd);
  for (const rel of files) {
    if (rel === "SKILL.md") continue;
    const target = join5(destDir, rel);
    mkdirSync4(dirname3(target), { recursive: true });
    copyFileSync(join5(srcDir, rel), target);
  }
}

// src/lib/queue.ts
function isSafeSlug(slug) {
  return /^[a-z0-9][a-z0-9-]*$/.test(slug);
}
function auditSkillDir(sourceDir) {
  const name = basename(sourceDir);
  if (!isSafeSlug(name)) return { shareable: false, reason: "unsafe-name", detail: name };
  let skillMd;
  try {
    skillMd = readFileSync5(join6(sourceDir, "SKILL.md"), "utf8");
  } catch {
    return { shareable: false, reason: "no-skill-md" };
  }
  const summary = parseSkillFrontmatter(skillMd);
  if (!summary) return { shareable: false, reason: "no-frontmatter" };
  const { files, skipped } = listSkillFiles(sourceDir);
  if (skipped.length > 0) {
    return { shareable: false, reason: "irregular-entry", detail: skipped[0] };
  }
  if (files.length === 0) return { shareable: false, reason: "no-files" };
  for (const file of files) {
    let content;
    try {
      content = readFileSync5(join6(sourceDir, file), "utf8");
    } catch {
      return { shareable: false, reason: "unreadable", detail: file };
    }
    const pattern = detectSecret(content);
    if (pattern) {
      return { shareable: false, reason: "secret", detail: pattern, secret: { pattern, file } };
    }
  }
  return { shareable: true, skillMd, files, summary };
}
function skillRefusalMessage(shownDir, slug, audit) {
  switch (audit.reason) {
    case "unsafe-name":
      return `"${slug}" cannot be a skill name (lowercase letters, digits and dashes)`;
    case "no-skill-md":
      return `no readable SKILL.md in ${shownDir}`;
    case "no-frontmatter":
      return `the SKILL.md in ${shownDir} has no name and description frontmatter`;
    case "irregular-entry":
      return `${slug} contains "${audit.detail}", which is not a regular file; nothing was shared`;
    case "no-files":
      return `${slug} has no files to share`;
    case "unreadable":
      return `cannot read "${audit.detail}" in ${shownDir}; nothing was shared`;
    default:
      return `"${audit.secret?.file}" looks like it contains a secret (${audit.detail}), so ${slug} was not shared. Skills are reviewed and shared as they are, and a redacted one would install and then fail; take the credential out of the skill and try again.`;
  }
}

// src/lib/publish.ts
import { existsSync as existsSync3, mkdirSync as mkdirSync6, readdirSync as readdirSync5, readFileSync as readFileSync7, rmSync as rmSync3, writeFileSync as writeFileSync4 } from "node:fs";
import { join as join8 } from "node:path";

// src/lib/commands.ts
import { readdirSync as readdirSync4, readFileSync as readFileSync6 } from "node:fs";
import { homedir as homedir4 } from "node:os";
import { basename as basename2, join as join7 } from "node:path";
function localCommandDirs(userHome = homedir4(), cwd = process.cwd()) {
  return [
    { dir: join7(userHome, ".claude", "commands"), scope: "personal" },
    { dir: join7(cwd, ".claude", "commands"), scope: "project" }
  ];
}
function readLocalCommands(userHome = homedir4(), cwd = process.cwd()) {
  const byName = /* @__PURE__ */ new Map();
  for (const { dir, scope } of localCommandDirs(userHome, cwd)) {
    let entries;
    try {
      entries = readdirSync4(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => e.name);
    } catch {
      continue;
    }
    for (const entry of entries.sort()) {
      const name = basename2(entry, ".md");
      byName.set(name, { name, scope, file: join7(dir, entry) });
    }
  }
  return [...byName.values()];
}
function commandDescription(content) {
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
  const described = frontmatter?.[1]?.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  if (described) return described.replace(/^["']|["']$/g, "");
  const body = frontmatter ? content.slice(frontmatter[0].length) : content;
  return body.split("\n").map((line) => line.trim()).find((line) => line && !line.startsWith("#")) ?? "";
}
function auditCommand(file) {
  const name = basename2(file, ".md");
  if (!isSafeSlug(name)) return { shareable: false, reason: "unsafe-name", detail: name };
  let content;
  try {
    content = readFileSync6(file, "utf8");
  } catch {
    return { shareable: false, reason: "unreadable", detail: basename2(file) };
  }
  const pattern = detectSecret(content);
  if (pattern) {
    return { shareable: false, reason: "secret", detail: pattern, secret: { pattern, file: basename2(file) } };
  }
  return { shareable: true, content, description: commandDescription(content) };
}
function commandRefusalSummary(audit) {
  switch (audit.reason) {
    case "unsafe-name":
      return `"${audit.detail}" cannot be a command name (lowercase letters, digits and dashes)`;
    case "unreadable":
      return `"${audit.detail}" cannot be read, so it cannot be screened`;
    default:
      return `it looks like it contains a secret (${audit.detail})`;
  }
}
function commandRefusalMessage(name, audit) {
  if (audit.reason === "secret") {
    return `"${audit.secret?.file}" looks like it contains a secret (${audit.detail}), so ${name} was not shared. Commands are reviewed and merged as they are, and a redacted one would arrive and then misfire; take the credential out of the command and try again.`;
  }
  return commandRefusalSummary(audit);
}

// src/lib/publish.ts
function mayUpdate(options, name) {
  return options.update === true || Array.isArray(options.update) && options.update.includes(name);
}
function bumpPluginVersion(repoDir) {
  const file = join8(repoDir, ".claude-plugin", "plugin.json");
  try {
    const plugin = JSON.parse(readFileSync7(file, "utf8"));
    const parts = String(plugin.version ?? "0.1.0").split(".").map(Number);
    if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
    parts[2] = (parts[2] ?? 0) + 1;
    plugin.version = parts.join(".");
    writeFileSync4(file, JSON.stringify(plugin, null, 2) + "\n");
    return plugin.version;
  } catch {
    return null;
  }
}
var MAX_BRANCH_PATTERN_CHARS = 200;
function retryBranchAfterNameRejection(err, team, slug) {
  const raw = String(err instanceof Error ? err.message : err);
  if (pushRuleSubject(raw) !== "branch-name") return null;
  const pattern = raw.match(/does not follow the pattern\s*'([^']+)'/)?.[1];
  if (!pattern || pattern.length > MAX_BRANCH_PATTERN_CHARS) return null;
  const commitPrefix = team.commitPrefix?.trim().replace(/-+$/, "");
  if (!commitPrefix) return null;
  const prefix = `${commitPrefix}-`;
  const branch = `${prefix}${slug}`;
  try {
    if (!new RegExp(pattern).test(branch)) return null;
  } catch {
    return null;
  }
  return { branch, prefix };
}
function resolveGitIdentity(git) {
  const read = (key) => {
    try {
      return git(["config", key], process.cwd());
    } catch {
      return "";
    }
  };
  const email = read("user.email");
  const name = read("user.name");
  const unset = (v) => typeof v === "string" && v.trim() === "";
  if (unset(email) || unset(name)) {
    return {
      error: 'git user.name/user.email is not set - the PR would have a junk author. Run `git config --global user.name "Your Name"` and `git config --global user.email you@example.com`, then approve again.'
    };
  }
  return {
    args: typeof name === "string" && name.trim() !== "" && typeof email === "string" && email.trim() !== "" ? ["-c", `user.name=${name.trim()}`, "-c", `user.email=${email.trim()}`] : []
  };
}
function cloneTeamRepo(git, repoUrl, repoDir, workdir) {
  try {
    git(["clone", "--depth", "1", "--", repoUrl, repoDir], workdir);
    return null;
  } catch (err) {
    return `git clone failed (is the team repo reachable?): ${String(err)}`;
  }
}
function listRemoteBranches(git, repoDir) {
  try {
    const out = git(["ls-remote", "--heads", "origin"], repoDir);
    return new Set(
      String(out ?? "").split("\n").map((line) => line.split("	")[1] ?? "").filter(Boolean).map((ref) => ref.replace("refs/heads/", ""))
    );
  } catch {
    return /* @__PURE__ */ new Set();
  }
}
function pushBranch(git, repoDir, branch, team, slug, remoteBranches) {
  try {
    git(["push", "-u", "origin", branch], repoDir);
    return { branch };
  } catch (err) {
    const retry = retryBranchAfterNameRejection(err, team, slug);
    if (!retry || remoteBranches.has(retry.branch)) throw err;
    git(["branch", "-m", retry.branch], repoDir);
    git(["push", "-u", "origin", retry.branch], repoDir);
    return { branch: retry.branch, learnedBranchPrefix: retry.prefix };
  }
}
function skillCollisionMessage(name, chosen) {
  const taken = `the team repository already has a skill named "${name}" (skills/${name}/). Nothing was written.`;
  return chosen ? `${taken} Pick a name nothing has taken with --as, or drop --as and approve with --update to send this candidate as an update to the skill it actually collided with.` : `${taken} Approve again with --update to send yours as an update to it, or with --as <name> to send it under a different name.`;
}
function commitPrefixForPush(team, repoDir) {
  if (typeof team.commitPrefix === "string") return { team, prefix: teamCommitPrefix(team) };
  const recorded = readTeamCommitPrefix(repoDir);
  if (recorded.prefix === void 0) return { team, prefix: teamCommitPrefix(team) };
  return {
    team: { ...team, commitPrefix: recorded.prefix },
    prefix: commitMessagePrefix(recorded.prefix),
    learned: recorded.prefix
  };
}
var TEAM_MCP_FILE = ".mcp.json";
var TEAM_COMMANDS_DIR = "commands";
var TEAM_SKILLS_DIR = "skills";
var NOTHING_UPDATED = { servers: [], commands: [], skills: [] };
function buildSelectionPrTitle(serverNames, commandNames, updated = NOTHING_UPDATED, skillNames = []) {
  const scopes = [
    skillNames.length ? "skill" : "",
    serverNames.length ? "mcp" : "",
    commandNames.length ? "commands" : ""
  ].filter(Boolean);
  const added = [
    ...skillNames.filter((n) => !updated.skills.includes(n)),
    ...serverNames.filter((n) => !updated.servers.includes(n)),
    ...commandNames.filter((n) => !updated.commands.includes(n))
  ];
  const changed = [
    ...skillNames.filter((n) => updated.skills.includes(n)),
    ...serverNames.filter((n) => updated.servers.includes(n)),
    ...commandNames.filter((n) => updated.commands.includes(n))
  ];
  const parts = [];
  if (added.length) parts.push(`add ${added.join(", ")}`);
  if (changed.length) parts.push(`update ${changed.join(", ")}`);
  return `feat(${scopes.join(",")}): ${parts.join("; ")}`;
}
function selectionIntro(servers, commands, skills = 0) {
  if (skills) {
    if (!servers && !commands) {
      return skills === 1 ? [
        "Adds one skill to this plugin. Once this is merged, every teammate whose copy",
        "refreshes has it: nobody copies a directory into their own setup."
      ] : [
        `Adds ${skills} skills to this plugin. Once this is merged, every teammate whose copy`,
        "refreshes has them: nobody copies a directory into their own setup."
      ];
    }
    const parts = [
      `${skills} skill${skills === 1 ? "" : "s"}`,
      ...servers ? [`${servers} MCP server${servers === 1 ? "" : "s"}`] : [],
      ...commands ? [`${commands} slash command${commands === 1 ? "" : "s"}`] : []
    ];
    const listed = parts.length === 2 ? parts.join(" and ") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
    return [
      `Adds ${listed} to this plugin. Once this is merged, every teammate whose copy`,
      "refreshes has all of it: nobody installs, configures or copies anything."
    ];
  }
  if (!servers) {
    return commands === 1 ? [
      "Adds one slash command to this plugin. Once this is merged, every teammate whose copy",
      "refreshes can type it: nobody copies a file into their own setup."
    ] : [
      `Adds ${commands} slash commands to this plugin. Once this is merged, every teammate whose`,
      "copy refreshes can type them: nobody copies a file into their own setup."
    ];
  }
  if (!commands) {
    return servers === 1 ? [
      `Adds the \`SERVER_NAME\` MCP server to this plugin. Once this is merged, every`,
      "teammate whose copy refreshes has it connected: nobody installs or configures anything."
    ] : [
      `Adds ${servers} MCP servers to this plugin. Once this is merged, every teammate whose`,
      "copy refreshes has them connected: nobody installs or configures anything."
    ];
  }
  return [
    `Adds ${servers} MCP server${servers === 1 ? "" : "s"} and ${commands} slash command${commands === 1 ? "" : "s"} to this`,
    "plugin. Once this is merged, every teammate whose copy refreshes has the servers connected",
    "and can type the commands: nobody installs, configures or copies anything."
  ];
}
function buildSelectionPrBody(subjects, commands, marketplaceName, updated = NOTHING_UPDATED, skills = []) {
  const single = subjects.length === 1 && !commands.length && !skills.length;
  const lines = selectionIntro(subjects.length, commands.length, skills.length).map(
    (line) => line.replace("SERVER_NAME", subjects[0]?.entry.name ?? "")
  );
  for (const { entry, audit } of subjects) {
    const config = entry.config;
    lines.push("", `- server: \`${entry.name}\``, `- transport: \`${audit.transport}\``);
    if (typeof config.url === "string") lines.push(`- endpoint: \`${config.url}\``);
    if (audit.startsProcess) {
      const args = Array.isArray(config.args) ? config.args.map(String) : [];
      lines.push(`- command: \`${String(config.command)}${args.length ? ` ${args.join(" ")}` : ""}\``);
    }
  }
  const processes = subjects.filter((s) => s.audit.startsProcess).map((s) => s.entry.name);
  if (processes.length === 1) {
    lines.push(
      "",
      single ? "## This one starts a process" : `## \`${processes[0]}\` starts a process`,
      "",
      "Enabling the plugin runs that command on every teammate's machine, with their",
      "privileges, for as long as the session lasts. Review it the way you would review a",
      "dependency you are adding, not the way you would review a document."
    );
  } else if (processes.length > 1) {
    lines.push(
      "",
      "## Some of these start a process",
      "",
      `Enabling the plugin runs the commands above for ${processes.map((n) => `\`${n}\``).join(", ")} on`,
      "every teammate's machine, with their privileges, for as long as the session lasts.",
      "Review them the way you would review a dependency you are adding, not the way you",
      "would review a document."
    );
  }
  for (const command of commands) {
    lines.push(
      "",
      `- command: \`/${marketplaceName}:${command.name}\``,
      `- file: \`${TEAM_COMMANDS_DIR}/${command.name}.md\``
    );
  }
  for (const skill of skills) {
    lines.push(
      "",
      `- skill: \`${skill.name}\``,
      `- files: \`${TEAM_SKILLS_DIR}/${skill.name}/\` (${skill.files.length})`
    );
    if (skill.description) lines.push(`- description: ${skill.description}`);
  }
  if (skills.length) {
    lines.push(
      "",
      skills.length === 1 ? "## This skill was written by hand" : "## These skills were written by hand",
      "",
      "Their author picked them from their own machine, so they carry no gate score and no",
      "grounded case: nothing proposed them and there is nothing to score. Review them by",
      "reading them, the same way you would review any other document in this repository."
    );
  }
  const changed = [
    ...skills.filter((s) => updated.skills.includes(s.name)).map((s) => `${TEAM_SKILLS_DIR}/${s.name}/`),
    ...subjects.filter((s) => updated.servers.includes(s.entry.name)).map((s) => s.entry.name),
    // Namespaced, like the bullet above and for the same reason: a bare `/<command>` is a
    // name nobody can type once the plugin is installed. Two spellings of one command in
    // one document leave the reviewer deciding which of them to believe.
    ...commands.filter((c) => updated.commands.includes(c.name)).map((c) => `/${marketplaceName}:${c.name}`)
  ];
  if (changed.length) {
    lines.push(
      "",
      changed.length === 1 ? "## This one replaces what the team has" : "## Some of these replace what the team has",
      "",
      `${changed.map((n) => `\`${n}\``).join(", ")} ${changed.length === 1 ? "is" : "are"} already in this repository, and`,
      "the publisher was told so before asking for this. What is in the diff is the version on",
      "their machine, whole: anything the team's copy gained since it landed is gone after the",
      "merge, so read the removed lines as carefully as the added ones."
    );
  }
  if (commands.length) {
    lines.push(
      "",
      commands.length === 1 ? "## This one is read as instructions" : "## These are read as instructions",
      "",
      "A merged command is typed by a teammate and then read by Claude as its instructions for",
      "that turn, with their tools and their permissions. Read the bod" + (commands.length === 1 ? "y" : "ies") + " in this diff the way you",
      "would read a runbook someone else is about to run, not the way you would read a note."
    );
  }
  const requiresEnv = [];
  for (const { audit } of subjects) {
    for (const name of audit.requiresEnv) if (!requiresEnv.includes(name)) requiresEnv.push(name);
  }
  return finishMcpPrBody(lines, requiresEnv, subjects.length > 0, commands.length);
}
function finishMcpPrBody(lines, requiresEnv, hasServers, commandCount) {
  lines.push("", "## What was checked", "");
  if (hasServers) {
    lines.push(
      "Every value in `headers` and `env` is a plain ${VAR} reference rather than a literal, so",
      "no credential travels in those fields. The endpoint was also scanned for an embedded",
      "token and none was found."
    );
  }
  if (commandCount) {
    if (hasServers) lines.push("");
    lines.push(
      `Each command file was scanned for known credential shapes before it was copied, and one`,
      "that matched would have stopped this request rather than arriving with the token blanked",
      "out. That scan is a heuristic over the shapes it knows, not a proof."
    );
  }
  if (requiresEnv.length) {
    lines.push(
      "",
      `Each teammate supplies these from their own environment: ${requiresEnv.map((v) => `\`${v}\``).join(", ")}. Until they do, the server will not start for them.`
    );
  }
  lines.push("");
  if (hasServers) {
    lines.push(
      'That is the whole of the check, and it is a narrower claim than "this definition holds',
      'no secret": the endpoint scan is a heuristic, and a credential passed in `args` is not',
      "checked at all. Read the endpoint and the command above before merging."
    );
  }
  if (commandCount) {
    const read = `Read the ${commandCount === 1 ? "file" : "files"} in this diff before merging.`;
    if (hasServers) {
      lines.push(
        "",
        "A command body is prose, and a credential in a shape the scan has never seen reads to it",
        `as prose too. ${read}`
      );
    } else {
      lines.push(
        'That is the whole of the check, and it is a narrower claim than "these commands hold no',
        'secret": a command body is prose, and a credential in a shape the scan has never seen',
        `reads to it as prose too. ${read}`
      );
    }
  }
  lines.push(
    "",
    "---",
    "Opened by TeamHandbook at the explicit request of whoever ran the command."
  );
  return lines.join("\n");
}
function collisionMessage(name) {
  return `the team repository already declares an MCP server named "${name}". It was left exactly as it is.`;
}
function commandCollisionMessage(name) {
  return `the team repository already has a command named "${name}" (${TEAM_COMMANDS_DIR}/${name}.md). It was left exactly as it is.`;
}
function namesIn(dir, suffix) {
  try {
    return readdirSync5(dir, { withFileTypes: true }).filter((entry) => suffix ? entry.isFile() && entry.name.endsWith(suffix) : entry.isDirectory()).map((entry) => suffix ? entry.name.slice(0, -suffix.length) : entry.name);
  } catch {
    return [];
  }
}
function teamAssets(team, git = runGit) {
  try {
    assertSafeGitUrl(team.repoUrl);
  } catch {
    return null;
  }
  const workdir = handbookWorkdir("handbook-index-");
  const repoDir = join8(workdir, "repo");
  try {
    if (cloneTeamRepo(git, team.repoUrl, repoDir, workdir)) return null;
    const mcpFile = join8(repoDir, TEAM_MCP_FILE);
    return {
      skills: namesIn(join8(repoDir, "skills")),
      servers: declaredServerNames(existsSync3(mcpFile) ? readFileSync7(mcpFile, "utf8") : null),
      commands: namesIn(join8(repoDir, TEAM_COMMANDS_DIR), ".md")
    };
  } catch {
    return null;
  } finally {
    rmSync3(workdir, { recursive: true, force: true });
  }
}
function publishTeamSelection(selection, team, git = runGit, forge = runForge, options = {}) {
  const entries = selection.servers ?? [];
  const commandEntries = selection.commands ?? [];
  const skillEntries = selection.skills ?? [];
  const single = entries.length === 1 && !commandEntries.length && !skillEntries.length ? { serverName: entries[0].name } : {};
  const subjects = [];
  const refused = [];
  for (const entry of entries) {
    const audit = auditServer(entry.config);
    if (audit.migratable) subjects.push({ entry, audit });
    else refused.push({ name: entry.name, kind: "mcp", reason: refusalMessage(entry.name, audit) });
  }
  const commands = [];
  for (const entry of commandEntries) {
    const audit = auditCommand(entry.file);
    if (audit.shareable) commands.push({ name: entry.name, content: audit.content });
    else refused.push({ name: entry.name, kind: "command", reason: commandRefusalMessage(entry.name, audit) });
  }
  const skills = [];
  for (const entry of skillEntries) {
    if (skills.some((skill) => skill.name === entry.name)) {
      refused.push({
        name: entry.name,
        kind: "skill",
        reason: `two of the skills selected are named "${entry.name}"; only the first was taken`
      });
      continue;
    }
    const audit = auditSkillDir(entry.dir);
    if (audit.shareable) {
      skills.push({
        name: entry.name,
        dir: entry.dir,
        skillMd: audit.skillMd,
        files: audit.files,
        description: audit.summary?.description ?? ""
      });
    } else {
      refused.push({
        name: entry.name,
        kind: "skill",
        reason: skillRefusalMessage(
          entry.namedBy === "user" ? entry.dir : displayPath(entry.dir),
          entry.name,
          audit
        )
      });
    }
  }
  if (!subjects.length && !commands.length && !skills.length) {
    return {
      ok: false,
      ...single,
      refused,
      error: refused[0]?.reason ?? "nothing was named to share"
    };
  }
  try {
    assertSafeGitUrl(team.repoUrl);
  } catch (err) {
    return { ok: false, refused, error: String(err instanceof Error ? err.message : err) };
  }
  for (const { entry } of subjects) {
    if (!slugifySkillName(entry.name)) {
      return { ok: false, refused, error: `cannot derive a branch name from the server name "${entry.name}"` };
    }
  }
  for (const skill of skills) {
    if (!isSafeSlug(skill.name)) {
      return {
        ok: false,
        refused,
        error: `"${skill.name}" cannot be a skill name (lowercase letters, digits and dashes)`
      };
    }
  }
  const identity = resolveGitIdentity(git);
  if ("error" in identity) return { ok: false, refused, error: identity.error };
  const prefix = teamBranchPrefix(team);
  const workdir = handbookWorkdir("handbook-mcp-");
  const repoDir = join8(workdir, "repo");
  try {
    const cloneError = cloneTeamRepo(git, team.repoUrl, repoDir, workdir);
    if (cloneError) return { ok: false, refused, error: cloneError };
    const pushTeam = commitPrefixForPush(team, repoDir);
    const commitPrefix = pushTeam.prefix;
    const remoteBranches = listRemoteBranches(git, repoDir);
    const target = join8(repoDir, TEAM_MCP_FILE);
    let merged = "";
    let collided = [];
    let replacedServers = [];
    if (subjects.length) {
      try {
        ({ merged, collided, replaced: replacedServers } = mergeServersIntoMcpJson(
          existsSync3(target) ? readFileSync7(target, "utf8") : null,
          subjects.map((s) => s.entry),
          (name) => mayUpdate(options, name)
        ));
      } catch (err) {
        return { ok: false, ...single, refused, error: String(err instanceof Error ? err.message : err) };
      }
    }
    const collisions = [];
    for (const name of collided) {
      collisions.push(collisionMessage(name));
      refused.push({ name, kind: "mcp", reason: collisionMessage(name), collision: true });
    }
    const going = subjects.filter((s) => !collided.includes(s.entry.name));
    const goingCommands = [];
    const replacedCommands = [];
    for (const command of commands) {
      if (existsSync3(join8(repoDir, TEAM_COMMANDS_DIR, `${command.name}.md`))) {
        if (!mayUpdate(options, command.name)) {
          collisions.push(commandCollisionMessage(command.name));
          refused.push({
            name: command.name,
            kind: "command",
            reason: commandCollisionMessage(command.name),
            collision: true
          });
          continue;
        }
        replacedCommands.push(command.name);
      }
      goingCommands.push(command);
    }
    const goingSkills = [];
    const replacedSkills = [];
    for (const skill of skills) {
      if (existsSync3(join8(repoDir, TEAM_SKILLS_DIR, skill.name))) {
        if (!mayUpdate(options, skill.name)) {
          collisions.push(skillCollisionMessage(skill.name, false));
          refused.push({
            name: skill.name,
            kind: "skill",
            reason: skillCollisionMessage(skill.name, false),
            collision: true
          });
          continue;
        }
        replacedSkills.push(skill.name);
      }
      goingSkills.push(skill);
    }
    const updated = {
      servers: replacedServers.filter((n) => going.some((s) => s.entry.name === n)),
      commands: replacedCommands,
      skills: replacedSkills
    };
    if (!going.length && !goingCommands.length && !goingSkills.length) {
      return { ok: false, ...single, refused, error: collisions[0] ?? refused[0]?.reason ?? "nothing was left to share" };
    }
    const names = going.map((s) => s.entry.name);
    const commandNames = goingCommands.map((c) => c.name);
    const skillNames = goingSkills.map((s) => s.name);
    const all = [...skillNames, ...names, ...commandNames];
    const label = [skillNames.length ? "skills" : "", names.length ? "mcp" : "", commandNames.length ? "commands" : ""].filter(Boolean).length > 1 ? "share" : skillNames.length ? "skills" : names.length ? "mcp" : "commands";
    const first = slugifySkillName(all[0]);
    const base = all.length === 1 ? `${label}-${first}` : `${label}-${first}-and-${all.length - 1}-more`;
    const slug = uniqueSlug(base, (s) => remoteBranches.has(`${prefix}${s}`));
    let branch = `${prefix}${slug}`;
    let learnedBranchPrefix;
    let version = null;
    const title = buildSelectionPrTitle(names, commandNames, updated, skillNames);
    try {
      git(["checkout", "-b", branch], repoDir);
      if (going.length) writeFileSync4(target, merged);
      if (goingCommands.length) mkdirSync6(join8(repoDir, TEAM_COMMANDS_DIR), { recursive: true });
      for (const command of goingCommands) {
        writeFileSync4(join8(repoDir, TEAM_COMMANDS_DIR, `${command.name}.md`), command.content);
      }
      for (const skill of goingSkills) {
        const dest = join8(repoDir, TEAM_SKILLS_DIR, skill.name);
        if (replacedSkills.includes(skill.name)) rmSync3(dest, { recursive: true, force: true });
        copySkillPayload(skill.dir, dest, skill.skillMd, skill.files);
      }
      version = bumpPluginVersion(repoDir);
      git(["add", "-A"], repoDir);
      git([...identity.args, "commit", "-m", `${commitPrefix}${title}`], repoDir);
      const pushed = pushBranch(git, repoDir, branch, pushTeam.team, slug, remoteBranches);
      branch = pushed.branch;
      learnedBranchPrefix = pushed.learnedBranchPrefix;
    } catch (err) {
      return {
        ok: false,
        ...single,
        refused,
        error: pushFailureReason(
          team.repoUrl,
          branch,
          err,
          'Set "branchPrefix" under "team" in ~/.teamhandbook/config.json to a prefix that fits (for example "TEAM-1-"), then run this again.',
          teamCommitPrefixFix(pushTeam.team, "run this again")
        )
      };
    }
    const requiresEnv = [];
    for (const { audit } of going) {
      for (const name of audit.requiresEnv) if (!requiresEnv.includes(name)) requiresEnv.push(name);
    }
    const pr = openPr(
      team.repoUrl,
      branch,
      title,
      buildSelectionPrBody(going, goingCommands, team.marketplaceName, updated, goingSkills),
      repoDir,
      forge
    );
    return {
      ok: true,
      ...single,
      ...names.length ? { serverNames: names } : {},
      ...commandNames.length ? { commandNames } : {},
      ...skillNames.length ? { skillNames } : {},
      ...updated.servers.length || updated.commands.length || updated.skills.length ? { updated } : {},
      ...refused.length ? { refused } : {},
      branch,
      requiresEnv,
      startsProcess: going.some((s) => s.audit.startsProcess),
      ...version ? { version } : {},
      ...pr.url ? { prUrl: pr.url } : { manualUrl: manualPrUrl(team.repoUrl, branch) ?? void 0 },
      ...pr.url ? {} : pr.error ? { prError: pr.error } : {},
      ...learnedBranchPrefix ? { learnedBranchPrefix } : {},
      ...pushTeam.learned !== void 0 ? { learnedCommitPrefix: pushTeam.learned } : {}
    };
  } finally {
    rmSync3(workdir, { recursive: true, force: true });
  }
}

// src/lib/share.ts
function localSkillDirs(paths = {}) {
  return [
    { dir: join9(paths.userHome ?? homedir5(), ".claude", "skills"), scope: "personal" },
    { dir: join9(paths.cwd ?? process.cwd(), ".claude", "skills"), scope: "project" }
  ];
}
function isDirectory(path) {
  try {
    return statSync2(path).isDirectory();
  } catch {
    return false;
  }
}
function skillRefusal(audit) {
  switch (audit.reason) {
    case "unsafe-name":
      return "its directory name cannot be a skill name (lowercase letters, digits and dashes)";
    case "no-skill-md":
      return "it has no readable SKILL.md";
    case "no-frontmatter":
      return "its SKILL.md has no name and description frontmatter";
    case "irregular-entry":
      return `it contains "${audit.detail}", which is not a regular file`;
    case "no-files":
      return "it has no files to share";
    case "unreadable":
      return `"${audit.detail}" cannot be read, so it cannot be screened`;
    default:
      return `"${audit.secret?.file}" looks like it contains a secret (${audit.detail})`;
  }
}
function readSkillDir(dir, scope) {
  const name = basename3(dir);
  const audit = auditSkillDir(dir);
  const base = { kind: "skill", name, scope, dir, description: audit.summary?.description ?? "" };
  return audit.shareable ? { ...base, shareable: true } : { ...base, shareable: false, reason: skillRefusal(audit) };
}
function commandItem(entry, audit) {
  const base = { kind: "command", name: entry.name, scope: entry.scope, file: entry.file };
  return audit.shareable ? { ...base, description: audit.description ?? "", shareable: true } : { ...base, description: "", shareable: false, reason: commandRefusalSummary(audit) };
}
function serverItem(entry, audit) {
  const base = {
    kind: "mcp",
    name: entry.name,
    scope: entry.scope,
    entry,
    transport: audit.transport,
    startsProcess: audit.startsProcess,
    requiresEnv: audit.requiresEnv
  };
  return audit.migratable ? { ...base, shareable: true } : { ...base, shareable: false, reason: refusalSummary(audit), fullReason: refusalMessage(entry.name, audit) };
}
function buildInventory(paths = {}, teamHas = null) {
  const onTeam = (item, names) => names?.includes(item.name) ? { ...item, onTeam: true } : item;
  const byName = /* @__PURE__ */ new Map();
  for (const { dir, scope } of localSkillDirs(paths)) {
    let entries;
    try {
      entries = readdirSync6(dir);
    } catch {
      continue;
    }
    for (const entry of entries.sort()) {
      if (!isDirectory(join9(dir, entry))) continue;
      byName.set(entry, onTeam(readSkillDir(join9(dir, entry), scope), teamHas?.skills));
    }
  }
  const servers = readLocalServers(paths.configFile ?? claudeConfigFile(), paths.cwd ?? process.cwd()).map(
    (entry) => onTeam(serverItem(entry, auditServer(entry.config)), teamHas?.servers)
  );
  const commands = readLocalCommands(paths.userHome ?? homedir5(), paths.cwd ?? process.cwd()).map(
    (entry) => onTeam(commandItem(entry, auditCommand(entry.file)), teamHas?.commands)
  );
  return { skills: [...byName.values()], servers, commands };
}
var DESCRIPTION_CHARS = 150;
function oneLine(text) {
  const first = text.split("\n")[0].trim();
  return first.length > DESCRIPTION_CHARS ? `${first.slice(0, DESCRIPTION_CHARS).trimEnd()}...` : first;
}
function onTeamNote(item) {
  return item.onTeam ? "  already on the team: picking it sends an update to their copy" : "";
}
function formatInventory(inv) {
  if (!inv.skills.length && !inv.servers.length && !inv.commands.length) {
    return "No skills, MCP servers or commands are set up on this machine or in this project, so there is nothing to take to the team yet.";
  }
  const lines = ["Your local Claude Code setup, as it is on this machine:"];
  if (inv.skills.length) {
    lines.push(
      "",
      `Skills (${inv.skills.length}) - the ones you pick go out as part of ONE merge request to the team repository`,
      ""
    );
    inv.skills.forEach((skill, i) => {
      const state = skill.shareable ? onTeamNote(skill) : `  not shareable: ${skill.reason}`;
      lines.push(`  ${i + 1}. ${skill.name}  [${skill.scope}]${state}`);
      if (skill.shareable) lines.push(`     ${oneLine(skill.description) || "(no description)"}`);
    });
  }
  if (inv.servers.length) {
    lines.push(
      "",
      `MCP servers (${inv.servers.length}) - the ones you pick travel in that SAME merge request`,
      ""
    );
    inv.servers.forEach((server, i) => {
      const needs = server.requiresEnv.length ? `, needs ${server.requiresEnv.join(", ")}` : "";
      const state = server.shareable ? server.startsProcess ? `shareable (starts a process on every teammate's machine)${needs}` : `shareable${needs}` : `not shareable: ${server.reason}`;
      lines.push(`  ${i + 1}. ${server.name}  [${server.scope}, ${server.transport}]  ${state}${onTeamNote(server)}`);
    });
  }
  if (inv.commands.length) {
    lines.push(
      "",
      `Commands (${inv.commands.length}) - the ones you pick travel in that SAME merge request, as commands/<name>.md`,
      ""
    );
    inv.commands.forEach((command, i) => {
      const state = command.shareable ? onTeamNote(command) : `  not shareable: ${command.reason}`;
      lines.push(`  ${i + 1}. /${command.name}  [${command.scope}]${state}`);
      if (command.shareable) lines.push(`     ${oneLine(command.description) || "(no description)"}`);
    });
    lines.push("", "  Commands namespaced in a subdirectory (/git:sync) cannot travel yet and are not listed.");
  }
  lines.push(
    "",
    "Everything you pick travels together, in one merge request, and other people can see it.",
    "Nothing is selected and nothing has been shared. A skill or a command carrying a",
    "credential is refused rather than redacted, and anything in a server's headers or env",
    "that is not a plain ${VAR} reference stays here: the name of a secret can travel, the",
    "secret cannot."
  );
  return lines.join("\n");
}
function shareSelection(selection, team, paths = {}, git = runGit, forge = runForge, options = {}) {
  const result = { refused: [] };
  const inv = buildInventory(paths);
  const skills = [];
  for (const name of selection.skills) {
    const skill = inv.skills.find((s) => s.name === name);
    if (!skill) {
      result.refused.push({ name, kind: "skill", reason: "no skill of that name is installed here" });
      continue;
    }
    skills.push({ name, dir: skill.dir, namedBy: "inventory" });
  }
  for (const dir of selection.skillPaths ?? []) {
    skills.push({ name: basename3(dir), dir, namedBy: "user" });
  }
  const entries = [];
  for (const name of selection.servers) {
    const server = inv.servers.find((s) => s.name === name);
    if (!server) result.refused.push({ name, kind: "mcp", reason: "no MCP server of that name is configured here" });
    else entries.push(server.entry);
  }
  const commands = [];
  for (const name of selection.commands) {
    const command = inv.commands.find((c) => c.name === name);
    if (!command) result.refused.push({ name, kind: "command", reason: "no command of that name is installed here" });
    else commands.push({ name: command.name, scope: command.scope === "project" ? "project" : "personal", file: command.file });
  }
  if (!entries.length && !commands.length && !skills.length) return result;
  if (!team) {
    const reason = "no team repository is configured. Run /handbook:init (or /handbook:join <url>) first";
    for (const skill of skills) result.refused.push({ name: skill.name, kind: "skill", reason });
    for (const entry of entries) result.refused.push({ name: entry.name, kind: "mcp", reason });
    for (const command of commands) result.refused.push({ name: command.name, kind: "command", reason });
    return result;
  }
  const outcome = publishTeamSelection({ servers: entries, commands, skills }, team, git, forge, options);
  result.team = outcome;
  const selectors = new Map(
    skills.map((skill) => [
      skill.name,
      skill.namedBy === "user" ? `--skill-path ${skill.dir}` : `--skill ${skill.name}`
    ])
  );
  for (const refusal of outcome.refused ?? []) {
    const selector = refusal.kind === "skill" ? selectors.get(refusal.name) : refusal.kind === "mcp" ? `--mcp ${refusal.name}` : `--command ${refusal.name}`;
    result.refused.push({
      name: refusal.name,
      kind: refusal.kind,
      reason: refusal.reason,
      ...refusal.collision ? { collision: true } : {},
      ...selector ? { selector } : {}
    });
  }
  if (!outcome.ok && outcome.error) {
    const judged = new Set((outcome.refused ?? []).map((r) => `${r.kind}:${r.name}`));
    for (const skill of skills) {
      if (!judged.has(`skill:${skill.name}`)) {
        result.refused.push({ name: skill.name, kind: "skill", reason: outcome.error });
      }
    }
    for (const entry of entries) {
      if (!judged.has(`mcp:${entry.name}`)) result.refused.push({ name: entry.name, kind: "mcp", reason: outcome.error });
    }
    for (const command of commands) {
      if (!judged.has(`command:${command.name}`)) {
        result.refused.push({ name: command.name, kind: "command", reason: outcome.error });
      }
    }
  }
  return result;
}
function formatShareResult(result, marketplaceName) {
  const lines = [];
  const shared = result.team;
  if (shared?.ok) {
    const servers = shared.serverNames ?? [];
    const commands = shared.commandNames ?? [];
    const skills = shared.skillNames ?? [];
    lines.push(
      `Shared with the team (${skills.length + servers.length + commands.length}) in one merge request:`
    );
    if (skills.length) lines.push(`  - skills (${skills.length}): ${skills.join(", ")}`);
    if (servers.length) lines.push(`  - MCP servers (${servers.length}): ${servers.join(", ")}`);
    if (commands.length) lines.push(`  - commands (${commands.length}): ${commands.join(", ")}`);
    const updated = [
      ...shared.updated?.skills ?? [],
      ...shared.updated?.servers ?? [],
      ...shared.updated?.commands ?? []
    ];
    if (updated.length) {
      lines.push(
        `  - sent as an update to the team's own copy (${updated.length}): ${updated.join(", ")} - the merge replaces theirs`
      );
    }
    lines.push(
      `  - branch: ${shared.branch}`,
      // manualPrUrl returns null for a remote whose host it does not know how to build a
      // "new merge request" link for. The branch is pushed either way, and printing
      // "undefined" at someone is worse than telling them the link is theirs to find.
      shared.prUrl ? `  - merge request: ${shared.prUrl}` : shared.manualUrl ? `  - open the merge request: ${shared.manualUrl}` : "  - the branch is pushed; open the merge request in your forge"
    );
    if (shared.prError) lines.push(`    (the forge CLI could not open it: ${shared.prError})`);
    if (shared.version) {
      lines.push(`  - plugin version raised to ${shared.version}, which is what makes teammates fetch it`);
    }
    if (shared.requiresEnv?.length) {
      lines.push(
        `  - each teammate must set ${shared.requiresEnv.join(", ")} in their own environment, or those servers will not start for them`
      );
    }
    if (shared.startsProcess) {
      lines.push("  - at least one of these starts a process on every teammate's machine; the request says which");
    }
    if (marketplaceName && servers.length) {
      lines.push(
        `  - after the merge they appear as plugin:${marketplaceName}:<name>. Your own copies are untouched:`,
        "    this never writes to ~/.claude.json, so you will see both until you remove yours."
      );
    }
    if (marketplaceName && commands.length) {
      lines.push(
        `  - after the merge the commands are typed as /${marketplaceName}:<name>. Your own are untouched:`,
        "    this never writes to ~/.claude/commands, so both names keep working."
      );
    }
  }
  const collisions = result.refused.filter((r) => r.collision);
  const faults = result.refused.filter((r) => !r.collision);
  if (faults.length) {
    if (lines.length) lines.push("");
    lines.push(`Not taken (${faults.length}):`, ...faults.map((r) => `  ${r.name} - ${r.reason}`));
  }
  if (collisions.length) {
    if (lines.length) lines.push("");
    lines.push(
      `The team already has these (${collisions.length}) - theirs is untouched:`,
      ...collisions.map((r) => `  ${r.name} - ${r.reason}`),
      "",
      "To send one of them as an update to the team's copy, name that one and only that one:",
      ...collisions.map((r) => `  share.js share ${r.selector ?? `--skill ${r.name}`} --update ${r.name}`)
    );
  }
  if (!lines.length) return "Nothing was selected, so nothing was shared.";
  return lines.join("\n");
}

// src/cli/share.ts
function usage() {
  console.error(
    "usage: share.js [list]\n       share.js share [--skill <name>]... [--skill-path <dir>]... [--mcp <name>]... [--command <name>]... [--update <name>]..."
  );
  process.exit(2);
}
function resolve(available, wanted) {
  if (available.includes(wanted)) return wanted;
  const loose = available.filter((name) => name.toLowerCase() === wanted.toLowerCase());
  return loose.length === 1 ? loose[0] : wanted;
}
var FLAGS = ["--skill", "--mcp", "--command"];
var SKILL_PATH = "--skill-path";
var UPDATE = "--update";
function parseUpdates(args, inv) {
  const names = [];
  const available = [
    ...inv.skills.map((s) => s.name),
    ...inv.servers.map((s) => s.name),
    ...inv.commands.map((c) => c.name)
  ];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== UPDATE) continue;
    const value = args[i + 1];
    if (!value || value.startsWith("--")) usage();
    names.push(resolve(available, value.replace(/^\//, "")));
  }
  return names;
}
function parseSelection(args, inv) {
  const selection = { skills: [], servers: [], commands: [], skillPaths: [] };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = args[i + 1];
    if (!FLAGS.includes(flag) && flag !== SKILL_PATH) continue;
    if (!value || value.startsWith("--")) usage();
    if (flag === SKILL_PATH) selection.skillPaths.push(toAbsolutePath(value));
    else if (flag === "--skill") selection.skills.push(resolve(inv.skills.map((s) => s.name), value));
    else if (flag === "--mcp") selection.servers.push(resolve(inv.servers.map((s) => s.name), value));
    else selection.commands.push(resolve(inv.commands.map((c) => c.name), value.replace(/^\//, "")));
    i++;
  }
  return selection;
}
function main() {
  const args = process.argv.slice(2);
  const selected = args.some((a) => FLAGS.includes(a) || a === SKILL_PATH);
  const update = args.includes(UPDATE);
  const [cmd = "list", ...rest] = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
  if (rest.length || cmd !== "list" && cmd !== "share") usage();
  if (cmd === "list" && (selected || update)) usage();
  if (cmd === "list") {
    const config = loadTeamConfig();
    console.log(formatInventory(buildInventory({}, config ? teamAssets(config) : null)));
    if (!config) {
      console.log(
        "\nNo team repository is configured yet, so nothing on this screen has anywhere to go: run /handbook:init (or /handbook:join <url>) first."
      );
    }
    return;
  }
  const inv = buildInventory();
  const selection = parseSelection(args, inv);
  const updates = parseUpdates(args, inv);
  if (!selection.skills.length && !selection.skillPaths.length && !selection.servers.length && !selection.commands.length) {
    console.log("Nothing was selected, so nothing was shared.");
    return;
  }
  if (configIsBroken()) {
    console.error(
      "error: ~/.teamhandbook/config.json is not valid JSON, so TeamHandbook cannot tell which repository your team uses. Fix the JSON (or delete the file) and try again."
    );
    process.exitCode = 1;
    return;
  }
  const team = loadTeamConfig();
  const result = shareSelection(selection, team, {}, void 0, void 0, updates.length ? { update: updates } : {});
  const learned = {
    ...result.team?.learnedBranchPrefix ? { branchPrefix: result.team.learnedBranchPrefix } : {},
    ...result.team?.learnedCommitPrefix !== void 0 ? { commitPrefix: result.team.learnedCommitPrefix } : {}
  };
  if (team && Object.keys(learned).length) saveTeamConfig({ ...team, ...learned });
  console.log(formatShareResult(result, team?.marketplaceName));
  if (result.refused.length) process.exitCode = 1;
}
main();
