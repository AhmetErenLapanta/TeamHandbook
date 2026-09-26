// src/lib/doctor.ts
import { execFileSync } from "node:child_process";
import { existsSync as existsSync4, mkdirSync as mkdirSync5, readdirSync as readdirSync3, readFileSync as readFileSync7, rmSync as rmSync4, writeFileSync as writeFileSync4 } from "node:fs";
import { join as join9 } from "node:path";

// src/lib/session-state.ts
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
var EDIT_ATTACH_WINDOW_MS = 15 * 60 * 1e3;
function handbookHome() {
  return process.env.TEAMHANDBOOK_HOME ?? join(homedir(), ".teamhandbook");
}
function handbookWorkdir(prefix, home = handbookHome()) {
  try {
    const root = join(home, "tmp");
    mkdirSync(root, { recursive: true });
    return mkdtempSync(join(root, prefix));
  } catch {
    return mkdtempSync(join(tmpdir(), prefix));
  }
}
var SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1e3;
var SESSION_ORPHAN_MS = 3 * 60 * 60 * 1e3;

// src/lib/counters.ts
import { mkdirSync as mkdirSync2, readdirSync as readdirSync2, readFileSync as readFileSync2, writeFileSync } from "node:fs";
import { join as join2 } from "node:path";
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

// src/lib/init.ts
import { existsSync as existsSync2, mkdirSync as mkdirSync3, readFileSync as readFileSync4, writeFileSync as writeFileSync2 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { dirname, join as join5 } from "node:path";

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
import { mkdtempSync as mkdtempSync2, rmSync as rmSync2 } from "node:fs";
import { tmpdir as tmpdir2 } from "node:os";
import { join as join4 } from "node:path";
import { promisify } from "node:util";

// src/lib/prompt-safety.ts
var INVISIBLE_FOR_MATCH = new RegExp("\\p{Default_Ignorable_Code_Point}", "u");
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

// src/lib/score.ts
var execFileAsync = promisify(execFile);
var defaultScoreConfig = {
  model: "haiku",
  threshold: 7,
  timeoutMs: 6e4
};
function loadScoreConfig(home = handbookHome()) {
  const gate = readConfigFile(home).gate;
  return {
    model: typeof gate?.model === "string" ? gate.model : defaultScoreConfig.model,
    threshold: typeof gate?.threshold === "number" && gate.threshold >= 0 && gate.threshold <= 10 ? gate.threshold : defaultScoreConfig.threshold,
    timeoutMs: typeof gate?.timeoutMs === "number" && gate.timeoutMs > 0 ? gate.timeoutMs : defaultScoreConfig.timeoutMs
  };
}
var CHILD_ISOLATION_ARGS = ["--tools", "", "--strict-mcp-config", "--restricted"];
var CHILD_ISOLATION_FLAGS = ["--tools", "--strict-mcp-config", "--restricted"];
function declaredOptions(helpText) {
  const rows = [];
  for (const line of helpText.split("\n")) {
    const match = /^(\s*)-\S/.exec(line);
    if (match) rows.push({ indent: match[1].length, text: line });
  }
  if (rows.length === 0) return /* @__PURE__ */ new Set();
  const column = Math.min(...rows.map((r) => r.indent));
  const options = /* @__PURE__ */ new Set();
  for (const row of rows) {
    if (row.indent > column + 1) continue;
    const flagColumn = row.text.trim().split(/\s{2,}/)[0] ?? "";
    for (const flag of flagColumn.match(/--[a-zA-Z0-9][a-zA-Z0-9-]*/g) ?? []) options.add(flag);
  }
  return options;
}
function childIsolationArgsFor(helpText) {
  const declared = declaredOptions(helpText);
  if (declared.size === 0) {
    return CHILD_ISOLATION_FLAGS.every((flag) => helpText.includes(flag)) ? CHILD_ISOLATION_ARGS : [];
  }
  return CHILD_ISOLATION_FLAGS.every((flag) => declared.has(flag)) ? CHILD_ISOLATION_ARGS : [];
}
function helpFormatRecognized(helpText) {
  return declaredOptions(helpText).size > 0;
}
var CHILD_ENV_EXACT = /* @__PURE__ */ new Set([
  // where the CLI, node and its config live
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "TMPDIR",
  "LANG",
  "TZ",
  // the Windows spelling of the same things
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "SystemRoot",
  "SystemDrive",
  "COMSPEC",
  "PATHEXT",
  // Windows spells the temp directory with these, not TMPDIR
  "TEMP",
  "TMP",
  // how it reaches the network at all, on a machine behind a proxy
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  // how it trusts that network, where TLS is intercepted by a corporate CA
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "REQUESTS_CA_BUNDLE",
  // which region a Vertex deployment answers on
  "CLOUD_ML_REGION",
  // which handbook home this call belongs to
  "TEAMHANDBOOK_HOME"
]);
var CHILD_ENV_PREFIXES = [
  "LC_",
  "ANTHROPIC_",
  "AWS_",
  "GOOGLE_",
  "GCLOUD_",
  "CLOUDSDK_",
  "AZURE_"
];
var CHILD_ENV_CLAUDE_ALLOW = /* @__PURE__ */ new Set([
  // which backend answers at all
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  // where the CLI's own config lives
  "CLAUDE_CONFIG_DIR",
  // the credentials it presents
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_CODE_API_KEY_HELPER_TTL_MS",
  "CLAUDE_CODE_CLIENT_KEY",
  "CLAUDE_CODE_CLIENT_KEY_PASSPHRASE",
  "CLAUDE_CODE_HOST_CREDS_FILE",
  // names ANOTHER variable that holds the credential; the name it points at is allowed
  // too, below, because the CLI itself designates it
  "CLAUDE_CODE_HOST_AUTH_ENV_VAR",
  // a gateway in front of the backend: the token it wants, and the six switches that say
  // "do not sign this request yourself, the gateway did". Without these a gateway install
  // tries to sign with SigV4 it does not have and the call fails - measured as the failure
  // mode of the previous, shorter list.
  "CLAUDE_CODE_GATEWAY_TOKEN",
  "CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
  "CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH",
  "CLAUDE_CODE_SKIP_ANTHROPIC_GOOGLE_CLOUD_AUTH",
  "CLAUDE_CODE_SKIP_MANTLE_AUTH",
  // which endpoint, and how to get through the proxy in front of it
  "CLAUDE_CODE_API_BASE_URL",
  "CLAUDE_CODE_HTTP_PROXY",
  "CLAUDE_CODE_HTTPS_PROXY",
  "CLAUDE_CODE_PROXY_AUTHENTICATE",
  "CLAUDE_CODE_ENABLE_PROXY_AUTH_HELPER"
]);
var CHILD_ENV_NEVER = [
  "NODE_OPTIONS",
  "NODE_TLS_REJECT_UNAUTHORIZED"
];
function childEnv(source = process.env) {
  const env = {};
  const designated = source.CLAUDE_CODE_HOST_AUTH_ENV_VAR;
  for (const [name, value] of Object.entries(source)) {
    if (value === void 0) continue;
    if (CHILD_ENV_NEVER.includes(name)) continue;
    if (name.startsWith("CLAUDE_")) {
      if (CHILD_ENV_CLAUDE_ALLOW.has(name)) env[name] = value;
      continue;
    }
    if (CHILD_ENV_EXACT.has(name) || name === designated || CHILD_ENV_PREFIXES.some((p) => name.startsWith(p))) {
      env[name] = value;
    }
  }
  return env;
}
function childInvocation(input) {
  const args = ["-p", input.prompt];
  if (input.model) args.push("--model", input.model);
  args.push(...childIsolationArgsFor(input.helpText));
  const cwd = mkdtempSync2(join4(tmpdir2(), "teamhandbook-child-"));
  return {
    args,
    env: childEnv(),
    cwd,
    done: () => rmSync2(cwd, { recursive: true, force: true })
  };
}

// src/lib/distill.ts
var defaultDistillConfig = {
  model: "",
  timeoutMs: 12e4
};
function loadDistillConfig(home = handbookHome()) {
  const distill = readConfigFile(home).distill;
  return {
    model: typeof distill?.model === "string" ? distill.model : defaultDistillConfig.model,
    timeoutMs: typeof distill?.timeoutMs === "number" && distill.timeoutMs > 0 ? distill.timeoutMs : defaultDistillConfig.timeoutMs
  };
}
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

// src/lib/forge.ts
function hostFromUrl(url) {
  const normalized = normalizeRemoteUrl(url);
  if (!normalized) return null;
  return normalized.slice(0, normalized.indexOf("/"));
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
function commitMessagePrefix(prefix) {
  return prefix?.trim() ? `${prefix.trim()} ` : "";
}
function loadTeamConfig(home = handbookHome()) {
  const team = readConfigFile(home).team;
  if (team && typeof team.repoUrl === "string" && typeof team.marketplaceName === "string") {
    return team;
  }
  return null;
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
          node-version: 20
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
  image: node:20
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
  if (new RegExp("\\p{C}", "u").test(value)) return "carrying a control character";
  return null;
}
function readTeamCommitPrefix(repoDir) {
  let raw;
  try {
    raw = JSON.parse(readFileSync4(join5(repoDir, TEAM_PREFIX_FILE), "utf8"))?.commitPrefix;
  } catch {
    return {};
  }
  if (typeof raw !== "string") return {};
  const value = raw.trim();
  const problem = commitPrefixProblem(value);
  return problem ? { problem } : { prefix: value };
}
function skeletonFiles(name, url, host, commitPrefix = "", withCi = false) {
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
function marketplacesRoot() {
  return join5(homedir3(), ".claude", "plugins", "marketplaces");
}

// src/lib/upgrade.ts
import { existsSync as existsSync3, lstatSync, mkdirSync as mkdirSync4, readFileSync as readFileSync5, rmSync as rmSync3, writeFileSync as writeFileSync3 } from "node:fs";
import { dirname as dirname2, join as join6, relative } from "node:path";
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
    return readFileSync5(file, "utf8");
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
function upgradeCandidates(repoDir, team) {
  const withCi = existsSync3(join6(repoDir, CI_MARKER));
  const recorded = commitPrefixIsKnown(team) ? void 0 : readTeamCommitPrefix(repoDir).prefix;
  const prefix = recorded ?? team.commitPrefix?.trim() ?? "";
  const generated = skeletonFiles(team.marketplaceName, team.repoUrl, hostFromUrl(team.repoUrl), prefix, withCi);
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
function classify(repoDir, candidates) {
  return Object.entries(candidates).map(([path, content]) => {
    const existing = readIfPresent(join6(repoDir, path));
    if (existing === null) return { path, state: "absent" };
    return { path, state: existing === content ? "current" : "differs" };
  });
}
function countStaleSkeleton(repoDir, team) {
  const files = classify(repoDir, upgradeCandidates(repoDir, team).files);
  return {
    absent: files.filter((file) => file.state === "absent").length,
    differs: files.filter((file) => file.state === "differs").length
  };
}

// src/lib/transcript.ts
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

// src/lib/status.ts
import { readFileSync as readFileSync6 } from "node:fs";
import { dirname as dirname3, join as join8 } from "node:path";
import { fileURLToPath } from "node:url";

// src/lib/notify.ts
var DIGEST_INTERVAL_MS = 7 * 24 * 60 * 60 * 1e3;

// src/lib/pipeline.ts
import { basename, join as join7 } from "node:path";
var STALE_CLAIM_MS = 10 * 60 * 1e3;
function pipelineLogFile(home = handbookHome()) {
  return join7(home, "pipeline.log");
}
var LOG_ROTATE_BYTES = 512 * 1024;
var MARKER_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1e3;

// src/lib/status.ts
function pluginVersion() {
  const here = dirname3(fileURLToPath(import.meta.url));
  for (const up of ["..", "../.."]) {
    try {
      const parsed = JSON.parse(
        readFileSync6(join8(here, up, ".claude-plugin", "plugin.json"), "utf8")
      );
      if (typeof parsed?.version === "string") return parsed.version;
    } catch {
    }
  }
  return "unknown";
}
function lastPipelineRun(home = handbookHome()) {
  let raw;
  try {
    raw = readFileSync6(pipelineLogFile(home), "utf8");
  } catch {
    return null;
  }
  const lines = raw.split("\n").filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (typeof parsed?.ts === "string") return parsed;
    } catch {
    }
  }
  return null;
}

// src/lib/doctor.ts
var runCommand = (cmd, args, timeoutMs, options) => execFileSync(cmd, args, {
  encoding: "utf8",
  timeout: timeoutMs,
  stdio: ["ignore", "pipe", "pipe"],
  ...options?.cwd ? { cwd: options.cwd } : {},
  // never let git/ssh block on an interactive prompt; stdin is closed anyway
  env: options?.env ?? {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: "ssh -oBatchMode=yes"
  }
}).trim();
function ok(name, detail) {
  return { name, level: "ok", detail };
}
function warn(name, detail) {
  return { name, level: "warn", detail };
}
function fail(name, detail) {
  return { name, level: "fail", detail };
}
function checkNode() {
  const major = Number(process.versions.node.split(".")[0]);
  return major >= 18 ? ok("node", `${process.version} (\u2265 18 required)`) : fail("node", `${process.version} - TeamHandbook needs Node \u2265 18`);
}
var PROBE_TIMEOUT_MS = 6e4;
function checkClaudeCli(run, home) {
  const unknownIsolation = warn(
    "model call isolation",
    "not established: the `claude CLI` check above did not get a successful call, so nothing here has exercised the restricted invocation"
  );
  try {
    run("claude", ["--version"], 15e3);
  } catch (err) {
    if (err?.code === "ENOENT") {
      return [
        fail(
          "claude CLI",
          "not found on PATH - the gate and distiller need it; install Claude Code CLI or fix PATH"
        ),
        unknownIsolation
      ];
    }
    const message = String(err instanceof Error ? err.message : err).split("\n")[0];
    return [
      fail("claude CLI", `found, but \`claude --version\` failed or timed out: ${message}`),
      unknownIsolation
    ];
  }
  let helpText = "";
  try {
    helpText = run("claude", ["--help"], 15e3);
  } catch {
    helpText = "";
  }
  const isolated = childIsolationArgsFor(helpText).length > 0;
  const harvestModel = loadHarvestConfig(home).model;
  const gateModel = loadScoreConfig(home).model;
  const distillModel = loadDistillConfig(home).model;
  const models = [...new Set([harvestModel, gateModel, distillModel].filter(Boolean))];
  for (const model of models) {
    try {
      const invocation = childInvocation({
        prompt: "Reply with exactly: OK",
        model: model ?? "",
        helpText
      });
      let reply;
      try {
        reply = run("claude", invocation.args, PROBE_TIMEOUT_MS, {
          env: invocation.env,
          cwd: invocation.cwd
        });
      } finally {
        invocation.done();
      }
      if (!/\bok\b/i.test(reply)) {
        return [
          warn("claude CLI", `installed, but a probe with model "${model}" returned an unexpected reply: ${reply.slice(0, 60)}`),
          unknownIsolation
        ];
      }
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err);
      const lower = message.toLowerCase();
      if (lower.includes("login") || lower.includes("auth") || lower.includes("logged")) {
        return [
          fail("claude CLI", "installed but NOT logged in - run `claude` and /login; the gate cannot score until then"),
          unknownIsolation
        ];
      }
      if (err?.code === "ETIMEDOUT" || lower.includes("etimedout")) {
        return [
          warn(
            "claude CLI",
            `installed and logged in, but the probe with model "${model}" did not answer within ${PROBE_TIMEOUT_MS / 1e3}s - usually a cold start; re-run this check`
          ),
          unknownIsolation
        ];
      }
      return [
        fail(
          "claude CLI",
          `logged in, but \`claude -p --model ${model}\` failed${isolated ? " with the restricted invocation the harvest uses" : ""} - is that model valid, and does it authenticate from the environment the call is given? (config.json harvest.model/gate.model/distill.model): ${(message.split("\n")[0] ?? "").slice(0, 80)}`
        ),
        unknownIsolation
      ];
    }
  }
  return [
    ok(
      "claude CLI",
      models.length > 1 ? `installed and authenticated (${models.length} configured models reachable)` : "installed and authenticated"
    ),
    !helpFormatRecognized(helpText) ? warn(
      "model call isolation",
      `help format unrecognized: nothing in \`claude --help\` reads as an option list, so whether this CLI can restrict the child session was decided by searching its text${isolated ? " - the restricting flags WERE passed and the call above answered" : ", and no restricting flags were passed"}`
    ) : isolated ? ok(
      "model call isolation",
      "verified by a real call: no tools, no MCP servers, no local settings, an empty working directory and a restricted environment"
    ) : warn(
      "model call isolation",
      "child session tool restriction unsupported by this claude version - the harvest still runs, but its model call gets this machine's tools, MCP servers and settings; upgrade Claude Code to restrict it"
    )
  ];
}
function checkGitIdentity(home, run) {
  if (!loadTeamConfig(home)) return null;
  const read = (args) => {
    try {
      return run("git", args, 5e3);
    } catch {
      return "";
    }
  };
  const email = read(["config", "user.email"]);
  if (!email) {
    return fail("git identity", "git user.email is not set - team PRs would ship with a junk author; run `git config --global user.email you@example.com`");
  }
  const global = read(["config", "--global", "user.email"]);
  if (global === email) return ok("git identity", `user.email = ${email}`);
  return ok(
    "git identity",
    `user.email = ${email}, resolved in ${displayPath(process.cwd())} rather than from your global config (${global || "unset"}) - team PRs are authored by the first of those, so check it is the address your forge knows you by`
  );
}
function checkHomeWritable(home) {
  const probe = join9(home, `.doctor-probe-${process.pid}`);
  try {
    mkdirSync5(home, { recursive: true });
    writeFileSync4(probe, "ok");
    rmSync4(probe, { force: true });
    return ok("state dir", `${displayPath(home)} writable`);
  } catch (err) {
    return fail("state dir", `cannot write ${displayPath(home)}: ${String(err instanceof Error ? err.message : err)}`);
  }
}
function checkConfig(home) {
  const file = join9(home, "config.json");
  if (!existsSync4(file)) return ok("config", "no config.json (defaults apply)");
  try {
    const parsed = JSON.parse(readFileSync7(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return fail(
        "config",
        "config.json is not a JSON object - automatic harvesting is OFF until it is (the privacy switches fail closed); every other setting falls back to its default"
      );
    }
    return ok("config", "config.json valid");
  } catch {
    return fail(
      "config",
      "config.json is not valid JSON - automatic harvesting is OFF until it parses (the privacy switches fail closed); every other setting falls back to its default"
    );
  }
}
function checkHooks(home) {
  const counters = readCounters(home);
  if (counters.postToolUse === 0) {
    return warn(
      "hooks",
      "no hook events recorded yet - run any command in a Claude Code session and re-check; if this stays 0 the hooks are not firing (was the plugin installed and the session restarted?)"
    );
  }
  return ok(
    "hooks",
    `firing - ${counters.postToolUse} tool calls seen, ${counters.bashFailuresCaptured} failures captured, ${counters.pairsResolved} pairs resolved`
  );
}
function remoteDistributionState(team, run) {
  const dir = handbookWorkdir("handbook-doctor-");
  try {
    run("git", ["clone", "--depth", "1", "--single-branch", "--", team.repoUrl, dir], 25e3);
    const version = JSON.parse(readFileSync7(join9(dir, ".claude-plugin", "plugin.json"), "utf8")).version;
    let skillCount = 0;
    try {
      skillCount = readdirSync3(join9(dir, "skills"), { withFileTypes: true }).filter((e) => e.isDirectory()).length;
    } catch {
    }
    const behind = countStaleSkeleton(dir, team);
    return typeof version === "string" ? { version, skillCount, missing: behind.absent } : null;
  } catch {
    return null;
  } finally {
    rmSync4(dir, { recursive: true, force: true });
  }
}
function checkTeamRepo(home, run) {
  const team = loadTeamConfig(home);
  if (!team) return ok("team repo", "not configured (solo mode - that's fine)");
  try {
    run("git", ["ls-remote", "--heads", "--", team.repoUrl], 2e4);
  } catch (err) {
    const message = String(err instanceof Error ? err.message : err).split("\n").slice(-2).join(" | ");
    return fail("team repo", `${team.repoUrl} NOT reachable - approvals cannot publish (${message})`);
  }
  const dist = remoteDistributionState(team, run);
  if (dist && dist.skillCount > 0 && dist.version === "0.1.0") {
    return warn(
      "team repo",
      `${team.repoUrl} reachable, but ${dist.skillCount} merged skill(s) sit at plugin version 0.1.0 - the version-bump CI has not run, so teammates are NOT receiving updates (check the TEAMHANDBOOK_CI_TOKEN variable / Actions write permission)`
    );
  }
  if (dist && dist.missing > 0) {
    return warn(
      "team repo",
      `${team.repoUrl} reachable, but ${dist.missing} scaffold file(s) this version ships are not in it at all - run \`/handbook:init --upgrade\` to see what they are and pick which to add (your skills, commands and MCP settings are never touched)`
    );
  }
  return ok("team repo", `${team.repoUrl} reachable`);
}
function checkForge(home, run) {
  const team = loadTeamConfig(home);
  if (!team) return null;
  const tool = (hostFromUrl(team.repoUrl) ?? "").includes("github") ? "gh" : "glab";
  try {
    run(tool, ["auth", "status"], 1e4);
    return ok("forge CLI", `${tool} authenticated - approvals can auto-open PRs`);
  } catch (err) {
    if (err?.code === "ENOENT") {
      return warn(
        "forge CLI",
        `${tool} not installed - approvals still push a branch and print a manual PR link; install ${tool} to auto-open PRs`
      );
    }
    return warn(
      "forge CLI",
      `${tool} installed but not authenticated - run \`${tool} auth login\` (approvals still print a manual link)`
    );
  }
}
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function declaredMcpServerNames(mcpFile) {
  let raw;
  try {
    raw = readFileSync7(mcpFile, "utf8");
  } catch {
    return { error: "unreadable" };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "invalid-json" };
  }
  if (!isPlainObject(parsed)) return { error: "invalid-json" };
  const map = isPlainObject(parsed.mcpServers) ? parsed.mcpServers : parsed;
  return { names: Object.keys(map) };
}
var MCP_LIST_LINE = /^(.+?):\s.*[-–]\s*(✔|✘|!)\s*(.+)$/;
function parseMcpListing(output) {
  const byName = /* @__PURE__ */ new Map();
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = MCP_LIST_LINE.exec(line);
    if (!match) continue;
    const [, name, mark, detail] = match;
    const state = mark === "\u2714" ? "connected" : mark === "!" ? "needs-auth" : "failed";
    byName.set(name.trim(), { state, detail: detail.trim() });
  }
  return byName;
}
function checkTeamMcpServers(home, run, marketRoot = marketplacesRoot()) {
  const team = loadTeamConfig(home);
  if (!team) return null;
  const mcpFile = join9(marketRoot, team.marketplaceName, ".mcp.json");
  if (!existsSync4(mcpFile)) {
    return ok("team MCP servers", "the team has not shared an MCP server yet");
  }
  const declared = declaredMcpServerNames(mcpFile);
  if ("error" in declared) {
    return declared.error === "unreadable" ? warn("team MCP servers", `cannot read ${displayPath(mcpFile)} - connection state unknown`) : warn("team MCP servers", `${displayPath(mcpFile)} is not valid JSON - cannot verify connection state`);
  }
  if (declared.names.length === 0) {
    return ok("team MCP servers", "the team's .mcp.json declares no servers yet");
  }
  let listing;
  try {
    listing = run("claude", ["mcp", "list"], 2e4);
  } catch (err) {
    const message = String(err instanceof Error ? err.message : err).split("\n")[0];
    return warn("team MCP servers", `\`claude mcp list\` failed - connection state unknown: ${message}`);
  }
  const statuses = parseMcpListing(listing);
  if (statuses.size === 0) {
    return warn(
      "team MCP servers",
      "`claude mcp list` returned nothing this check recognizes - connection state unknown (never assumed connected)"
    );
  }
  const results = declared.names.map((name) => {
    const status = statuses.get(`plugin:${team.marketplaceName}:${name}`);
    if (!status) return { name, state: "unknown", detail: "not listed by `claude mcp list`" };
    return { name, state: status.state, detail: status.detail };
  });
  const summary = results.map((r) => `${r.name}: ${r.state === "connected" ? "connected" : r.detail}`).join("; ");
  if (results.some((r) => r.state === "failed")) {
    return fail("team MCP servers", summary);
  }
  if (results.some((r) => r.state === "unknown")) {
    return warn("team MCP servers", `connection state unknown for at least one server - ${summary}`);
  }
  if (results.some((r) => r.state === "needs-auth")) {
    return warn("team MCP servers", summary);
  }
  return ok("team MCP servers", summary);
}
function checkLastRun(home) {
  const last = lastPipelineRun(home);
  if (!last) return ok("gate pipeline", "no runs yet (nothing recurred or was captured manually)");
  if (last.errored > 0) {
    const reason = last.outcomes?.filter((o) => o.outcome === "error").at(-1)?.error;
    const why = reason ? ` - ${reason}` : "";
    return warn(
      "gate pipeline",
      `last run had ${last.errored} error(s)${why} (see the claude CLI check above; full log: ${displayPath(join9(home, "pipeline.log"))})`
    );
  }
  return ok("gate pipeline", `last run ${last.ts}: ${last.written.length} written, ${last.rejected} rejected`);
}
function checkAbandoned(home) {
  const abandoned = readCounters(home).gateAbandoned;
  if (abandoned === 0) return null;
  return warn(
    "abandoned pairs",
    `${abandoned} captured pair(s) were given up after repeated gate failures - recoverable in ${displayPath(join9(home, "abandoned.jsonl"))} once claude works again`
  );
}
function runDoctor(home = handbookHome(), run = runCommand, marketRoot = marketplacesRoot()) {
  const checks = [
    checkNode(),
    ...checkClaudeCli(run, home),
    checkHomeWritable(home),
    checkConfig(home),
    checkHooks(home),
    checkTeamRepo(home, run)
  ];
  const identity = checkGitIdentity(home, run);
  if (identity) checks.push(identity);
  const forge = checkForge(home, run);
  if (forge) checks.push(forge);
  const mcpServers = checkTeamMcpServers(home, run, marketRoot);
  if (mcpServers) checks.push(mcpServers);
  checks.push(checkLastRun(home));
  const abandoned = checkAbandoned(home);
  if (abandoned) checks.push(abandoned);
  return { version: pluginVersion(), checks };
}
var MARKS = { ok: "\u2714", warn: "\u26A0", fail: "\u2718" };
function formatDoctor(report2) {
  const lines = [`TeamHandbook doctor  (v${report2.version})`, ""];
  for (const check of report2.checks) {
    lines.push(` ${MARKS[check.level]} ${check.name}: ${check.detail}`);
  }
  const counts = { ok: 0, warn: 0, fail: 0 };
  for (const check of report2.checks) counts[check.level] += 1;
  lines.push("", `${counts.ok} ok, ${counts.warn} warning(s), ${counts.fail} problem(s)`);
  if (counts.fail === 0 && counts.warn === 0) lines.push("Everything looks healthy.");
  return lines.join("\n");
}
function doctorExitCode(report2) {
  return report2.checks.some((c) => c.level === "fail") ? 1 : 0;
}

// src/cli/doctor.ts
var report = runDoctor();
console.log(formatDoctor(report));
process.exitCode = doctorExitCode(report);
