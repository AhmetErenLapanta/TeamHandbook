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
    .map(([i, text]) => `${entries[i]!.role === "user" ? "User" : "Assistant"}: ${text}`)
    .join("\n\n");
}

// A PEM block is the one secret whose VALUE lives on lines after the line that
// identifies it: the `-----BEGIN … PRIVATE KEY-----` header matches a pattern, the
// base64 body matches nothing. Redacting line by line would blank the header,
// report a redaction, and pass every byte of the key through — so the block is
// consumed as a unit. If the END marker never arrives (a truncated slice), the rest
// of the slice is dropped: losing harvest material beats leaking a key.
const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const PEM_END = /-----END [A-Z0-9 ]*PRIVATE KEY-----/;

/**
 * Line-level redaction for transcript slices. Capture-time redaction DROPS a
 * secret-bearing occurrence entirely; here that would kill the whole harvest, so
 * matching lines are replaced in place with a content-free marker instead. The raw
 * secret reaches neither the harvest prompt nor disk.
 */
export function redactSlice(slice: string): { clean: string; redacted: number } {
  let redacted = 0;
  const out: string[] = [];
  let inPemBlock = false;
  for (const line of slice.split("\n")) {
    if (inPemBlock) {
      if (PEM_END.test(line)) inPemBlock = false;
      continue; // the whole block collapses into the marker emitted at BEGIN
    }
    if (PEM_BEGIN.test(line)) {
      inPemBlock = !PEM_END.test(line); // a one-line BEGIN…END pair ends immediately
      out.push("[redacted:private-key]");
      redacted += 1;
      continue;
    }
    const hit = detectSecret(line);
    if (!hit) {
      out.push(line);
      continue;
    }
    redacted += 1;
    out.push(`[redacted:${hit}]`);
  }
  return { clean: out.join("\n"), redacted };
}

/** Read → slice → redact, ready to be fenced into the harvest prompt. */
export function buildTranscriptSlice(
  path: string,
  budget = 40_000,
): { slice: string; redacted: number } {
  const { clean, redacted } = redactSlice(sliceTranscript(readTranscriptTexts(path), budget));
  return { slice: clean, redacted };
}
