import type { AgentCodec, AgentDecoder, AgentEvent, AgentSession, AgentTransport, Decision } from "./contract.js";

/**
 * A session over a process the runner started. Every stdout line goes to `frames`, the
 * diagnostics sink, before it is decoded; the sink is a persistence boundary, so the runner
 * masks what it writes there. With a codec the session is two-way: a message, an answer and
 * an interrupt go to the agent as stdin lines. With a decoder alone it runs one turn on the
 * prompt it was started with, and interrupting it ends the process.
 */
export function openSession(codec: AgentDecoder | AgentCodec, transport: AgentTransport, { frames = () => {}, steer = false }: { frames?: (line: string) => void; steer?: boolean } = {}): AgentSession {
  const twoWay = "answer" in codec ? codec : null;
  const queue: AgentEvent[] = [];
  const waiting = new Set<string>();
  const granted = new Set<string>();
  let wake: (() => void) | null = null;
  let done = false;
  let broken: unknown = null;
  let interrupted = false;
  let busy = false;

  const rouse = () => {
    const woken = wake;
    wake = null;
    woken?.();
  };
  const push = (event: AgentEvent) => {
    queue.push(event);
    rouse();
  };

  const answer = (requestId: string, decision: Decision, note?: string) => {
    const line = twoWay?.answer(requestId, decision, note);
    if (!line) throw new Error("no request of this agent's is waiting for that decision");
    transport.write(line);
  };

  void (async () => {
    try {
      for await (const line of transport.lines) {
        frames(line);
        for (const event of codec.decode(line)) {
          push(event);
          if (event.type === "turn_finished") busy = false;
          if (event.type === "request_withdrawn") waiting.delete(event.requestId);
          if (event.type !== "request") continue;
          const key = twoWay?.grantKey(event.request.id);
          if (key && granted.has(key)) {
            answer(event.request.id, "allow-once");
            push({ type: "request_resolved", requestId: event.request.id, decision: "allow-for-task" });
          } else waiting.add(event.request.id);
        }
        for (const refusal of twoWay?.pending() ?? []) transport.write(refusal);
      }
      const terminal = codec.finish(await transport.exit);
      push(interrupted && terminal.status === "failed" ? { ...terminal, status: "interrupted" } : terminal);
    } catch (error) {
      broken = error;
    } finally {
      done = true;
      rouse();
    }
  })();

  async function* events(): AsyncGenerator<AgentEvent> {
    for (;;) {
      if (queue.length) yield queue.shift()!;
      else if (done) {
        if (broken) throw broken;
        return;
      } else await new Promise<void>((resolve) => (wake = resolve));
    }
  }

  return {
    events: events(),
    sendTurn(text) {
      if (!twoWay) throw new Error("this agent takes no message while it runs");
      if (busy && !steer) throw new Error("the agent is in a turn and takes the next message when it is done");
      transport.write(twoWay.turn(text));
      busy = true;
    },
    interrupt() {
      interrupted = true;
      if (twoWay) transport.write(twoWay.interrupt());
      else transport.kill();
    },
    reply(requestId, answers) {
      if (!waiting.has(requestId)) throw new Error("no question of this agent's is waiting for an answer");
      const line = twoWay?.reply?.(requestId, answers);
      if (!line) throw new Error("no question of this agent's is waiting for an answer");
      transport.write(line);
      waiting.delete(requestId);
    },
    approvePlan(requestId, plan) {
      if (!waiting.has(requestId)) throw new Error("no plan of this agent's is waiting for approval");
      const line = twoWay?.approvePlan?.(requestId, plan);
      if (!line) throw new Error("no plan of this agent's is waiting for approval");
      transport.write(line);
      waiting.delete(requestId);
      push({ type: "request_resolved", requestId, decision: "allow-once" });
    },
    respond(requestId, decision, note) {
      if (!twoWay) throw new Error("this agent asks for no decision");
      if (!waiting.has(requestId)) throw new Error("no request of this agent's is waiting for that decision");
      const key = twoWay.grantKey(requestId);
      answer(requestId, decision, decision === "deny" ? note : undefined);
      waiting.delete(requestId);
      // A grant nobody can tell apart from another call is not kept: the next one asks again.
      if (decision === "allow-for-task" && key) granted.add(key);
      push({ type: "request_resolved", requestId, decision });
    },
    close() {
      transport.end();
    },
    stop() {
      transport.end();
      transport.kill();
    },
  };
}
