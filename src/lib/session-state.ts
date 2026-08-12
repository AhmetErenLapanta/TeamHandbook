import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { writeFileAtomic } from "./fs-atomic.js";
import type { CorrectionNote } from "./corrections.js";

// An edit is attributed to an open error only if that error was seen within this
// window. Without it, a stale failure from hours ago collects every later edit in
// the session and produces a false candidate when the command eventually passes.
const EDIT_ATTACH_WINDOW_MS = 15 * 60 * 1000;
const MAX_EDITS_PER_ERROR = 20;
const MAX_OPEN_ERRORS = 50;

export interface OpenError {
  fingerprint: string;
  family: string;
  command: string;
  error: string;
  cwd: string;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  edits: string[];
}

export interface ResolvedPair extends OpenError {
  resolvedAt: string;
  resolvedCommand: string;
}

export interface SessionState {
  sessionId: string;
  openErrors: OpenError[];
  resolvedPairs: ResolvedPair[];
  // coarse what-happened-this-session shape, for repeated-work detection (T3)
  activity?: { families: string[]; exts: string[] };
  // where this session's transcript lives — the harvest reads it at session end
  // (and salvage needs it recorded, since the hook input is gone by then)
  transcriptPath?: string;
  // meaningful (non-generic) tool calls this session — one leg of the substance check
  meaningfulToolCalls?: number;
  // teaching-shaped prompts the user typed ("we never do X here") — flagged
  // deterministically as they happen so the harvest cannot miss them
  corrections?: CorrectionNote[];
  // set when salvage already harvested this (possibly still-alive) session, so an
  // orphan is never harvested twice
  harvestedAt?: string;
}

export function emptySessionState(sessionId: string): SessionState {
  return { sessionId, openErrors: [], resolvedPairs: [] };
}

export function handbookHome(): string {
  return process.env.TEAMHANDBOOK_HOME ?? join(homedir(), ".teamhandbook");
}

function sessionFile(sessionId: string, home: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "_");
  return join(home, "sessions", `${safe}.json`);
}

export function loadSessionState(sessionId: string, home: string = handbookHome()): SessionState {
  try {
    const raw = readFileSync(sessionFile(sessionId, home), "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || !Array.isArray(parsed.openErrors)) {
      return emptySessionState(sessionId);
    }
    const activity =
      typeof parsed.activity === "object" &&
      parsed.activity !== null &&
      Array.isArray(parsed.activity.families) &&
      Array.isArray(parsed.activity.exts)
        ? { families: parsed.activity.families, exts: parsed.activity.exts }
        : undefined;
    return {
      sessionId,
      openErrors: parsed.openErrors.map((e: OpenError) => ({ ...e, edits: e.edits ?? [] })),
      resolvedPairs: Array.isArray(parsed.resolvedPairs) ? parsed.resolvedPairs : [],
      ...(activity ? { activity } : {}),
      ...(typeof parsed.transcriptPath === "string" ? { transcriptPath: parsed.transcriptPath } : {}),
      ...(typeof parsed.meaningfulToolCalls === "number"
        ? { meaningfulToolCalls: parsed.meaningfulToolCalls }
        : {}),
      ...(typeof parsed.harvestedAt === "string" ? { harvestedAt: parsed.harvestedAt } : {}),
      ...(Array.isArray(parsed.corrections) ? { corrections: parsed.corrections } : {}),
    };
  } catch {
    return emptySessionState(sessionId);
  }
}

export function saveSessionState(state: SessionState, home: string = handbookHome()): void {
  writeFileAtomic(sessionFile(state.sessionId, home), JSON.stringify(state, null, 2));
}

// A session is worth harvesting when it did real work. Deterministic and free —
// this decides whether a claude call happens at all (spec §4).
const SUBSTANCE_MIN_TOOL_CALLS = 5;

export function sessionHasSubstance(state: SessionState): boolean {
  if (state.resolvedPairs.length > 0) return true;
  // Recorded prompts are deliberately NOT a leg of this. They used to be, back when a
  // prompt only got recorded if it matched a teaching pattern — one of those meant a
  // human had stated a rule, which is substance by itself. Now every prompt long
  // enough to carry a lesson is recorded, so counting them here would make "a question
  // and two ls calls" a harvest, and the promise that a trivial session costs nothing
  // is one this file is what enforces.
  const activity = state.activity;
  if (activity && activity.families.length > 0 && activity.exts.length > 0) return true;
  return (state.meaningfulToolCalls ?? 0) >= SUBSTANCE_MIN_TOOL_CALLS;
}

export function deleteSessionState(sessionId: string, home: string = handbookHome()): void {
  rmSync(sessionFile(sessionId, home), { force: true });
}

// SessionEnd never fires on a terminal kill / crash / power loss, so dead session
// files would otherwise accumulate forever. Sessions this old are unrecoverable;
// drop them.
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// A session file untouched for this long belongs to a session that ended without
// SessionEnd firing (terminal kill, crash, power loss). Old enough to be safely
// treated as orphaned, young enough that its resolved pairs are still worth
// salvaging before deletion.
const SESSION_ORPHAN_MS = 3 * 60 * 60 * 1000;

/** Session ids (file basenames) whose file hasn't changed in SESSION_ORPHAN_MS —
 * candidates for salvage-then-delete at the next session start. */
export function orphanedSessionIds(
  home: string = handbookHome(),
  now: number = Date.now(),
): string[] {
  const dir = join(home, "sessions");
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      if (now - statSync(join(dir, entry)).mtimeMs > SESSION_ORPHAN_MS) {
        ids.push(entry.replace(/\.json$/, ""));
      }
    } catch {
      // raced; skip
    }
  }
  return ids;
}

export function cleanupStaleSessionFiles(
  home: string = handbookHome(),
  now: number = Date.now(),
): number {
  const dir = join(home, "sessions");
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    try {
      const file = join(dir, entry);
      if (now - statSync(file).mtimeMs > SESSION_MAX_AGE_MS) {
        rmSync(file, { force: true });
        removed += 1;
      }
    } catch {
      // raced with a live session; leave it
    }
  }
  return removed;
}

export function recordFailure(
  state: SessionState,
  failure: Pick<OpenError, "fingerprint" | "family" | "command" | "error" | "cwd">,
  at: string = new Date().toISOString(),
): SessionState {
  const existing = state.openErrors.find((e) => e.fingerprint === failure.fingerprint);
  if (existing) {
    existing.count += 1;
    existing.lastSeenAt = at;
    existing.command = failure.command;
    return state;
  }
  state.openErrors.push({ ...failure, count: 1, firstSeenAt: at, lastSeenAt: at, edits: [] });
  // Cap unbounded growth from a session that hits many distinct never-resolved
  // errors; keep the most recently seen.
  if (state.openErrors.length > MAX_OPEN_ERRORS) {
    state.openErrors.sort((a, b) => a.lastSeenAt.localeCompare(b.lastSeenAt));
    state.openErrors = state.openErrors.slice(-MAX_OPEN_ERRORS);
  }
  return state;
}

export function attachEditToOpenErrors(
  state: SessionState,
  filePath: string,
  at: string = new Date().toISOString(),
): boolean {
  const cutoff = new Date(at).getTime() - EDIT_ATTACH_WINDOW_MS;
  let attached = false;
  for (const error of state.openErrors) {
    const seen = new Date(error.lastSeenAt).getTime();
    if (Number.isFinite(seen) && seen < cutoff) continue; // too old to be related
    if (!error.edits.includes(filePath)) {
      error.edits.push(filePath);
      // most-recent-N ring buffer: an early flurry of flail edits must not lock
      // out the actual fix that lands later in a long session
      if (error.edits.length > MAX_EDITS_PER_ERROR) error.edits.shift();
      attached = true;
    }
  }
  return attached;
}

export function resolveOpenErrors(
  state: SessionState,
  family: string,
  command: string,
  cwd = "",
  at: string = new Date().toISOString(),
): ResolvedPair[] {
  const sameCwd = (e: OpenError) => cwd === "" || e.cwd === "" || e.cwd === cwd;
  const matching = state.openErrors.filter((e) => e.family === family && sameCwd(e));
  if (matching.length === 0) return [];
  // A single green run resolves only the MOST-RECENTLY-SEEN matching error — not
  // every same-family error at once (which would mint false pairs all claiming
  // the same resolving command). The rest stay open to resolve on their own.
  matching.sort((a, b) => a.lastSeenAt.localeCompare(b.lastSeenAt));
  const target = matching[matching.length - 1]!;
  state.openErrors = state.openErrors.filter((e) => e !== target);
  const resolved = [{ ...target, resolvedAt: at, resolvedCommand: command }];
  state.resolvedPairs.push(...resolved);
  return resolved;
}
