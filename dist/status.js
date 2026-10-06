var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};

// src/lib/fs-atomic.ts
var init_fs_atomic = __esm({
  "src/lib/fs-atomic.ts"() {
    "use strict";
  }
});

// src/lib/session-state.ts
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
function handbookHome() {
  return process.env.TEAMHANDBOOK_HOME ?? join(homedir(), ".teamhandbook");
}
var EDIT_ATTACH_WINDOW_MS, SESSION_MAX_AGE_MS, SESSION_ORPHAN_MS;
var init_session_state = __esm({
  "src/lib/session-state.ts"() {
    "use strict";
    init_fs_atomic();
    EDIT_ATTACH_WINDOW_MS = 15 * 60 * 1e3;
    SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1e3;
    SESSION_ORPHAN_MS = 3 * 60 * 60 * 1e3;
  }
});

// src/lib/secrets.ts
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
function isWordsNotToken(match) {
  return !/[A-Z0-9+/=._~]/.test(match.replace(/^\s*bearer\s+/i, ""));
}
var PLACEHOLDER_VALUE, unquote, lastToken, SECRET_PATTERNS, GLOBAL_TWIN;
var init_secrets = __esm({
  "src/lib/secrets.ts"() {
    "use strict";
    PLACEHOLDER_VALUE = /^(?:[xX]+|changeme[0-9]{0,6}|placeholder[0-9]{0,6}|dummy[a-z-]{0,10}|your[-_][a-z-]{0,16}|example[a-z-]{0,10}|redacted)$/;
    unquote = (value) => value.replace(/^["']|["']$/g, "");
    lastToken = (match) => match.trim().split(/[\s=]+/).pop() ?? "";
    SECRET_PATTERNS = [
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
    GLOBAL_TWIN = new Map(
      SECRET_PATTERNS.filter((p) => p.reject).map((p) => [
        p.name,
        new RegExp(p.re.source, p.re.flags + "g")
      ])
    );
  }
});

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
var init_config = __esm({
  "src/lib/config.ts"() {
    "use strict";
    init_session_state();
  }
});

// src/lib/identity.ts
var HOME_PATH;
var init_identity = __esm({
  "src/lib/identity.ts"() {
    "use strict";
    HOME_PATH = new RegExp(
      "(?:\\/(?:Users|home)\\/|[A-Za-z]:\\\\{1,2}(?:Users|home)\\\\{1,2})([A-Za-z0-9._-]{1,40})",
      "g"
    );
  }
});

// src/lib/prompt-safety.ts
var LINE_TERMINATOR_CLASS, LINE_TERMINATORS, LABEL_BREAKS;
var init_prompt_safety = __esm({
  "src/lib/prompt-safety.ts"() {
    "use strict";
    init_identity();
    LINE_TERMINATOR_CLASS = "\\n\\r\\u000B\\u000C\\u0085\\u2028\\u2029";
    LINE_TERMINATORS = new RegExp(`\\r\\n|[${LINE_TERMINATOR_CLASS}]`);
    LABEL_BREAKS = new RegExp(`[${LINE_TERMINATOR_CLASS}]+`, "g");
  }
});

// src/lib/skill-index.ts
import { readdirSync as readdirSync2, readFileSync as readFileSync3 } from "node:fs";
import { join as join5 } from "node:path";
function candidatesDir(home = handbookHome()) {
  return join5(home, "candidates");
}
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
var BLOCK_SCALAR;
var init_skill_index = __esm({
  "src/lib/skill-index.ts"() {
    "use strict";
    init_session_state();
    BLOCK_SCALAR = /^[|>][-+]?\d*$/;
  }
});

// src/lib/skill-files.ts
var init_skill_files = __esm({
  "src/lib/skill-files.ts"() {
    "use strict";
  }
});

// src/lib/queue.ts
import { existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync as readFileSync4, readdirSync as readdirSync3 } from "node:fs";
import { basename, join as join6 } from "node:path";
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
var STATUSES;
var init_queue = __esm({
  "src/lib/queue.ts"() {
    "use strict";
    init_session_state();
    init_fs_atomic();
    init_skill_index();
    init_secrets();
    init_identity();
    init_skill_files();
    STATUSES = ["pending", "approved", "rejected", "archived"];
  }
});

// src/lib/score.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
function loadScoreConfig(home = handbookHome()) {
  const gate = readConfigFile(home).gate;
  return {
    model: typeof gate?.model === "string" ? gate.model : defaultScoreConfig.model,
    threshold: typeof gate?.threshold === "number" && gate.threshold >= 0 && gate.threshold <= 10 ? gate.threshold : defaultScoreConfig.threshold,
    timeoutMs: typeof gate?.timeoutMs === "number" && gate.timeoutMs > 0 ? gate.timeoutMs : defaultScoreConfig.timeoutMs
  };
}
var execFileAsync, defaultScoreConfig;
var init_score = __esm({
  "src/lib/score.ts"() {
    "use strict";
    init_session_state();
    init_config();
    init_prompt_safety();
    init_queue();
    execFileAsync = promisify(execFile);
    defaultScoreConfig = {
      model: "haiku",
      threshold: 7,
      timeoutMs: 6e4
    };
  }
});

// src/lib/skill-format.ts
function ci(source) {
  return new RegExp(source, "iu");
}
function splitFrontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!match) return { fields: null, body: text };
  const fields = {};
  let key = null;
  for (const line of match[1].split("\n")) {
    const kv = new RegExp(`^([${WORD_CHAR}-]+):[${SPACE}]*(.*)$`, "u").exec(line);
    if (kv) {
      key = kv[1];
      fields[key] = kv[2].trim();
    } else if (key && line.trim()) {
      fields[key] = `${fields[key]} ${line.trim()}`.trim();
    }
  }
  for (const [name, raw] of Object.entries(fields)) {
    let value = raw.replace(/^[>|][-+]?\s*/, "").trim();
    const chars = [...value];
    const first = chars[0];
    if (chars.length >= 2 && first === chars[chars.length - 1] && (first === '"' || first === "'")) {
      value = chars.slice(1, -1).join("");
    }
    fields[name] = value;
  }
  return { fields, body: match[2] };
}
function classifyLines(body) {
  const out = [];
  let inFence = false;
  for (const line of body.split("\n")) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      out.push({ kind: "fence-mark", text: line });
      continue;
    }
    if (inFence) {
      out.push({ kind: "fenced", text: line });
      continue;
    }
    const head = HEAD_RE.exec(line);
    out.push(head ? { kind: "head", level: head[1].length, title: head[2].trim() } : { kind: "text", text: line });
  }
  return out;
}
function sections(lines) {
  const heads = lines.map((line, index) => ({ line, index })).filter((entry) => entry.line.kind === "head");
  return heads.map((head, n) => {
    const next = heads.slice(n + 1).find((other) => other.line.level <= head.line.level);
    return {
      title: head.line.title,
      level: head.line.level,
      body: lines.slice(head.index + 1, next ? next.index : lines.length)
    };
  });
}
function dataRows(body) {
  const out = [];
  let afterSeparator = false;
  for (const line of body) {
    if (line.kind !== "text") continue;
    if (TABLE_SEP_RE.test(line.text) && line.text.includes("|")) afterSeparator = true;
    else if (TABLE_ROW_RE.test(line.text)) {
      if (afterSeparator) out.push(line.text);
    } else afterSeparator = false;
  }
  return out;
}
function firstCell(row) {
  return row.trim().replace(/^\|/, "").split("|")[0].trim();
}
function fileMapCells(text) {
  return sections(classifyLines(splitFrontmatter(text).body)).filter((s) => MAP_HEAD_RE.test(s.title)).flatMap((s) => dataRows(s.body)).map(firstCell);
}
function pathTokens(cell) {
  const matches = [...cell.replace(/`/g, "").matchAll(PATH_TOKEN_ALL_RE)].map((m) => m[0]);
  return matches.sort((a, b) => Number(b.includes("/")) - Number(a.includes("/")) || b.length - a.length);
}
function matcherFor(token) {
  if (!token) return null;
  const source = token.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\\\{[^}]*\\\}/g, "[^/]*").replace(/<[^>]*>/g, "[^/]*").replace(/\*/g, "[^/]*");
  try {
    return new RegExp(`(^|/)${source}$`, "i");
  } catch {
    return null;
  }
}
var WORD_CHAR, SPACE, WB2, XML_RE, TRIGGER_RE, ABBREV_RE, SENTENCE_SPLIT_RE, HEAD_RE, FENCE_RE, NUM_HEAD_RE, NUM_ITEM_RE, LIST_ITEM_RE, TABLE_ROW_RE, TABLE_SEP_RE, VERIFY_HEAD_RE, DELIVERY_HEAD_RE, COMMAND_RE, PITFALL_HEAD_RE, ABS_PATH_RE, EMAIL_RE, PATH_TOKEN_RE, PATH_TOKEN_ALL_RE, HEAD_NUMBER_RE, NOT_VISIBLE_HEAD_RE, OPEN_QUESTION_RE, MAP_HEAD_RE, EXEMPT_EXACT_RE;
var init_skill_format = __esm({
  "src/lib/skill-format.ts"() {
    "use strict";
    WORD_CHAR = "\\p{L}\\p{N}_";
    SPACE = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
    WB2 = `(?:(?<=[${WORD_CHAR}])(?![${WORD_CHAR}])|(?<![${WORD_CHAR}])(?=[${WORD_CHAR}]))`;
    XML_RE = new RegExp(`<[${SPACE}]*/?[${SPACE}]*[A-Za-z][${WORD_CHAR}-]*([${SPACE}][^<>]*)?>`, "u");
    TRIGGER_RE = ci(
      `${WB2}(use when|use whenever|use this when|use for|also when|also use when|should be used when|when the user|triggers?[${SPACE}]*:)`
    );
    ABBREV_RE = new RegExp(`${WB2}(e\\.g|i\\.e|etc|vs|cf)\\.`, "giu");
    SENTENCE_SPLIT_RE = new RegExp(`(?<=[.!?])[${SPACE}]+`, "u");
    HEAD_RE = new RegExp(`^(#{1,6})[${SPACE}]+(.*)$`, "u");
    FENCE_RE = new RegExp(`^[${SPACE}]*(\`\`\`|~~~)`, "u");
    NUM_HEAD_RE = ci(`^[${SPACE}]*(\\p{Nd}+[.)]|step[${SPACE}]+\\p{Nd}+|phase[${SPACE}]+\\p{Nd}+)`);
    NUM_ITEM_RE = new RegExp(`^[${SPACE}]*\\p{Nd}+[.)][${SPACE}]+[^${SPACE}]`, "u");
    LIST_ITEM_RE = new RegExp(`^[${SPACE}]*([-*+]|\\p{Nd}+[.)])[${SPACE}]+[^${SPACE}]`, "u");
    TABLE_ROW_RE = new RegExp(`^[${SPACE}]*\\|.*\\|[${SPACE}]*$`, "u");
    TABLE_SEP_RE = new RegExp(
      `^[${SPACE}]*\\|?[${SPACE}]*:?-{3,}:?[${SPACE}]*(\\|[${SPACE}]*:?-{3,}:?[${SPACE}]*)*\\|?[${SPACE}]*$`,
      "u"
    );
    VERIFY_HEAD_RE = ci(`verif|validat|checklist|${WB2}test`);
    DELIVERY_HEAD_RE = ci(`deliver|hand-?off|${WB2}done${WB2}|finish`);
    COMMAND_RE = ci(
      "```|`[^`\\n]*" + WB2 + "(run|gradlew|npm|npx|pytest|make|git|python3?|node|mvn|go|cargo|bash|\\./)[^`\\n]*`"
    );
    PITFALL_HEAD_RE = ci(
      "pitfall|mistake|gotcha|common (errors|failures|problems)|anti-?pattern|red flags"
    );
    ABS_PATH_RE = new RegExp(`(/(?:Users|home)/[^/${SPACE}]+|[A-Za-z]:\\\\Users\\\\)`, "u");
    EMAIL_RE = new RegExp(`[${WORD_CHAR}.+-]+@[${WORD_CHAR}-]+\\.[A-Za-z]{2,}`, "u");
    PATH_TOKEN_RE = /[^\s`|()]*(?:[/*]|\.[A-Za-z][A-Za-z0-9]{0,9})[^\s`|()]*/;
    PATH_TOKEN_ALL_RE = new RegExp(PATH_TOKEN_RE.source, "g");
    HEAD_NUMBER_RE = new RegExp(`^[${SPACE}]*(?:step[${SPACE}]+|phase[${SPACE}]+)?(\\p{Nd}+)`, "iu");
    NOT_VISIBLE_HEAD_RE = ci("not visible in history|not visible in the history");
    OPEN_QUESTION_RE = ci(
      "\\?|not (recorded|measured|visible|captured|in the evidence|known)|no commit|nothing (in the )?(history|evidence)|does not (say|record|show)|unknown|unclear|is not stated"
    );
    MAP_HEAD_RE = /file map|files? touched/i;
    EXEMPT_EXACT_RE = ci(
      "^(file map|files? touched|verification|verify|validation|checklist|tests?|delivery|deliver|hand-?off|finish(ed)?|done|common mistakes|mistakes|pitfalls?|gotchas?|anti-?patterns?|red flags|not visible in( the)? history)$"
    );
  }
});

// src/lib/status.ts
init_session_state();
import { execFileSync as execFileSync3 } from "node:child_process";
import { readFileSync as readFileSync9 } from "node:fs";
import { basename as basename6, dirname as dirname4, join as join13, resolve as resolve2 } from "node:path";
import { fileURLToPath } from "node:url";

// src/lib/signals.ts
init_session_state();
init_secrets();
import { join as join3 } from "node:path";

// src/lib/counters.ts
init_session_state();
init_fs_atomic();
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join as join2 } from "node:path";
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
  return join2(home, "counters.json");
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
init_fs_atomic();
import { readFileSync as readFileSync6 } from "node:fs";
import { basename as basename3, join as join9 } from "node:path";

// src/lib/init.ts
import { homedir as homedir3 } from "node:os";
import { dirname, join as join7 } from "node:path";

// src/lib/distill.ts
init_session_state();
init_config();
init_score();
init_skill_index();
init_prompt_safety();
init_secrets();
function openingsOf(literal) {
  return [...literal].reduceRight((rest, ch) => `(?:${ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${rest})?`, "");
}
var CUT_SCOPE_SENTENCE = new RegExp(
  `\\s*Applies ONLY in the(?: \\S*${openingsOf(" repository - do not use it elsewhere.")})?$`
);

// src/lib/branch.ts
init_identity();
init_secrets();

// src/lib/init.ts
init_session_state();
init_config();
init_fs_atomic();

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
init_secrets();
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
function nonInteractiveEnv(base = process.env) {
  return {
    ...base,
    GIT_TERMINAL_PROMPT: "0",
    GLAB_NO_PROMPT: "1",
    GH_PROMPT_DISABLED: "1",
    NO_COLOR: "1"
  };
}
function marketplacesRoot() {
  return join7(homedir3(), ".claude", "plugins", "marketplaces");
}
function teamSkillsDir(home = handbookHome(), root = marketplacesRoot()) {
  const team = loadTeamConfig(home);
  return team ? join7(root, team.marketplaceName, "skills") : null;
}

// src/lib/usage.ts
init_queue();
init_session_state();

// src/lib/session-workflow.ts
import { appendFileSync, mkdirSync as mkdirSync3, readFileSync as readFileSync5, realpathSync, statSync, writeFileSync as writeFileSync2 } from "node:fs";
init_config();
import { basename as basename2, dirname as dirname2, join as join8, relative, resolve, sep as sep2 } from "node:path";
init_identity();
init_secrets();
init_fs_atomic();
init_session_state();

// src/lib/mine.ts
init_secrets();

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
function readAuthorNames(repoPath, options = {}) {
  const run = options.run ?? defaultRunner;
  const args = ["log", options.ref ?? "HEAD", `--format=%H${FIELD}%aN${FIELD}%an`];
  if (options.since) args.push(`--since=${options.since}`);
  const names = /* @__PURE__ */ new Map();
  for (const line of run(args, repoPath).split("\n")) {
    if (!line) continue;
    const [sha, mapped, raw] = line.split(FIELD);
    if (!sha) continue;
    const both = [mapped, raw].filter((n) => Boolean(n));
    if (both.length) names.set(sha, [...new Set(both)]);
  }
  return names;
}
var MAX_BLOB_BYTES = 1 << 20;

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
  const filters = options.filters ?? true;
  const compiled = filters ? compiledRoles(all, namer(templates, areas), options.binaryPaths) : /* @__PURE__ */ new Set();
  return resolverFrom(mirrors, templates, areas, compiled, filters);
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
  const resolve3 = (path) => {
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
  resolve3.mirrors = mirrors;
  resolve3.templates = templates;
  resolve3.areas = areas;
  resolve3.compiled = compiled;
  return resolve3;
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
var PREFERRED_REFS = ["origin/master", "origin/main", "master", "main", "HEAD"];
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

// src/lib/session-workflow.ts
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
function repositoryOf(dir) {
  let at = resolve(dir);
  for (; ; ) {
    const dotgit = join8(at, ".git");
    try {
      const stat = statSync(dotgit);
      if (stat.isDirectory()) return { repo: realpathSync(at), checkout: at, gitdir: dotgit };
      if (stat.isFile()) {
        const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync5(dotgit, "utf8"));
        if (pointer) {
          const gitdir = resolve(at, pointer[1].trim());
          const marker = `${sep2}.git${sep2}worktrees${sep2}`;
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
function loadMinedRecord(home = handbookHome()) {
  try {
    const parsed = JSON.parse(readFileSync5(minedRecordFile(home), "utf8"));
    if (parsed?.version !== 1 || !Array.isArray(parsed.repos) || !Array.isArray(parsed.shapes)) return null;
    return parsed;
  } catch {
    return null;
  }
}
var COUNTED_MATCHES = /* @__PURE__ */ new Set(["shape"]);
function recentWorkflowSessions(home = handbookHome(), now = Date.now(), days = 30) {
  let raw;
  try {
    raw = readFileSync5(workflowsFile(home), "utf8");
  } catch {
    return { recognized: 0, matched: 0 };
  }
  const since = now - days * 864e5;
  const recognized = /* @__PURE__ */ new Set();
  const matched = /* @__PURE__ */ new Set();
  for (const text of raw.split("\n")) {
    if (!text.trim()) continue;
    let line;
    try {
      line = JSON.parse(text);
    } catch {
      continue;
    }
    const at = Date.parse(line.ts ?? "");
    if (typeof line.session !== "string" || !Number.isFinite(at) || at < since) continue;
    if (line.match && COUNTED_MATCHES.has(line.match)) recognized.add(line.session);
    if (line.match === "shape") matched.add(line.session);
  }
  return { recognized: recognized.size, matched: matched.size };
}
function sessionsByShape(home = handbookHome(), now = Date.now(), days = 30) {
  let raw;
  try {
    raw = readFileSync5(workflowsFile(home), "utf8");
  } catch {
    return /* @__PURE__ */ new Map();
  }
  const since = now - days * 864e5;
  const sessions = /* @__PURE__ */ new Map();
  for (const text of raw.split("\n")) {
    if (!text.trim()) continue;
    let line;
    try {
      line = JSON.parse(text);
    } catch {
      continue;
    }
    const at = Date.parse(line.ts ?? "");
    if (typeof line.session !== "string" || typeof line.shape !== "string" || !Number.isFinite(at) || at < since) continue;
    const seen = sessions.get(line.shape) ?? /* @__PURE__ */ new Set();
    seen.add(line.session);
    sessions.set(line.shape, seen);
  }
  return new Map([...sessions].map(([shape, seen]) => [shape, seen.size]));
}

// src/lib/usage.ts
init_skill_index();
var USAGE_DAYS = 30;
var DAY = /^\d{4}-\d{2}-\d{2}$/;
function usageFile(home = handbookHome()) {
  return join9(home, "skill-usage.json");
}
function readSkillUsage(home = handbookHome()) {
  try {
    const parsed = JSON.parse(readFileSync6(usageFile(home), "utf8"));
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
function dayOf(at) {
  return at.slice(0, 10);
}
function windowStart(at, days) {
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? new Date(ms - (days - 1) * 864e5).toISOString().slice(0, 10) : dayOf(at);
}
function usesSince(use, now = (/* @__PURE__ */ new Date()).toISOString(), days = USAGE_DAYS) {
  if (!use?.days) return 0;
  const since = windowStart(now, days);
  const today = dayOf(now);
  return Object.entries(use.days).reduce((sum, [day, count]) => day >= since && day <= today ? sum + count : sum, 0);
}
function handbookSkills(home = handbookHome()) {
  const delivered = listCandidates(home, "approved").filter((c) => c.deliveredMode === "personal" || c.deliveredMode === "solo").map((c) => c.deliveredTo ? basename3(c.deliveredTo) : c.slug);
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

// src/lib/status.ts
init_queue();

// src/lib/notify.ts
init_fs_atomic();
init_session_state();
init_config();
import { existsSync as existsSync3, readFileSync as readFileSync7, readdirSync as readdirSync4 } from "node:fs";
import { join as join10 } from "node:path";
init_queue();

// src/lib/harvest.ts
init_session_state();
init_config();
init_prompt_safety();
init_secrets();
init_identity();
init_score();

// src/lib/teachings.ts
init_fs_atomic();
init_session_state();

// src/lib/harvest.ts
init_skill_index();
init_queue();

// src/lib/transcript.ts
init_secrets();
init_prompt_safety();
var PER_USER_CAP = 1e3;
var USER_HEAD = 700;
var USER_TAIL = PER_USER_CAP - USER_HEAD;
var ROLE_LABEL = new RegExp(`(^|[${LINE_TERMINATOR_CLASS}])(User|Assistant)(\\s*:)`, "gi");
var WRAPPED_LINE_MIN = 24;
var BLOB_LINE = new RegExp(`^[A-Za-z0-9+/]{${WRAPPED_LINE_MIN},}={0,2}$`);

// src/lib/harvest.ts
init_skill_index();
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

// src/lib/review-list.ts
init_queue();
init_session_state();

// src/lib/notify.ts
init_skill_index();
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
    entries = readdirSync4(join10(home, "pending"));
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    if (!entry.includes(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync7(join10(home, "pending", entry), "utf8"));
      if (parsed && typeof parsed === "object" && typeof parsed.sessionId === "string") total += 1;
    } catch {
    }
  }
  return total;
}

// src/lib/status.ts
init_score();

// src/lib/pipeline.ts
import { basename as basename4, join as join11 } from "node:path";
init_fs_atomic();
init_session_state();
init_secrets();

// src/lib/gate.ts
init_session_state();
init_secrets();

// src/lib/pipeline.ts
init_score();
init_skill_index();
init_queue();
var STALE_CLAIM_MS = 10 * 60 * 1e3;
function pipelineLogFile(home = handbookHome()) {
  return join11(home, "pipeline.log");
}
var LOG_ROTATE_BYTES = 512 * 1024;
var MARKER_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1e3;

// src/lib/skill-health.ts
import { execFileSync as execFileSync2 } from "node:child_process";
import { readFileSync as readFileSync8, realpathSync as realpathSync2 } from "node:fs";
import { homedir as homedir4 } from "node:os";
import { basename as basename5, dirname as dirname3, join as join12, relative as relative2, sep as sep3 } from "node:path";

// src/lib/draft.ts
init_identity();
init_prompt_safety();
init_secrets();
function slicePaths(slice) {
  const out = [];
  for (const commit of slice.commits) for (const path of commit.paths) if (!out.includes(path)) out.push(path);
  return out;
}
function readUnitIndex(repoPaths, options = {}) {
  const labels = repoLabels(repoPaths);
  const byRepo = /* @__PURE__ */ new Map();
  for (const repoPath of repoPaths) {
    if (!isRepository(repoPath, { run: options.run })) continue;
    const ref = options.ref ?? resolveRef(repoPath, PREFERRED_REFS, { run: options.run });
    if (!ref) continue;
    try {
      byRepo.set(labels.get(repoPath), {
        path: repoPath,
        ref,
        commits: readCommits(repoPath, { ...options, ref })
      });
    } catch (error) {
      void gitFailure(error);
    }
  }
  const prefixes = learnTicketPrefixes([...byRepo.values()].flatMap((r) => r.commits.map((c) => c.subject)));
  const index = /* @__PURE__ */ new Map();
  for (const [repo, { path, ref, commits }] of byRepo) {
    const names = readAuthorNames(path, { ...options, ref });
    for (const { commit, key, cls } of assignUnitKeys(commits, repo, prefixes, options)) {
      if (cls !== "work") continue;
      let record = index.get(key);
      if (!record) index.set(key, record = { key, slices: [], firstAt: commit.date, authorNames: [] });
      let slice = record.slices.find((s) => s.repo === repo);
      if (!slice) record.slices.push(slice = { repo, repoPath: path, ref, commits: [], firstAt: commit.date });
      slice.commits.push({
        sha: commit.sha,
        subject: commit.subject,
        paths: commit.files.map((f) => f.path),
        date: commit.date
      });
      if (commit.date < slice.firstAt) slice.firstAt = commit.date;
      if (commit.date < record.firstAt) record.firstAt = commit.date;
      for (const name of names.get(commit.sha) ?? []) {
        if (!record.authorNames.includes(name)) record.authorNames.push(name);
      }
    }
  }
  for (const record of index.values()) {
    for (const slice of record.slices) {
      slice.commits.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.sha < b.sha ? -1 : 1);
    }
    record.slices.sort((a, b) => a.firstAt < b.firstAt ? -1 : a.firstAt > b.firstAt ? 1 : a.repo < b.repo ? -1 : 1);
  }
  return index;
}
var WORD = "\\p{L}\\p{N}_";
var WB = `(?:(?<=[${WORD}])(?![${WORD}])|(?<![${WORD}])(?=[${WORD}]))`;
var INCIDENTAL_PATH_RE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Gemfile\.lock|composer\.lock|go\.sum|gradle\.lockfile|deno\.lock)$|\.(md|mdx|rst|txt)$|(^|\/)(docs?|CHANGELOG[^/]*|LICENSE[^/]*)(\/|$)|(^|\/)(dist|build|generated|node_modules|vendor|__generated__)(\/)/i;
function isIncidentalPath(path) {
  return INCIDENTAL_PATH_RE.test(path);
}
function coverage(roles, heldOut, index, roleOf) {
  const touchedRoles = /* @__PURE__ */ new Set();
  const narrowedRoles = /* @__PURE__ */ new Set();
  let files = 0;
  let narrowedFiles = 0;
  for (const key of heldOut) {
    for (const slice of index.get(key)?.slices ?? []) {
      for (const path of slicePaths(slice)) {
        files++;
        const role = roleOf(slice.repo, path);
        if (role) touchedRoles.add(role);
        if (isIncidentalPath(path)) continue;
        narrowedFiles++;
        if (role) narrowedRoles.add(role);
      }
    }
  }
  const narrowedPredicted = roles.filter((role) => !isIncidentalPath(role));
  return {
    ...score(roles, touchedRoles, files),
    narrowed: score(narrowedPredicted, narrowedRoles, narrowedFiles)
  };
}
function score(roles, touched, files) {
  const predicted = new Set(roles);
  const hit = [...touched].filter((role) => predicted.has(role)).length;
  return {
    recall: touched.size ? Number((hit / touched.size).toFixed(2)) : 0,
    precision: predicted.size ? Number((hit / predicted.size).toFixed(2)) : 0,
    predicted: predicted.size,
    actual: touched.size,
    hit,
    files
  };
}

// src/lib/skill-health.ts
init_queue();
init_session_state();
init_skill_format();
init_skill_index();
var ROW_LABEL = /^\s*`?([A-Za-z0-9][A-Za-z0-9._-]*)`?\s*:\s/;
var QUOTED = /`([^`]+)`/g;
function fileMapRows(text) {
  return fileMapCells(text).map(mapRow).filter((row) => row.patterns.length > 0);
}
function mapRow(cell) {
  let label = ROW_LABEL.exec(cell)?.[1] ?? null;
  const quoted = [...cell.matchAll(QUOTED)].map((m) => m[1]);
  const tokens = quoted.length ? quoted.flatMap(pathTokens) : pathTokens(cell).filter((t) => t.includes("/"));
  const patterns = [];
  for (const raw of tokens) {
    let token = raw.replace(/[,;:.]+$/, "");
    const colon = token.indexOf(":");
    if (colon > 0 && !/[/*]/.test(token.slice(0, colon))) {
      label ??= token.slice(0, colon);
      token = token.slice(colon + 1);
    }
    if (token && !patterns.includes(token)) patterns.push(token);
  }
  return { cell, label, patterns };
}
var LIST_TIMEOUT_MS = 1e4;
var trackedFiles = (root) => {
  try {
    const out = execFileSync2("git", ["-C", root, "ls-files", "-z"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: nonInteractiveEnv(),
      timeout: LIST_TIMEOUT_MS,
      maxBuffer: 256 * 1024 * 1024
    });
    return out.split("\0").filter(Boolean);
  } catch {
    return null;
  }
};
function repoTree(root, label, list = trackedFiles) {
  const files = list(root);
  if (!files) return null;
  return { root, label, files, role: buildRoleResolver(files) };
}
var VENDORED = /(^|\/)(node_modules|vendor|vendored|third_party|bower_components)\//;
var MIN_AREAS = 2;
function pathMatcher(pattern, repo) {
  const anyDepth = pattern.startsWith("**/");
  const body = anyDepth ? pattern.slice(3) : pattern.replace(/^\.\//, "");
  const segment = matcherFor(body);
  const prefixes = repo.base ? ["", `${repo.base}/`] : [""];
  const rooted = (path) => prefixes.some((prefix) => {
    if (!path.startsWith(prefix)) return false;
    const match = segment?.exec(path.slice(prefix.length));
    return !!match && match.index === 0 && match[1] === "";
  });
  const wildcard = /[*{<]/.test(body);
  const role = anyDepth || wildcard ? segment : null;
  const slash = body.lastIndexOf("/");
  const areaForm = wildcard && slash > 0 && body.slice(slash + 1).includes("*") ? matcherFor(`${body.slice(0, slash)}/*${body.slice(slash)}`) : null;
  const areas = areaForm ? new Set(repo.tree.files.filter((f) => !VENDORED.test(f) && areaForm.test(f)).map((f) => dirname3(f))) : null;
  const area = areas && areas.size >= MIN_AREAS ? areaForm : null;
  return (path) => !VENDORED.test(path) && (rooted(path) || (role?.test(path) ?? false) || (area?.test(path) ?? false));
}
function checkRows(rows, repoFor) {
  return rows.map((row) => {
    const repo = repoFor(row.label);
    if (!repo) return { cell: row.cell, repo: null, files: [], stale: null };
    const files = row.patterns.map((pattern) => {
      const matches = pathMatcher(pattern, repo);
      return repo.tree.files.filter((path) => matches(path)).length;
    });
    return { cell: row.cell, repo: repo.tree.label, files, stale: files.some((n) => n === 0) };
  });
}
var TREND_WINDOW = 10;
var MIN_WINDOW = 3;
var TREND_BAND = 0.25;
function fitTrend(rows, trees, repoFor, index) {
  const byRoot = new Map(trees.map((t) => [t.root, t]));
  const labels = repoLabels(trees.map((t) => t.root));
  const byLabel = new Map([...labels].map(([root, label]) => [label, byRoot.get(root)]));
  const mapped = rows.flatMap((row, i) => {
    const repo = repoFor(row.label);
    return repo ? [{ id: `map:${i}`, tree: repo.tree, matches: row.patterns.map((p) => pathMatcher(p, repo)) }] : [];
  });
  const roleOf = (repo, path) => {
    const tree = byLabel.get(repo);
    if (!tree) return null;
    const row = mapped.find((m) => m.tree === tree && m.matches.some((match) => match(path)));
    if (row) return row.id;
    const role = tree.role(path);
    return IGNORED_ROLES.has(role) ? null : `${tree.label}:${role}`;
  };
  const predicted = mapped.map((m) => m.id);
  const scored = [...index.values()].sort((a, b) => a.firstAt < b.firstAt ? -1 : a.firstAt > b.firstAt ? 1 : a.key < b.key ? -1 : 1).map((record) => coverage(predicted, [record.key], index, roleOf).narrowed).filter((score2) => score2.hit > 0).map((score2) => score2.recall);
  return trendOf(scored);
}
function trendOf(scored) {
  const window = Math.min(TREND_WINDOW, Math.floor(scored.length / 2));
  if (window < MIN_WINDOW) return { trend: null, units: scored.length, recent: null, prior: null };
  const recentScores = scored.slice(-window);
  const priorScores = scored.slice(-2 * window, -window);
  const delta = mean(recentScores) - mean(priorScores);
  const spread = 2 * Math.sqrt(variance(recentScores) / window + variance(priorScores) / window);
  const moved = Math.abs(delta) > Math.max(TREND_BAND, spread);
  return {
    trend: !moved ? "flat" : delta < 0 ? "down" : "up",
    units: scored.length,
    recent: Number(mean(recentScores).toFixed(2)),
    prior: Number(mean(priorScores).toFixed(2))
  };
}
function mean(values) {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}
function variance(values) {
  const m = mean(values);
  return values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
}
var FILLER = new Set(
  "a about after again all also an and any are as at be been before being both but by can could did do does doing done each either for from had has have having how if in into is it its itself just may might more most must no nor not now of off on once one only or other our out over own same should so some such than that the their them then there these they this those through to too under until up upon very was we were what when whenever where whether which while who whom why will with within without would you your yours use used uses using also trigger triggers skill skills request requests asks asked something someone thing things way e g eg etc via new instead like want wants need needs make makes made get gets".split(" ")
);
function triggerWords(description) {
  const words = /* @__PURE__ */ new Set();
  for (const match of description.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    let word = match[0];
    if (word.length < 3 || FILLER.has(word)) continue;
    if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) word = word.slice(0, -1);
    words.add(word);
  }
  return words;
}
function wordOverlap(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return Number((shared / (a.size + b.size - shared)).toFixed(3));
}
var OVERLAP_THRESHOLD = 0.25;
function overlappingSkills(named, others, threshold = OVERLAP_THRESHOLD) {
  const words = /* @__PURE__ */ new Map();
  const wordsOf = (skill) => {
    let set = words.get(skill.description);
    if (!set) words.set(skill.description, set = triggerWords(skill.description));
    return set;
  };
  const result = /* @__PURE__ */ new Map();
  for (const skill of named) {
    const hits = others.filter((other) => other.name !== skill.name).map((other) => ({ name: other.name, score: wordOverlap(wordsOf(skill), wordsOf(other)) })).filter((hit) => hit.score >= threshold).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    result.set(skill.name, [...new Set(hits.map((hit) => hit.name))]);
  }
  return result;
}
function readSkill(dir) {
  try {
    return readFileSync8(join12(dir, "SKILL.md"), "utf8");
  } catch {
    return null;
  }
}
function deliveredSkills(home) {
  const out = /* @__PURE__ */ new Map();
  for (const meta of listCandidates(home, "approved")) {
    if (meta.deliveredMode !== "solo" && meta.deliveredMode !== "personal" || !meta.deliveredTo) continue;
    const text = readSkill(meta.deliveredTo);
    if (text === null) continue;
    const name = basename5(meta.deliveredTo);
    if (out.has(name)) continue;
    const shape = meta.fingerprint?.startsWith("mine:") ? meta.fingerprint.slice("mine:".length) : null;
    const repo = meta.deliveredMode === "solo" ? repositoryOf(meta.deliveredTo)?.checkout ?? null : null;
    out.set(name, { name, text, repo, base: repo ? projectBase(repo, meta.deliveredTo) : "", shape });
  }
  const teamDir = teamSkillsDir(home);
  if (teamDir) {
    for (const skill of listExistingSkills([teamDir])) {
      if (out.has(skill.name)) continue;
      const text = readSkill(join12(teamDir, skill.name));
      if (text !== null) out.set(skill.name, { name: skill.name, text, repo: null, base: "", shape: null });
    }
  }
  return [...out.values()];
}
function projectBase(checkout, skillDir) {
  const rel = relative2(checkout, dirname3(dirname3(dirname3(skillDir)))).split(sep3).join("/");
  return rel.startsWith("..") ? "" : rel;
}
function installedSkills(home = handbookHome(), userHome = homedir4(), cwd = process.cwd()) {
  const teamDir = teamSkillsDir(home);
  return listExistingSkills([join12(cwd, ".claude", "skills"), join12(userHome, ".claude", "skills"), ...teamDir ? [teamDir] : []]);
}
function realRoot(root) {
  try {
    return realpathSync2(root);
  } catch {
    return root;
  }
}
function callsOf(name, usage, now) {
  return Object.entries(usage).filter(([key]) => key === name || key.endsWith(`:${name}`)).reduce((sum, [, use]) => sum + usesSince(use, now, USAGE_DAYS), 0);
}
function gatherSkillHealth(home = handbookHome(), deps = {}) {
  const skills = deliveredSkills(home);
  if (!skills.length) return [];
  const now = deps.now ?? (/* @__PURE__ */ new Date()).toISOString();
  const tracked = deps.tracked ?? trackedFiles;
  const units = deps.units ?? ((roots) => readUnitIndex(roots));
  const recording = sessionDetectEnabled(home);
  const usage = readSkillUsage(home);
  const sessions = sessionsByShape(home, Date.parse(now), USAGE_DAYS);
  const mined = loadMinedRecord(home);
  const minedRoots = new Map((mined?.repos ?? []).map((r) => [r.label, r.root]));
  const trees = /* @__PURE__ */ new Map();
  const treeAt = (root) => {
    const real = realRoot(root);
    if (!trees.has(real)) trees.set(real, repoTree(real, basename5(real), tracked));
    return trees.get(real);
  };
  const indexes = /* @__PURE__ */ new Map();
  const overlaps = overlappingSkills(
    skills.map((s) => ({ name: s.name, description: parseSkillFrontmatter(s.text)?.description ?? "" })),
    installedSkills(home, deps.userHome, deps.cwd)
  );
  return skills.map((skill) => {
    const rows = fileMapRows(skill.text);
    const repoFor = (label) => {
      const own = skill.repo && (label === null || basename5(skill.repo) === label) ? treeAt(skill.repo) : null;
      if (own) return { tree: own, base: skill.base };
      const root = label === null ? void 0 : minedRoots.get(label);
      const tree = root ? treeAt(root) : null;
      return tree ? { tree, base: "" } : null;
    };
    const checks = checkRows(rows, repoFor);
    const checked = checks.filter((c) => c.stale !== null);
    const used = [...new Set(rows.map((row) => repoFor(row.label)?.tree).filter((t) => !!t))];
    let trend = null;
    if (checked.length && used.length) {
      const key = used.map((t) => t.root).sort().join("\n");
      if (!indexes.has(key)) indexes.set(key, units(used.map((t) => t.root)));
      trend = fitTrend(rows, used, repoFor, indexes.get(key)).trend;
    }
    return {
      name: skill.name,
      map: { rows: rows.length, checked: checked.length, stale: checked.filter((c) => c.stale).length },
      uses: recording ? callsOf(skill.name, usage, now) : null,
      workflowSessions: recording && skill.shape ? sessions.get(skill.shape) ?? 0 : null,
      trend,
      overlaps: overlaps.get(skill.name) ?? []
    };
  });
}
var ARROW = { down: "\u2193", flat: "\u2192", up: "\u2191" };
function formatSkillHealth(health) {
  if (!health.length) return [];
  const width = Math.max(...health.map((h) => h.name.length));
  const lines = health.map((h) => {
    const parts = [
      !h.map.rows ? "no file map" : !h.map.checked ? "map not checkable here" : `map ${h.map.stale}/${h.map.checked} stale`,
      h.uses === null ? "usage not recorded" : `used ${h.uses}`
    ];
    if (h.workflowSessions !== null) parts.push(`workflow done ${h.workflowSessions}\xD7`);
    if (h.trend) parts.push(`fit to new work ${ARROW[h.trend]}`);
    if (h.overlaps.length) parts.push(`overlaps ${h.overlaps[0]}${h.overlaps.length > 1 ? ` +${h.overlaps.length - 1}` : ""}`);
    return `  ${h.name.padEnd(width)}  ${parts.join(" \xB7 ")}`;
  });
  const flagged = health.some((h) => h.map.stale > 0 || h.trend === "down" || h.overlaps.length);
  return [
    `Skill health:    last ${USAGE_DAYS} days; nothing here is changed for you`,
    ...lines,
    ...flagged ? ["  Stale map or falling fit: run /handbook:mine and draft that workflow again. Overlap: reword one of the two descriptions."] : []
  ];
}

// src/lib/status.ts
function pluginVersion() {
  const root = pluginRoot();
  if (!root) return "unknown";
  try {
    const parsed = JSON.parse(readFileSync9(join13(root, ".claude-plugin", "plugin.json"), "utf8"));
    if (typeof parsed?.version === "string") return parsed.version;
  } catch {
  }
  return "unknown";
}
function pluginRoot() {
  const here = dirname4(fileURLToPath(import.meta.url));
  for (const up of ["..", "../.."]) {
    try {
      const parsed = JSON.parse(readFileSync9(join13(here, up, ".claude-plugin", "plugin.json"), "utf8"));
      if (typeof parsed?.version === "string") return join13(here, up);
    } catch {
    }
  }
  return null;
}
var RELEASE_CHECK_TIMEOUT_MS = 5e3;
var lookupRelease = (args, cwd) => execFileSync3("git", args, {
  cwd,
  stdio: ["ignore", "pipe", "ignore"],
  encoding: "utf8",
  env: nonInteractiveEnv(),
  timeout: RELEASE_CHECK_TIMEOUT_MS
});
function newerRelease(installed, root = pluginRoot(), marketRoot = marketplacesRoot(), git = lookupRelease) {
  if (!root || !versionNumbers(installed)) return null;
  const versionDir = resolve2(root);
  if (basename6(dirname4(dirname4(dirname4(versionDir)))) !== "cache") return null;
  const marketplace = basename6(dirname4(dirname4(versionDir)));
  let out;
  try {
    out = String(git(["ls-remote", "--tags", "origin"], join13(marketRoot, marketplace)) ?? "");
  } catch {
    return null;
  }
  let latest = null;
  for (const line of out.split("\n")) {
    const tag = line.split("	")[1]?.match(/^refs\/tags\/v?(\d+\.\d+\.\d+)$/)?.[1];
    if (tag && (latest === null || laterThan(tag, latest))) latest = tag;
  }
  return latest && laterThan(latest, installed) ? latest : null;
}
function versionNumbers(version) {
  const parts = version.split(".").map(Number);
  return parts.length === 3 && parts.every((n) => Number.isInteger(n) && n >= 0) ? parts : null;
}
function laterThan(a, b) {
  const x = versionNumbers(a);
  const y = versionNumbers(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}
function newerReleaseLine(installed, newer) {
  return `${installed} is installed and a newer version is available (${newer}) - update it from /plugin`;
}
function ledgerStats(home = handbookHome()) {
  const stats = { total: 0, candidates: 0, weak: 0, distinctFingerprints: 0 };
  let raw;
  try {
    raw = readFileSync9(signalsFile(home), "utf8");
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
    raw = readFileSync9(pipelineLogFile(home), "utf8");
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
    raw = readFileSync9(pipelineLogFile(home), "utf8");
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
function gatherStatus(home = handbookHome(), release = newerRelease, health = gatherSkillHealth) {
  const candidates = listCandidates(home);
  const count = (status) => candidates.filter((c) => c.status === status).length;
  const score2 = loadScoreConfig(home);
  const harvest = loadHarvestConfig(home);
  const counters = readCounters(home);
  const approved = candidates.filter((c) => c.status === "approved");
  const known = handbookSkills(home);
  const teamShared = approved.filter((c) => c.deliveredMode === "team").length;
  const version = pluginVersion();
  const newerVersion = release(version);
  return {
    home,
    version,
    ...newerVersion ? { newerVersion } : {},
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
    workflows: recentWorkflowSessions(home),
    scoringNow: pendingHarvestCount(home),
    abandoned: counters.gateAbandoned,
    usage: { ...summarizeUsage(readSkillUsage(home), known), known: known.length, recording: sessionDetectEnabled(home) },
    skillHealth: health(home),
    config: {
      harvestModel: harvest.model,
      harvestEnabled: harvest.enabled,
      harvestFloor: harvest.minScore,
      harvestMax: harvest.maxPerSession,
      learnThreshold: score2.threshold,
      sessionStartNotice: loadNotifyConfig(home).sessionStart
    }
  };
}
function formatLastRejection(lastRun) {
  const reject = lastRun?.outcomes?.filter((o) => o.outcome === "reject").at(-1);
  if (!reject) return [];
  const score2 = reject.total !== void 0 ? `${reject.total}/10` : "n/a";
  const why = reject.duplicateOf ? `duplicate of "${reject.duplicateOf}"` : reject.rationale ?? "no rationale recorded";
  return [`Last rejection:  ${score2} - ${why}`];
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
    ...report.newerVersion ? [`Version:         ${newerReleaseLine(report.version, report.newerVersion)}`] : [],
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
    `Workflows:       ${report.workflows.recognized} workflow session${report.workflows.recognized === 1 ? "" : "s"} recognized in the last 30 days (${report.workflows.matched} matched a mined workflow)`,
    ...report.usage.known > 0 ? [
      // While recording is off the totals are frozen at whatever was counted before, so they are
      // not shown: the health lines below say "usage not recorded", and this line agrees with them.
      !report.usage.recording ? `Skills in use:   usage not recorded while session recording is off` : report.usage.totalUses > 0 ? `Skills in use:   ${report.usage.fired}/${report.usage.known} have fired, ${report.usage.totalUses} time${report.usage.totalUses === 1 ? "" : "s"} total` + (report.usage.topSkill ? ` (most used: ${report.usage.topSkill.slug} \xD7${report.usage.topSkill.count})` : "") : `Skills in use:   none of your ${report.usage.known} skill${report.usage.known === 1 ? " has" : "s have"} fired yet - they load by description, so this fills in as the situations come up`
    ] : [],
    ...formatSkillHealth(report.skillHealth),
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
