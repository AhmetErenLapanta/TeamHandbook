import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { detectSecret } from "../plugin.js";

/**
 * One run of an agent CLI as the orchestrator saw it, kept so a test plays it back through the real
 * adapter and runner without the CLI: the flags and prompt text the run had to be started with,
 * every line it printed, and its exit code. Only what the adapters read of a line is kept, so a
 * recording carries no session id, model name, working directory or anything else the CLI adds.
 */
export interface Transcript {
  agent: "claude-code" | "opencode" | "fake";
  /** The CLI's version the run was recorded with; the adapter's checked version has to match it. */
  cliVersion: string;
  /** `hand` for a transcript written from the CLI's documented output, `recorded` for one taken from a real run. */
  source: "hand" | "recorded";
  expect: { args: string[]; stdin: string[] };
  steps: Step[];
  exit: number;
}

/**
 * What the agent does, in order: print a line, read the client's next line on stdin (a two-way
 * run; it has to parse to this value), write or remove a file (a path inside the checkout,
 * relative to it), wait, or hold until a file exists, so a test that needs a running agent
 * releases it by writing that file instead of waiting on a clock.
 */
export type Step = { emit_inbound: unknown } | { stdin: unknown } | { write: { path: string; content: string } } | { remove: string } | { wait: number } | { until: string };

export class TranscriptRefused extends Error {}

/** The exit code of a replay whose start did not match what the transcript expects. */
export const REPLAY_MISMATCH = 97;

const PATH_FIELDS = ["command", "url", "query", "file_path", "path", "pattern"];

const pick = (from: unknown, keys: readonly string[]): Record<string, unknown> => {
  const source = from && typeof from === "object" ? (from as Record<string, unknown>) : {};
  return Object.fromEntries(keys.filter((k) => source[k] !== undefined).map((k) => [k, source[k]]));
};

function claudeFrame(frame: Record<string, unknown>): Record<string, unknown> {
  const kept = pick(frame, ["type", "subtype"]);
  if (frame.type === "assistant") {
    const content = (frame.message as { content?: unknown })?.content;
    kept.message = {
      content: Array.isArray(content)
        ? content.flatMap((part: Record<string, unknown>) => {
            if (part?.type === "text") return [pick(part, ["type", "text"])];
            if (part?.type === "tool_use") return [{ ...pick(part, ["type", "name"]), input: pick(part.input, PATH_FIELDS) }];
            return [];
          })
        : [],
    };
  }
  if (frame.type === "result") {
    Object.assign(kept, pick(frame, ["is_error", "num_turns", "result", "total_cost_usd"]));
    kept.usage = pick(frame.usage, ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"]);
    if (Array.isArray(frame.permission_denials)) {
      kept.permission_denials = frame.permission_denials.map((d: Record<string, unknown>) => ({ ...pick(d, ["tool_name"]), tool_input: pick(d?.tool_input, PATH_FIELDS) }));
    }
  }
  return kept;
}

function opencodeFrame(frame: Record<string, unknown>): Record<string, unknown> {
  const kept = pick(frame, ["type"]);
  const part = (frame.part ?? {}) as Record<string, unknown>;
  if (frame.type === "text") kept.part = pick(part, ["text"]);
  else if (frame.type === "tool_use") kept.part = pick(part, ["tool"]);
  else if (frame.type === "step_finish") kept.part = { ...pick(part, ["cost"]), tokens: pick(part.tokens, ["input", "output"]) };
  else if (frame.type === "error") kept.error = pick(frame.error, ["name", "message"]);
  else kept.part = {};
  return kept;
}

/** A printed line as a transcript keeps it: the fields its adapter reads of a JSON line, and a line that is not JSON as it was. */
export function keptLine(agent: Transcript["agent"], line: string): unknown {
  let frame: unknown;
  try {
    frame = JSON.parse(line);
  } catch {
    return line;
  }
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) return line;
  if (agent === "fake") return pick(frame, ["type", "text", "summary", "denied"]);
  return agent === "claude-code" ? claudeFrame(frame as Record<string, unknown>) : opencodeFrame(frame as Record<string, unknown>);
}

/** A step's path that leaves the checkout: absolute, or climbing out of it with `..`. */
function outsideCheckout(steps: readonly Step[]): string | null {
  for (const step of steps) {
    const path = "write" in step ? step.write.path : "remove" in step ? step.remove : null;
    if (path !== null && (isAbsolute(path) || normalize(path).split(/[\\/]/)[0] === "..")) return path;
  }
  return null;
}

const toLines = (t: Transcript): string =>
  [{ meta: { agent: t.agent, cliVersion: t.cliVersion, source: t.source } }, { expect_outbound: t.expect }, ...t.steps, { exit: t.exit }]
    .map((line) => JSON.stringify(line))
    .join("\n") + "\n";

/**
 * Writes a transcript, or refuses to: one that still names something of the machine it was
 * recorded on (a home or temp directory, the account name, a credential the run had) or holds
 * what looks like a secret is never put on disk. A transcript is a file that gets committed.
 */
export function writeTranscript(file: string, transcript: Transcript, traces: readonly string[]): void {
  const outside = outsideCheckout(transcript.steps);
  if (outside) throw new TranscriptRefused(`the transcript writes or removes ${JSON.stringify(outside)}, outside the checkout; it is not written`);
  const text = toLines(transcript);
  const leaked = traces.filter((t) => t.length >= 4 && text.includes(t));
  if (leaked.length) throw new TranscriptRefused(`the transcript names ${leaked.length} trace(s) of the machine or run it was recorded on; it is not written`);
  const secret = detectSecret(text);
  if (secret) throw new TranscriptRefused(`the transcript holds what looks like a ${secret}; it is not written`);
  writeFileSync(file, text);
}

export function readTranscript(file: string): Transcript {
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  const meta = lines.find((l) => l.meta)?.meta as Pick<Transcript, "agent" | "cliVersion" | "source">;
  const expect = lines.find((l) => l.expect_outbound)?.expect_outbound as Transcript["expect"];
  const exit = lines.find((l) => "exit" in l)?.exit as number;
  const steps = lines.filter((l) => !("meta" in l || "expect_outbound" in l || "exit" in l)) as Step[];
  const outside = outsideCheckout(steps);
  if (outside) throw new TranscriptRefused(`the transcript ${file} writes or removes ${JSON.stringify(outside)}, outside the checkout`);
  return { ...meta, expect, steps, exit };
}

/**
 * A program that stands in for an agent CLI by playing a transcript back: it checks that it was
 * started with every flag and given every prompt text the transcript expects, then takes its
 * steps and exits with the recorded code. The stand-in adapter runs it as its script. A start that does not match exits
 * REPLAY_MISMATCH naming what was missing, so a test sees the invocation changed.
 */
export function replayProgram(dir: string, transcriptFile: string, node: string = process.execPath): string {
  const program = join(dir, "replay-agent.mjs");
  writeFileSync(program, `#!${node}\nprocess.env.ORCHESTRATOR_REPLAY_TRANSCRIPT = ${JSON.stringify(transcriptFile)};\nawait import(${JSON.stringify(new URL("./replay-agent.mjs", import.meta.url).href)});\n`);
  chmodSync(program, 0o755);
  return program;
}
