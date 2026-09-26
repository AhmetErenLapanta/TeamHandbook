// src/lib/join.ts
import { readFileSync as readFileSync4, rmSync as rmSync3 } from "node:fs";
import { join as join4 } from "node:path";

// src/lib/init.ts
import { execFileSync as execFileSync2 } from "node:child_process";
import { existsSync as existsSync2, mkdirSync as mkdirSync3, readFileSync as readFileSync3, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname as dirname2, join as join3 } from "node:path";

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
var execFileAsync = promisify(execFile);

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

// src/lib/git-errors.ts
import { execFileSync } from "node:child_process";
function probeCredentials() {
  const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", timeout: 5e3, stdio: ["ignore", "pipe", "pipe"] });
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

// src/lib/queue.ts
function isSafeSlug(slug) {
  return /^[a-z0-9][a-z0-9-]*$/.test(slug);
}

// src/lib/join.ts
function readMarketplaceName(repoDir) {
  try {
    const parsed = JSON.parse(
      readFileSync4(join4(repoDir, ".claude-plugin", "marketplace.json"), "utf8")
    );
    return typeof parsed?.name === "string" && parsed.name ? parsed.name : null;
  } catch {
    return null;
  }
}
var MARKETPLACE_NAME_MAX = 64;
function marketplaceNameProblem(name) {
  if (name.length > MARKETPLACE_NAME_MAX) {
    return `longer than ${MARKETPLACE_NAME_MAX} characters`;
  }
  if (!isSafeSlug(name)) {
    return "not a plain name (lowercase letters, digits and dashes, starting with a letter or a digit)";
  }
  return null;
}
function renderRejectedName(name) {
  const shown = name.slice(0, 60);
  return JSON.stringify(shown) + (shown.length < name.length ? " (truncated)" : "");
}
function joinTeamRepo(url, home = handbookHome(), git = runGit, now = (/* @__PURE__ */ new Date()).toISOString()) {
  if (!url.trim()) return { ok: false, error: "a git URL is required" };
  try {
    assertSafeGitUrl(url);
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err) };
  }
  if (configIsBroken(home)) {
    return { ok: false, error: new BrokenConfigError(home).message };
  }
  const existing = loadTeamConfig(home);
  if (existing && existing.repoUrl !== url) {
    return {
      ok: false,
      error: `already joined ${existing.repoUrl}; run /handbook:leave (or edit ${displayPath(join4(home, "config.json"))}) to switch teams`
    };
  }
  const workdir = handbookWorkdir("handbook-join-", home);
  const repoDir = join4(workdir, "repo");
  try {
    try {
      git(["clone", "--depth", "1", "--single-branch", "--", url, repoDir], workdir);
    } catch (err) {
      return { ok: false, error: cloneFailureReason(url, err) };
    }
    const name = readMarketplaceName(repoDir);
    if (!name) {
      return {
        ok: false,
        error: "the repository has no .claude-plugin/marketplace.json - is it a TeamHandbook team repo?"
      };
    }
    const problem = marketplaceNameProblem(name);
    if (problem) {
      return {
        ok: false,
        error: `the repository's .claude-plugin/marketplace.json names the marketplace ${renderRejectedName(name)}, which is ${problem}. That name becomes a directory under ~/.claude/plugins/marketplaces and part of the commands printed here, so TeamHandbook will not join with it. Fix the name in the repository and re-run.`
      };
    }
    const recorded = readTeamCommitPrefix(repoDir);
    saveTeamConfig(
      {
        ...existing ?? {},
        repoUrl: url,
        marketplaceName: name,
        joinedAt: now,
        ...recorded.prefix !== void 0 ? { commitPrefix: recorded.prefix } : {}
      },
      home
    );
    return {
      ok: true,
      name,
      url,
      home,
      ...recorded.prefix ? { commitPrefix: recorded.prefix } : {},
      ...recorded.prefix === void 0 ? { prefixNote: prefixNote(recorded.problem) } : {}
    };
  } finally {
    rmSync3(workdir, { recursive: true, force: true });
  }
}
function prefixNote(problem) {
  if (problem) {
    return `The repository's ${TEAM_PREFIX_FILE} names a commit-message prefix TeamHandbook will not use: it is ${problem}. Nothing was taken from it. If your project enforces a commit-message rule, fix that file in the repository; until then a share refused by the rule will say so.`;
  }
  return `This repository does not record a commit-message prefix (no ${TEAM_PREFIX_FILE}), which is what a handbook scaffolded by an older TeamHandbook looks like. If your project enforces a commit-message rule, your first share will be refused by it and the message will name the two ways out; whoever ran /handbook:init can record the prefix for everyone with \`/handbook:init --upgrade\`.`;
}
function formatJoinSuccess(result) {
  return [
    `Joined the team skill base at ${result.url}.`,
    "",
    "  engine:  approved skills will now target this repository",
    ...result.commitPrefix ? [`  commits: titled "${result.commitPrefix} ...", the prefix this repository records`] : [],
    `  config:  team repo saved to ${displayPath(join4(result.home ?? "", "config.json"))}`,
    "",
    ...result.prefixNote ? [result.prefixNote, ""] : [],
    "To finish, connect Claude Code to the team marketplace (built-in commands):",
    "",
    `  /plugin marketplace add ${result.url}`,
    `  /plugin install ${result.name}@${result.name}`
  ].join("\n");
}

// src/cli/join.ts
function usage() {
  console.error("usage: join.js <git-url>");
  process.exit(2);
}
function main() {
  const [url, extra] = process.argv.slice(2);
  if (!url || extra) usage();
  const result = joinTeamRepo(url);
  if (!result.ok) {
    console.error(`error: ${result.error}`);
    process.exit(1);
  }
  console.log(formatJoinSuccess(result));
}
main();
