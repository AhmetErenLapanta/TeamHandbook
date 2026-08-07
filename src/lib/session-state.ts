import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

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
    return {
      sessionId,
      openErrors: parsed.openErrors.map((e: OpenError) => ({ ...e, edits: e.edits ?? [] })),
      resolvedPairs: Array.isArray(parsed.resolvedPairs) ? parsed.resolvedPairs : [],
    };
  } catch {
    return emptySessionState(sessionId);
  }
}

export function saveSessionState(state: SessionState, home: string = handbookHome()): void {
  const file = sessionFile(state.sessionId, home);
  mkdirSync(join(home, "sessions"), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2));
}

export function deleteSessionState(sessionId: string, home: string = handbookHome()): void {
  rmSync(sessionFile(sessionId, home), { force: true });
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
  return state;
}

export function attachEditToOpenErrors(state: SessionState, filePath: string): boolean {
  let attached = false;
  for (const error of state.openErrors) {
    if (!error.edits.includes(filePath)) {
      error.edits.push(filePath);
      attached = true;
    }
  }
  return attached;
}

export function resolveOpenErrors(
  state: SessionState,
  family: string,
  command: string,
  at: string = new Date().toISOString(),
): ResolvedPair[] {
  const matching = state.openErrors.filter((e) => e.family === family);
  if (matching.length === 0) return [];
  state.openErrors = state.openErrors.filter((e) => e.family !== family);
  const resolved = matching.map((e) => ({ ...e, resolvedAt: at, resolvedCommand: command }));
  state.resolvedPairs.push(...resolved);
  return resolved;
}
