import { existsSync, appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { OpenError, ResolvedPair } from "./session-state.js";
import {
  deleteSessionState,
  loadSessionState,
  saveSessionState,
  handbookHome,
} from "./session-state.js";

export interface Signal {
  ts: string;
  sessionId: string;
  kind: "candidate" | "weak";
  fingerprint: string;
  family: string;
  command: string;
  error: string;
  cwd: string;
  count: number;
  edits: string[];
  resolvedCommand?: string;
  resolvedAt?: string;
  promotedBy?: "recurrence";
  trigger?: "manual";
}

export function signalsFile(home: string = handbookHome()): string {
  return join(home, "signals.jsonl");
}

export function ledgerFingerprintCounts(home: string = handbookHome()): Map<string, number> {
  const counts = new Map<string, number>();
  let raw: string;
  try {
    raw = readFileSync(signalsFile(home), "utf8");
  } catch {
    return counts;
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed?.fingerprint === "string") {
        counts.set(parsed.fingerprint, (counts.get(parsed.fingerprint) ?? 0) + 1);
      }
    } catch {
      // skip malformed lines; the ledger is append-only and best-effort
    }
  }
  return counts;
}

export function ledgerFingerprints(home: string = handbookHome()): Set<string> {
  return new Set(ledgerFingerprintCounts(home).keys());
}

export function promoteRecurrentSignals(signals: Signal[], priorFingerprints: Set<string>): Signal[] {
  const seen = new Set(priorFingerprints);
  return signals.map((signal) => {
    const recurrent = seen.has(signal.fingerprint);
    seen.add(signal.fingerprint);
    if (signal.kind !== "weak" || !recurrent) return signal;
    return { ...signal, kind: "candidate", promotedBy: "recurrence" };
  });
}

export function appendSignals(signals: Signal[], home: string = handbookHome()): void {
  if (signals.length === 0) return;
  mkdirSync(home, { recursive: true });
  const lines = signals.map((s) => JSON.stringify(s)).join("\n") + "\n";
  appendFileSync(signalsFile(home), lines);
}

export function signalFromPair(
  pair: ResolvedPair,
  sessionId: string,
  ts: string,
  fileExists: (path: string) => boolean = existsSync,
): Signal {
  const persistedEdits = pair.edits.filter(fileExists);
  return {
    ts,
    sessionId,
    kind: persistedEdits.length > 0 ? "candidate" : "weak",
    fingerprint: pair.fingerprint,
    family: pair.family,
    command: pair.command,
    error: pair.error,
    cwd: pair.cwd,
    count: pair.count,
    edits: persistedEdits,
    resolvedCommand: pair.resolvedCommand,
    resolvedAt: pair.resolvedAt,
  };
}

export function signalFromOpenError(error: OpenError, sessionId: string, ts: string): Signal {
  return {
    ts,
    sessionId,
    kind: "weak",
    fingerprint: error.fingerprint,
    family: error.family,
    command: error.command,
    error: error.error,
    cwd: error.cwd,
    count: error.count,
    edits: error.edits,
  };
}

export function flushResolvedPairs(
  sessionId: string,
  home: string = handbookHome(),
  ts: string = new Date().toISOString(),
  fileExists: (path: string) => boolean = existsSync,
): Signal[] {
  const state = loadSessionState(sessionId, home);
  if (state.resolvedPairs.length === 0) return [];
  const signals = promoteRecurrentSignals(
    state.resolvedPairs.map((p) => signalFromPair(p, sessionId, ts, fileExists)),
    ledgerFingerprints(home),
  );
  appendSignals(signals, home);
  state.resolvedPairs = [];
  saveSessionState(state, home);
  return signals;
}

export function flushSessionEnd(
  sessionId: string,
  home: string = handbookHome(),
  ts: string = new Date().toISOString(),
  fileExists: (path: string) => boolean = existsSync,
): Signal[] {
  const state = loadSessionState(sessionId, home);
  const signals = promoteRecurrentSignals(
    [
      ...state.resolvedPairs.map((p) => signalFromPair(p, sessionId, ts, fileExists)),
      ...state.openErrors.map((e) => signalFromOpenError(e, sessionId, ts)),
    ],
    ledgerFingerprints(home),
  );
  appendSignals(signals, home);
  deleteSessionState(sessionId, home);
  return signals;
}
