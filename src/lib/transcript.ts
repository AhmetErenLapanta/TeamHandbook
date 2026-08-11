import { readFileSync } from "node:fs";
import { detectSecret } from "./secrets.js";

// Claude Code writes one JSON object per transcript line. Schema verified
// empirically (2026-08-10) against real session files: conversation lines carry
// type "user" | "assistant" with message.content either a plain string (human
// prompt) or an array of blocks (text / tool_use / tool_result / thinking / …).
// Everything else (attachment, system, mode, file-history-*, queue-operation,
// ai-title, …) is bookkeeping. isSidechain: true marks subagent traffic.

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
 * and interrupt markers are neither — they start with markup or brackets. */
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
      message?: { role?: unknown; content?: unknown };
    };
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed.isSidechain === true) continue;
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
// message whose own content starts a line that way could forge a turn — an
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
// PuTTY keys are not PEM-armored: the body follows a `Private-Lines: N` header.
const PPK_BEGIN = /^\s*(?:PuTTY-User-Key-File-\d+|Private-Lines):/im;

/**
 * Does this message carry key material at all? Line-by-line redaction of pasted
 * keys is a losing game — every armor variant, per-line prefix (a `git diff` that
 * deletes a key, `cat -n`), and line terminator is another evasion. So the primary
 * defense is coarse and message-level: a message that looks key-bearing is dropped
 * from the slice WHOLE. The per-line pass below stays as a second belt for inline
 * secrets (tokens, passwords) that legitimately sit inside otherwise useful prose.
 *
 * A long base64-ish run is the tell that survives any prefix or armor style. Hex
 * digests (a 40-char SHA, a 64-char sha256) are single-case with no +/=, so they do
 * NOT trip it. A message quoting a public certificate does — its body is a base64
 * blob — which loses that message from the harvest but leaks nothing.
 */
/** Is this run actual base64 blob, or just a long path/URL/identifier? */
function isBlobRun(run: string, minLength: number): boolean {
  if (run.length < minLength) return false;
  // A path or URL is slash-separated SHORT segments; key material is not. Without
  // this, "/Users/dev/projects/company/backend/src/main/java/AcmeGateway" reads as
  // one long "base64" run and the whole message would be dropped — and paths and
  // URLs are everywhere in a coding session.
  const segments = run.split("/");
  if (segments.length >= 3 && segments.every((seg) => seg.length < 25)) return false;
  // Real base64 key material mixes case AND digits (or carries +/=); an identifier
  // like AcmeGatewayServiceFactoryBuilder does not.
  return /[+=]/.test(run) || (/[a-z]/.test(run) && /[A-Z]/.test(run) && /[0-9]/.test(run));
}

export function looksKeyBearing(text: string): boolean {
  if (PEM_BEGIN.test(text) || PEM_END.test(text) || PPK_BEGIN.test(text)) return true;
  const runs = [...text.matchAll(/[A-Za-z0-9+/]{30,}={0,2}/g)].map((m) => m[0]);
  // one long blob is enough…
  if (runs.some((run) => isBlobRun(run, 50))) return true;
  // …and so are several medium ones, which is what a key looks like once a narrow
  // terminal (or a paste) has wrapped it below the single-run bar
  return runs.filter((run) => isBlobRun(run, 30)).length >= 3;
}

/**
 * Fit the conversation into `budget` chars for the harvest prompt. User messages
 * get 60% of the budget, newest-first when they don't all fit (a late correction
 * outweighs early smalltalk); assistant prose fills the rest, also newest-first.
 * The selection is then re-emitted in chronological order so the model reads a
 * coherent conversation.
 */
export function sliceTranscript(entries: TranscriptEntry[], budget = 40_000): string {
  const pick = new Map<number, string>();
  let remaining = Math.floor(budget * USER_BUDGET_SHARE);
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.role !== "user") continue;
    const text = cap(entry.text, PER_USER_CAP);
    if (text.length > remaining) break;
    pick.set(i, text);
    remaining -= text.length;
  }
  remaining += Math.floor(budget * (1 - USER_BUDGET_SHARE));
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.role !== "assistant") continue;
    const text = cap(entry.text, PER_ASSISTANT_CAP);
    if (text.length > remaining) break;
    pick.set(i, text);
    remaining -= text.length;
  }
  return [...pick.entries()]
    .sort(([a], [b]) => a - b)
    .map(([i, text]) => {
      const role = entries[i]!.role === "user" ? "User" : "Assistant";
      // fail closed at the message level — see looksKeyBearing
      const body = looksKeyBearing(entries[i]!.text)
        ? "[redacted: this message contained key material]"
        : neutralizeRoleLabels(text);
      return `${role}: ${body}`;
    })
    .join("\n\n");
}


/**
 * The second belt: an inline secret (a token, an `API_KEY=…`) sitting inside prose
 * that is otherwise worth harvesting. Key material never reaches here — a message
 * carrying it was dropped whole by looksKeyBearing — so this stays a plain
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
