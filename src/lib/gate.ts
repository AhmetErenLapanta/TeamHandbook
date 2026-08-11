import { handbookHome } from "./session-state.js";
import type { Signal } from "./signals.js";
import { signalSecret } from "./secrets.js";
import { incrementRedactionBlocked } from "./counters.js";

// The rule sieve for the MANUAL path (/handbook:learn). The user asked for this
// capture explicitly, so the detector's noise rules never applied here — only the
// two vetoes a human shouldn't have to make: a secret, and a case too large to
// distill. (The automatic path has its own sieves in harvest.ts.)

export interface GateConfig {
  maxErrorChars: number;
  maxCommandChars: number;
  maxEditCount: number;
  maxTaskChars: number;
}

export const defaultGateConfig: GateConfig = {
  maxErrorChars: 4000,
  maxCommandChars: 1000,
  maxEditCount: 10,
  maxTaskChars: 8000,
};

export type DropReason = "secret" | "oversized";

export interface SieveDecision {
  signal: Signal;
  pass: boolean;
  reason?: DropReason;
  // never holds candidate content: pattern name or field name only
  detail?: string;
}

function drop(signal: Signal, reason: DropReason, detail?: string): SieveDecision {
  return { signal, pass: false, reason, detail };
}

export function sieveSignal(signal: Signal, config: GateConfig = defaultGateConfig): SieveDecision {
  const secret = signalSecret(signal);
  if (secret) return drop(signal, "secret", secret);
  if (signal.error.length > config.maxErrorChars) return drop(signal, "oversized", "error");
  if (signal.command.length > config.maxCommandChars) return drop(signal, "oversized", "command");
  if (signal.edits.length > config.maxEditCount) return drop(signal, "oversized", "edits");
  if (signal.task) {
    const taskText = [signal.task.goal, ...signal.task.steps, signal.task.verification ?? ""].join("\n");
    if (taskText.length > config.maxTaskChars) return drop(signal, "oversized", "task");
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
  const decisions = signals.map((s) => sieveSignal(s, config));
  const secretDrops = decisions.filter((d) => d.reason === "secret").length;
  if (secretDrops > 0) incrementRedactionBlocked(home, secretDrops);
  return {
    passed: decisions.filter((d) => d.pass).map((d) => d.signal),
    dropped: decisions.filter((d) => !d.pass),
  };
}
