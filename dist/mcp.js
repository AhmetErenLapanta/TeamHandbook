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
import { dirname as dirname2, join as join3 } from "node:path";

// src/lib/score.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);

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

// src/lib/init.ts
var REMOTE_HELPER = /^[A-Za-z][A-Za-z0-9+.-]*::/;
function assertSafeGitUrl(url) {
  const u = url.trim();
  if (!u || u.startsWith("-") || REMOTE_HELPER.test(u) || /[\r\n\0]/.test(u)) {
    throw new Error(`unsafe or unsupported git URL: ${url}`);
  }
}
var DEFAULT_BRANCH_PREFIX = "handbook/";
function teamCommitPrefix(config) {
  return config?.commitPrefix?.trim() ? `${config.commitPrefix.trim()} ` : "";
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
      `${join3(home, "config.json")} exists but is not valid JSON. TeamHandbook will not rewrite it, because doing so would silently discard settings you wrote \u2014 including the privacy switches, which are currently failing closed. Fix the JSON (or delete the file) and try again.`
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
var INIT_BRANCH_PREFIX_FIX = 'Re-run with a prefix that fits, for example --branch-prefix "HEM-1-", and it is remembered for every skill shared later.';
function pushFailureReason(url, branch, err, branchPrefixFix = INIT_BRANCH_PREFIX_FIX) {
  const raw = String(err instanceof Error ? err.message : err);
  const text = raw.toLowerCase();
  const detail = raw.split("\n").find((l) => l.trim())?.slice(0, 140) ?? "";
  const remoteSaid = raw.split("\n").filter((l) => l.trim().startsWith("remote:")).map((l) => l.replace(/^\s*remote:\s*/, "").trim()).filter(Boolean);
  const pattern = raw.match(/does not follow the pattern\s*'([^']+)'/)?.[1];
  if (pattern && !/commit message/i.test(raw)) {
    return `${url} rejected the branch NAME "${branch}": this project requires branch names matching ${pattern}. Nothing is wrong with your access. ${branchPrefixFix}`;
  }
  if (text.includes("protected") || text.includes("not allowed to push")) {
    return `${url} refused the push to ${branch}: ${remoteSaid[0] ?? "that branch is protected"}. Ask for the role that lets you write there, or have someone who has it push once.`;
  }
  if (/commit message/i.test(raw) && /pattern|does not|must/i.test(raw)) {
    return `${url} rejected the commit MESSAGE, not the contents: ${remoteSaid[0] ?? detail} Re-run with a prefix that satisfies it, for example --commit-prefix "HEM-1", and it is remembered for every skill shared later.`;
  }
  if (/author|committer/i.test(raw) && /email|not a .* user|restricted/i.test(raw)) {
    return `${url} rejected the commit AUTHOR: ${remoteSaid[0] ?? detail} The commit is made with your own \`git config user.name/user.email\`, so set those to the address your forge knows you by.`;
  }
  if (text.includes("pre-receive hook declined")) {
    return `${url} refused the push to ${branch} through a server-side rule: ${remoteSaid.join(" ") || detail}`;
  }
  if (text.includes("non-fast-forward") || text.includes("fetch first") || text.includes("rejected")) {
    return `${url} moved while this ran; nothing was changed. Re-run /handbook:init and it will pick the new state up.`;
  }
  return `pushing the scaffold to ${branch} on ${url} failed: ${detail}`;
}

// src/lib/mcp.ts
import { readFileSync as readFileSync3 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join4 } from "node:path";
var PURE_VAR_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
var CREDENTIAL_BEARING_FIELDS = ["headers", "env"];
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function claudeConfigFile() {
  const dir = process.env.CLAUDE_CONFIG_DIR?.trim();
  return join4(dir || homedir2(), ".claude.json");
}
function readLocalServers(file = claudeConfigFile(), cwd = process.cwd()) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync3(file, "utf8"));
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
function mergeServersIntoMcpJson(existing, servers) {
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
    target = isPlainObject(parsed.mcpServers) ? parsed.mcpServers : parsed;
  }
  const collided = [];
  for (const server of servers) {
    if (Object.prototype.hasOwnProperty.call(target, server.name)) {
      collided.push(server.name);
      continue;
    }
    if (document === null) {
      document = { mcpServers: target };
    }
    target[server.name] = server.config;
  }
  return { merged: JSON.stringify(document ?? { mcpServers: {} }, null, 2) + "\n", collided };
}
function refusalSummary(audit) {
  if (audit.reason === "credential-field") return `${audit.detail} holds a literal value`;
  if (audit.reason === "url-token") return `its URL carries what looks like a credential (${audit.detail})`;
  return String(audit.detail);
}
function formatServerList(entries) {
  if (!entries.length) {
    return "No MCP servers are configured for this machine or this project, so there is nothing to share yet. Add one the way you normally would (claude mcp add), then run this again.";
  }
  const lines = ["Your MCP servers, as Claude Code has them here:", ""];
  for (const entry of entries) {
    const audit = auditServer(entry.config);
    const state = audit.migratable ? audit.startsProcess ? "shareable (starts a process on every teammate's machine)" : "shareable" : `not shareable: ${refusalSummary(audit)}`;
    const needs = audit.requiresEnv.length ? `, needs ${audit.requiresEnv.join(", ")}` : "";
    lines.push(`  ${entry.name}  [${entry.scope}, ${audit.transport}]  ${state}${needs}`);
  }
  lines.push(
    "",
    "Nothing has been shared. Anything in headers or env that is not a plain ${VAR}",
    "reference stays here: the name of a secret can travel, the secret itself cannot."
  );
  return lines.join("\n");
}

// src/lib/publish.ts
import { existsSync as existsSync2, mkdirSync as mkdirSync3, readFileSync as readFileSync5, rmSync as rmSync3, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join6 } from "node:path";

// src/lib/commands.ts
import { readdirSync as readdirSync2, readFileSync as readFileSync4 } from "node:fs";
import { basename, join as join5 } from "node:path";

// src/lib/queue.ts
function isSafeSlug(slug) {
  return /^[a-z0-9][a-z0-9-]*$/.test(slug);
}

// src/lib/commands.ts
function commandDescription(content) {
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
  const described = frontmatter?.[1]?.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  if (described) return described.replace(/^["']|["']$/g, "");
  const body = frontmatter ? content.slice(frontmatter[0].length) : content;
  return body.split("\n").map((line) => line.trim()).find((line) => line && !line.startsWith("#")) ?? "";
}
function auditCommand(file) {
  const name = basename(file, ".md");
  if (!isSafeSlug(name)) return { shareable: false, reason: "unsafe-name", detail: name };
  let content;
  try {
    content = readFileSync4(file, "utf8");
  } catch {
    return { shareable: false, reason: "unreadable", detail: basename(file) };
  }
  const pattern = detectSecret(content);
  if (pattern) {
    return { shareable: false, reason: "secret", detail: pattern, secret: { pattern, file: basename(file) } };
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
function bumpPluginVersion(repoDir) {
  const file = join6(repoDir, ".claude-plugin", "plugin.json");
  try {
    const plugin = JSON.parse(readFileSync5(file, "utf8"));
    const parts = String(plugin.version ?? "0.1.0").split(".").map(Number);
    if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
    parts[2] = (parts[2] ?? 0) + 1;
    plugin.version = parts.join(".");
    writeFileSync2(file, JSON.stringify(plugin, null, 2) + "\n");
    return plugin.version;
  } catch {
    return null;
  }
}
var MAX_BRANCH_PATTERN_CHARS = 200;
function retryBranchAfterNameRejection(err, team, slug) {
  const raw = String(err instanceof Error ? err.message : err);
  if (/commit message/i.test(raw)) return null;
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
var TEAM_MCP_FILE = ".mcp.json";
var TEAM_COMMANDS_DIR = "commands";
function buildSelectionPrTitle(serverNames, commandNames) {
  const scopes = [serverNames.length ? "mcp" : "", commandNames.length ? "commands" : ""].filter(Boolean);
  return `feat(${scopes.join(",")}): add ${[...serverNames, ...commandNames].join(", ")}`;
}
function selectionIntro(servers, commands) {
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
function buildSelectionPrBody(subjects, commands) {
  const single = subjects.length === 1 && !commands.length;
  const lines = selectionIntro(subjects.length, commands.length).map(
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
    lines.push("", `- command: \`/${command.name}\``, `- file: \`${TEAM_COMMANDS_DIR}/${command.name}.md\``);
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
function publishMcpServer(entry, team, git = runGit, forge = runForge) {
  return publishTeamSelection({ servers: [entry] }, team, git, forge);
}
function collisionMessage(name) {
  return `the team repository already declares an MCP server named "${name}". Rename yours, or edit the team's .mcp.json directly.`;
}
function commandCollisionMessage(name) {
  return `the team repository already has a command named "${name}" (${TEAM_COMMANDS_DIR}/${name}.md). It was left exactly as it is; rename yours, or change theirs in the team repository.`;
}
function publishTeamSelection(selection, team, git = runGit, forge = runForge) {
  const entries = selection.servers ?? [];
  const commandEntries = selection.commands ?? [];
  const single = entries.length === 1 && !commandEntries.length ? { serverName: entries[0].name } : {};
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
  if (!subjects.length && !commands.length) {
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
  const identity = resolveGitIdentity(git);
  if ("error" in identity) return { ok: false, refused, error: identity.error };
  const prefix = teamBranchPrefix(team);
  const commitPrefix = teamCommitPrefix(team);
  const workdir = handbookWorkdir("handbook-mcp-");
  const repoDir = join6(workdir, "repo");
  try {
    const cloneError = cloneTeamRepo(git, team.repoUrl, repoDir, workdir);
    if (cloneError) return { ok: false, refused, error: cloneError };
    const remoteBranches = listRemoteBranches(git, repoDir);
    const target = join6(repoDir, TEAM_MCP_FILE);
    let merged = "";
    let collided = [];
    if (subjects.length) {
      try {
        ({ merged, collided } = mergeServersIntoMcpJson(
          existsSync2(target) ? readFileSync5(target, "utf8") : null,
          subjects.map((s) => s.entry)
        ));
      } catch (err) {
        return { ok: false, ...single, refused, error: String(err instanceof Error ? err.message : err) };
      }
    }
    const collisions = [];
    for (const name of collided) {
      collisions.push(collisionMessage(name));
      refused.push({ name, kind: "mcp", reason: collisionMessage(name) });
    }
    const going = subjects.filter((s) => !collided.includes(s.entry.name));
    const goingCommands = [];
    for (const command of commands) {
      if (existsSync2(join6(repoDir, TEAM_COMMANDS_DIR, `${command.name}.md`))) {
        collisions.push(commandCollisionMessage(command.name));
        refused.push({ name: command.name, kind: "command", reason: commandCollisionMessage(command.name) });
        continue;
      }
      goingCommands.push(command);
    }
    if (!going.length && !goingCommands.length) {
      return { ok: false, ...single, refused, error: collisions[0] ?? refused[0]?.reason ?? "nothing was left to share" };
    }
    const names = going.map((s) => s.entry.name);
    const commandNames = goingCommands.map((c) => c.name);
    const all = [...names, ...commandNames];
    const label = names.length ? commandNames.length ? "share" : "mcp" : "commands";
    const first = slugifySkillName(all[0]);
    const base = all.length === 1 ? `${label}-${first}` : `${label}-${first}-and-${all.length - 1}-more`;
    const slug = uniqueSlug(base, (s) => remoteBranches.has(`${prefix}${s}`));
    let branch = `${prefix}${slug}`;
    let learnedBranchPrefix;
    let version = null;
    const title = buildSelectionPrTitle(names, commandNames);
    try {
      git(["checkout", "-b", branch], repoDir);
      if (going.length) writeFileSync2(target, merged);
      if (goingCommands.length) mkdirSync3(join6(repoDir, TEAM_COMMANDS_DIR), { recursive: true });
      for (const command of goingCommands) {
        writeFileSync2(join6(repoDir, TEAM_COMMANDS_DIR, `${command.name}.md`), command.content);
      }
      version = bumpPluginVersion(repoDir);
      git(["add", "-A"], repoDir);
      git([...identity.args, "commit", "-m", `${commitPrefix}${title}`], repoDir);
      const pushed = pushBranch(git, repoDir, branch, team, slug, remoteBranches);
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
          'Set "branchPrefix" under "team" in ~/.teamhandbook/config.json to a prefix that fits (for example "HEM-1-"), then run this again.'
        )
      };
    }
    const requiresEnv = [];
    for (const { audit } of going) {
      for (const name of audit.requiresEnv) if (!requiresEnv.includes(name)) requiresEnv.push(name);
    }
    const pr = openPr(team.repoUrl, branch, title, buildSelectionPrBody(going, goingCommands), repoDir, forge);
    return {
      ok: true,
      ...single,
      ...names.length ? { serverNames: names } : {},
      ...commandNames.length ? { commandNames } : {},
      ...refused.length ? { refused } : {},
      branch,
      requiresEnv,
      startsProcess: going.some((s) => s.audit.startsProcess),
      ...version ? { version } : {},
      ...pr.url ? { prUrl: pr.url } : { manualUrl: manualPrUrl(team.repoUrl, branch) ?? void 0 },
      ...pr.url ? {} : pr.error ? { prError: pr.error } : {},
      ...learnedBranchPrefix ? { learnedBranchPrefix } : {}
    };
  } finally {
    rmSync3(workdir, { recursive: true, force: true });
  }
}
function formatMcpShareResult(outcome, marketplaceName) {
  const lines = [
    `Shared "${outcome.serverName}" with the team.`,
    "",
    `- branch: ${outcome.branch}`,
    // manualPrUrl returns null for a remote whose host it does not know how to build a
    // "new merge request" link for, and printing "undefined" at someone is worse than
    // telling them the branch is there and the link is theirs to find.
    outcome.prUrl ? `- merge request: ${outcome.prUrl}` : outcome.manualUrl ? `- open the merge request: ${outcome.manualUrl}` : "- the branch is pushed; open the merge request in your forge"
  ];
  if (outcome.prError) lines.push(`  (the forge CLI could not open it: ${outcome.prError})`);
  if (outcome.version) lines.push(`- plugin version raised to ${outcome.version}, which is what makes teammates fetch it`);
  if (outcome.requiresEnv?.length) {
    lines.push(
      `- each teammate must set ${outcome.requiresEnv.join(", ")} in their own environment, or the server will not start for them`
    );
  }
  if (outcome.startsProcess) {
    lines.push("- this server starts a process on every teammate's machine; the merge request says which");
  }
  lines.push(
    "",
    `After the merge it appears as plugin:${marketplaceName}:${outcome.serverName}. Your own copy is`,
    "untouched, so you will see both: this command never writes to ~/.claude.json. Remove the",
    `local "${outcome.serverName}" yourself (claude mcp remove) once the team's one is connected.`
  );
  return lines.join("\n");
}

// src/cli/mcp.ts
function usage() {
  console.error("usage: mcp.js [<server-name>]");
  process.exit(2);
}
function find(servers, wanted) {
  const exact = servers.find((s) => s.name === wanted);
  if (exact) return exact;
  const loose = servers.filter((s) => s.name.toLowerCase() === wanted.toLowerCase());
  if (loose.length === 1) return loose[0];
  return `no MCP server named "${wanted}" is configured here. Available: ${servers.map((s) => s.name).join(", ") || "(none)"}`;
}
function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || args[0]?.startsWith("-")) usage();
  const servers = readLocalServers();
  const wanted = args[0];
  if (!wanted) {
    console.log(formatServerList(servers));
    if (!loadTeamConfig()) {
      console.log(
        "\nNo team repository is configured yet, so there is nowhere to share these. Run /handbook:init (or /handbook:join <url>) first."
      );
    }
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
  if (!team) {
    console.error("error: no team repository is configured. Run /handbook:init (or /handbook:join <url>) first.");
    process.exitCode = 1;
    return;
  }
  const entry = find(servers, wanted);
  if (typeof entry === "string") {
    console.error(`error: ${entry}`);
    process.exitCode = 1;
    return;
  }
  const result = publishMcpServer(entry, team);
  if (!result.ok) {
    console.error(`error: ${result.error}`);
    process.exitCode = 1;
    return;
  }
  if (result.learnedBranchPrefix) {
    saveTeamConfig({ ...team, branchPrefix: result.learnedBranchPrefix });
  }
  console.log(formatMcpShareResult(result, team.marketplaceName));
}
main();
