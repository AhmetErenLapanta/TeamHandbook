// src/lib/status.ts
import { readFileSync as readFileSync7 } from "node:fs";
import { dirname as dirname2, join as join11 } from "node:path";
import { fileURLToPath } from "node:url";

// src/lib/session-state.ts
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
var EDIT_ATTACH_WINDOW_MS = 15 * 60 * 1e3;
function handbookHome() {
  return process.env.TEAMHANDBOOK_HOME ?? join(homedir(), ".teamhandbook");
}
var SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1e3;
var SESSION_ORPHAN_MS = 3 * 60 * 60 * 1e3;

// src/lib/signals.ts
import { join as join3 } from "node:path";

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

// src/lib/counters.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
    const parsed = JSON.parse(readFileSync(countersFile(home), "utf8"));
    for (const f of FIELDS) base[f] = Number(parsed?.[f]) || 0;
  } catch {
  }
  return base;
}

// src/lib/signals.ts
function signalsFile(home = handbookHome()) {
  return join3(home, "signals.jsonl");
}

// src/lib/usage.ts
import { readFileSync as readFileSync5 } from "node:fs";
import { basename as basename2, join as join8 } from "node:path";

// src/lib/init.ts
import { homedir as homedir3 } from "node:os";
import { dirname, join as join7 } from "node:path";

// src/lib/config.ts
import { existsSync, readFileSync as readFileSync2 } from "node:fs";
import { join as join4 } from "node:path";
function configFile(home = handbookHome()) {
  return join4(home, "config.json");
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

// src/lib/prompt-safety.ts
var INVISIBLE_FOR_MATCH = new RegExp("\\p{Default_Ignorable_Code_Point}", "u");
var LINE_TERMINATOR_CLASS = "\\n\\r\\u000B\\u000C\\u0085\\u2028\\u2029";
var LINE_TERMINATORS = new RegExp(`\\r\\n|[${LINE_TERMINATOR_CLASS}]`);
var LABEL_BREAKS = new RegExp(`[${LINE_TERMINATOR_CLASS}]+`, "g");

// src/lib/queue.ts
import { mkdirSync as mkdirSync2, readFileSync as readFileSync4, readdirSync as readdirSync3 } from "node:fs";
import { basename, join as join6 } from "node:path";

// src/lib/skill-index.ts
import { readdirSync as readdirSync2, readFileSync as readFileSync3 } from "node:fs";
import { join as join5 } from "node:path";
function candidatesDir(home = handbookHome()) {
  return join5(home, "candidates");
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
    const meta = JSON.parse(readFileSync3(join5(dir, entry, "candidate.json"), "utf8"));
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
      entries = readdirSync2(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (isDecidedCandidate(dir, entry)) continue;
      let raw;
      try {
        raw = readFileSync3(join5(dir, entry, "SKILL.md"), "utf8");
      } catch {
        continue;
      }
      const summary = parseSkillFrontmatter(raw);
      if (summary && !byName.has(summary.name)) byName.set(summary.name, summary);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// src/lib/queue.ts
var STATUSES = ["pending", "approved", "rejected", "archived"];
function candidateMetaFile(dir) {
  return join6(dir, "candidate.json");
}
function synthesizeMeta(dir) {
  let md;
  try {
    md = readFileSync4(join6(dir, "SKILL.md"), "utf8");
  } catch {
    return null;
  }
  const summary = parseSkillFrontmatter(md);
  if (!summary) return null;
  let grounded = {};
  try {
    grounded = JSON.parse(readFileSync4(join6(dir, "grounded-case.json"), "utf8"));
  } catch {
  }
  const gate = grounded.gate;
  return {
    slug: basename(dir),
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
    const parsed = JSON.parse(readFileSync4(candidateMetaFile(dir), "utf8"));
    if (typeof parsed === "object" && parsed !== null && STATUSES.includes(parsed.status) && typeof parsed.description === "string" && typeof parsed.scope === "string") {
      return {
        ...parsed,
        slug: basename(dir),
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
    entries = readdirSync3(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const metas = entries.filter((e) => e.isDirectory()).map((e) => readCandidateMeta(join6(base, e.name))).filter((m) => m !== null);
  const filtered = status ? metas.filter((m) => m.status === status) : metas;
  return filtered.sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || a.slug.localeCompare(b.slug)
  );
}
function brokenMeta(dir, reason) {
  return { reason, listed: readCandidateMeta(dir) !== null };
}
function unreadableCandidates(home = handbookHome()) {
  const base = candidatesDir(home);
  let entries;
  try {
    entries = readdirSync3(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const broken = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join6(base, entry.name);
    let raw = null;
    try {
      raw = readFileSync4(candidateMetaFile(dir), "utf8");
    } catch {
    }
    if (raw !== null) {
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        broken.push({ slug: entry.name, ...brokenMeta(dir, "its candidate.json is not valid JSON") });
        continue;
      }
      const meta = parsed;
      if (typeof meta !== "object" || meta === null) {
        broken.push({ slug: entry.name, ...brokenMeta(dir, "its candidate.json is not an object") });
        continue;
      }
      if (!STATUSES.includes(meta.status)) {
        broken.push({
          slug: entry.name,
          ...brokenMeta(dir, `its candidate.json has an unknown status ${JSON.stringify(meta.status)}`)
        });
        continue;
      }
      if (typeof meta.description !== "string" || typeof meta.scope !== "string") {
        broken.push({ slug: entry.name, ...brokenMeta(dir, "its candidate.json has no description or scope") });
        continue;
      }
      continue;
    }
    if (readCandidateMeta(dir) === null) {
      broken.push({
        slug: entry.name,
        reason: "it has no candidate.json and no readable SKILL.md frontmatter",
        listed: false
      });
    }
  }
  return broken.sort((a, b) => a.slug.localeCompare(b.slug));
}

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
  return join7(homedir3(), ".claude", "plugins", "marketplaces");
}
function teamSkillsDir(home = handbookHome(), root = marketplacesRoot()) {
  const team = loadTeamConfig(home);
  return team ? join7(root, team.marketplaceName, "skills") : null;
}

// src/lib/usage.ts
function usageFile(home = handbookHome()) {
  return join8(home, "skill-usage.json");
}
function readSkillUsage(home = handbookHome()) {
  try {
    const parsed = JSON.parse(readFileSync5(usageFile(home), "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const usage = {};
    for (const [slug, value] of Object.entries(parsed)) {
      const entry = value;
      if (typeof entry?.count === "number" && typeof entry?.lastAt === "string") {
        usage[slug] = { count: entry.count, lastAt: entry.lastAt };
      }
    }
    return usage;
  } catch {
    return {};
  }
}
function handbookSkills(home = handbookHome()) {
  const delivered = listCandidates(home, "approved").filter((c) => c.deliveredMode === "personal" || c.deliveredMode === "solo").map((c) => c.deliveredTo ? basename2(c.deliveredTo) : c.slug);
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
import { existsSync as existsSync2, readFileSync as readFileSync6, readdirSync as readdirSync4 } from "node:fs";
import { join as join9 } from "node:path";
function loadNotifyConfig(home = handbookHome()) {
  const notify = readConfigFile(home).notify;
  return {
    sessionStart: notify?.sessionStart !== false,
    heartbeat: notify?.heartbeat !== false
  };
}
var DIGEST_INTERVAL_MS = 7 * 24 * 60 * 60 * 1e3;
function pendingHarvestCount(home = handbookHome()) {
  let entries;
  try {
    entries = readdirSync4(join9(home, "pending"));
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    if (!entry.includes(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync6(join9(home, "pending", entry), "utf8"));
      if (parsed && typeof parsed === "object" && typeof parsed.sessionId === "string") total += 1;
    } catch {
    }
  }
  return total;
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

// src/lib/pipeline.ts
import { basename as basename3, join as join10 } from "node:path";
var STALE_CLAIM_MS = 10 * 60 * 1e3;
function pipelineLogFile(home = handbookHome()) {
  return join10(home, "pipeline.log");
}
var LOG_ROTATE_BYTES = 512 * 1024;
var MARKER_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1e3;

// src/lib/status.ts
function pluginVersion() {
  const here = dirname2(fileURLToPath(import.meta.url));
  for (const up of ["..", "../.."]) {
    try {
      const parsed = JSON.parse(
        readFileSync7(join11(here, up, ".claude-plugin", "plugin.json"), "utf8")
      );
      if (typeof parsed?.version === "string") return parsed.version;
    } catch {
    }
  }
  return "unknown";
}
function ledgerStats(home = handbookHome()) {
  const stats = { total: 0, candidates: 0, weak: 0, distinctFingerprints: 0 };
  let raw;
  try {
    raw = readFileSync7(signalsFile(home), "utf8");
  } catch {
    return stats;
  }
  const fingerprints = /* @__PURE__ */ new Set();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    stats.total += 1;
    if (parsed.kind === "candidate") stats.candidates += 1;
    if (parsed.kind === "weak") stats.weak += 1;
    if (typeof parsed.fingerprint === "string") fingerprints.add(parsed.fingerprint);
  }
  stats.distinctFingerprints = fingerprints.size;
  return stats;
}
function lastPipelineRun(home = handbookHome()) {
  let raw;
  try {
    raw = readFileSync7(pipelineLogFile(home), "utf8");
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
function pipelineAggregate(home = handbookHome()) {
  const agg = { runs: 0, written: 0, rejected: 0, errored: 0, sievedOut: 0 };
  let raw;
  try {
    raw = readFileSync7(pipelineLogFile(home), "utf8");
  } catch {
    return agg;
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const p = JSON.parse(line);
      agg.runs += 1;
      agg.written += Array.isArray(p.written) ? p.written.length : 0;
      agg.rejected += Number(p.rejected) || 0;
      agg.errored += Number(p.errored) || 0;
      agg.sievedOut += Number(p.sievedOut) || 0;
    } catch {
    }
  }
  return agg;
}
function gatherStatus(home = handbookHome()) {
  const candidates = listCandidates(home);
  const count = (status) => candidates.filter((c) => c.status === status).length;
  const score = loadScoreConfig(home);
  const harvest = loadHarvestConfig(home);
  const counters = readCounters(home);
  const approved = candidates.filter((c) => c.status === "approved");
  const known = handbookSkills(home);
  const teamShared = approved.filter((c) => c.deliveredMode === "team").length;
  return {
    home,
    version: pluginVersion(),
    ledger: ledgerStats(home),
    queue: {
      pending: count("pending"),
      approved: count("approved"),
      rejected: count("rejected"),
      archived: count("archived")
    },
    unreadable: unreadableCandidates(home),
    redactionBlocked: counters.redactionBlocked,
    sinceInstall: {
      approved: approved.length,
      teamShared,
      pairsCaptured: counters.pairsResolved,
      secretsBlocked: counters.redactionBlocked
    },
    detector: {
      postToolUse: counters.postToolUse,
      bashFailuresCaptured: counters.bashFailuresCaptured,
      pairsResolved: counters.pairsResolved
    },
    lastRun: lastPipelineRun(home),
    pipeline: pipelineAggregate(home),
    scoringNow: pendingHarvestCount(home),
    abandoned: counters.gateAbandoned,
    usage: { ...summarizeUsage(readSkillUsage(home), known), known: known.length },
    config: {
      harvestModel: harvest.model,
      harvestEnabled: harvest.enabled,
      harvestFloor: harvest.minScore,
      harvestMax: harvest.maxPerSession,
      learnThreshold: score.threshold,
      sessionStartNotice: loadNotifyConfig(home).sessionStart
    }
  };
}
function formatLastRejection(lastRun) {
  const reject = lastRun?.outcomes?.filter((o) => o.outcome === "reject").at(-1);
  if (!reject) return [];
  const score = reject.total !== void 0 ? `${reject.total}/10` : "n/a";
  const why = reject.duplicateOf ? `duplicate of "${reject.duplicateOf}"` : reject.rationale ?? "no rationale recorded";
  return [`Last rejection:  ${score} - ${why}`];
}
function formatLastError(lastRun) {
  const errored = lastRun?.outcomes?.filter((o) => o.outcome === "error").at(-1);
  if (!errored) return [];
  return [`Last error:      ${errored.error ?? "(no reason recorded)"} - run /handbook:doctor`];
}
function unreadableNote(unreadable) {
  if (!unreadable.length) return "";
  const lost = unreadable.filter((u) => !u.listed).length;
  const listed = unreadable.length - lost;
  const parts = [
    ...listed ? [`${listed} of them with an unusable candidate.json`] : [],
    ...lost ? [`${lost} unreadable and counted nowhere`] : []
  ];
  return ` (${parts.join(", ")})`;
}
function formatStatus(report) {
  const { ledger, queue, unreadable, lastRun, config } = report;
  const lines = [
    `TeamHandbook status  (v${report.version}, ${displayPath(report.home)})`,
    "",
    `Detector:        ${report.detector.postToolUse} tool calls seen, ${report.detector.bashFailuresCaptured} failures captured, ${report.detector.pairsResolved} pairs resolved`,
    `Signal ledger:   ${ledger.total} signals (${ledger.candidates} candidate, ${ledger.weak} weak), ${ledger.distinctFingerprints} distinct fingerprints`,
    // Archived candidates are counted here and nowhere else. "Quietly" means no nag,
    // not no trace: a queue that shrank by 151 items with no number to show for it
    // would have the product telling the developer something untrue about their data.
    `Candidate queue: ${queue.pending} pending, ${queue.approved} approved, ${queue.rejected} rejected${queue.archived > 0 ? `, ${queue.archived} archived` : ""}${unreadableNote(unreadable)}`,
    `Secret vetoes:   ${report.redactionBlocked} candidate(s) dropped by the secret scan`,
    `Since install:   ${report.sinceInstall.approved} skill${report.sinceInstall.approved === 1 ? "" : "s"} approved${report.sinceInstall.teamShared > 0 ? ` (${report.sinceInstall.teamShared} shared with the team)` : ""}, ${report.sinceInstall.pairsCaptured} error\u2192fix pair${report.sinceInstall.pairsCaptured === 1 ? "" : "s"} captured, ${report.sinceInstall.secretsBlocked} secret${report.sinceInstall.secretsBlocked === 1 ? "" : "s"} blocked`,
    lastRun ? `Last harvest:    ${lastRun.ts}${lastRun.trigger === "manual" ? " (manual)" : ""} - ${lastRun.received} received, ${lastRun.sievedOut} sieved out, ${lastRun.rejected} rejected, ${lastRun.errored} errored, ${lastRun.written.length} written` : "Last harvest:    never",
    ...formatLastRejection(lastRun),
    ...formatLastError(lastRun),
    `Harvest runs:    ${report.pipeline.runs} run(s) in log - ${report.pipeline.written} written, ${report.pipeline.rejected} rejected, ${report.pipeline.errored} errored, ${report.pipeline.sievedOut} sieved out`,
    ...report.usage.known > 0 ? [
      report.usage.totalUses > 0 ? `Skills in use:   ${report.usage.fired}/${report.usage.known} have fired, ${report.usage.totalUses} time${report.usage.totalUses === 1 ? "" : "s"} total` + (report.usage.topSkill ? ` (most used: ${report.usage.topSkill.slug} \xD7${report.usage.topSkill.count})` : "") : `Skills in use:   none of your ${report.usage.known} skill${report.usage.known === 1 ? " has" : "s have"} fired yet - they load by description, so this fills in as the situations come up`
    ] : [],
    ...report.abandoned > 0 ? [`Abandoned:       ${report.abandoned} session harvest(s) given up after repeated failures (kept in abandoned.jsonl) - run /handbook:doctor`] : [],
    ...report.scoringNow > 0 ? [`Harvesting now:  ${report.scoringNow} session(s) queued for the background harvest`] : [],
    "",
    config.harvestEnabled ? `Config:          harvest model "${config.harvestModel}" (floor ${config.harvestFloor}/10, max ${config.harvestMax}/session), learn threshold ${config.learnThreshold}/10, session-start notice ${config.sessionStartNotice ? "on" : "off"}` : `Config:          harvest DISABLED (sessions are never read or sent); learn threshold ${config.learnThreshold}/10, session-start notice ${config.sessionStartNotice ? "on" : "off"}`
  ];
  if (queue.pending > 0) {
    lines.push("", `Run /handbook:review to review the ${queue.pending} pending candidate(s).`);
  } else if (report.sinceInstall.approved === 0) {
    lines.push(
      "",
      "No skills yet - normal early on: TeamHandbook harvests a session after it ends, so finish a real session and check back. /handbook:demo walks the whole loop in two minutes, /handbook:learn captures something right now, and /handbook:doctor confirms TeamHandbook can reach your claude CLI."
    );
  }
  return lines.join("\n");
}

// src/cli/status.ts
console.log(formatStatus(gatherStatus()));
