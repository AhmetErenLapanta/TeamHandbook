// src/lib/hook-io.ts
async function readStdin(stream = process.stdin) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
function parseHookInput(raw) {
  if (!raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

// src/lib/policy.ts
import { execFileSync } from "node:child_process";
import { readFileSync as readFileSync2 } from "node:fs";
import { basename, isAbsolute, join as join4, resolve } from "node:path";

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

// src/lib/init.ts
import { homedir as homedir2 } from "node:os";
import { dirname as dirname3, join as join3 } from "node:path";

// src/lib/session-state.ts
import { homedir, tmpdir } from "node:os";
import { dirname as dirname2, join } from "node:path";
var EDIT_ATTACH_WINDOW_MS = 15 * 60 * 1e3;
function handbookHome() {
  return process.env.TEAMHANDBOOK_HOME ?? join(homedir(), ".teamhandbook");
}
var SLEEPER = new Int32Array(new SharedArrayBuffer(4));
var SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1e3;
var SESSION_ORPHAN_MS = 3 * 60 * 60 * 1e3;

// src/lib/config.ts
import { existsSync, readFileSync } from "node:fs";
import { join as join2 } from "node:path";
function configFile(home = handbookHome()) {
  return join2(home, "config.json");
}
function readConfigFile(home = handbookHome()) {
  try {
    const parsed = JSON.parse(readFileSync(configFile(home), "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// src/lib/score.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// src/lib/identity.ts
var HOME_PATH = new RegExp(
  "(?:\\/(?:Users|home)\\/|[A-Za-z]:\\\\{1,2}(?:Users|home)\\\\{1,2})([A-Za-z0-9._-]{1,40})",
  "g"
);

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
function isVariableReference(match) {
  const password = match.slice(match.indexOf(":", match.indexOf("://") + 3) + 1, -1);
  const name = /^\$\{([^{}]+)\}$/.exec(password)?.[1] ?? /^\$\{\{(?:secrets|env)\.([^{}]+)\}\}$/.exec(password)?.[1];
  return name !== void 0 && /^[A-Z_][A-Z0-9_]{0,63}$/.test(name) && name.split("_").every((word) => word.length <= 16 && (word.match(/[0-9]/g)?.length ?? 0) <= 2);
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
  { name: "url-credentials", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]{3,}@/i, reject: isVariableReference },
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
function openingsOf(literal) {
  return [...literal].reduceRight((rest, ch) => `(?:${ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${rest})?`, "");
}
var CUT_SCOPE_SENTENCE = new RegExp(
  `\\s*Applies ONLY in the(?: \\S*${openingsOf(" repository - do not use it elsewhere.")})?$`
);

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
var TEAM_PREFIX_FILE = ".teamhandbook.json";
function marketplacesRoot() {
  return join3(homedir2(), ".claude", "plugins", "marketplaces");
}

// src/lib/shell-command.ts
var OPERATORS = ["&&", "||", ";;", ";", "|&", "|", "&", "(", ")"];
var REDIRECTS = ["&>>", "&>", ">>", ">|", ">&", "<<<", "<<-", "<<", "<&", "<>", ">", "<"];
function simpleCommands(line) {
  const out = [];
  let current = { words: [], redirects: [], then: null };
  let word = "";
  let inWord = false;
  let pendingRedirect = null;
  const heredocs = [];
  let i = 0;
  const endWord = () => {
    if (!inWord) return;
    if (pendingRedirect) {
      if (pendingRedirect === "<<" || pendingRedirect === "<<-") {
        heredocs.push({ delimiter: word, strip: pendingRedirect === "<<-" });
      } else {
        current.redirects.push({ op: pendingRedirect, target: word });
      }
      pendingRedirect = null;
    } else {
      current.words.push(word);
    }
    word = "";
    inWord = false;
  };
  const endCommand = (then) => {
    endWord();
    if (current.words.length || current.redirects.length) {
      current.then = then;
      out.push(current);
    } else if (then && out.length) {
      out[out.length - 1].then = then;
    }
    current = { words: [], redirects: [], then: null };
  };
  const skipHeredocBodies = () => {
    while (heredocs.length && i < line.length) {
      const { delimiter, strip } = heredocs.shift();
      while (i < line.length) {
        const end = line.indexOf("\n", i);
        const text = line.slice(i, end === -1 ? line.length : end);
        i = end === -1 ? line.length : end + 1;
        if ((strip ? text.replace(/^\t+/, "") : text) === delimiter) break;
      }
    }
  };
  while (i < line.length) {
    const c = line[i];
    if (c === "\\") {
      if (line[i + 1] === "\n") {
        i += 2;
        continue;
      }
      word += line[i + 1] ?? "";
      inWord = true;
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      const stop = end === -1 ? line.length : end;
      word += line.slice(i + 1, stop);
      inWord = true;
      i = stop + 1;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === "\\" && i + 1 < line.length) {
          word += line[i + 1];
          i += 2;
        } else if (line[i] === "$" && line[i + 1] === "(") {
          const end = closingParen(line, i + 1);
          word += line.slice(i, end + 1);
          i = end + 1;
        } else {
          word += line[i];
          i++;
        }
      }
      inWord = true;
      i++;
      continue;
    }
    if (c === "$" && line[i + 1] === "(") {
      const end = closingParen(line, i + 1);
      word += line.slice(i, end + 1);
      inWord = true;
      i = end + 1;
      continue;
    }
    if (c === "`") {
      const end = line.indexOf("`", i + 1);
      const stop = end === -1 ? line.length : end;
      word += line.slice(i, stop + 1);
      inWord = true;
      i = stop + 1;
      continue;
    }
    if (c === "#" && !inWord) {
      const end = line.indexOf("\n", i);
      i = end === -1 ? line.length : end;
      continue;
    }
    if (c === "\n") {
      endCommand(";");
      i++;
      skipHeredocBodies();
      continue;
    }
    if (c === " " || c === "	") {
      endWord();
      i++;
      continue;
    }
    if (/[0-9]/.test(c) && !inWord) {
      const m = /^[0-9]+(?=[<>])/.exec(line.slice(i));
      if (m) {
        const op = REDIRECTS.find((r) => line.startsWith(r, i + m[0].length));
        endWord();
        pendingRedirect = `${m[0]}${op}`;
        i += m[0].length + op.length;
        continue;
      }
    }
    const redirect = REDIRECTS.find((r) => line.startsWith(r, i));
    if (redirect) {
      endWord();
      pendingRedirect = redirect;
      i += redirect.length;
      continue;
    }
    const operator = OPERATORS.find((o) => line.startsWith(o, i));
    if (operator) {
      endCommand(operator === "(" || operator === ")" || operator === ";;" ? ";" : operator === "|&" ? "|" : operator);
      i += operator.length;
      continue;
    }
    word += c;
    inWord = true;
    i++;
  }
  endCommand(null);
  return out;
}
function closingParen(line, open) {
  let depth = 0;
  for (let i = open; i < line.length; i++) {
    if (line[i] === "(") depth++;
    else if (line[i] === ")" && --depth === 0) return i;
  }
  return line.length - 1;
}
var WRAPPERS = /* @__PURE__ */ new Set(["sudo", "command", "nohup", "time", "nice", "exec", "env", "builtin"]);
function programOf(cmd) {
  const words = [...cmd.words];
  while (words.length) {
    const first = words[0];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) words.shift();
    else if (WRAPPERS.has(first)) words.shift();
    else if (first === "timeout") {
      words.shift();
      while (words.length && words[0].startsWith("-")) words.shift();
      words.shift();
    } else break;
  }
  return words;
}

// src/lib/policy.ts
var POLICY_ACTIONS = ["mcp.use", "skill.use", "tool.use"];
var POLICY_TOOLS = {
  Bash: { tools: ["Bash"], field: "command" },
  Read: { tools: ["Read"], field: "file_path" },
  Edit: { tools: ["Edit", "MultiEdit", "Write", "NotebookEdit"], field: "file_path" },
  Glob: { tools: ["Glob"], field: "path" },
  Grep: { tools: ["Grep"], field: "path" },
  WebFetch: { tools: ["WebFetch"], field: "url" },
  WebSearch: { tools: ["WebSearch"], field: "query" }
};
var POLICY_MAX_POLICIES = 50;
var POLICY_MAX_RULES = 20;
var POLICY_MAX_RESOURCES = 20;
var POLICY_MAX_STATEMENTS = POLICY_MAX_RULES * POLICY_MAX_RESOURCES;
var POLICY_NAME_MAX = 100;
var POLICY_ID = /^[A-Za-z0-9_-]{1,64}$/;
var POLICY_REASON_MAX = 200;
var POLICY_PATTERN_MAX = 200;
var NAME = /^[A-Za-z0-9_.*-]+$/;
var SKILL = /^[A-Za-z0-9_.:*-]+$/;
var KEYS = /* @__PURE__ */ new Set(["action", "resource", "effect", "reason"]);
function printableProblem(value, max, what) {
  if (!value.trim()) return `its ${what} is empty`;
  if (value.length > max) return `its ${what} is longer than ${max} characters`;
  if (/\p{C}/u.test(value)) return `its ${what} carries a control character`;
  return null;
}
function resourceProblem(action, resource) {
  const [kind, ...rest] = resource.split(":");
  const value = rest.join(":");
  if (action === "mcp.use") {
    if (kind !== "mcp") return "an mcp.use rule names mcp:<server> or mcp:<server>/<tool>";
    const [server, tool2, extra] = value.split("/");
    if (extra !== void 0 || !server || !NAME.test(server) || tool2 !== void 0 && (!tool2 || !NAME.test(tool2))) {
      return "an mcp.use rule names mcp:<server> or mcp:<server>/<tool>, in letters, digits, _ . - and *";
    }
    return null;
  }
  if (action === "skill.use") {
    if (kind !== "skill" || !value || !SKILL.test(value)) return "a skill.use rule names skill:<skill>, in letters, digits, _ . : - and *";
    return null;
  }
  const tool = rest[0];
  const pattern = rest.slice(1).join(":");
  if (kind !== "tool" || tool === void 0 || rest.length < 2) return "a tool.use rule names tool:<tool>:<pattern>";
  if (!Object.hasOwn(POLICY_TOOLS, tool)) return `a tool.use rule names one of ${Object.keys(POLICY_TOOLS).join(", ")}, not ${JSON.stringify(tool)}`;
  return printableProblem(pattern, POLICY_PATTERN_MAX, "pattern");
}
function ruleProblem(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "it is not an object";
  const rule = raw;
  const extra = Object.keys(rule).filter((key) => !KEYS.has(key));
  if (extra.length) return `it has ${extra.map((k) => JSON.stringify(k)).join(", ")}, which a rule does not take`;
  if (typeof rule.action !== "string" || !POLICY_ACTIONS.includes(rule.action)) return `its action is not one of ${POLICY_ACTIONS.join(", ")}`;
  if (rule.effect !== "deny") return 'its effect is not "deny": a policy only takes away, and a capability is given by adding it in a reviewed request';
  if (typeof rule.resource !== "string") return "it has no resource";
  if (typeof rule.reason !== "string") return "it has no reason";
  const reason = printableProblem(rule.reason, POLICY_REASON_MAX, "reason");
  if (reason) return reason;
  const resource = resourceProblem(rule.action, rule.resource);
  if (resource) return resource;
  const secret = detectSecret(`${rule.resource}
${rule.reason}`);
  return secret ? `it looks like it contains a secret (${secret})` : null;
}
function rulesProblem(value) {
  if (!Array.isArray(value) || !value.length) return "it has no rules";
  if (value.length > POLICY_MAX_STATEMENTS) return `it has more than ${POLICY_MAX_STATEMENTS} rules`;
  for (const [index, rule] of value.entries()) {
    const problem = ruleProblem(rule);
    if (problem) return `rule ${index + 1}: ${problem}`;
  }
  return null;
}
function policiesProblem(value) {
  if (!Array.isArray(value)) return "policies is not a list";
  if (value.length > POLICY_MAX_POLICIES) return `policies has more than ${POLICY_MAX_POLICIES} entries`;
  const ids = /* @__PURE__ */ new Set();
  for (const [index, raw] of value.entries()) {
    const at = `policy ${index + 1}`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return `${at} is not an object`;
    const policy = raw;
    const extra = Object.keys(policy).filter((key) => !["id", "name", "rules"].includes(key));
    if (extra.length) return `${at} has ${extra.map((k) => JSON.stringify(k)).join(", ")}, which a policy does not take`;
    if (typeof policy.id !== "string" || !POLICY_ID.test(policy.id)) return `${at} has no id of letters, digits, _ and -`;
    if (ids.has(policy.id)) return `${at} repeats the id ${policy.id}`;
    ids.add(policy.id);
    const name = typeof policy.name === "string" ? printableProblem(policy.name, POLICY_NAME_MAX, "name") : "its name is missing";
    if (name) return `${at} (${policy.id}): ${name}`;
    const rules = rulesProblem(policy.rules);
    if (rules) return `${at} (${policy.id}): ${rules}`;
  }
  return null;
}
function policyRules(policies) {
  return policies.flatMap((p) => p.rules);
}
function patternMatches(pattern, value) {
  let p = 0;
  let v = 0;
  let star = -1;
  let resume = 0;
  while (v < value.length) {
    if (p < pattern.length && pattern[p] !== "*" && pattern[p] === value[v]) {
      p++;
      v++;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p++;
      resume = v;
    } else if (star >= 0) {
      p = star + 1;
      v = ++resume;
    } else {
      return false;
    }
  }
  while (pattern[p] === "*") p++;
  return p === pattern.length;
}
function mcpToolPart(name) {
  return name.replace(/[^a-zA-Z0-9_*-]/g, "_");
}
function mcpCall(toolName) {
  if (!toolName.startsWith("mcp__")) return null;
  const rest = toolName.slice(5);
  const split = rest.indexOf("__");
  if (split <= 0) return null;
  const server = rest.slice(0, split);
  const servers = [server];
  const plugin = server.startsWith("plugin_") ? server.slice(7) : null;
  const end = plugin?.indexOf("_") ?? -1;
  if (plugin && end > 0) servers.push(plugin.slice(end + 1));
  return { servers, tool: rest.slice(split + 2) };
}
var SHELL_KEYWORDS = /* @__PURE__ */ new Set(["{", "}", "!", "if", "then", "else", "elif", "fi", "do", "done", "while", "until", "time"]);
var SHELLS = /* @__PURE__ */ new Set(["sh", "bash", "zsh", "dash", "ksh"]);
var XARGS_VALUED = /* @__PURE__ */ new Set(["-I", "-n", "-P", "-L", "-d", "-E", "-s", "-a"]);
function substitutions(line) {
  const found = [];
  for (let i = 0; i < line.length; i++) {
    if ((line[i] === "$" || line[i] === "<" || line[i] === ">") && line[i + 1] === "(") {
      let depth = 0;
      for (let j = i + 1; j < line.length; j++) {
        if (line[j] === "(") depth++;
        else if (line[j] === ")" && --depth === 0) {
          found.push(line.slice(i + 2, j));
          break;
        }
      }
    }
  }
  for (const m of line.matchAll(/`([^`]*)`/g)) found.push(m[1]);
  return found;
}
function shellCandidates(line, depth) {
  const out = /* @__PURE__ */ new Set([line.trim()]);
  if (depth > 3) return out;
  for (const inner of substitutions(line)) for (const c of shellCandidates(inner, depth + 1)) out.add(c);
  for (const cmd of simpleCommands(line)) {
    let words = cmd.words;
    while (words.length && SHELL_KEYWORDS.has(words[0])) words = words.slice(1);
    words = programOf({ ...cmd, words });
    while (words.length && basename(words[0]) === "xargs") {
      let i = 1;
      while (i < words.length && words[i].startsWith("-")) i += XARGS_VALUED.has(words[i]) ? 2 : 1;
      words = programOf({ ...cmd, words: words.slice(i) });
    }
    if (!words.length) continue;
    const program = basename(words[0]);
    const at = words.indexOf("-c");
    if (SHELLS.has(program) && at > 0 && words[at + 1]) for (const c of shellCandidates(words[at + 1], depth + 1)) out.add(c);
    if (program === "eval") for (const c of shellCandidates(words.slice(1).join(" "), depth + 1)) out.add(c);
    const rest = words.slice(1);
    for (const name of [words[0], program, program.toLowerCase()]) out.add([name, ...rest].join(" "));
    out.add(cmd.words.join(" "));
  }
  return out;
}
function toolValues(tool, input, cwd) {
  const named = Object.entries(POLICY_TOOLS).find(([, spec]) => spec.tools.includes(tool));
  if (!named) return [];
  const field = named[1].field;
  const raw = field ? input[field] ?? (tool === "NotebookEdit" ? input.notebook_path : void 0) : void 0;
  const value = typeof raw === "string" ? raw : field === "path" && cwd || "";
  if (tool === "Bash") return [...shellCandidates(value, 0)];
  if ((field === "file_path" || field === "path") && value) {
    if (isAbsolute(value)) return [value, resolve(value)];
    if (cwd) return [value, resolve(cwd, value)];
  }
  return [value];
}
function policyDenial(rules, call) {
  const name = call.tool_name ?? "";
  const input = call.tool_input ?? {};
  const mcp = mcpCall(name);
  const skill = name === "Skill" && typeof input.skill === "string" ? input.skill : null;
  let decided = null;
  for (const rule of rules) {
    const [kind, ...rest] = rule.resource.split(":");
    const value = rest.join(":");
    let hit = false;
    if (kind === "mcp" && mcp) {
      const [server, tool] = value.split("/").map(mcpToolPart);
      hit = mcp.servers.some((s) => patternMatches(server, s)) && (tool === void 0 || patternMatches(tool, mcp.tool));
    } else if (kind === "skill" && skill) {
      hit = patternMatches(value, skill) || patternMatches(value, skill.slice(skill.lastIndexOf(":") + 1));
    } else if (kind === "tool") {
      const spec = POLICY_TOOLS[rest[0]];
      const pattern = rest.slice(1).join(":");
      hit = !!spec?.tools.includes(name) && toolValues(name, input, call.cwd).some((v) => patternMatches(pattern, v));
    }
    if (hit) decided = rule;
  }
  return decided;
}
function policyCacheFile(home = handbookHome()) {
  return join4(home, "policy-cache.json");
}
function readCache(home, marketplace) {
  try {
    const cache = JSON.parse(readFileSync2(policyCacheFile(home), "utf8"));
    return cache.marketplace === marketplace && Array.isArray(cache.rules) && cache.rules.every((r) => ruleProblem(r) === null) ? cache : null;
  } catch {
    return null;
  }
}
function teamPolicy(home = handbookHome(), root = marketplacesRoot(), now = () => (/* @__PURE__ */ new Date()).toISOString()) {
  const team = loadTeamConfig(home);
  if (!team) return { source: "none", rules: [] };
  const copy = join4(root, team.marketplaceName);
  let problem;
  let text = null;
  try {
    text = readFileSync2(join4(copy, TEAM_PREFIX_FILE), "utf8");
  } catch (err) {
    if (err.code === "ENOENT" && readable(copy)) return { source: "team", rules: [], copy };
  }
  if (text === null) {
    problem = `${TEAM_PREFIX_FILE} in the team's copy cannot be read`;
  } else {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = void 0;
    }
    const value = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed.policies : void 0;
    if (parsed === void 0 || parsed !== null && typeof parsed !== "object" || Array.isArray(parsed)) {
      problem = `${TEAM_PREFIX_FILE} in the team's copy is not a JSON object`;
    } else if (value === void 0) {
      return { source: "team", rules: [], copy };
    } else {
      const grammar = policiesProblem(value);
      if (!grammar) {
        const rules = policyRules(value);
        const cached2 = readCache(home, team.marketplaceName);
        if (!cached2 || JSON.stringify(cached2.rules) !== JSON.stringify(rules)) {
          try {
            writeFileAtomic(policyCacheFile(home), JSON.stringify({ marketplace: team.marketplaceName, rules, savedAt: now() }, null, 2) + "\n");
          } catch {
          }
        }
        return { source: "team", rules, copy };
      }
      problem = `the policies in ${TEAM_PREFIX_FILE} are not valid: ${grammar}`;
    }
  }
  const cached = readCache(home, team.marketplaceName);
  return cached ? { source: "cache", rules: cached.rules, problem, savedAt: cached.savedAt, copy } : { source: "none", rules: [], problem, copy };
}
function readable(dir) {
  try {
    readFileSync2(join4(dir, ".claude-plugin", "plugin.json"));
    return true;
  } catch {
    return false;
  }
}
function policyOrigin(copy, rule) {
  try {
    const sha = execFileSync("git", ["-C", copy, "log", "-1", "--format=%h", `-S${JSON.stringify(rule.resource)}`, "--", TEAM_PREFIX_FILE], {
      encoding: "utf8",
      timeout: 2e3,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return /^[0-9a-f]{4,40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}
function denialMessage(rule, origin) {
  return `Blocked by the team's policy: ${rule.reason} (${rule.action} ${rule.resource}${origin ? `, added in ${origin}` : ""}).`;
}

// src/hooks/pre-tool-use.ts
async function main() {
  const input = parseHookInput(await readStdin());
  if (!input?.tool_name) return;
  const policy = teamPolicy();
  if (!policy.rules.length) return;
  const rule = policyDenial(policy.rules, input);
  if (!rule) return;
  const origin = policy.copy ? policyOrigin(policy.copy, rule) : null;
  console.log(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: denialMessage(rule, origin) }
    })
  );
}
main().then(
  () => process.exit(0),
  () => process.exit(0)
);
