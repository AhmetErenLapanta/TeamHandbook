// src/hooks/session-end.ts
import { fileURLToPath } from "node:url";

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

// src/lib/pipeline.ts
import { spawn } from "node:child_process";
import {
  appendFileSync as appendFileSync2,
  existsSync as existsSync2,
  mkdirSync as mkdirSync4,
  readdirSync as readdirSync3,
  readFileSync as readFileSync4,
  renameSync as renameSync2,
  rmSync as rmSync3,
  statSync as statSync2,
  writeFileSync as writeFileSync3
} from "node:fs";
import { basename, join as join4 } from "node:path";

// src/lib/session-state.ts
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, readdirSync, rmSync as rmSync2, statSync } from "node:fs";

// src/lib/fs-atomic.ts
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
var seq = 0;
function writeFileAtomic(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${seq++}-${process.hrtime.bigint().toString(36)}`;
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

// src/lib/session-state.ts
var EDIT_ATTACH_WINDOW_MS = 15 * 60 * 1e3;
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
    const activity = typeof parsed.activity === "object" && parsed.activity !== null && Array.isArray(parsed.activity.families) && Array.isArray(parsed.activity.exts) ? { families: parsed.activity.families, exts: parsed.activity.exts } : void 0;
    return {
      sessionId,
      openErrors: parsed.openErrors.map((e) => ({ ...e, edits: e.edits ?? [] })),
      resolvedPairs: Array.isArray(parsed.resolvedPairs) ? parsed.resolvedPairs : [],
      ...activity ? { activity } : {}
    };
  } catch {
    return emptySessionState(sessionId);
  }
}
function deleteSessionState(sessionId, home = handbookHome()) {
  rmSync2(sessionFile(sessionId, home), { force: true });
}
var SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1e3;

// src/lib/score.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);

// src/lib/secrets.ts
var SECRET_PATTERNS = [
  { name: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { name: "github-token", re: /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}\b/ },
  { name: "gitlab-token", re: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { name: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "slack-webhook", re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}/ },
  { name: "stripe-key", re: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  { name: "openai-key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: "google-api-key", re: /\bAIza[A-Za-z0-9_-]{30,}\b/ },
  { name: "npm-token", re: /\bnpm_[A-Za-z0-9]{30,}\b/ },
  { name: "bearer-token", re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/i },
  { name: "basic-auth-header", re: /\bAuthorization\s*:\s*Basic\s+[A-Za-z0-9+/]{16,}=*/i },
  { name: "url-credentials", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]{3,}@/i },
  {
    // keyword may be preceded by a word boundary OR an underscore (AWS_SECRET_KEY=...),
    // which \b cannot match between two word chars.
    name: "assigned-secret",
    re: /(?:\b|_)(?:api[_-]?key|secret|token|passw(?:or)?d|access[_-]?key)["']?\s*[=:]\s*["']?[A-Za-z0-9+/_.-]{8,}/i
  }
];
function detectSecret(text) {
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(text)) return name;
  }
  return null;
}
function signalSecret(fields) {
  return detectSecret(
    [
      fields.command ?? "",
      fields.error ?? "",
      fields.resolvedCommand ?? "",
      ...fields.edits ?? [],
      fields.task?.goal ?? "",
      ...fields.task?.steps ?? [],
      fields.task?.verification ?? ""
    ].join("\n")
  );
}

// src/lib/signals.ts
import { createHash } from "node:crypto";
import { existsSync, appendFileSync, mkdirSync as mkdirSync3, readFileSync as readFileSync3 } from "node:fs";
import { join as join3 } from "node:path";

// src/lib/counters.ts
import { mkdirSync as mkdirSync2, readdirSync as readdirSync2, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join2 } from "node:path";
var FIELDS = [
  "redactionBlocked",
  "postToolUse",
  "bashFailuresCaptured",
  "pairsResolved"
];
function countersFile(home = handbookHome()) {
  return join2(home, "counters.json");
}
function readCounters(home = handbookHome()) {
  const base = { redactionBlocked: 0, postToolUse: 0, bashFailuresCaptured: 0, pairsResolved: 0 };
  try {
    const parsed = JSON.parse(readFileSync2(countersFile(home), "utf8"));
    for (const f of FIELDS) base[f] = Number(parsed?.[f]) || 0;
  } catch {
  }
  return base;
}
function bumpCounter(field, home = handbookHome(), by = 1) {
  const counters = readCounters(home);
  counters[field] += by;
  mkdirSync2(home, { recursive: true });
  writeFileAtomic(countersFile(home), JSON.stringify(counters, null, 2));
  return counters;
}
function incrementRedactionBlocked(home = handbookHome(), by = 1) {
  return bumpCounter("redactionBlocked", home, by);
}

// src/lib/signals.ts
function sanitizeSignalsForPersistence(signals) {
  let redacted = 0;
  const clean = signals.map((s) => {
    if (s.secretRedacted || !signalSecret(s)) return s;
    redacted += 1;
    return {
      ts: s.ts,
      sessionId: s.sessionId,
      kind: "weak",
      fingerprint: s.fingerprint,
      family: "",
      command: "",
      error: "",
      cwd: "",
      count: s.count,
      edits: [],
      secretRedacted: true
    };
  });
  return { clean, redacted };
}
function signalsFile(home = handbookHome()) {
  return join3(home, "signals.jsonl");
}
function ledgerFingerprintCounts(home = handbookHome()) {
  const counts = /* @__PURE__ */ new Map();
  let raw;
  try {
    raw = readFileSync3(signalsFile(home), "utf8");
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
    if (signal.work) return signal;
    return { ...signal, kind: "candidate", promotedBy: "recurrence" };
  });
}
function appendSignals(signals, home = handbookHome()) {
  if (signals.length === 0) return;
  const { clean, redacted } = sanitizeSignalsForPersistence(signals);
  if (redacted > 0) incrementRedactionBlocked(home, redacted);
  mkdirSync3(home, { recursive: true });
  const lines = clean.map((s) => JSON.stringify(s)).join("\n") + "\n";
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
function workRecordFromState(state, sessionId, ts, cwd = "") {
  const activity = state.activity;
  if (!activity || activity.families.length === 0 || activity.exts.length === 0) return null;
  const families = [...activity.families].sort();
  const exts = [...activity.exts].sort();
  const fingerprint = createHash("sha256").update(`work:${families.join(",")}:${exts.join(",")}`).digest("hex").slice(0, 16);
  return {
    ts,
    sessionId,
    kind: "weak",
    fingerprint,
    family: "work",
    command: "",
    error: "",
    cwd,
    count: 1,
    edits: [],
    work: { families, exts }
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
  const work = workRecordFromState(state, sessionId, ts);
  if (work) signals.push(work);
  appendSignals(signals, home);
  deleteSessionState(sessionId, home);
  return signals;
}

// src/lib/pipeline.ts
function pendingDir(home = handbookHome()) {
  return join4(home, "pending");
}
function enqueuePendingSignals(signals, home = handbookHome()) {
  if (signals.length === 0) return null;
  const { clean } = sanitizeSignalsForPersistence(signals);
  mkdirSync4(pendingDir(home), { recursive: true });
  const session = signals[0].sessionId.replace(/[^A-Za-z0-9_-]/g, "_");
  const base = `${session}-${Date.now()}`;
  let file = join4(pendingDir(home), `${base}.json`);
  for (let i = 2; existsSync2(file); i++) {
    file = join4(pendingDir(home), `${base}-${i}.json`);
  }
  for (let i = 0; i < 50; i++) {
    try {
      writeFileSync3(file, JSON.stringify(clean), { flag: "wx" });
      return file;
    } catch {
      file = join4(pendingDir(home), `${base}-x${i}.json`);
    }
  }
  return null;
}
var STALE_CLAIM_MS = 10 * 60 * 1e3;
var LOG_ROTATE_BYTES = 512 * 1024;
function spawnPipelineRunner(runnerScript, spawnFn = spawn) {
  const child = spawnFn(process.execPath, [runnerScript], {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
}

// src/hooks/session-end.ts
async function main() {
  const input = parseHookInput(await readStdin());
  if (!input?.session_id) return;
  const signals = flushSessionEnd(input.session_id);
  const candidates = signals.filter((s) => s.kind === "candidate");
  if (candidates.length === 0) return;
  enqueuePendingSignals(candidates);
  spawnPipelineRunner(fileURLToPath(new URL("./run-pipeline.js", import.meta.url)));
}
main().then(
  () => process.exit(0),
  () => process.exit(0)
);
