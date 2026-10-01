/**
 * The deterministic format gate a generated workflow skill has to clear before anyone is offered it.
 *
 * A port of the measurement harness's checker, because the baseline this product is judged against
 * was taken with that script: a checker that merely agrees in spirit would move the number without
 * anybody noticing which of the two changed. `skill-format.test.ts` replays the harness's own
 * fixtures against this file and requires the same verdict on each.
 *
 * The port covers the ENGLISH half of that script's patterns. The harness also matches phrases in
 * the language its own measurements were written in; those belong to a measurement tool, and this
 * is product code, which this repository keeps in one language. The consequence is stated rather
 * than hidden: a skill whose headings are written in another language reaches fewer of these rules
 * than it reaches in the harness, and the fixtures that test those phrases are excluded from the
 * equivalence table by name rather than quietly passing.
 *
 * Limits come from the published skill documentation: a name of at most 64 characters, a
 * description of at most 1024, the two listing fields together at most 1536, and a body under 500
 * lines. The fill thresholds are the gate's own: a heading that matches a pattern proves nothing,
 * so a section has to carry items as well as a title.
 *
 * Three divergences between the two regex engines are handled deliberately rather than inherited,
 * because each one silently changes a verdict on text that is not plain ASCII:
 *
 * - Word characters. The source engine's `\w` covers every letter in Unicode; this one's stops at
 *   ASCII, so a tag or an address spelled with a non-ASCII letter would slip past a rule that
 *   catches it there. `WORD_CHAR` restores the wider meaning.
 * - Word boundaries. For the same reason `\b` sits in a different place in the two engines, which
 *   matters wherever a forbidden term or a name is spelled with a non-ASCII letter. Boundaries are
 *   written as explicit lookarounds over `WORD_CHAR`.
 * - Length. The source counts code points and this one counts UTF-16 units, so a single emoji or
 *   an astral character would count twice against a limit. Every limit below counts code points.
 */

/**
 * The character classes the source engine means, spelled out.
 *
 * `WORD_CHAR` is that engine's `\w`, which covers every letter and digit in Unicode where this
 * one's stops at ASCII. `SPACE` is its `\s`, which includes the four information separators and
 * NEL and excludes the byte order mark - the two classes differ at both ends.
 */
const WORD_CHAR = "\\p{L}\\p{N}_";
const SPACE = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";

/**
 * A word boundary as the source engine draws one: a TRANSITION between a word character and a
 * non-word character, in either direction. A plain lookbehind is not the same thing, and the
 * difference shows on a term that begins with punctuation - a boundary before `@name` demands a
 * word character to its left, so `ask @name` does not match, which is behaviour the gate inherits.
 */
const WB = `(?:(?<=[${WORD_CHAR}])(?![${WORD_CHAR}])|(?<![${WORD_CHAR}])(?=[${WORD_CHAR}]))`;

/** Case-insensitive, with the wider word class the source engine uses. */
function ci(source: string): RegExp {
  return new RegExp(source, "iu");
}

const NAME_RE = /^[a-z0-9-]+$/;
const XML_RE = new RegExp(`<[${SPACE}]*/?[${SPACE}]*[A-Za-z][${WORD_CHAR}-]*([${SPACE}][^<>]*)?>`, "u");
const TRIGGER_RE = ci(
  `${WB}(use when|use whenever|use this when|use for|also when|also use when|should be used when|when the user|triggers?[${SPACE}]*:)`,
);
const ABBREV_RE = new RegExp(`${WB}(e\\.g|i\\.e|etc|vs|cf)\\.`, "giu");
const SENTENCE_SPLIT_RE = new RegExp(`(?<=[.!?])[${SPACE}]+`, "u");
const HEAD_RE = new RegExp(`^(#{1,6})[${SPACE}]+(.*)$`, "u");
const FENCE_RE = new RegExp(`^[${SPACE}]*(\`\`\`|~~~)`, "u");
const NUM_HEAD_RE = ci(`^[${SPACE}]*(\\p{Nd}+[.)]|step[${SPACE}]+\\p{Nd}+|phase[${SPACE}]+\\p{Nd}+)`);
const NUM_ITEM_RE = new RegExp(`^[${SPACE}]*\\p{Nd}+[.)][${SPACE}]+[^${SPACE}]`, "u");
const LIST_ITEM_RE = new RegExp(`^[${SPACE}]*([-*+]|\\p{Nd}+[.)])[${SPACE}]+[^${SPACE}]`, "u");
const TABLE_ROW_RE = new RegExp(`^[${SPACE}]*\\|.*\\|[${SPACE}]*$`, "u");
const TABLE_SEP_RE = new RegExp(
  `^[${SPACE}]*\\|?[${SPACE}]*:?-{3,}:?[${SPACE}]*(\\|[${SPACE}]*:?-{3,}:?[${SPACE}]*)*\\|?[${SPACE}]*$`,
  "u",
);
const VERIFY_HEAD_RE = ci(`verif|validat|checklist|${WB}test`);
const DELIVERY_HEAD_RE = ci(`deliver|hand-?off|${WB}done${WB}|finish`);
const COMMAND_RE = ci(
  "```|`[^`\\n]*" + WB + "(run|gradlew|npm|npx|pytest|make|git|python3?|node|mvn|go|cargo|bash|\\./)[^`\\n]*`",
);
const PITFALL_HEAD_RE = ci(
  "pitfall|mistake|gotcha|common (errors|failures|problems)|anti-?pattern|red flags",
);
// The two home roots in ONE alternation rather than two spelled-out branches. Same matches, and
// it keeps this file from carrying a contiguous copy of the path shape it exists to detect -
// which is how `identity.ts` already writes the same thing.
const ABS_PATH_RE = new RegExp(`(/(?:Users|home)/[^/${SPACE}]+|[A-Za-z]:\\\\Users\\\\)`, "u");
const EMAIL_RE = new RegExp(`[${WORD_CHAR}.+-]+@[${WORD_CHAR}-]+\\.[A-Za-z]{2,}`, "u");
const RESERVED = ["anthropic", "claude"];

export const MAX_NAME = 64;
export const MAX_DESC = 1024;
export const MAX_LISTING = 1536;
export const MAX_BODY_LINES = 500;
export const MIN_STEPS = 3;
export const MIN_TRIGGER_SENTENCES = 2;
export const MIN_VERIFY_ITEMS = 2;
export const MIN_PITFALL_ITEMS = 1;

/** Code points, not UTF-16 units: see the note on divergences above. */
function length(value: string): number {
  return [...value].length;
}

export interface FormatFinding {
  rule: string;
  ok: boolean;
  /** An optional rule is reported but never fails a draft, exactly as in the source checker. */
  required: boolean;
  detail: string;
}

export interface FormatOptions {
  denyTerms?: string[];
  denyUsers?: string[];
  /**
   * The three rules the harness's checker does not measure, which cover the parts of the template
   * a mined workflow is supposed to fill. Off by default so that the equivalence table stays a
   * comparison of the SAME rule set rather than of two different ones.
   */
  extended?: boolean;
  /**
   * What the evidence says this draft owes, which two of the extended rules cannot know by
   * reading the file.
   *
   * Measured: with these rules applied unconditionally, all three of the fixtures the source
   * checker must pass failed all three of them - a minimal hand-written skill has no file map and
   * no delivery section, and nothing in its text is wrong for lacking them. The fixtures are not
   * drafts of a mined workflow, so the rules ask for a section only when the caller says this
   * draft was supposed to have one, and otherwise judge the section it does have.
   */
  expects?: { fileMap?: boolean; multiRepo?: boolean };
}

type Line =
  | { kind: "head"; level: number; title: string }
  | { kind: "fence-mark" | "fenced" | "text"; text: string };

interface Section {
  title: string;
  level: number;
  body: Line[];
}

export interface Frontmatter {
  fields: Record<string, string> | null;
  body: string;
}

/**
 * The YAML header, read the way the source checker reads it: one pass of `key: value`, a
 * continuation line folded onto the key before it, then block markers and matching quotes peeled
 * off. Not a YAML parser, and deliberately so - the gate has to agree with the script it replaces
 * about malformed headers too, and two real parsers would not.
 */
export function splitFrontmatter(text: string): Frontmatter {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!match) return { fields: null, body: text };
  const fields: Record<string, string> = {};
  let key: string | null = null;
  for (const line of match[1]!.split("\n")) {
    const kv = new RegExp(`^([${WORD_CHAR}-]+):[${SPACE}]*(.*)$`, "u").exec(line);
    if (kv) {
      key = kv[1]!;
      fields[key] = kv[2]!.trim();
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
  return { fields, body: match[2]! };
}

/** Every line as what it is. A line inside a fence is never a heading and never a step. */
function classifyLines(body: string): Line[] {
  const out: Line[] = [];
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
    out.push(head ? { kind: "head", level: head[1]!.length, title: head[2]!.trim() } : { kind: "text", text: line });
  }
  return out;
}

/** A section's body runs to the next heading of the same or a higher level, so an `##` keeps its `###`. */
function sections(lines: Line[]): Section[] {
  const heads = lines
    .map((line, index) => ({ line, index }))
    .filter((entry): entry is { line: Extract<Line, { kind: "head" }>; index: number } => entry.line.kind === "head");
  return heads.map((head, n) => {
    const next = heads.slice(n + 1).find((other) => other.line.level <= head.line.level);
    return {
      title: head.line.title,
      level: head.line.level,
      body: lines.slice(head.index + 1, next ? next.index : lines.length),
    };
  });
}

/**
 * How many ITEMS a section carries. A table row counts only after the separator row, so a header
 * with nothing under it is an empty table rather than a filled section - which is the whole point
 * of counting items instead of trusting a heading.
 */
function items(body: Line[]): number {
  let count = 0;
  let afterSeparator = false;
  for (const line of body) {
    if (line.kind === "fenced") {
      if (line.text.trim()) count++;
    } else if (line.kind === "text") {
      if (TABLE_SEP_RE.test(line.text) && line.text.includes("|")) {
        afterSeparator = true;
      } else if (TABLE_ROW_RE.test(line.text)) {
        if (afterSeparator) count++;
      } else {
        afterSeparator = false;
        if (LIST_ITEM_RE.test(line.text)) count++;
      }
    } else if (line.kind === "head") {
      afterSeparator = false;
    }
  }
  return count;
}

function hasContent(body: Line[]): boolean {
  return body.some((line) => (line.kind === "text" || line.kind === "fenced") && line.text.trim() !== "");
}

/**
 * How many sentences of the listing text say WHEN to reach for the skill. An abbreviation's full
 * stop is replaced by a look-alike first, so "e.g. a chart" stays one sentence rather than becoming
 * two and inflating the count.
 */
export function triggerSentences(text: string): number {
  const protectedText = text.replace(ABBREV_RE, (_match, group: string) => `${group}․`);
  return protectedText.split(SENTENCE_SPLIT_RE).filter((sentence) => TRIGGER_RE.test(sentence)).length;
}

function bodyText(body: Line[]): string {
  return body.filter((line) => line.kind !== "head").map((line) => (line as { text: string }).text).join("\n");
}

/** A `k/N` cell: the share of the workflow's jobs that touched a file, which is what §3 is for. */
const SHARE_CELL_RE = /\b\d+\s*\/\s*\d+\b/;
/**
 * An observable result, as opposed to an instruction to go and look.
 *
 * The verbs of OBSERVING are in the list, not only the verbs of returning. The first version left
 * them out and rejected "Open the page and see the widget", which names exactly what a reader is
 * supposed to end up looking at - the rule is meant to catch "run the tests", which names no
 * outcome at all, and seeing a thing on a page is an outcome.
 */
const OBSERVABLE_RE =
  /\b(returns?|shows?|appears?|contains?|equals?|matches?|logs?|responds?|renders?|displays?|opens?|sees?|visible|status|200|201|400|404|500|non-empty|empty|\d+\s*(rows?|records?|items?|entries))\b/i;
const INLINE_CODE_RE = /`[^`\n]+`/;

export function checkSkillFormat(text: string, options: FormatOptions = {}): FormatFinding[] {
  const denyTerms = options.denyTerms ?? [];
  const denyUsers = options.denyUsers ?? [];
  const { fields, body } = splitFrontmatter(text);
  const findings: FormatFinding[] = [];
  const add = (rule: string, ok: unknown, detail: string, required = true) =>
    findings.push({ rule, ok: Boolean(ok), required, detail });

  add("frontmatter", fields !== null, "YAML frontmatter between --- markers");
  const fm = fields ?? {};
  const name = fm["name"] ?? "";
  const desc = fm["description"] ?? "";
  const whenToUse = fm["when_to_use"] ?? "";

  add(
    "name",
    name && length(name) <= MAX_NAME && NAME_RE.test(name) && !RESERVED.some((word) => name.includes(word)),
    `name=${JSON.stringify(name)} len=${length(name)}`,
  );
  add("description", desc && length(desc) <= MAX_DESC && !XML_RE.test(desc), `len=${length(desc)}`);
  add(
    "listing-cap",
    length(desc) + length(whenToUse) <= MAX_LISTING,
    `description+when_to_use=${length(desc) + length(whenToUse)}`,
  );
  const triggers = triggerSentences(`${desc} ${whenToUse}`);
  add("trigger", triggers >= MIN_TRIGGER_SENTENCES, `trigger sentences=${triggers} (need ${MIN_TRIGGER_SENTENCES})`);
  if ("argument-hint" in fm) {
    const hint = fm["argument-hint"]!;
    add("argument-hint", /^(\[[^\]]+\]\s*)+$/.test(hint), `argument-hint=${JSON.stringify(hint)}`, false);
  }

  const lines = classifyLines(body);
  const secs = sections(lines);
  const numSecs = secs.filter((s) => s.level >= 2 && s.level <= 3 && NUM_HEAD_RE.test(s.title));
  const numItems = lines.filter((line) => line.kind === "text" && NUM_ITEM_RE.test(line.text)).length;
  const emptySteps = numSecs.filter((s) => !hasContent(s.body)).map((s) => s.title);
  const steps = Math.max(numSecs.length, numItems);
  add(
    "steps",
    steps >= MIN_STEPS && emptySteps.length === 0,
    `numbered headings=${numSecs.length} numbered items=${numItems} empty numbered headings=${JSON.stringify(emptySteps.slice(0, 3))}`,
  );

  const verify = secs.filter((s) => VERIFY_HEAD_RE.test(s.title)).map((s) => [s.title, items(s.body)] as const);
  const delivery = secs
    .filter((s) => DELIVERY_HEAD_RE.test(s.title) && COMMAND_RE.test(bodyText(s.body)))
    .map((s) => [s.title, items(s.body)] as const);
  const okVerify = [...verify, ...delivery].filter(([, n]) => n >= MIN_VERIFY_ITEMS);
  add(
    "verification",
    okVerify.length > 0,
    `verification sections(items)=${JSON.stringify(verify.slice(0, 3))} delivery-with-command(items)=${JSON.stringify(delivery.slice(0, 2))} need ${MIN_VERIFY_ITEMS} items`,
  );

  const pitfalls = secs.filter((s) => PITFALL_HEAD_RE.test(s.title)).map((s) => [s.title, items(s.body)] as const);
  add(
    "pitfalls",
    pitfalls.some(([, n]) => n >= MIN_PITFALL_ITEMS),
    `pitfall sections(items)=${JSON.stringify(pitfalls.slice(0, 3))}`,
  );

  add("no-abs-path", !ABS_PATH_RE.test(text), `hits=${JSON.stringify(matchAll(ABS_PATH_RE, text).slice(0, 3))}`);
  add("no-email", !EMAIL_RE.test(text), `hits=${JSON.stringify(matchAll(EMAIL_RE, text).slice(0, 3))}`);
  const users = denyUsers.filter((user) => user && wordPresent(user, text));
  add("no-username", users.length === 0, `hits=${JSON.stringify(users)}`);
  const terms = denyTerms.filter((term) => term && wordPresent(term, text));
  add("no-org-term", terms.length === 0, `hits=${JSON.stringify(terms)}`);
  add("body-length", body.split("\n").length < MAX_BODY_LINES, `body lines=${body.split("\n").length}`);

  if (options.extended) addExtendedFindings(findings, secs, text, options.expects ?? {});
  return findings;
}

/**
 * The parts of the template that only a mined workflow can fill, and that the harness's checker
 * never looked at. Kept in their own pass so that turning them on cannot change any verdict the
 * equivalence table records.
 */
function addExtendedFindings(
  findings: FormatFinding[],
  secs: Section[],
  text: string,
  expects: { fileMap?: boolean; multiRepo?: boolean },
): void {
  const add = (rule: string, ok: unknown, detail: string) =>
    findings.push({ rule, ok: Boolean(ok), required: true, detail });

  const mapSecs = secs.filter((s) => /file map|files? touched/i.test(s.title));
  const mapRows = mapSecs
    .flatMap((s) =>
      s.body.filter((line) => line.kind === "text" && TABLE_ROW_RE.test(line.text) && !TABLE_SEP_RE.test(line.text)),
    )
    .map((line) => (line as { text: string }).text);
  const shareRows = mapRows.filter((row) => SHARE_CELL_RE.test(row));
  // A header row carries no share cell, so a table is judged on whether every DATA row has one: a
  // map whose rows do not say how often a file is touched is a list of files, which the reader
  // already has. A draft with no map at all fails only when the evidence said it owed one.
  const mapWellFormed = mapRows.length >= 2 && shareRows.length >= mapRows.length - 1 && shareRows.length >= 1;
  add(
    "file-map",
    mapSecs.length === 0 ? !expects.fileMap : mapWellFormed,
    `file-map sections=${mapSecs.length} rows=${mapRows.length} rows with k/N=${shareRows.length} expected=${Boolean(expects.fileMap)}`,
  );

  const deliverySecs = secs.filter((s) => DELIVERY_HEAD_RE.test(s.title));
  const singleRepo = /\bsingle repo\b|\btek repo\b/i.test(text);
  add(
    "delivery",
    deliverySecs.length === 0
      ? !expects.multiRepo
      : deliverySecs.some((s) => items(s.body) >= 1) || singleRepo,
    `delivery sections=${deliverySecs.length} single-repo note=${singleRepo} multi-repo=${Boolean(expects.multiRepo)}`,
  );

  // "Run the tests" names no command and no result, and a green run is a safety net rather than
  // proof that the workflow was done: an item has to carry one or the other to count as a check.
  // A fenced command block counts as an item here exactly as it does for the fill rules, because
  // a checklist written as a shell block is still a checklist.
  const verifySecs = secs.filter((s) => VERIFY_HEAD_RE.test(s.title));
  const verifyItems = verifySecs
    .flatMap((s) => s.body.filter((line) => line.kind === "text" && LIST_ITEM_RE.test(line.text)))
    .map((line) => (line as { text: string }).text);
  const fencedItems = verifySecs
    .flatMap((s) => s.body.filter((line) => line.kind === "fenced" && line.text.trim() !== ""))
    .map((line) => (line as { text: string }).text);
  const all = [...verifyItems, ...fencedItems];
  const concrete = all.filter((item) => INLINE_CODE_RE.test(item) || OBSERVABLE_RE.test(item) || fencedItems.includes(item));
  add(
    "verification-concrete",
    all.length > 0 && concrete.length === all.length,
    `verification items=${all.length} with command or observable result=${concrete.length}`,
  );
}

function matchAll(re: RegExp, text: string): string[] {
  const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  return [...text.matchAll(global)].map((m) => m[0]);
}

/** A whole-word match, with the wider notion of a word character the source engine uses. */
function wordPresent(word: string, text: string): boolean {
  return ci(`${WB}${escapeRe(word)}${WB}`).test(text);
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether a draft clears the gate: every REQUIRED rule passed. */
export function formatPasses(findings: FormatFinding[]): boolean {
  return findings.every((finding) => !finding.required || finding.ok);
}

/** The rules that failed, which is what a retry is told and what a rejection records. */
export function failedRules(findings: FormatFinding[]): string[] {
  return findings.filter((finding) => finding.required && !finding.ok).map((finding) => finding.rule);
}

/**
 * The patterns, by the name the source checker gives each one.
 *
 * Exported for the equivalence table alone: that table replays the source's own regex fixtures,
 * and a pattern it could not address by name would be a pattern nobody compares. Nothing in the
 * product reaches for these - the rules above are the interface.
 */
export const FORMAT_PATTERNS: Record<string, RegExp> = {
  TRIGGER_RE,
  NUM_HEAD_RE,
  NUM_ITEM_RE,
  LIST_ITEM_RE,
  TABLE_SEP_RE,
  TABLE_ROW_RE,
  FENCE_RE,
  HEAD_RE,
  ABBREV_RE,
  VERIFY_HEAD_RE,
  DELIVERY_HEAD_RE,
  COMMAND_RE,
  PITFALL_HEAD_RE,
  ABS_PATH_RE,
  EMAIL_RE,
  XML_RE,
  NAME_RE,
};
