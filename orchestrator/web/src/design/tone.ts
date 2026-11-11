export type Tone = "ok" | "warn" | "error" | "info" | "neutral";

/**
 * The one colour a state is said in, wherever it shows: amber when it waits on a person, blue
 * while an agent is at work, green when it ended as wanted, red when it failed, and grey when it
 * waits on nothing or was set aside. A badge takes its class from here, so two screens never
 * colour the same state two ways.
 */
const TONES: Record<string, Tone> = {
  "needs-review": "warn",
  "needs review": "warn",
  interrupted: "warn",
  "awaiting review": "warn",
  open: "warn",
  asks: "warn",
  running: "info",
  working: "info",
  tests: "info",
  request: "info",
  review: "warn",
  merged: "ok",
  kept: "ok",
  "changes kept": "ok",
  failed: "error",
  queued: "neutral",
  cancelled: "neutral",
  closed: "neutral",
  undone: "neutral",
  "changes undone": "neutral",
};

/** The tone of a state by its name; a name this table does not know is said in grey rather than guessed. */
export function toneOf(state: string): Tone {
  return TONES[state] ?? "neutral";
}
