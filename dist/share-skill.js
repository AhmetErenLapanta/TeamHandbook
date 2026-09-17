// src/cli/share-skill.ts
import { resolve } from "node:path";

// src/lib/queue.ts
import { existsSync, mkdirSync as mkdirSync2, readFileSync, readdirSync as readdirSync2 } from "node:fs";
import { basename, join as join4 } from "node:path";

// src/lib/session-state.ts
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
var EDIT_ATTACH_WINDOW_MS = 15 * 60 * 1e3;
function handbookHome() {
  return process.env.TEAMHANDBOOK_HOME ?? join(homedir(), ".teamhandbook");
}
var SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1e3;
var SESSION_ORPHAN_MS = 3 * 60 * 60 * 1e3;

// src/lib/skill-index.ts
import { join as join2 } from "node:path";
function candidatesDir(home = handbookHome()) {
  return join2(home, "candidates");
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

// src/lib/skill-files.ts
import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join as join3 } from "node:path";
function isQueueBookkeeping(name) {
  return name.startsWith("candidate.json");
}
function listSkillFiles(dir) {
  const files = [];
  const skipped = [];
  const walk = (current, prefix) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (prefix === "" && isQueueBookkeeping(entry.name)) continue;
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join3(current, entry.name), rel);
      else if (entry.isFile()) files.push(rel);
      else skipped.push(rel);
    }
  };
  walk(dir, "");
  return { files, skipped };
}
function copySkillPayload(srcDir, destDir, skillMd, files = listSkillFiles(srcDir).files) {
  mkdirSync(destDir, { recursive: true });
  writeFileSync(join3(destDir, "SKILL.md"), skillMd);
  for (const rel of files) {
    if (rel === "SKILL.md") continue;
    const target = join3(destDir, rel);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join3(srcDir, rel), target);
  }
}

// src/lib/queue.ts
var STATUSES = ["pending", "approved", "rejected", "archived"];
function isSafeSlug(slug) {
  return /^[a-z0-9][a-z0-9-]*$/.test(slug);
}
function candidateMetaFile(dir) {
  return join4(dir, "candidate.json");
}
function synthesizeMeta(dir) {
  let md;
  try {
    md = readFileSync(join4(dir, "SKILL.md"), "utf8");
  } catch {
    return null;
  }
  const summary = parseSkillFrontmatter(md);
  if (!summary) return null;
  let grounded = {};
  try {
    grounded = JSON.parse(readFileSync(join4(dir, "grounded-case.json"), "utf8"));
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
    const parsed = JSON.parse(readFileSync(candidateMetaFile(dir), "utf8"));
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
function auditSkillDir(sourceDir) {
  const name = basename(sourceDir);
  if (!isSafeSlug(name)) return { shareable: false, reason: "unsafe-name", detail: name };
  let skillMd;
  try {
    skillMd = readFileSync(join4(sourceDir, "SKILL.md"), "utf8");
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
      content = readFileSync(join4(sourceDir, file), "utf8");
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
function intakeSkill(sourceDir, home = handbookHome()) {
  const slug = basename(sourceDir);
  const dir = join4(candidatesDir(home), slug);
  if (isSafeSlug(slug) && existsSync(dir)) {
    const existing = readCandidateMeta(dir);
    const decided = existing && existing.status !== "pending" ? existing.status : null;
    return {
      ok: false,
      error: decided ? `"${slug}" was already ${decided} here; nothing was changed` : `"${slug}" is already waiting in the review queue`
    };
  }
  const audit = auditSkillDir(sourceDir);
  if (!audit.shareable) {
    return {
      ok: false,
      ...audit.secret ? { secret: audit.secret } : {},
      error: intakeRefusal(sourceDir, slug, audit)
    };
  }
  copySkillPayload(sourceDir, dir, audit.skillMd, audit.files);
  return { ok: true, slug, dir, fileCount: audit.files.length };
}
function intakeRefusal(sourceDir, slug, audit) {
  switch (audit.reason) {
    case "unsafe-name":
      return `"${slug}" cannot be a skill name (lowercase letters, digits and dashes)`;
    case "no-skill-md":
      return `no readable SKILL.md in ${sourceDir}`;
    case "no-frontmatter":
      return `the SKILL.md in ${sourceDir} has no name and description frontmatter`;
    case "irregular-entry":
      return `${slug} contains "${audit.detail}", which is not a regular file; nothing was queued`;
    case "no-files":
      return `${slug} has no files to queue`;
    case "unreadable":
      return `cannot read "${audit.detail}" in ${sourceDir}; nothing was queued`;
    default:
      return `"${audit.secret?.file}" looks like it contains a secret (${audit.detail}), so ${slug} was not queued. Skills are reviewed and shared as they are, and a redacted one would install and then fail; take the credential out of the skill and try again.`;
  }
}

// src/cli/share-skill.ts
var source = process.argv[2];
if (!source) {
  console.error("usage: share-skill.js <path to a skill directory>");
  process.exit(2);
}
var result = intakeSkill(resolve(source));
if (!result.ok) {
  console.error(`error: ${result.error}`);
  process.exit(1);
}
var extras = (result.fileCount ?? 1) - 1;
console.log(
  `Queued "${result.slug}" for review${extras > 0 ? ` with its ${extras} other file(s)` : ""}. Run /handbook:review to share it with your team, add it to this project, or keep it.`
);
