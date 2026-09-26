interface SecretPattern {
  name: string;
  re: RegExp;
  /**
   * Rejects one MATCH that has the shape of a credential but cannot be one. It runs per
   * match rather than per text on purpose: a rule that looked at the first hit and gave up
   * would fail open on `api_key=xxxxxxxx` standing one line above the real key.
   */
  reject?: (match: string) => boolean;
}

/**
 * A value that is nothing but a stand-in. The list is built from lines the corpus actually
 * carries (`src/lib/secret-corpus.ts`), not from guesswork, and it is anchored to the WHOLE
 * value: a real credential that merely contains "changeme" in the middle still counts.
 * "test" is deliberately absent - it is a substring of too many real values to spend.
 *
 * Every tail is BOUNDED, and the bound is the whole guard. An open tail exempts any length
 * of lowercase, so a real key that happens to open with "example" was handed through
 * unredacted: a stand-in is a word plus a few characters, and thirty more is a credential.
 * The digits after `changeme` and `placeholder` stay generous enough for a year suffix,
 * which is the form the corpus's own fixture line carries.
 */
const PLACEHOLDER_VALUE =
  /^(?:[xX]+|changeme[0-9]{0,6}|placeholder[0-9]{0,6}|dummy[a-z-]{0,10}|your[-_][a-z-]{0,16}|example[a-z-]{0,10}|redacted)$/;

const unquote = (value: string) => value.replace(/^["']|["']$/g, "");

function isPlaceholderAssignment(match: string): boolean {
  return PLACEHOLDER_VALUE.test(unquote(match.slice(match.search(/[=:]/) + 1).trim()));
}

/**
 * A value a reader is meant to substitute: a shell expansion, a bracketed instruction, or the
 * SHOUTING_NAME of the variable that holds the real thing. The field-name rules below accept
 * ANY value - that is what lets them see a blob with no shape of its own - so this is the only
 * thing standing between them and every README that documents the flag. It matters past the
 * harvest: `queue.ts` and `commands.ts` run the same scan over a skill's own files, and a
 * skill whose docs show `--token <YOUR_TOKEN>` would otherwise be refused rather than shared.
 */
function isSubstitute(value: string): boolean {
  const bare = unquote(value);
  return (
    /^[$<{]/.test(bare) || /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(bare) || isFilePath(bare)
  );
}

/**
 * A path names where a credential lives; it is not the credential. BuildKit documents its own
 * `--secret id=…,src=<path>`, and `systemd-creds --secret <path>` is the same shape, so
 * without this a skill teaching either one is refused with "secret" and a session running
 * either command loses its signal.
 *
 * A value that opens with `/`, `./` or `~/` and carries a second separator or an extension is
 * a path. That is the whole test, and the leading slash alone is deliberately not enough -
 * base64 can begin with one, the JPEG magic being `/9j/`.
 *
 * Telling a path from a token by the SHAPE of its segments was tried and measured wrong: a
 * rule excluding values whose longest segment was long and mixed case with digits scored 24
 * false positives over the 88 real-path lines in `secret-corpus.ts` - 22 paths crossed with
 * four credential flags - and 6 of 22 in BuildKit's own documented `src=` form. The
 * independent review reproduced it at 32/88 and 8/22 over its own path set (26 September).
 * Real segments look exactly like that -
 * `SecretsProviderV2Config`, a pnpm virtual store entry, a bundler content hash, a
 * devcontainer name with a year in it. The cost landed on the very case this function exists
 * for, so the shape test is gone and a token that happens to look like a path is missed
 * instead. That miss predates the flag rule: master misses it too.
 */
function isFilePath(value: string): boolean {
  if (!/^(?:\.{1,2}\/|~\/|\/)/.test(value)) return false;
  return value.lastIndexOf("/") > 0 || /\.[A-Za-z0-9]{1,8}$/.test(value);
}

/** The value a CLI flag or a `machine … password …` line ends with. */
const lastToken = (match: string) => match.trim().split(/[\s=]+/).pop() ?? "";

/**
 * A bearer value made only of lowercase letters and hyphens is a sentence, not a token:
 * every credential a `Bearer` header actually carries is base64, hex or a JWT, so it shows
 * a digit, an upper-case letter or one of base64's own characters somewhere.
 */
function isWordsNotToken(match: string): boolean {
  return !/[A-Z0-9+/=._~]/.test(match.replace(/^\s*bearer\s+/i, ""));
}

const SECRET_PATTERNS: SecretPattern[] = [
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
    re: /PuTTY-User-Key-File-\d+:[ \t]*\S|Private-Lines:[ \t]*\d|Private-MAC:[ \t]*[0-9a-fA-F]{16}/,
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
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b[\s\S]{0,300}?(?=[A-Za-z0-9+/]{40}(?![A-Za-z0-9+/]))(?=[A-Za-z0-9+/]*[a-z])(?=[A-Za-z0-9+/]*[A-Z])(?=[A-Za-z0-9+/]*\d)[A-Za-z0-9+/]{40}/,
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
    re: /\bhvs\.(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{20,}(?!\.[A-Za-z0-9]{1,8})\b/,
  },
  { name: "linear-api-key", re: /\blin_api_[A-Za-z0-9]{32,}\b/ },
  // A lookbehind rather than \b: the token's own home is inside a URL path (`/bot<id>:AA…`),
  // where the digits follow a letter and \b never matches between two word characters.
  { name: "telegram-bot-token", re: /(?<!\d)\d{8,10}:AA[A-Za-z0-9_-]{30,}\b/ },
  // Azure AD writes a fixed `8Q~` into a client secret, three characters in and thirty-four
  // from the end; the delimiters keep it from matching inside a longer run.
  {
    name: "azure-client-secret",
    re: /(?:^|[\s'"`>=:(,])[A-Za-z0-9_~.-]{3}8Q~[A-Za-z0-9_~.-]{34}(?:$|[\s'"`<),;])/,
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
    reject: (m) => isSubstitute(lastToken(m)),
  },
  { name: "docker-auth-field", re: /["']auth["']\s*:\s*["'][A-Za-z0-9+/]{20,}={0,2}["']/ },
  { name: "kubeconfig-key-data", re: /\bclient-key-data:\s*[A-Za-z0-9+/]{40,}={0,2}/ },
  {
    name: "gcp-private-key-field",
    re: /["']private_key["']\s*:\s*["'][^"']{40,}["']/,
    reject: (m) => isSubstitute(m.slice(m.indexOf(":") + 1).trim()),
  },
  {
    name: "aws-secret-key",
    re: /\baws[_-]?secret[_-]?access[_-]?key\s*[=:]\s*["']?[A-Za-z0-9+/]{30,}/i,
  },
  // A credential handed to a CLI as a flag. `--token-file` and its kind are excluded by the
  // `[= ]`: a flag NAME that continues past the keyword is a different flag.
  {
    name: "cli-credential-flag",
    re: /\s--?(?:auth[_-]?token|api[_-]?key|access[_-]?token|registration[_-]?token|token|password|secret)[= ]\S{16,}/i,
    reject: (m) => isSubstitute(lastToken(m)),
  },
  {
    // keyword may be preceded by a word boundary OR an underscore (AWS_SECRET_KEY=...),
    // which \b cannot match between two word chars.
    name: "assigned-secret",
    re: /(?:\b|_)(?:api[_-]?key|secret|token|passw(?:or)?d|access[_-]?key)["']?\s*[=:]\s*["']?[A-Za-z0-9+/_.-]{8,}/i,
    reject: isPlaceholderAssignment,
  },
];

// A pattern carrying a `reject` has to see every match rather than only the first, so it
// gets a global twin built once here instead of on each call.
const GLOBAL_TWIN = new Map<string, RegExp>(
  SECRET_PATTERNS.filter((p) => p.reject).map((p) => [
    p.name,
    new RegExp(p.re.source, p.re.flags + "g"),
  ]),
);

export function detectSecret(text: string): string | null {
  for (const { name, re, reject } of SECRET_PATTERNS) {
    if (!reject) {
      if (re.test(text)) return name;
      continue;
    }
    for (const match of text.matchAll(GLOBAL_TWIN.get(name)!)) {
      if (!reject(match[0])) return name;
    }
  }
  return null;
}

/** True-name of any secret found across a signal's untrusted fields, else null. */
export function signalSecret(fields: {
  command?: string;
  error?: string;
  resolvedCommand?: string;
  edits?: string[];
  task?: { goal?: string; steps?: string[]; verification?: string };
}): string | null {
  return detectSecret(
    [
      fields.command ?? "",
      fields.error ?? "",
      fields.resolvedCommand ?? "",
      ...(fields.edits ?? []),
      fields.task?.goal ?? "",
      ...(fields.task?.steps ?? []),
      fields.task?.verification ?? "",
    ].join("\n"),
  );
}
