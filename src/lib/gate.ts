import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handbookHome } from "./session-state.js";
import { ledgerFingerprintCounts } from "./signals.js";
import type { Signal } from "./signals.js";
import { detectSecret } from "./secrets.js";

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
  | "below-repeat-threshold"
  | "oversized";

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
): SieveDecision {
  if (signal.kind !== "candidate") return drop(signal, "not-candidate");
  const secret = detectSecret(
    [signal.command, signal.error, signal.resolvedCommand ?? "", ...signal.edits].join("\n"),
  );
  if (secret) return drop(signal, "secret", secret);
  // manual (T2) signals carry explicit user intent: the detector's noise sieves
  // (file-change requirement, repeat threshold) do not apply; the secret veto does
  if (signal.trigger !== "manual") {
    if (signal.edits.length === 0) return drop(signal, "no-file-change");
    if (occurrences < config.repeatThreshold) {
      return drop(signal, "below-repeat-threshold", `${occurrences}/${config.repeatThreshold}`);
    }
  }
  if (signal.error.length > config.maxErrorChars) return drop(signal, "oversized", "error");
  if (signal.command.length > config.maxCommandChars) return drop(signal, "oversized", "command");
  if (signal.edits.length > config.maxEditCount) return drop(signal, "oversized", "edits");
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
  const decisions = signals.map((s) => sieveSignal(s, counts.get(s.fingerprint) ?? 0, config));
  const secretDrops = decisions.filter((d) => d.reason === "secret").length;
  if (secretDrops > 0) incrementRedactionBlocked(home, secretDrops);
  return {
    passed: decisions.filter((d) => d.pass).map((d) => d.signal),
    dropped: decisions.filter((d) => !d.pass),
  };
}

export interface Counters {
  redactionBlocked: number;
}

export function countersFile(home: string = handbookHome()): string {
  return join(home, "counters.json");
}

export function readCounters(home: string = handbookHome()): Counters {
  try {
    const parsed = JSON.parse(readFileSync(countersFile(home), "utf8"));
    return { redactionBlocked: Number(parsed?.redactionBlocked) || 0 };
  } catch {
    return { redactionBlocked: 0 };
  }
}

export function incrementRedactionBlocked(home: string = handbookHome(), by = 1): Counters {
  const counters = readCounters(home);
  counters.redactionBlocked += by;
  mkdirSync(home, { recursive: true });
  writeFileSync(countersFile(home), JSON.stringify(counters, null, 2));
  return counters;
}
