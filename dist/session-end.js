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

// src/lib/signals.ts
import { existsSync, appendFileSync, mkdirSync as mkdirSync2, readFileSync as readFileSync2 } from "node:fs";
import { join as join2 } from "node:path";

// src/lib/session-state.ts
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
function emptySessionState(sessionId) {
  return { sessionId, openErrors: [], resolvedPairs: [] };
}
function handbookHome() {
  return process.env.TEAMHANDBOOK_HOME ?? join(homedir(), ".teamhandbook");
}
function sessionFile(sessionId, home) {
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "_");
  return join(home, "sessions", `${safe}.json`);
}
function loadSessionState(sessionId, home = handbookHome()) {
  try {
    const raw = readFileSync(sessionFile(sessionId, home), "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || !Array.isArray(parsed.openErrors)) {
      return emptySessionState(sessionId);
    }
    return {
      sessionId,
      openErrors: parsed.openErrors.map((e) => ({ ...e, edits: e.edits ?? [] })),
      resolvedPairs: Array.isArray(parsed.resolvedPairs) ? parsed.resolvedPairs : []
    };
  } catch {
    return emptySessionState(sessionId);
  }
}
function deleteSessionState(sessionId, home = handbookHome()) {
  rmSync(sessionFile(sessionId, home), { force: true });
}

// src/lib/signals.ts
function signalsFile(home = handbookHome()) {
  return join2(home, "signals.jsonl");
}
function ledgerFingerprintCounts(home = handbookHome()) {
  const counts = /* @__PURE__ */ new Map();
  let raw;
  try {
    raw = readFileSync2(signalsFile(home), "utf8");
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
    }
  }
  return counts;
}
function ledgerFingerprints(home = handbookHome()) {
  return new Set(ledgerFingerprintCounts(home).keys());
}
function promoteRecurrentSignals(signals, priorFingerprints) {
  const seen = new Set(priorFingerprints);
  return signals.map((signal) => {
    const recurrent = seen.has(signal.fingerprint);
    seen.add(signal.fingerprint);
    if (signal.kind !== "weak" || !recurrent) return signal;
    return { ...signal, kind: "candidate", promotedBy: "recurrence" };
  });
}
function appendSignals(signals, home = handbookHome()) {
  if (signals.length === 0) return;
  mkdirSync2(home, { recursive: true });
  const lines = signals.map((s) => JSON.stringify(s)).join("\n") + "\n";
  appendFileSync(signalsFile(home), lines);
}
function signalFromPair(pair, sessionId, ts, fileExists = existsSync) {
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
    resolvedAt: pair.resolvedAt
  };
}
function signalFromOpenError(error, sessionId, ts) {
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
    edits: error.edits
  };
}
function flushSessionEnd(sessionId, home = handbookHome(), ts = (/* @__PURE__ */ new Date()).toISOString(), fileExists = existsSync) {
  const state = loadSessionState(sessionId, home);
  const signals = promoteRecurrentSignals(
    [
      ...state.resolvedPairs.map((p) => signalFromPair(p, sessionId, ts, fileExists)),
      ...state.openErrors.map((e) => signalFromOpenError(e, sessionId, ts))
    ],
    ledgerFingerprints(home)
  );
  appendSignals(signals, home);
  deleteSessionState(sessionId, home);
  return signals;
}

// src/hooks/session-end.ts
async function main() {
  const input = parseHookInput(await readStdin());
  if (!input?.session_id) return;
  flushSessionEnd(input.session_id);
}
main().then(
  () => process.exit(0),
  () => process.exit(0)
);
