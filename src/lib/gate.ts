import { handbookHome } from "./session-state.js";
import { ledgerFingerprintCounts } from "./signals.js";
import type { Signal } from "./signals.js";
import { signalSecret } from "./secrets.js";
import { incrementRedactionBlocked } from "./counters.js";
import { loadMutedFingerprints } from "./queue.js";

export interface GateConfig {
  repeatThreshold: number;
  maxErrorChars: number;
  maxCommandChars: number;
  maxEditCount: number;
}

export const defaultGateConfig: GateConfig = {
  repeatThreshold: 2,
  maxErrorChars: 4000,
  maxCommandChars: 1000,
  maxEditCount: 10,
};

export type DropReason =
  | "not-candidate"
  | "secret"
  | "no-file-change"
  | "never-passed"
  | "below-repeat-threshold"
  | "oversized"
  | "muted";

export interface SieveDecision {
  signal: Signal;
  pass: boolean;
  reason?: DropReason;
  // never holds candidate content: pattern name, counter ratio, or field name only
  detail?: string;
}

function drop(signal: Signal, reason: DropReason, detail?: string): SieveDecision {
  return { signal, pass: false, reason, detail };
}

export function sieveSignal(
  signal: Signal,
  occurrences: number,
  config: GateConfig = defaultGateConfig,
  muted: Set<string> = new Set(),
): SieveDecision {
  if (signal.kind !== "candidate") return drop(signal, "not-candidate");
  const secret = signalSecret(signal);
  if (secret) return drop(signal, "secret", secret);
  // manual (T2) signals carry explicit user intent: the detector's noise sieves
  // (file-change requirement, repeat threshold, an earlier "don't suggest this
  // again") do not apply; the secret veto does
  if (signal.trigger !== "manual") {
    if (muted.has(signal.fingerprint)) return drop(signal, "muted");
    if (signal.edits.length === 0) return drop(signal, "no-file-change");
    // A recurring error that was never actually fixed (a promoted open error with
    // no resolving command) has no fix to teach — distilling it would invent one.
    if (!signal.resolvedCommand) return drop(signal, "never-passed");
    if (occurrences < config.repeatThreshold) {
      return drop(signal, "below-repeat-threshold", `${occurrences}/${config.repeatThreshold}`);
    }
  }
  if (signal.error.length > config.maxErrorChars) return drop(signal, "oversized", "error");
  if (signal.command.length > config.maxCommandChars) return drop(signal, "oversized", "command");
  if (signal.edits.length > config.maxEditCount) return drop(signal, "oversized", "edits");
  if (signal.task) {
    const taskText = [signal.task.goal, ...signal.task.steps, signal.task.verification ?? ""].join("\n");
    if (taskText.length > 8000) return drop(signal, "oversized", "task");
  }
  return { signal, pass: true };
}

export interface SieveResult {
  passed: Signal[];
  dropped: SieveDecision[];
}

export function runRuleSieves(
  signals: Signal[],
  home: string = handbookHome(),
  config: GateConfig = defaultGateConfig,
): SieveResult {
  const counts = ledgerFingerprintCounts(home);
  const muted = loadMutedFingerprints(home);
  const decisions = signals.map((s) => sieveSignal(s, counts.get(s.fingerprint) ?? 0, config, muted));
  const secretDrops = decisions.filter((d) => d.reason === "secret").length;
  if (secretDrops > 0) incrementRedactionBlocked(home, secretDrops);
  return {
    passed: decisions.filter((d) => d.pass).map((d) => d.signal),
    dropped: decisions.filter((d) => !d.pass),
  };
}
