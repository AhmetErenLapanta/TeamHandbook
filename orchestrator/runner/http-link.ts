import { BATCH_BYTES, EVENTS_PER_BATCH, POLL_WAIT_MAX_MS, RUNNER_PATHS } from "../shared/runner-wire.js";
import { MACHINE_FEATURES } from "../server/runner-store.js";
import type { ForgeRequestAnswer, PollAnswer, ProtocolRefusal, RenewAnswer } from "../shared/runner-wire.js";
import type { NumberedEvent, RunnerLink } from "./link.js";
import { signedCall } from "./profile.js";
import type { Fetch, RunnerProfile } from "./profile.js";

/** The orchestrator no longer knows this machine: revoked in Settings, or its person removed. Polling again changes nothing. */
export class MachineRefused extends Error {}

/** One side runs an older protocol; the message says which to update. */
export class ProtocolMismatch extends Error {}

/** A task call whose lease the orchestrator no longer gives this machine. */
export class LeaseGone extends Error {}

/** A body the orchestrator refuses as it is: sending it again changes nothing. */
export class NotTaken extends Error {}

const PROTOCOL_ADVICE: Record<ProtocolRefusal["update"], string> = {
  runner: "this machine's handbook-orchestrator is older than the orchestrator; update it",
  orchestrator: "the orchestrator is older than this machine's handbook-orchestrator; ask its operator to update it",
};

async function refusal(response: Response): Promise<Error> {
  const body = (await response.json().catch(() => null)) as Partial<ProtocolRefusal> | null;
  if (response.status === 426) return new ProtocolMismatch(body?.update && PROTOCOL_ADVICE[body.update] ? PROTOCOL_ADVICE[body.update] : "the orchestrator and this machine speak different protocols");
  if (response.status === 401) return new MachineRefused("the orchestrator no longer takes this machine; connect it again from Settings");
  if (response.status === 404) return new LeaseGone("the orchestrator no longer gives this machine that task");
  if (response.status === 400) return new NotTaken(typeof body?.error === "string" ? body.error : "the orchestrator did not take what this machine sent");
  return new Error(typeof body?.error === "string" ? body.error : `the orchestrator answered ${response.status}`);
}

/** Splits a batch so each part stays inside the count and the size one call may carry; the numbers make a part sent twice harmless. */
export function batches(events: readonly NumberedEvent[]): NumberedEvent[][] {
  const parts: NumberedEvent[][] = [];
  let part: NumberedEvent[] = [];
  let bytes = 0;
  for (const event of events) {
    const size = Buffer.byteLength(JSON.stringify(event));
    if (part.length && (part.length >= EVENTS_PER_BATCH || bytes + size > BATCH_BYTES)) {
      parts.push(part);
      part = [];
      bytes = 0;
    }
    part.push(event);
    bytes += size;
  }
  if (part.length) parts.push(part);
  return parts;
}

/**
 * The link of a machine that reaches a team's or the cloud's orchestrator over HTTP: every call
 * signed with the machine's key, sent only to the address it was paired with, and never through a
 * redirect. A poll waits on the orchestrator for at most the wire's limit, so no proxy cuts it.
 */
export function httpLink(profile: RunnerProfile, fetchImpl: Fetch = fetch): RunnerLink {
  const call = async (path: string, body: unknown, signal?: AbortSignal): Promise<Response> => {
    const response = await signedCall(profile, "POST", path, body, fetchImpl, signal);
    if (!response.ok) throw await refusal(response);
    return response;
  };
  return {
    async poll(waitMs, canTake, signal) {
      try {
        const response = await call(RUNNER_PATHS.poll, { waitMs: Math.min(waitMs, POLL_WAIT_MAX_MS), canTake }, signal);
        return (await response.json()) as PollAnswer;
      } catch (error) {
        if (signal.aborted) return { lease: null, commands: [] };
        throw error;
      }
    },
    async renew(taskId, leaseId) {
      try {
        return ((await (await call(RUNNER_PATHS.renew(taskId), { leaseId })).json()) as RenewAnswer).held;
      } catch (error) {
        if (error instanceof LeaseGone) return false;
        throw error;
      }
    },
    async events(taskId, leaseId, events) {
      for (const part of batches(events)) await call(RUNNER_PATHS.events(taskId), { leaseId, events: part });
    },
    async request(taskId, leaseId, request) {
      await call(RUNNER_PATHS.agentRequest(taskId), { leaseId, request });
    },
    async progress(taskId, leaseId, progress) {
      await call(RUNNER_PATHS.progress(taskId), { leaseId, progress });
    },
    async attachment(taskId, leaseId, attachmentId) {
      return new Uint8Array(await (await call(RUNNER_PATHS.attachment(taskId, attachmentId), { leaseId })).arrayBuffer());
    },
    async followUpsDelivered(taskId, leaseId, ids) {
      await call(RUNNER_PATHS.followUpsDelivered(taskId), { leaseId, ids });
    },
    async finish(taskId, leaseId, outcome) {
      await call(RUNNER_PATHS.finish(taskId), { leaseId, outcome });
    },
    async status(agents, started) {
      await call(RUNNER_PATHS.status, { agents, features: [...MACHINE_FEATURES], ...(started ? { started: true } : {}) });
    },
    async folders(nonce, answer) {
      await call(RUNNER_PATHS.folders(nonce), { answer });
    },
    async undo(nonce, answer) {
      await call(RUNNER_PATHS.undo(nonce), { answer });
    },
    async lesson(nonce, answer) {
      await call(RUNNER_PATHS.lessons(nonce), { answer });
    },
    async checks(nonce, answer) {
      await call(RUNNER_PATHS.checks(nonce), { answer });
    },
    async lessonOp(nonce, answer) {
      await call(RUNNER_PATHS.lessonOps(nonce), { answer });
    },
    async push(nonce, answer) {
      await call(RUNNER_PATHS.pushes(nonce), { answer });
    },
    async forgeRequest(taskId, leaseId, opened) {
      // A request the orchestrator does not take answers 409 with why: that is a verdict, not a failed call.
      const response = await signedCall(profile, "POST", RUNNER_PATHS.forgeRequest(taskId), { leaseId, ...opened }, fetchImpl);
      if (response.ok || response.status === 409) return (await response.json()) as ForgeRequestAnswer;
      throw await refusal(response);
    },
  };
}
