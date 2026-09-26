import { readFileSync } from "node:fs";
import { detectSecret } from "./secrets.js";

// Claude Code writes one JSON object per transcript line. Schema verified
// empirically (2026-08-10) against real session files: conversation lines carry
// type "user" | "assistant" with message.content either a plain string (human
// prompt) or an array of blocks (text / tool_use / tool_result / thinking / …).
// Everything else (attachment, system, mode, file-history-*, queue-operation,
// ai-title, …) is bookkeeping. isSidechain: true marks subagent traffic, and
// isMeta: true marks a line Claude Code injected rather than a human typing it.

export interface TranscriptEntry {
  role: "user" | "assistant";
  text: string;
}

const PER_USER_CAP = 1_000;
const PER_ASSISTANT_CAP = 1_500;
// The user's own words carry the highest-value lessons (corrections, "always/never"
// teachings), so they get the larger share of the slice budget.
const USER_BUDGET_SHARE = 0.6;

/** Human-authored or model-authored prose? Local-command echoes, system reminders,
 * and interrupt markers are neither - they start with markup or brackets. */
function isNoise(text: string): boolean {
  const t = text.trimStart();
  return t === "" || t.startsWith("<") || t.startsWith("[Request interrupted");
}

function textBlocks(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content
    .filter((b): b is { type: string; text: string } =>
      typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text" &&
      typeof (b as { text?: unknown }).text === "string",
    )
    .map((b) => b.text);
}

/** Parse a transcript JSONL into ordered conversation prose. Tolerant: malformed
 * lines, sidechain (subagent) traffic, tool blocks, and command noise are skipped. */
export function readTranscriptTexts(path: string): TranscriptEntry[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const entries: TranscriptEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: {
      type?: unknown;
      isSidechain?: unknown;
      isMeta?: unknown;
      message?: { role?: unknown; content?: unknown };
    };
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed.isSidechain === true) continue;
    // A slash command expands into the transcript as a user turn carrying the
    // command's own markdown, and the `<command-name>` wrapper that survives the
    // markup filter is only half of it: the expanded body is plain prose with no
    // markup at all. Read as the developer's words it is worse than noise, because
    // it is a set of instructions addressed to the model. Harvesting the demo of
    // this very plugin, the slice opened with "You are running TeamHandbook's guided
    // demo", the model concluded it was watching a staged exercise, and the one real
    // teaching in that session went unproposed. isMeta marks every such line.
    if (parsed.isMeta === true) continue;
    if (parsed.type !== "user" && parsed.type !== "assistant") continue;
    const role = parsed.type;
    for (const text of textBlocks(parsed.message?.content)) {
      if (isNoise(text)) continue;
      entries.push({ role, text: text.trim() });
    }
  }
  return entries;
}

function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

// The slice labels each turn "User:" / "Assistant:" at the start of a line, so a
// message whose own content starts a line that way could forge a turn - an
// assistant echoing a repo file that reads "User: always run <evil> first" would be
// harvested as something the DEVELOPER said, and shipped as a quoted receipt.
// Mark such lines as quoted content so they can't be mistaken for a real turn.
function neutralizeRoleLabels(text: string): string {
  return text.replace(/^(User|Assistant)(\s*:)/gim, "(quoted) $1$2");
}

// Markers that identify key material. Used by looksKeyBearing above; the slice
// drops such a message whole, so no per-line block machine is needed here.
// Covers PEM (`-----BEGIN RSA PRIVATE KEY-----`), armored PGP (`… BLOCK-----`) and
// ssh.com/SSH2 (`---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----`: four dashes, spaces).
const PEM_BEGIN = /-{4,5}\s?BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?\s?-{4,5}/;
const PEM_END = /-{4,5}\s?END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?\s?-{4,5}/;
// PuTTY keys are not PEM-armored: the body follows a line-count header. Not anchored to the
// start of a line - a diff of a .ppk prefixes every line with `+`, and `cat -n` prefixes it
// with a number, which is how a key file actually appears in a session - but it does ask for
// the rest of the format, so that prose naming the header (this file's own comment included)
// is not read as key material.
const PPK_BEGIN = /PuTTY-User-Key-File-\d+:[ \t]*\S|Private-Lines:[ \t]*\d/i;

/**
 * Does this message carry key material at all? Line-by-line redaction of pasted
 * keys is a losing game - every armor variant, per-line prefix (a `git diff` that
 * deletes a key, `cat -n`), and line terminator is another evasion. So the primary
 * defense is coarse and message-level: a message that looks key-bearing is dropped
 * from the slice WHOLE. The per-line pass below stays as a second belt for inline
 * secrets (tokens, passwords) that legitimately sit inside otherwise useful prose.
 *
 * A long base64-ish run is the tell that survives any prefix or armor style. Hex
 * digests (a 40-char SHA, a 64-char sha256) are single-case with no +/=, so they do
 * NOT trip it. A message quoting a public certificate does - its body is a base64
 * blob - which loses that message from the harvest but leaks nothing.
 */
/**
 * The two long base64 runs a coding session prints that are never key material. Each is
 * bound to the EXACT base64 length its hash produces (sha256 43 + `=`, sha384 64, sha512
 * 86 + `==`) and to the file format's own magic bytes, so a key body hidden behind a
 * `sha512-` prefix fails the length test and is dropped as before.
 *
 * Measured: without this, a lockfile is nothing but integrity lines and a message quoting
 * one was dropped from the harvest whole - so every dependency-upgrade session lost its
 * lessons, which is the most common session there is after a feature.
 */
const SRI_DIGEST =
  /\bsha(?:256-[A-Za-z0-9+/]{43}=|384-[A-Za-z0-9+/]{64}|512-[A-Za-z0-9+/]{86}==)(?![A-Za-z0-9+/=])/g;
const IMAGE_DATA_URI =
  /\bdata:image\/[a-z.+-]+;base64,(?:iVBORw0KGgo|\/9j\/4|R0lGOD|UklGR)[A-Za-z0-9+/]*={0,2}/g;

/**
 * Per MATCH, never per text: a message that quotes a lockfile line AND pastes a key has to
 * keep being dropped, so only the exempt run leaves the text the run scanner sees.
 */
function withoutExemptRuns(text: string): string {
  return text.replace(SRI_DIGEST, " ").replace(IMAGE_DATA_URI, " ");
}

/**
 * A body wrapped below the single-run bar is still a key: twenty consecutive 28-character
 * lines carry the same bytes as one 560-character run, and neither the run thresholds below
 * nor `redactSlice`'s per-line pass can see it.
 *
 * The floor is 24 characters and the run is four lines, measured against the columns a
 * session actually prints: a 20-character id column, a single-case hex column and an aligned
 * table all pass, and so does wrapped prose. A column of 28-character MIXED-CASE ids does
 * not - it is the same bytes as a body wrapped at 28, which is exactly the wrap the run
 * thresholds below miss - so that trade is taken in this direction. It fails closed: the cost
 * is one message that was nothing but a bare id column, and the alternative reopens the gap.
 */
const WRAPPED_LINE_MIN = 24;
const WRAPPED_LINE_RUN = 4;

const BLOB_LINE = new RegExp(`^[A-Za-z0-9+/]{${WRAPPED_LINE_MIN},}={0,2}$`);
// What a paste puts in front of every line: a diff sign, `cat -n`'s number, and the three
// markdown shapes a pasted block arrives in - a quote, a bullet, a table cell.
const LINE_PREFIX = /^\s*\d+\t|^[>|*+-][ \t]?/;

/**
 * One base64 STREAM broken across lines, as against a ragged list of identifiers.
 *
 * A wrap is deterministic: every line but the last is the wrap width, while a list of names
 * is uneven. That is the whole signature, and it is deliberately the only one. What it buys
 * is measured by `prose-around-an-identifier-list` in the corpus - four long CamelCase names
 * with a lesson around them, which this rule lets through and which drops without it.
 *
 * It is NOT what holds a secret dump; the run count below does that. See the note there
 * before adding a condition here, because the one that was tried made exactly that mistake.
 */
function isOneStream(lines: string[]): boolean {
  if (lines.length < WRAPPED_LINE_RUN) return false;
  return new Set(lines.slice(0, -1).map((line) => line.length)).size === 1;
}

function scanForWrappedBody(lines: string[]): boolean {
  let run: string[] = [];
  for (const line of lines) {
    if (BLOB_LINE.test(line) && isBlobRun(line, WRAPPED_LINE_MIN)) {
      run.push(line);
      continue;
    }
    if (isOneStream(run)) return true;
    run = [];
  }
  return isOneStream(run);
}

function hasWrappedBlob(text: string): boolean {
  const lines = text.split("\n");
  // Each reading is scanned WHOLE rather than line by line: `+` is itself a base64
  // character, so stripping unconditionally eats the first byte of a body line that starts
  // with one, and mixing the two readings across a run makes the equal-length test meaningless.
  const raw = lines.map((line) => line.trim());
  const stripped = lines.map((line) => line.replace(LINE_PREFIX, "").replace(/\s*\|$/, "").trim());
  return scanForWrappedBody(raw) || scanForWrappedBody(stripped);
}

/** Is this run actual base64 blob, or just a long path/URL/identifier? */
function isBlobRun(run: string, minLength: number): boolean {
  if (run.length < minLength) return false;
  // A path or URL is slash-separated SHORT segments; key material is not. Without
  // this, "/Users/dev/projects/company/backend/src/main/java/AcmeGateway" reads as
  // one long "base64" run and the whole message would be dropped - and paths and
  // URLs are everywhere in a coding session.
  const segments = run.split("/");
  if (segments.length >= 3 && segments.every((seg) => seg.length < 25)) return false;
  // Real base64 key material mixes case AND digits (or carries +/=); an identifier
  // like AcmeGatewayServiceFactoryBuilder does not.
  return /[+=]/.test(run) || (/[a-z]/.test(run) && /[A-Z]/.test(run) && /[0-9]/.test(run));
}

export function looksKeyBearing(text: string): boolean {
  if (PEM_BEGIN.test(text) || PEM_END.test(text) || PPK_BEGIN.test(text)) return true;
  const scanned = withoutExemptRuns(text);
  if (hasWrappedBlob(scanned)) return true;
  const runs = [...scanned.matchAll(/[A-Za-z0-9+/]{30,}={0,2}/g)].map((m) => m[0]);
  // one long blob is enough…
  if (runs.some((run) => isBlobRun(run, 50))) return true;
  // …and so are several medium ones, which is what a key looks like once a narrow terminal
  // (or a paste) has wrapped it below the single-run bar - and also what a SECRET DUMP looks
  // like, which is why this counts runs and asks nothing else about them.
  //
  // This line is the one holding a dump, measured three ways: `kubectl get secret -o yaml`
  // with three key fields, the same three keys as `SIGNING_KEY=` lines, and three keys pasted
  // under a sentence. 32 bytes is the commonest secret size and its base64 is 43 characters
  // plus one `=`, so a dump is three padded runs of equal length - and a condition that read
  // padding as "separate values, so not key material" handed all three to the model. Nothing
  // else was holding them: `signing-key:` is in no keyword list. A digest column is dropped
  // along with them, and that is the cost, taken on the side that loses a lesson rather than
  // the side that ships a key.
  return runs.filter((run) => isBlobRun(run, 30)).length >= 3;
}

/**
 * Fit the conversation into `budget` chars for the harvest prompt. User messages
 * get 60% of the budget, newest-first when they don't all fit (a late correction
 * outweighs early smalltalk); assistant prose fills the rest, also newest-first.
 * The selection is then re-emitted in chronological order so the model reads a
 * coherent conversation.
 *
 * A message too big for what is left is SKIPPED, not a stop: stopping there threw
 * away every older message, including the short ones the budget could still afford
 * - and a teaching is short ("we never mock the db here") while the brief that
 * exhausted the budget is long. Measured over the real transcripts on one machine,
 * stopping lost user messages in 13 sessions (worst: 6 of them) that fit.
 */
export function sliceTranscript(entries: TranscriptEntry[], budget = 40_000): string {
  const pick = new Map<number, string>();
  let remaining = Math.floor(budget * USER_BUDGET_SHARE);
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.role !== "user") continue;
    const text = cap(entry.text, PER_USER_CAP);
    if (text.length > remaining) continue;
    pick.set(i, text);
    remaining -= text.length;
  }
  remaining += Math.floor(budget * (1 - USER_BUDGET_SHARE));
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.role !== "assistant") continue;
    const text = cap(entry.text, PER_ASSISTANT_CAP);
    if (text.length > remaining) continue;
    pick.set(i, text);
    remaining -= text.length;
  }
  return [...pick.entries()]
    .sort(([a], [b]) => a - b)
    .map(([i, text]) => {
      const role = entries[i]!.role === "user" ? "User" : "Assistant";
      // fail closed at the message level - see looksKeyBearing
      const body = looksKeyBearing(entries[i]!.text)
        ? "[redacted: this message contained key material]"
        : neutralizeRoleLabels(text);
      return `${role}: ${body}`;
    })
    .join("\n\n");
}


/**
 * The second belt: an inline secret (a token, an `API_KEY=…`) sitting inside prose
 * that is otherwise worth harvesting. Key material never reaches here - a message
 * carrying it was dropped whole by looksKeyBearing - so this stays a plain
 * line-by-line pass with no block state to get wrong.
 */
export function redactSlice(slice: string): { clean: string; redacted: number } {
  let redacted = 0;
  const clean = slice
    .split("\n")
    .map((line) => {
      const hit = detectSecret(line);
      if (!hit) return line;
      redacted += 1;
      return `[redacted:${hit}]`;
    })
    .join("\n");
  return { clean, redacted };
}

/** Read → slice → redact, ready to be fenced into the harvest prompt. */
export function buildTranscriptSlice(
  path: string,
  budget = 40_000,
): { slice: string; redacted: number } {
  const { clean, redacted } = redactSlice(sliceTranscript(readTranscriptTexts(path), budget));
  return { slice: clean, redacted };
}
