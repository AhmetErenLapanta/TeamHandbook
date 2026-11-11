import type { AgentTransport } from "./adapters/contract.js";
import { startProcess } from "./isolation.js";
import type { Invocation, RunOptions, RunOutcome } from "./isolation.js";

/**
 * An agent process a session talks to: its stdout read a line at a time, its stdin open for the
 * session's messages and answers until the session ends it. The process runs as every other
 * does (`startProcess`): a group of its own, ended on timeout or cancel. `onLine` still sees
 * every line, stdout's included, for the log and its budget; `lines` is the session's copy.
 */
export function processTransport(inv: Invocation, options: RunOptions): AgentTransport & { outcome: Promise<RunOutcome> } {
  const read: string[] = [];
  let ended = false;
  let wake: (() => void) | null = null;
  const rouse = () => {
    const woken = wake;
    wake = null;
    woken?.();
  };
  const started = startProcess(inv, {
    ...options,
    onLine: (stream, line) => {
      options.onLine(stream, line);
      if (stream !== "stdout") return;
      read.push(line);
      rouse();
    },
  });
  const outcome = started.outcome.finally(() => {
    ended = true;
    rouse();
  });
  if (inv.stdin) started.write(inv.stdin);

  async function* lines(): AsyncGenerator<string> {
    for (;;) {
      if (read.length) yield read.shift()!;
      else if (ended) return;
      else await new Promise<void>((resolve) => (wake = resolve));
    }
  }

  return {
    lines: lines(),
    write: (line) => started.write(`${line}\n`),
    end: () => started.end(),
    kill: () => started.kill(),
    exit: outcome.then((o) => o.code),
    outcome,
  };
}
