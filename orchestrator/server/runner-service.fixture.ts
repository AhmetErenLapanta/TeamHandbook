import type { FollowUpRecord } from "./task-followups.js";
import type { RunnerServiceStore } from "./runner-service.js";
import type { LeasedTaskEnd, RunnerEventRow } from "./runner-store.js";
import type { TaskRequestRecord } from "./task-requests.js";
import type { TaskRecord } from "./tasks/types.js";

export const task = (id: string, createdBy: string): TaskRecord => ({ tenant: "acme", id, repoId: "payments-skills", team: "Payments", title: `Task ${id}`, description: "", issueUrl: null, issueKey: null, agent: "claude-code", status: "queued", createdBy, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, baseSha: null, tests: null, cost: { usd: null, inputTokens: null, outputTokens: null }, requestNumber: null, error: null });

/** The store's runner calls in memory, held to the same rule: a write under a lease the task no longer holds changes nothing. */
export function memoryStore() {
  const queued: TaskRecord[] = [];
  const leases = new Map<string, { leaseId: string; holder: string; until: number }>();
  const events = new Map<string, RunnerEventRow[]>();
  const requests: TaskRequestRecord[] = [];
  const ended: Record<string, LeasedTaskEnd> = {};
  const holds = (taskId: string, leaseId: string, now: number) => {
    const lease = leases.get(taskId);
    return !!lease && lease.leaseId === leaseId && lease.until > now;
  };
  const natives = new Map<string, string>();
  const contexts = new Map<string, number>();
  const patched: { taskId: string; patch: unknown }[] = [];
  const stops = new Set<string>();
  const logs = new Map<string, string[]>();
  const followUps: FollowUpRecord[] = [];
  const store: RunnerServiceStore = {
    async pendingFollowUps(_tenant, taskId) {
      return followUps.filter((f) => f.taskId === taskId && f.status === "pending");
    },
    async markFollowUpsDelivered(_tenant, ids, at) {
      const marked = followUps.filter((f) => ids.includes(f.id) && f.status === "pending");
      for (const f of marked) Object.assign(f, { status: "delivered", deliveredAt: at });
      return marked.length;
    },
    async appendTaskLog(_tenant, taskId, lines) {
      logs.set(taskId, [...(logs.get(taskId) ?? []), ...lines.map((line) => (typeof line === "string" ? line : line.text))]);
    },
    async claimLocalTask(_tenant, person, holder, leaseId, until) {
      const index = queued.findIndex((t) => t.createdBy === person);
      if (index < 0) return null;
      const [claimed] = queued.splice(index, 1);
      leases.set(claimed!.id, { leaseId, holder, until: Date.parse(until) });
      return { task: claimed!, nextEvent: (events.get(claimed!.id)?.length ?? 0) + 1 };
    },
    async renewLease(_tenant, taskId, leaseId, until, now) {
      if (!holds(taskId, leaseId, Date.parse(now))) return false;
      leases.get(taskId)!.until = Date.parse(until);
      return true;
    },
    async heldTasks(_tenant, holder, now) {
      return [...leases].filter(([, l]) => l.holder === holder && l.until > Date.parse(now)).map(([taskId, l]) => ({ taskId, leaseId: l.leaseId, stopRequested: stops.has(taskId) }));
    },
    async appendRunnerEvents(_tenant, taskId, leaseId, rows) {
      if (!holds(taskId, leaseId, Date.now())) return false;
      const kept = events.get(taskId) ?? [];
      for (const row of rows) if (!kept.some((k) => k.n === row.n)) kept.push(row);
      events.set(taskId, kept);
      return true;
    },
    async updateLeasedTask(_tenant, taskId, leaseId, patch) {
      if (!holds(taskId, leaseId, Date.now())) return false;
      patched.push({ taskId, patch });
      if (patch.nativeSession) natives.set(taskId, patch.nativeSession);
      return true;
    },
    async finishLeasedTask(_tenant, taskId, leaseId, end) {
      if (!holds(taskId, leaseId, Date.now())) return false;
      ended[taskId] = end;
      stops.delete(taskId);
      if (end.status !== "interrupted") natives.delete(taskId);
      else if (end.nativeSession) natives.set(taskId, end.nativeSession);
      leases.delete(taskId);
      return true;
    },
    async requestStop(_tenant, taskId) {
      if (!leases.has(taskId)) return false;
      stops.add(taskId);
      return true;
    },
    async taskLease(_tenant, taskId) {
      const lease = leases.get(taskId);
      return { runner: "local", claimedBy: lease?.holder ?? null, leaseId: lease?.leaseId ?? null, leaseUntil: lease ? new Date(lease.until).toISOString() : null, nativeSession: natives.get(taskId) ?? null, branch: null };
    },
    async updateTask(_tenant, taskId, patch) {
      patched.push({ taskId, patch });
    },
    async noteTaskContext(_tenant, taskId, tokens) {
      if (!contexts.has(taskId)) contexts.set(taskId, tokens);
    },
    async withdrawTaskRequest(_tenant, taskId, sourceKey) {
      const asked = requests.find((q) => q.taskId === taskId && q.sourceKey === sourceKey && q.status === "pending");
      if (!asked) return null;
      Object.assign(asked, { status: "withdrawn", responseCapability: "not_resumable" });
      return asked;
    },
    async recordTaskRequest(r) {
      const kept = requests.find((q) => q.taskId === r.taskId && q.sourceKey === r.sourceKey);
      if (kept) return { created: false, request: kept };
      const record: TaskRequestRecord = { ...r, status: "pending", responseCapability: "live", answer: null, answeredBy: null, answeredVia: null, answeredAt: null };
      requests.push(record);
      return { created: true, request: record };
    },
    async taskRequests(_tenant, taskId) {
      return requests.filter((q) => q.taskId === taskId);
    },
    async endTaskRequests(_tenant, taskId) {
      let n = 0;
      for (const q of requests) if (q.taskId === taskId && q.status === "pending") (q.status = "expired"), (q.responseCapability = "not_resumable"), n++;
      return n;
    },
  };
  return { store, queued, events, requests, ended, leases, natives, contexts, logs, followUps, patched };
}

