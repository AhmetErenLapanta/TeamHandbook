import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handbookHome } from "./session-state.js";
import { writeFileAtomic } from "./fs-atomic.js";

// Activity counters double as a health check: if `postToolUse` climbs but
// `bashFailuresCaptured` stays at 0, the detector is seeing tool calls but not
// recognizing failures — a five-second diagnosis instead of a three-day one.
export interface Counters {
  redactionBlocked: number;
  postToolUse: number;
  bashFailuresCaptured: number;
  pairsResolved: number;
  // pipeline runs that hit a gate/distill error (e.g. logged-out claude) — drives
  // the "N gate runs failed" failure-push at session start
  gateErrors: number;
  // captured pairs given up on after MAX_GATE_ATTEMPTS failed gate runs — surfaced
  // in status/doctor so the loss is never silent (originals kept in abandoned.jsonl)
  gateAbandoned: number;
}

const FIELDS: Array<keyof Counters> = [
  "redactionBlocked",
  "postToolUse",
  "bashFailuresCaptured",
  "pairsResolved",
  "gateErrors",
  "gateAbandoned",
];

export function countersFile(home: string = handbookHome()): string {
  return join(home, "counters.json");
}

export function readCounters(home: string = handbookHome()): Counters {
  const base: Counters = {
    redactionBlocked: 0,
    postToolUse: 0,
    bashFailuresCaptured: 0,
    pairsResolved: 0,
    gateErrors: 0,
    gateAbandoned: 0,
  };
  try {
    const parsed = JSON.parse(readFileSync(countersFile(home), "utf8"));
    for (const f of FIELDS) base[f] = Number(parsed?.[f]) || 0;
  } catch {
    // no counters yet
  }
  return base;
}

export function bumpCounter(field: keyof Counters, home: string = handbookHome(), by = 1): Counters {
  const counters = readCounters(home);
  counters[field] += by;
  mkdirSync(home, { recursive: true });
  writeFileAtomic(countersFile(home), JSON.stringify(counters, null, 2));
  return counters;
}

export function incrementRedactionBlocked(home: string = handbookHome(), by = 1): Counters {
  return bumpCounter("redactionBlocked", home, by);
}

// Dump raw hook payloads to ~/.teamhandbook/debug for schema diagnosis. OPT-IN only:
// raw payloads can contain secrets (a failing `curl` with a token), so this never
// runs unless the user explicitly sets TEAMHANDBOOK_DEBUG — the default health signal
// is the counters above, which carry no content. Capped and best-effort.
const DEBUG_DUMP_CAP = 50;

export function maybeDumpPayload(raw: string, home: string = handbookHome()): void {
  if (!process.env.TEAMHANDBOOK_DEBUG) return;
  try {
    const dir = join(home, "debug");
    mkdirSync(dir, { recursive: true });
    const n = readdirSync(dir).length;
    if (n >= DEBUG_DUMP_CAP) return;
    writeFileSync(join(dir, `payload-${String(n).padStart(4, "0")}-${process.pid}.json`), raw, { flag: "wx" });
  } catch {
    // diagnostics only; ignore races and IO errors
  }
}
