import { isDeepStrictEqual } from "node:util";
import type { Transcript } from "../transcript.js";
import type { AgentTransport } from "./contract.js";

/** How long a replay waits at a `stdin` step for the session to write, as long as the process replay waits by default; a session that never answers fails instead of hanging. */
const STDIN_WAIT_MS = 10_000;

const parsed = (line: string): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    return line;
  }
};

/**
 * A recorded run played back in place of a process: each `emit_inbound` step is one stdout
 * line, a frame as its JSON and a plain line as it was, and each `stdin` step is the line the
 * session has to write at that point, compared as JSON. Lines arrive one event-loop turn
 * apart, as a process's do. Steps that change files or wait are the process replay's
 * (replay-agent.mjs); a transport has no checkout and skips them. Being killed stops the
 * playback and ends it with no exit code, as a signalled process ends. A transcript without
 * an exit code fails instead of being given one.
 */
export function replayTransport(script: Pick<Transcript, "steps" | "exit">): AgentTransport & { readonly killed: boolean; readonly ended: boolean; readonly written: readonly string[] } {
  let killed = false;
  let closed = false;
  let ended!: (code: number | null) => void;
  const exit = new Promise<number | null>((resolve) => (ended = resolve));
  const written: string[] = [];
  let listener: (() => void) | null = null;

  const hear = () => {
    const heard = listener;
    listener = null;
    heard?.();
  };

  async function nextWrite(read: number): Promise<string> {
    if (written.length <= read) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`the session wrote nothing where the transcript expects input ${read + 1}`)), STDIN_WAIT_MS);
        listener = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
    if (killed) throw new Error("killed while the transcript waited for input");
    return written[read]!;
  }

  async function* lines(): AsyncGenerator<string> {
    if (typeof script.exit !== "number") throw new Error("the transcript has no exit code");
    let read = 0;
    for (const step of script.steps) {
      if (killed) return;
      if ("stdin" in step) {
        const line = await nextWrite(read++);
        if (!isDeepStrictEqual(parsed(line), step.stdin)) throw new Error(`the session wrote ${line} where the transcript expects ${JSON.stringify(step.stdin)}`);
      } else if ("emit_inbound" in step) {
        await new Promise((resolve) => setImmediate(resolve));
        if (killed) return;
        yield typeof step.emit_inbound === "string" ? step.emit_inbound : JSON.stringify(step.emit_inbound);
      }
    }
    if (written.length > read) throw new Error(`the session wrote ${written.length - read} line(s) the transcript does not expect`);
    if (!killed) ended(script.exit);
  }

  return {
    lines: lines(),
    write(line) {
      written.push(line);
      hear();
    },
    end() {
      closed = true;
    },
    kill() {
      killed = true;
      ended(null);
      hear();
    },
    exit,
    get killed() {
      return killed;
    },
    get ended() {
      return closed;
    },
    get written() {
      return written;
    },
  };
}
