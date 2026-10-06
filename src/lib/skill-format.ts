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
   * Measured: with these rules applied unconditionally, every fixture the source checker must pass
   * failed them - a minimal skill written by hand has no file map and no delivery section, and
   * nothing in its text is wrong for lacking them. The fixtures are not
   * drafts of a mined workflow, so the rules ask for a section only when the caller says this
   * draft was supposed to have one, and otherwise judge the section it does have.
   */
  expects?: {
    fileMap?: boolean;
    multiRepo?: boolean;
    /**
     * How many pieces of each kind the evidence packet offered, so a citation can be resolved.
     * Without it `step-evidence` cannot tell a reference to the third map row from a reference to
     * a row that was never there, so the rule asks for nothing at all and the fixtures written by
     * hand - which cite nothing, having no packet behind them - stay untouched.
     */
    citable?: {
      map?: number;
      fix?: number;
      hunk?: number;
      subject?: number;
      file?: number;
      config?: number;
      "later-fix"?: number;
    };
    /**
     * Concrete paths the evidence packet QUOTED to the draft, beyond the file map's patterns.
     *
     * A step naming one of them is not the draft contradicting its own map: it is the draft using
     * a file it was shown. Without this, `step-map-consistency` rejects a draft for naming the
     * very file the evidence put in front of it - the same defect the rule's own history records,
     * where eight of fourteen flagged drafts were flagged for a file their map listed all along.
     * Absent when the packet quoted none, so a draft with no expanded evidence is judged as before.
     */
    quoted?: string[];
  };
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
  /\b(returns?|shows?|appears?|contains?|equals?|match(?:es)?|logs?|responds?|renders?|displays?|opens?|sees?|visible|status|200|201|400|404|500|non-empty|empty|\d+\s*(rows?|records?|items?|entries))\b/i;
const INLINE_CODE_RE = /`[^`\n]+`/;

/**
 * A path PATTERN, as opposed to a sentence about one: it carries a separator, a wildcard or a
 * file extension.
 *
 * Brackets end a token rather than belonging to it. A measured map writes its pattern inside a
 * label - `Server reference docs (docs/Reference/Server.md)` - and reading the bracket as part of
 * the path built a pattern that matched nothing: eight of fourteen drafts this rule flagged were
 * flagged for a file their map listed all along.
 */
const PATH_TOKEN_RE = /[^\s`|()]*(?:[/*]|\.[A-Za-z][A-Za-z0-9]{0,9})[^\s`|()]*/;
const PATH_TOKEN_ALL_RE = new RegExp(PATH_TOKEN_RE.source, "g");
/** The number a numbered heading carries, whichever of the three forms it is written in. */
const HEAD_NUMBER_RE = new RegExp(`^[${SPACE}]*(?:step[${SPACE}]+|phase[${SPACE}]+)?(\\p{Nd}+)`, "iu");
/**
 * A citation to one piece of the evidence packet. The index alone identifies the piece; the
 * optional `/N` is the share form the file map's own cells use, accepted so that a draft writing
 * `[map 3/7]` is not punished for echoing the notation it was given.
 */
const CITATION_RE = /\[(map|later-fix|fix|hunk|subject|file|config)[ \t]+(\d+)(?:[ \t]*\/[ \t]*\d+)?\]/g;
const NOT_VISIBLE_HEAD_RE = ci("not visible in history|not visible in the history");
/**
 * What an item in that section is allowed to be: a question, or a statement that says outright
 * that the history does not record the thing. Anything else is a step wearing the section as a
 * disguise, which is the one place a draft can still assert something it cannot cite.
 *
 * A question mark ANYWHERE in the item, not only at its end. Measured against real drafts: the form
 * the model actually writes is a question followed by the observation that raised it - "What is the
 * merge order? Few of the jobs followed one" - and demanding the mark at the end rejected nearly
 * every draft that has the section, each for an item that opens with exactly the question the rule
 * wants.
 */
const OPEN_QUESTION_RE = ci(
  "\\?|not (recorded|measured|visible|captured|in the evidence|known)|no commit|nothing (in the )?(history|evidence)|does not (say|record|show)|unknown|unclear|is not stated",
);
const MAP_HEAD_RE = /file map|files? touched/i;

/**
 * The sections a numbered STEP can live in: not the map, the checks, the delivery or the table.
 *
 * Two guards, and each one covers a hole the other opens.
 *
 * The LEVEL guard: a section's body runs to the next heading of the same or a higher level, so the
 * document's single top-level title contains every other section. Judged by its own words that
 * title matches no exempt pattern, so it counted as a procedure section and every exempt section's
 * content was read a second time through it - the exemptions existed in the code and not in the
 * product. Measured against a draft that was otherwise clean: checks written as a numbered list
 * were asked for citations, a file named in a check or in the delivery note was charged against the
 * file map, and the step count came out at more than twice the steps the draft had. Deleting the
 * title alone made all three clean, which is what identifies the container rather than the patterns
 * as the fault.
 *
 * The NUMBER guard: the exempt patterns are broad on purpose - the checks section is found by
 * `verif|validat|checklist|test` - so a real layer section called `## 2. Test the gateway` would
 * match one and escape both rules entirely. That trades a rule that asks too much for a rule that
 * asks nothing, which is the worse of the two.
 *
 * A number alone cannot decide it, though. The template leaves the fixed sections unnumbered, but
 * every draft recorded before that template did number them, and reading `## 4. Verification` as a
 * layer brings back exactly the over-reach the level guard just removed. So a NUMBERED heading is
 * exempt only when its title, with the number and any trailing parenthetical taken off, IS one of
 * the fixed section names rather than merely containing one: `4. Verification` is the checks
 * section, `2. Test the gateway` is a layer that happens to start with the word. An unnumbered
 * heading still matches loosely, because that is the form the template asks for and the looser
 * test costs nothing there.
 */
function isProcedureSection(section: Section): boolean {
  if (section.level < 2) return false;
  const loose =
    MAP_HEAD_RE.test(section.title) ||
    VERIFY_HEAD_RE.test(section.title) ||
    DELIVERY_HEAD_RE.test(section.title) ||
    PITFALL_HEAD_RE.test(section.title) ||
    NOT_VISIBLE_HEAD_RE.test(section.title);
  if (!loose) return true;
  if (!NUM_HEAD_RE.test(section.title)) return false;
  return !EXEMPT_EXACT_RE.test(bareTitle(section.title));
}

/** A heading without its number and without a trailing parenthetical count. */
function bareTitle(title: string): string {
  return title
    .replace(new RegExp(`^[${SPACE}]*(?:step[${SPACE}]+|phase[${SPACE}]+)?\\p{Nd}+[.)]?[${SPACE}]*`, "iu"), "")
    .replace(/\s*\([^)]*\)\s*$/, "")
    .trim();
}

/** The fixed sections by name, for a heading that carries a number and so has to earn its exemption. */
const EXEMPT_EXACT_RE = ci(
  "^(file map|files? touched|verification|verify|validation|checklist|tests?|delivery|deliver|hand-?off|finish(ed)?|done|common mistakes|mistakes|pitfalls?|gotchas?|anti-?patterns?|red flags|not visible in( the)? history)$",
);

/** A table's DATA rows: everything after the separator, header excluded. */
function dataRows(body: Line[]): string[] {
  const out: string[] = [];
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

/** A row's first cell, which in the file map is the file pattern the row is about. */
function firstCell(row: string): string {
  return row.trim().replace(/^\|/, "").split("|")[0]!.trim();
}

/**
 * The pattern column of a skill's file map, one cell per data row, found the way the rules below
 * find it. Exported so a skill that is already installed has its map read by the same parser that
 * admitted it, rather than by a second one that disagrees on a heading or a table.
 */
export function fileMapCells(text: string): string[] {
  return sections(classifyLines(splitFrontmatter(text).body))
    .filter((s) => MAP_HEAD_RE.test(s.title))
    .flatMap((s) => dataRows(s.body))
    .map(firstCell);
}

/**
 * A file pattern turned into a matcher. `*` and the two placeholder spellings a draft uses for a
 * varying part (`{locale}`, `<name>`) all stand for "something within one path segment".
 */
function patternMatcher(pattern: string): RegExp | null {
  return matcherFor(pathTokens(pattern)[0] ?? null);
}

/**
 * The basename half of the same matcher, for a step that names a file without its directory.
 *
 * Split off the RAW token rather than the built pattern: a segment of the built one may end
 * inside an escape sequence, and a regex cut there either throws or, worse, matches something
 * else. One measured map cell did exactly that.
 */
function baseMatcher(pattern: string): RegExp | null {
  const token = pathTokens(pattern)[0];
  if (token === undefined) return null;
  return matcherFor(token.slice(token.lastIndexOf("/") + 1));
}

/**
 * Every path-shaped token a map cell carries, the most path-like first.
 *
 * A cell is not just a pattern: the measured drafts write a label beside it, and that label may
 * itself hold a wildcard - `` `*-service` messages `resources/messages/...` ``. Reading only the
 * first match made the label the pattern, and the row then matched nothing; one such row was
 * reported as a step naming an unmapped file while the map listed it all along. A token carrying
 * a separator is a path and sorts ahead of one that only carries a star or a dot.
 */
export function pathTokens(cell: string): string[] {
  const matches = [...cell.replace(/`/g, "").matchAll(PATH_TOKEN_ALL_RE)].map((m) => m[0]);
  return matches.sort((a, b) => Number(b.includes("/")) - Number(a.includes("/")) || b.length - a.length);
}

/**
 * One file pattern as a matcher, anchored at a segment boundary so that `enums/*Widget.kt` matches
 * `domain/enums/PriceWidget.kt` and not `otherenums/PriceWidget.kt`.
 *
 * The cell is text a model wrote, so the built source is handed to the engine inside a guard: an
 * unbuildable pattern makes the row match nothing, which costs the draft a finding, rather than
 * throwing out of a checker whose job is to return a verdict on every draft.
 */
export function matcherFor(token: string | null): RegExp | null {
  if (!token) return null;
  const source = token
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\\\{[^}]*\\\}/g, "[^/]*")
    .replace(/<[^>]*>/g, "[^/]*")
    .replace(/\*/g, "[^/]*");
  try {
    return new RegExp(`(^|/)${source}$`, "i");
  } catch {
    return null;
  }
}


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
  expects: NonNullable<FormatOptions["expects"]>,
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
  //
  // Only the checks section is read, by the two guards `isProcedureSection` already draws: never
  // the top-level title, whose body is the whole document, and never a numbered layer whose title
  // merely contains a checks word. Measured on recorded drafts, reading those made this rule judge
  // the steps of `## 1. Defaults and validation schema` and `## 4. Features and tests` - and every
  // line of a draft titled after its validator - as checks, and three of the eleven drafts it
  // rejected had no unconcrete item in their checks section at all.
  //
  // The template's checks section is unnumbered, and a numbered `## 4. Verification` is read as
  // one only in a draft that has no unnumbered checks section - the form drafts took before the
  // template, which numbered every section. A draft with `## Verification` that also writes
  // `## 3. Tests` is using the number to say Tests is one of its layers, and its steps are steps.
  const checks = secs.filter((s) => s.level >= 2 && VERIFY_HEAD_RE.test(s.title) && !isProcedureSection(s));
  const unnumbered = checks.filter((s) => !NUM_HEAD_RE.test(s.title));
  const verifySecs = unnumbered.length > 0 ? unnumbered : checks;
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

  addMechanicalFindings(findings, secs, expects);
}

/**
 * The four rules that read the draft as a STRUCTURE rather than as prose.
 *
 * Each exists because a measured draft cleared every earlier rule while breaking the thing the
 * rule names: drafts reused a section number, one wrote a sentence where the file map's pattern
 * column belongs and scored a coverage of zero, others named a class of file in a step that the
 * map never listed, and the drafts as a whole cited nothing at all, so a fabricated step read
 * exactly like a measured one.
 */
function addMechanicalFindings(
  findings: FormatFinding[],
  secs: Section[],
  expects: NonNullable<FormatOptions["expects"]>,
): void {
  const add = (rule: string, ok: unknown, detail: string) =>
    findings.push({ rule, ok: Boolean(ok), required: true, detail });

  const numbers = secs
    .filter((s) => s.level >= 2 && s.level <= 3 && NUM_HEAD_RE.test(s.title))
    .map((s) => HEAD_NUMBER_RE.exec(s.title)?.[1])
    .filter((n): n is string => n !== undefined);
  const repeated = numbers.filter((n, i) => numbers.indexOf(n) !== i);
  add(
    "unique-sections",
    repeated.length === 0,
    `numbered sections=${numbers.length} repeated=${JSON.stringify([...new Set(repeated)])}`,
  );

  const mapSecs = secs.filter((s) => MAP_HEAD_RE.test(s.title));
  const mapCells = mapSecs.flatMap((s) => dataRows(s.body)).map(firstCell);
  const prose = mapCells.filter((cell) => !PATH_TOKEN_RE.test(cell.replace(/`/g, "")));
  add(
    "file-map-pattern",
    prose.length === 0,
    `file-map rows=${mapCells.length} without a path pattern=${prose.length} ${JSON.stringify(prose.slice(0, 2))}`,
  );

  // A file class a step tells the reader to edit, but that the map never lists: the draft's own
  // two halves disagree about what this workflow touches, and the half the reader trusts to be
  // complete is the map.
  const stepLines = secs
    .filter(isProcedureSection)
    .flatMap((s) => s.body.filter((line) => line.kind === "text" && LIST_ITEM_RE.test(line.text)))
    .map((line) => (line as { text: string }).text);
  const matchers = [...mapCells, ...(expects.quoted ?? [])].map(
    (cell) => [patternMatcher(cell), baseMatcher(cell)] as const,
  );
  // The extensions the map itself uses. A bare word with a dot in it is a file name in one
  // language and an attribute chain in another, and nothing in the token says which; the map is
  // the draft's own statement of what kind of file this workflow is about, so it decides.
  const mapExtensions = new Set(
    [...mapCells, ...(expects.quoted ?? [])]
      .flatMap(pathTokens)
      .map(extensionOf)
      .filter((ext): ext is string => ext !== null),
  );
  const named = [...new Set(stepLines.flatMap((line) => fileTokens(line, mapExtensions)))];
  const unmapped = named.filter(
    (token) => !matchers.some(([full, base]) => full?.test(token) || base?.test(token)),
  );
  add(
    "step-map-consistency",
    mapCells.length === 0 || unmapped.length === 0,
    `files named in steps=${named.length} missing from the map=${unmapped.length} ${JSON.stringify(unmapped.slice(0, 3))}`,
  );

  // The one section a draft may write without evidence has to SOUND like it: the prompt asks for an
  // open question and nothing enforced that, so the section was free to hold an ordinary step
  // phrased as a fact - exactly the move the citation rule exists to stop, in the one place the
  // citation rule does not reach.
  const notVisible = secs.filter((s) => s.level >= 2 && NOT_VISIBLE_HEAD_RE.test(s.title));
  const openItems = notVisible
    .flatMap((s) => s.body.filter((line) => line.kind === "text" && LIST_ITEM_RE.test(line.text)))
    .map((line) => (line as { text: string }).text);
  // A question is always allowed. Otherwise an item naming a FILE is an instruction however it is
  // worded: the marker words match anywhere in the line, so "Copy the default from `x.json` if it
  // is unclear" carried a marker and read as a step - the exact shape of the fabrication this
  // section was added to absorb, in the one section no citation is required.
  const asserted = openItems.filter(
    (item) => !/\?/.test(item) && (namesAFile(item) || !OPEN_QUESTION_RE.test(item)),
  );
  add(
    "not-visible-open",
    asserted.length === 0,
    `not-visible items=${openItems.length} written as a claim=${asserted.length} ${JSON.stringify(asserted.slice(0, 2))}`,
  );

  // Off unless the caller says what there was to cite: a skill written by hand has no evidence
  // packet behind it, and asking it for citations would be asking it to invent them.
  const citable = expects.citable;
  if (!citable) return;
  const counts: Record<string, number> = {
    map: citable.map ?? 0,
    fix: citable.fix ?? 0,
    hunk: citable.hunk ?? 0,
    subject: citable.subject ?? 0,
    file: citable.file ?? 0,
    config: citable.config ?? 0,
    // Its own count, never the in-ticket one. `later-fix` is matched ahead of `fix` in the pattern
    // above so that `[later-fix 2]` is not read as a correction from a pool it is not in.
    "later-fix": citable["later-fix"] ?? 0,
  };
  const steps = numberedSteps(secs).map(({ step }) => step);
  const uncited = steps.filter((step) => citationsIn(step).length === 0);
  const dangling: string[] = [];
  for (const step of steps) {
    for (const { kind, index } of citationsIn(step)) {
      if (index < 1 || index > (counts[kind] ?? 0)) dangling.push(`${kind} ${index}`);
    }
  }
  add(
    "step-evidence",
    steps.length > 0 && uncited.length === 0 && dangling.length === 0,
    `steps=${steps.length} uncited=${uncited.length} dangling=${JSON.stringify([...new Set(dangling)].slice(0, 3))} available=${JSON.stringify(counts)}`,
  );
}

export interface ProcedureStep {
  /** The heading of the innermost section the step sits in. */
  section: string;
  /** The step's line as written, number and citations included. */
  step: string;
}

/**
 * The numbered steps of the procedure sections, in document order: exactly the lines `step-evidence`
 * asks a citation of. A line under a nested heading sits in two sections' bodies and is still one
 * step, filed under the nested one.
 */
function numberedSteps(secs: Section[]): ProcedureStep[] {
  const found = new Map<Line, ProcedureStep>();
  for (const section of secs.filter(isProcedureSection)) {
    for (const line of section.body) {
      if (line.kind !== "text" || !NUM_ITEM_RE.test(line.text)) continue;
      found.set(line, { section: section.title, step: line.text });
    }
  }
  return [...found.values()];
}

/**
 * The steps of a draft as the gate counts them. Exported so that whatever grades a draft step by
 * step grades the steps the gate made the model cite, rather than a second reading of the same file
 * that could skip one or find one the gate never saw.
 */
export function procedureSteps(text: string): ProcedureStep[] {
  return numberedSteps(sections(classifyLines(splitFrontmatter(text).body)));
}

export type CitationKind = "map" | "later-fix" | "fix" | "hunk" | "subject" | "file" | "config";

export interface Citation {
  kind: CitationKind;
  index: number;
}

/** Every citation a line carries, in the order it carries them. */
export function citationsIn(line: string): Citation[] {
  return [...line.matchAll(CITATION_RE)].map(([, kind, index]) => ({ kind: kind as CitationKind, index: Number(index) }));
}

/** A line with its citations taken out, for a reader who does not hold the packet they point into. */
export function withoutCitations(line: string): string {
  return line.replace(CITATION_RE, "").replace(/[ \t]{2,}/g, " ").trim();
}

/**
 * Whether a line quotes something shaped like a file path at all.
 *
 * A bare extension is not one: an open note saying a compiled `.mo` file is not recorded names a
 * KIND of file, not a file, and reading it as an instruction rejected a section that was doing
 * exactly what it is for.
 */
function namesAFile(line: string): boolean {
  for (const [, code] of line.matchAll(/`([^`\n]+)`/g)) {
    const text = code!.trim();
    if (/\s/.test(text)) continue;
    if (text.includes("/")) return true;
    if (/^[A-Za-z0-9_]/.test(text) && extensionOf(text) !== null) return true;
  }
  return false;
}

/**
 * The file references a step line names, as opposed to the commands, keys and identifiers it
 * quotes.
 *
 * Measured against real drafts: read loosely, this flagged most of them, and most of what it caught
 * was not a file at all - a message key (`label.<name>.text`), an attribute chain
 * (`self.connection`), a call (`super().clean`) and a language keyword (`for...of`) all end in
 * something that looks like an extension. Each exclusion below removes one of those classes. A path
 * says it is a path by carrying a separator; a bare name has to earn it by ending the way the
 * draft's own map says files in this workflow end.
 */
function fileTokens(line: string, mapExtensions: Set<string>): string[] {
  const out: string[] = [];
  for (const [, code] of line.matchAll(/`([^`\n]+)`/g)) {
    const text = code!.trim();
    // A command is not a file reference: a step quoting one says how to RUN the workflow rather
    // than what it edits. An elision means the draft declined to name the file at all.
    if (/\s/.test(text) || text.includes("...") || /[()]/.test(text)) continue;
    const ext = extensionOf(text);
    if (ext === null) continue;
    if (text.includes("/")) {
      out.push(text.replace(/^[./]+/, ""));
    } else if (!/[<>*]/.test(text) && /^[A-Za-z0-9_]/.test(text) && mapExtensions.has(ext)) {
      // A bare extension names no file: one draft quoted `.po` on its own and the map was
      // charged for a row it could never have written.
      out.push(text);
    }
  }
  return out;
}

/** The trailing extension of a path or file name, lowercased, or null when it has none. */
function extensionOf(token: string): string | null {
  return /\.([A-Za-z][A-Za-z0-9]{0,10})$/.exec(token)?.[1]!.toLowerCase() ?? null;
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
