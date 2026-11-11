import type { RunnerService } from "../server/runner-service.js";
import type { RunnerLink } from "./link.js";

/**
 * The link of the runner inside a local orchestrator: the same calls the runner routes make,
 * in the same process, so there is no address, token or signature to get wrong. The holder
 * names this runner's leases, and only the person's own tasks are leased to it.
 */
export function localLink(service: RunnerService, person: string, holder: string): RunnerLink {
  return {
    poll: (waitMs, canTake, signal) => service.poll(person, holder, waitMs, canTake, signal),
    renew: (taskId, leaseId) => service.renew(taskId, leaseId),
    events: (taskId, leaseId, events) => service.events(taskId, leaseId, events),
    request: (taskId, leaseId, request) => service.request(taskId, leaseId, request),
    progress: (taskId, leaseId, progress) => service.progress(taskId, leaseId, progress),
    followUpsDelivered: (taskId, leaseId, ids) => service.followUpsDelivered(taskId, leaseId, ids),
    finish: (taskId, leaseId, outcome) => service.finish(taskId, leaseId, outcome),
  };
}
