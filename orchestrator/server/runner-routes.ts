import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import { attachmentPath, contentDisposition, MAX_ATTACHMENT_BYTES } from "./attachments.js";
import type { Context } from "hono";
import type { OrchestratorContext } from "./app.js";
import type { OrchestratorEnv, Principal } from "./auth.js";
import { recordEvent } from "./events.js";
import { matchRunnerRequest } from "./forge/runner-request.js";
import { keepMachineChanges } from "./machine-changes.js";
import { checksAnswer, insideFolder, lessonAnswer, lessonOpAnswer, machineAnswer, machineAsksOf, pushAnswer, undoAnswer } from "./machine-folders.js";
import type { ChangedFile } from "./forge/request-diff.js";
import { SHADOW_MAX_FILES } from "./shadow-git.js";
import { runnerHolds, runnerOf } from "./machines.js";
import { localMode } from "./mode.js";
import { route } from "./route-scopes.js";
import type { RouteKey } from "./route-scopes.js";
import type { MachineAgentStatus, MachineRecord, RunnerEvent } from "./runner-store.js";
import { createRunnerService, NotHeld } from "./runner-service.js";
import type { RunnerService } from "./runner-service.js";
import { handedChecks, keepTaskRequest, openPushedRequest } from "./tasks/leased.js";
import { recordMachineVerification } from "./tasks/verify-machine.js";
import { OPTIONS_MAX, QUESTIONS_MAX } from "./tasks/adapters/contract.js";
import type { AgentFailure, AgentQuestion, AgentRequest, Decision, FailureClass, Refusal, RequestKind } from "./tasks/adapters/contract.js";
import { SECRET_NAME } from "./forge/project-git.js";
import { taskMask } from "./tasks/task-text.js";
import type { TaskCost, TestOutcome } from "./tasks/types.js";
import type { NumberedEvent, TaskOutcome, TaskProgress } from "../runner/link.js";
import { AGENTS_MAX, COMMAND_MAX, EVENTS_PER_BATCH, FOLDER_ENTRIES_MAX, OUTPUT_LINES_MAX, OUTPUT_LINE_MAX, PATCH_LINES_MAX, PLAN_TEXT_MAX, POLL_WAIT_MAX_MS, PROTOCOL_HEADER, RUNNER_PROTOCOL, TESTS_OUTPUT, TODOS_MAX, TODO_TEXT_MAX } from "../shared/runner-wire.js";
import type { ForgeRequestAnswer, ProtocolRefusal } from "../shared/runner-wire.js";

const OUTCOMES: readonly TaskOutcome["status"][] = ["needs-review", "failed", "interrupted"];

type Caller = { machine: MachineRecord; user: Principal; service: RunnerService; body: Record<string, unknown> };

const isText = (value: unknown, max = 200): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const textOrNull = (value: unknown) => value === null || typeof value === "string";

/**
 * Text from a person's machine is kept only as this orchestrator rebuilds it: the fields its kind
 * has and nothing else, every word masked with the task's secrets and every credential's shape,
 * as a run here writes its own. A name the record matches on, a branch, a session or a path, is
 * refused rather than masked when it holds what the mask would take out, since a masked name no
 * longer names what it did.
 */
type Mask = (text: string) => string;

const DECISIONS = new Set<Decision>(["allow-once", "allow-for-task", "deny"]);
const CALL_STATES = new Set(["started", "done", "failed", "refused"]);
const TODO_STATES = new Set(["todo", "doing", "done"]);
const REFUSAL_KINDS = new Set<string>(["tracker-write", "forge-write", "data-folder", "not-allowed"]);
const KINDS = new Set<RequestKind>(["command", "file-read", "file-change", "mcp", "permission", "question", "secret", "plan"]);
const FAILURES = new Set<FailureClass>(["usage_limit", "sign_in", "provider", "provider_retrying", "transport"]);
const isString = (value: unknown): value is string => typeof value === "string";
const amount = (value: unknown) => value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
/** A name kept as given: refused when the mask would change it. */
const exact = (value: unknown, mask: Mask, max = 200): value is string => isText(value, max) && mask(value) === value;

function costOf(raw: unknown): TaskCost | null {
  const c = raw as Partial<TaskCost> | null;
  return c && amount(c.usd) && amount(c.inputTokens) && amount(c.outputTokens) ? { usd: c.usd!, inputTokens: c.inputTokens!, outputTokens: c.outputTokens! } : null;
}

function failureOf(raw: unknown, mask: Mask): AgentFailure | null {
  const f = raw as Partial<AgentFailure> | null;
  if (!f || !FAILURES.has(f.class as FailureClass) || !isString(f.message) || typeof f.retryable !== "boolean") return null;
  if ((f.code !== undefined && !isText(f.code, 100)) || (f.resetAt !== undefined && !isText(f.resetAt, 40)) || (f.detail !== undefined && !isString(f.detail))) return null;
  return { class: f.class as FailureClass, message: mask(f.message), retryable: f.retryable, ...(f.code === undefined ? {} : { code: mask(f.code) }), ...(f.resetAt === undefined ? {} : { resetAt: f.resetAt }), ...(f.detail === undefined ? {} : { detail: mask(f.detail) }) };
}

const CHOICES = new Set(["one", "many", "text"]);

function questionsOf(raw: unknown, mask: Mask): AgentQuestion[] | null {
  if (!Array.isArray(raw) || !raw.length || raw.length > QUESTIONS_MAX) return null;
  const questions = raw.map((value): AgentQuestion | null => {
    const q = value as Partial<AgentQuestion> | null;
    if (!q || !exact(q.key, mask, 100) || !isText(q.title, 1000) || (q.description !== undefined && !isText(q.description, 4000)) || !CHOICES.has(q.choice as string) || (q.other !== undefined && typeof q.other !== "boolean")) return null;
    if (q.options !== undefined && (!Array.isArray(q.options) || q.options.length > OPTIONS_MAX)) return null;
    const options = (q.options ?? []).map((o) => (o && exact(o.value, mask, 200) && isText(o.label, 500) && (o.description === undefined || isText(o.description, 1000)) ? { value: o.value, label: mask(o.label), ...(o.description === undefined ? {} : { description: mask(o.description) }) } : null));
    if (options.some((o) => !o)) return null;
    return { key: q.key, title: mask(q.title), ...(q.description === undefined ? {} : { description: mask(q.description) }), choice: q.choice!, ...(q.options ? { options: options as NonNullable<AgentQuestion["options"]> } : {}), ...(q.other === undefined ? {} : { other: q.other }) };
  });
  return questions.every(Boolean) ? (questions as AgentQuestion[]) : null;
}

function requestOf(raw: unknown, mask: Mask): AgentRequest | null {
  const r = raw as Partial<AgentRequest> | null;
  if (!(r && exact(r.id, mask) && KINDS.has(r.kind as RequestKind) && isText(r.tool) && isString(r.summary) && r.summary.length <= 4000)) return null;
  const questions = r.questions === undefined ? undefined : questionsOf(r.questions, mask);
  if (questions === null) return null;
  if (r.plan !== undefined && (r.kind !== "plan" || !isText(r.plan, PLAN_TEXT_MAX))) return null;
  return { id: r.id, kind: r.kind as RequestKind, tool: mask(r.tool), summary: mask(r.summary), ...(questions ? { questions } : {}), ...(r.plan === undefined ? {} : { plan: r.plan.split("\n").map(mask).join("\n") }) };
}

/**
 * One event, rebuilt in the fields its kind has; null for a kind this orchestrator does not know,
 * which has no line to show. The one list of what an event may carry into the task's log, for a
 * machine's events and the orchestrator's own runs alike: a field it does not name is dropped.
 */
export function eventOf(raw: unknown, mask: Mask): RunnerEvent | null {
  const e = raw as Record<string, unknown> | null;
  if (!e || typeof e !== "object") return null;
  switch (e.type) {
    case "message":
    case "output":
    case "notice":
    case "log":
      return isString(e.text) ? { type: e.type, text: mask(e.text) } : null;
    case "steer":
      // A follow-up as it reached the agent, and who sent it: both masked, the sender an address at most.
      return isString(e.text) && isText(e.by, 320) ? { type: "steer", text: mask(e.text), by: mask(e.by) } : null;
    case "tool_call":
      if (!isText(e.tool) || !(e.target === null || isString(e.target)) || !CALL_STATES.has(e.status as string) || (e.id !== undefined && !exact(e.id, mask)) || (e.command !== undefined && !isString(e.command))) return null;
      // An MCP tool's server and tool, and why a call was refused: each a short text, masked, and left out when it does not read.
      const mcp = e.mcp as { server?: unknown; tool?: unknown } | undefined;
      const refusal = e.refusal as { kind?: unknown; reason?: unknown } | undefined;
      const named = mcp && isText(mcp.server, 200) && isText(mcp.tool, 200) ? { server: mask(mcp.server), tool: mask(mcp.tool) } : null;
      const refused = refusal && REFUSAL_KINDS.has(refusal.kind as string) && isText(refusal.reason, 500) ? { kind: refusal.kind as Refusal["kind"], reason: mask(refusal.reason) } : null;
      return {
        type: "tool_call",
        ...(e.id === undefined ? {} : { id: e.id as string }),
        tool: mask(e.tool),
        target: e.target === null ? null : mask(e.target),
        status: e.status as "started" | "done" | "failed" | "refused",
        ...(e.command === undefined ? {} : { command: mask(e.command as string).slice(0, COMMAND_MAX) }),
        ...(named ? { mcp: named } : {}),
        ...(refused ? { refusal: refused } : {}),
      };
    case "tool_output": {
      // Whole lines only, each masked: a secret split across two parts was joined before it got here.
      if (!exact(e.id, mask) || !Array.isArray(e.lines) || !e.lines.every(isString)) return null;
      // On a team's or the cloud's orchestrator an agent's own commands show as the call alone, as
      // what they print stays on the person's machine; the team's test command, whose output its team
      // reads anyway, keeps its lines.
      const kept = localMode() || e.id === TESTS_OUTPUT ? (e.lines as string[]).slice(-OUTPUT_LINES_MAX).map((line) => mask(line).slice(0, OUTPUT_LINE_MAX)) : [];
      return { type: "tool_output", id: e.id, lines: kept };
    }
    case "edit":
      if (!exact(e.id, mask) || !insideFolder(e.path) || !exact(e.path, mask, 4096) || !Number.isInteger(e.additions) || !Number.isInteger(e.deletions) || (e.additions as number) < 0 || (e.deletions as number) < 0 || (e.patch !== undefined && !isString(e.patch))) return null;
      // A credential file's edit shows by its path and size alone: its lines are what the mask is least sure to catch.
      return { type: "edit", id: e.id, path: e.path, additions: e.additions as number, deletions: e.deletions as number, ...(e.patch === undefined || SECRET_NAME.test(e.path) ? {} : { patch: mask((e.patch as string).split("\n").slice(0, PATCH_LINES_MAX).join("\n")) }) };
    case "todos": {
      if (!Array.isArray(e.items)) return null;
      const items = (e.items as Record<string, unknown>[]).slice(0, TODOS_MAX).map((i) => (i && isString(i.text) && TODO_STATES.has(i.state as string) ? { text: mask(i.text).slice(0, TODO_TEXT_MAX), state: i.state as "todo" | "doing" | "done" } : null));
      return items.every(Boolean) ? { type: "todos", items: items as { text: string; state: "todo" | "doing" | "done" }[] } : null;
    }
    case "request": {
      const request = requestOf(e.request, mask);
      return request ? { type: "request", request } : null;
    }
    case "request_resolved":
      return exact(e.requestId, mask) && DECISIONS.has(e.decision as Decision) ? { type: "request_resolved", requestId: e.requestId, decision: e.decision as Decision } : null;
    case "request_withdrawn":
      return exact(e.requestId, mask) ? { type: "request_withdrawn", requestId: e.requestId } : null;
    case "usage": {
      const cost = costOf(e.cost);
      return cost ? { type: "usage", cost } : null;
    }
    case "context":
      return Number.isInteger(e.tokens) && (e.tokens as number) >= 0 ? { type: "context", tokens: e.tokens as number } : null;
    case "spend":
      return typeof e.usd === "number" && Number.isFinite(e.usd) && e.usd >= 0 ? { type: "spend", usd: e.usd } : null;
    case "mcp_status":
      return Array.isArray(e.needsSignIn) && e.needsSignIn.length <= 50 && e.needsSignIn.every((name) => isText(name, 200)) ? { type: "mcp_status", needsSignIn: (e.needsSignIn as string[]).map(mask) } : null;
    case "turn_finished":
      return typeof e.ok === "boolean" && isString(e.summary) && (e.reason === null || isString(e.reason)) && (e.turns === null || Number.isInteger(e.turns))
        ? { type: "turn_finished", ok: e.ok, summary: mask(e.summary), reason: e.reason === null ? null : mask(e.reason), turns: e.turns as number | null }
        : null;
    case "error": {
      const failure = failureOf(e.failure, mask);
      return failure ? { type: "error", failure } : null;
    }
    case "limit":
      return isText(e.window, 100) && (e.status === "allowed" || e.status === "warning" || e.status === "refused") && (e.resetAt === undefined || isText(e.resetAt, 40))
        ? { type: "limit", window: mask(e.window), status: e.status, ...(e.resetAt === undefined ? {} : { resetAt: e.resetAt as string }) }
        : null;
    case "background":
      return Number.isInteger(e.pending) && (e.pending as number) >= 0 ? { type: "background", pending: e.pending as number } : null;
    case "terminal": {
      if ((e.status !== "completed" && e.status !== "interrupted" && e.status !== "failed") || !isString(e.summary) || (e.nativeSessionId !== undefined && !exact(e.nativeSessionId, mask))) return null;
      const failure = e.failure === undefined ? undefined : failureOf(e.failure, mask);
      if (failure === null) return null;
      return { type: "terminal", status: e.status, summary: mask(e.summary), ...(failure ? { failure } : {}), ...(e.nativeSessionId === undefined ? {} : { nativeSessionId: e.nativeSessionId as string }) };
    }
    default:
      return null;
  }
}

function eventsOf(raw: unknown, mask: Mask): NumberedEvent[] | null {
  if (!Array.isArray(raw) || raw.length > EVENTS_PER_BATCH) return null;
  const events: NumberedEvent[] = [];
  for (const item of raw as { n?: unknown; event?: unknown }[]) {
    if (!item || !Number.isInteger(item.n) || (item.n as number) < 1) return null;
    // An event that does not read is left out alone: refusing the batch would lose every event beside it.
    const event = eventOf(item.event, mask);
    if (event) events.push({ n: item.n as number, event });
  }
  return events;
}

const STAGES = new Set(["tests", "request"]);
const TESTS = new Set<TestOutcome>(["passed", "failed", "skipped"]);
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

function progressOf(raw: unknown, mask: Mask): TaskProgress | null {
  const p = raw as Record<string, unknown> | null;
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  if (p.stage !== undefined && !STAGES.has(p.stage as string)) return null;
  if (p.baseSha !== undefined && !(isString(p.baseSha) && SHA.test(p.baseSha))) return null;
  if (p.branch !== undefined && !exact(p.branch, mask, 255)) return null;
  if (p.tests !== undefined && !TESTS.has(p.tests as TestOutcome)) return null;
  if (p.nativeSession !== undefined && !exact(p.nativeSession, mask)) return null;
  const cost = p.cost === undefined ? undefined : costOf(p.cost);
  if (cost === null) return null;
  return {
    ...(p.stage === undefined ? {} : { stage: p.stage as TaskProgress["stage"] }),
    ...(p.baseSha === undefined ? {} : { baseSha: p.baseSha as string }),
    ...(p.branch === undefined ? {} : { branch: p.branch as string }),
    ...(p.tests === undefined ? {} : { tests: p.tests as TestOutcome }),
    ...(cost ? { cost } : {}),
    ...(p.nativeSession === undefined ? {} : { nativeSession: p.nativeSession as string }),
    ...(p.verification === undefined ? {} : { verification: p.verification as TaskProgress["verification"] }),
  };
}

const AGENT_FIELDS = ["id", "installed", "signIn", "supported", "version"].join(",");

/** A machine's agents, each in exactly the fields the row shows: an account's email or organization has no field to arrive in. */
function agentsOf(raw: unknown): MachineAgentStatus[] | null {
  if (!Array.isArray(raw) || raw.length > AGENTS_MAX) return null;
  for (const a of raw as Partial<MachineAgentStatus>[]) {
    if (!a || typeof a !== "object" || Object.keys(a).sort().join(",") !== AGENT_FIELDS) return null;
    if (!isText(a.id, 40) || typeof a.installed !== "boolean" || !(a.version === null || isText(a.version, 40))) return null;
    if (!["ok", "update"].includes(a.supported as string) || !["signed-in", "signed-out", "unknown"].includes(a.signIn as string)) return null;
  }
  return raw as MachineAgentStatus[];
}

function outcomeOf(raw: unknown, mask: Mask): TaskOutcome | null {
  const o = raw as Partial<TaskOutcome> | null;
  const named = (value: unknown) => value === null || exact(value, mask, 255);
  if (!o || !OUTCOMES.includes(o.status as TaskOutcome["status"]) || !textOrNull(o.error) || !named(o.nativeSessionId) || !named(o.branch)) return null;
  if (!(o.position === null || Number.isInteger(o.position))) return null;
  if (!(o.request === null || (o.request && typeof o.request.title === "string" && typeof o.request.body === "string"))) return null;
  const changes = o.changes === undefined || o.changes === null ? null : changesOf(o.changes, mask);
  if (changes === undefined) return null;
  const request = o.request ? { title: mask(o.request.title), body: mask(o.request.body) } : null;
  return { status: o.status!, error: o.error === null ? null : mask(o.error!), nativeSessionId: o.nativeSessionId!, branch: o.branch!, position: o.position!, request, ...(changes ? { changes } : {}) };
}

const SNAPSHOT = SHA;
const FILE_STATES = new Set(["added", "modified", "deleted", "renamed"]);
const count = (value: unknown) => value === null || (Number.isInteger(value) && (value as number) >= 0);

/** What a machine says a run in its folder changed, rebuilt from the fields a changed file has; undefined when any part is not one. */
function changesOf(raw: unknown, mask: Mask): NonNullable<TaskOutcome["changes"]> | undefined {
  const c = raw as { before?: unknown; after?: unknown; files?: unknown; undone?: unknown } | null;
  if (!c || typeof c.before !== "string" || typeof c.after !== "string" || !SNAPSHOT.test(c.before) || !SNAPSHOT.test(c.after) || !Array.isArray(c.files) || c.files.length > SHADOW_MAX_FILES) return undefined;
  const files: ChangedFile[] = [];
  for (const f of c.files as Record<string, unknown>[]) {
    if (!f || !insideFolder(f.path) || !exact(f.path, mask, 4096) || !FILE_STATES.has(f.status as string) || !(f.previousPath === null || (insideFolder(f.previousPath) && exact(f.previousPath, mask, 4096))) || !count(f.additions) || !count(f.deletions) || typeof f.binary !== "boolean" || typeof f.test !== "boolean") return undefined;
    files.push({ path: f.path, status: f.status as ChangedFile["status"], previousPath: f.previousPath as string | null, additions: f.additions as number | null, deletions: f.deletions as number | null, binary: f.binary, test: f.test });
  }
  // Set by a machine that took the change back itself, its policy having refused it.
  if (c.undone === undefined || c.undone === null) return { before: c.before, after: c.after, files };
  const kept = (c.undone as { kept?: unknown }).kept;
  if (!Array.isArray(kept) || kept.length > SHADOW_MAX_FILES || !kept.every((path) => insideFolder(path) && exact(path, mask, 4096))) return undefined;
  return { before: c.before, after: c.after, files, undone: { kept } };
}

/**
 * The calls a machine's runner makes for its person over HTTP, ending in the same runner service
 * a local orchestrator's own runner calls in process. Each call is checked in one order: the
 * protocol, then the machine's signature (runnerOf), then, for a task, the lease (runnerHolds).
 * A task the machine does not hold answers 404, as one that is not there.
 */
/**
 * An organization's runner service, the same in every mode: its own runner on a local
 * orchestrator and its people's machines on a team's or the cloud's call it. A machine is handed
 * the work the task runner describes for it, and the orchestrator opens the request from the
 * branch a runner pushed once that branch passes the checks its own runs' changes do: with the
 * person's own gh or glab where it has them, otherwise with the forge access the organization set
 * up here. The machine opens none itself. A run in a folder of the machine leaves its change
 * there, recorded here and held to the team's rules on which files an agent edits.
 */
export function organizationRunners(ctx: OrchestratorContext): RunnerService {
  return createRunnerService({
    tenant: ctx.tenant,
    store: ctx.store,
    describeWork: (taskId) => ctx.tasks!.describeWork(taskId),
    onSpend: (taskId, usd) => ctx.tasks!.holdSpend(taskId, usd),
    checks: {
      record: async (taskId, raw) => {
        const task = await ctx.store.getTask(ctx.tenant, taskId);
        return task ? recordMachineVerification(ctx, task, raw, await handedChecks(ctx.store, ctx.tenant, taskId)) : null;
      },
      handed: async (taskId) => (await handedChecks(ctx.store, ctx.tenant, taskId)) !== null,
    },
    onFinished: async (taskId, outcome) => {
      await keepMachineChanges(ctx, taskId, outcome);
      await openPushedRequest(ctx, taskId, outcome);
    },
  });
}

export function runnerRoutes(ctx: OrchestratorContext): Hono<OrchestratorEnv> {
  const app = new Hono<OrchestratorEnv>();
  const notFound = (c: Context<OrchestratorEnv>) => c.json({ error: "not found" }, 404);
  // The task's own secrets, read once per call it is held under: runnerHolds has found the task.
  const maskOf = async (taskId: string) => taskMask(ctx, (await ctx.store.getTask(ctx.tenant, taskId))!);

  async function caller(c: Context<OrchestratorEnv>): Promise<Caller | Response> {
    const theirs = Number(c.req.header(PROTOCOL_HEADER));
    if (theirs !== RUNNER_PROTOCOL) {
      const update = Number.isInteger(theirs) && theirs > RUNNER_PROTOCOL ? "orchestrator" : "runner";
      const refusal: ProtocolRefusal = { error: update === "runner" ? "this machine's handbook-orchestrator is older than the orchestrator; update it on this machine" : "the orchestrator is older than this machine's handbook-orchestrator; ask its operator to update it", update };
      return c.json(refusal, 426);
    }
    const service = ctx.runnerService;
    if (!service) return notFound(c);
    const raw = await c.req.raw.clone().text();
    const who = await runnerOf(c, ctx);
    if (who instanceof Response) return who;
    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return c.json({ error: "the body is not JSON" }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "the body is a JSON object" }, 400);
    return { ...who, service, body: body as Record<string, unknown> };
  }

  /** A call on one task: the lease named has to be this machine's hold on it now. */
  function onTask(pattern: Extract<RouteKey, `POST /api/runner/tasks/:id/${string}`>, work: (c: Context<OrchestratorEnv>, call: Caller, taskId: string, leaseId: string) => Promise<Response>) {
    route(app, pattern, async (c) => {
      const call = await caller(c);
      if (call instanceof Response) return call;
      const taskId = c.req.param("id")!;
      const leaseId = call.body.leaseId;
      if (!isText(leaseId) || !(await runnerHolds(ctx, call.machine, taskId, leaseId))) return notFound(c);
      try {
        return await work(c, call, taskId, leaseId);
      } catch (err) {
        if (err instanceof NotHeld) return notFound(c);
        throw err;
      }
    });
  }

  route(app, "POST /api/runner/poll", async (c) => {
    const call = await caller(c);
    if (call instanceof Response) return call;
    const waitMs = typeof call.body.waitMs === "number" && call.body.waitMs > 0 ? Math.min(call.body.waitMs, POLL_WAIT_MAX_MS) : 0;
    // A poll the runner gave up on, or one cut by this orchestrator stopping, takes no lease:
    // a task leased to a closed connection would wait out its lease and end interrupted unstarted.
    const signal = ctx.closing ? AbortSignal.any([c.req.raw.signal, ctx.closing]) : c.req.raw.signal;
    // A folder list or an undo asked of this machine cuts a waiting poll short, which then takes no
    // lease, and the asks ride its answer; one already waiting answers at once.
    const asks = machineAsksOf(ctx).polling(call.machine.id);
    try {
      const ready = asks.take();
      // Tasks record who started them by email, and a lease names the machine that holds it. A
      // machine away from the orchestrator is handed the work with the lease: it reads nothing here.
      const answer = await call.service.poll(call.user.email, call.machine.id, ready.folders.length || ready.undos.length || ready.lessons.length || ready.checks.length || ready.lessonOps.length || ready.pushes.length ? 0 : waitMs, call.body.canTake === true, AbortSignal.any([signal, asks.signal]), { work: true });
      const later = asks.take();
      const folders = [...ready.folders, ...later.folders];
      const undos = [...ready.undos, ...later.undos];
      const lessons = [...ready.lessons, ...later.lessons];
      const checks = [...ready.checks, ...later.checks];
      const lessonOps = [...ready.lessonOps, ...later.lessonOps];
      const pushes = [...ready.pushes, ...later.pushes];
      return c.json({ ...answer, ...(folders.length ? { folders } : {}), ...(undos.length ? { undos } : {}), ...(lessons.length ? { lessons } : {}), ...(checks.length ? { checks } : {}), ...(lessonOps.length ? { lessonOps } : {}), ...(pushes.length ? { pushes } : {}) });
    } finally {
      asks.end();
    }
  });

  route(app, "POST /api/runner/folders/:nonce", async (c) => {
    const call = await caller(c);
    if (call instanceof Response) return call;
    const answer = machineAnswer(call.body.answer);
    if (!machineAsksOf(ctx).answer(call.machine.id, "folders", c.req.param("nonce")!, answer ?? "invalid")) return notFound(c);
    if (!answer) return c.json({ error: `a folder list has at most ${FOLDER_ENTRIES_MAX} folders, each path from ~, and nothing else` }, 400);
    return c.body(null, 204);
  });

  route(app, "POST /api/runner/undos/:nonce", async (c) => {
    const call = await caller(c);
    if (call instanceof Response) return call;
    const answer = undoAnswer(call.body.answer);
    if (!machineAsksOf(ctx).answer(call.machine.id, "undos", c.req.param("nonce")!, answer ?? "invalid")) return notFound(c);
    if (!answer) return c.json({ error: "an undo answers with the paths undone and kept, each inside the folder, or why it was refused" }, 400);
    return c.body(null, 204);
  });

  route(app, "POST /api/runner/lessons/:nonce", async (c) => {
    const call = await caller(c);
    if (call instanceof Response) return call;
    const answer = lessonAnswer(call.body.answer);
    if (!machineAsksOf(ctx).answer(call.machine.id, "lessons", c.req.param("nonce")!, answer ?? "invalid")) return notFound(c);
    if (!answer) return c.json({ error: "a lesson answers with the name it was queued under, why it was left out, or why nothing was written" }, 400);
    return c.body(null, 204);
  });

  route(app, "POST /api/runner/checks/:nonce", async (c) => {
    const call = await caller(c);
    if (call instanceof Response) return call;
    const answer = checksAnswer(call.body.answer);
    if (!machineAsksOf(ctx).answer(call.machine.id, "checks", c.req.param("nonce")!, answer ?? "invalid")) return notFound(c);
    if (!answer) return c.json({ error: "a folder's checks answer with what its files name, or why the folder was not read" }, 400);
    return c.body(null, 204);
  });

  route(app, "POST /api/runner/lesson-ops/:nonce", async (c) => {
    const call = await caller(c);
    if (call instanceof Response) return call;
    const answer = lessonOpAnswer(call.body.answer);
    if (!machineAsksOf(ctx).answer(call.machine.id, "lessonOps", c.req.param("nonce")!, answer ?? "invalid")) return notFound(c);
    if (!answer) return c.json({ error: "a lesson's read or decision answers with the lesson, the decision, or why not" }, 400);
    return c.body(null, 204);
  });

  route(app, "POST /api/runner/pushes/:nonce", async (c) => {
    const call = await caller(c);
    if (call instanceof Response) return call;
    const answer = pushAnswer(call.body.answer);
    if (!machineAsksOf(ctx).answer(call.machine.id, "pushes", c.req.param("nonce")!, answer ?? "invalid")) return notFound(c);
    if (!answer) return c.json({ error: "a push answers that the branch was pushed, or why not" }, 400);
    return c.body(null, 204);
  });

  route(app, "POST /api/runner/status", async (c) => {
    const call = await caller(c);
    if (call instanceof Response) return call;
    const agents = agentsOf(call.body.agents);
    if (!agents) return c.json({ error: `a machine reports at most ${AGENTS_MAX} agents, each with its id, whether it is installed, its version, whether it is supported and its sign-in, and nothing else` }, 400);
    await ctx.store.touchMachine(ctx.tenant, call.machine.id, new Date().toISOString(), agents);
    if (call.body.started === true) await ctx.tasks?.autoContinue(call.machine.id);
    return c.body(null, 204);
  });

  onTask("POST /api/runner/tasks/:id/renew", async (c, call, taskId, leaseId) => c.json({ held: await call.service.renew(taskId, leaseId) }));

  onTask("POST /api/runner/tasks/:id/events", async (c, call, taskId, leaseId) => {
    const events = eventsOf(call.body.events, await maskOf(taskId));
    if (!events) return c.json({ error: `events are at most ${EVENTS_PER_BATCH}, each numbered from 1` }, 400);
    await call.service.events(taskId, leaseId, events);
    return c.body(null, 204);
  });

  onTask("POST /api/runner/tasks/:id/requests", async (c, call, taskId, leaseId) => {
    const request = requestOf(call.body.request, await maskOf(taskId));
    if (!request) return c.json({ error: "a request names its id, kind, tool and summary" }, 400);
    await call.service.request(taskId, leaseId, request);
    return c.body(null, 204);
  });

  onTask("POST /api/runner/tasks/:id/attachments/:att", async (c, _call, taskId) => {
    const attachment = await ctx.store.getAttachment(ctx.tenant, c.req.param("att") ?? "");
    if (!attachment || attachment.taskId !== taskId || attachment.size > MAX_ATTACHMENT_BYTES) return notFound(c);
    const bytes = await readFile(attachmentPath(ctx.dataDir, ctx.tenant, attachment.id)).catch(() => null);
    if (!bytes || bytes.length !== attachment.size || createHash("sha256").update(bytes).digest("hex") !== attachment.sha256) return notFound(c);
    return c.body(new Uint8Array(bytes), 200, { "content-type": attachment.mime, "x-content-type-options": "nosniff", "content-disposition": contentDisposition(attachment.name), "cache-control": "no-store" });
  });

  onTask("POST /api/runner/tasks/:id/follow-ups", async (c, call, taskId, leaseId) => {
    const ids = call.body.ids;
    if (!Array.isArray(ids) || ids.length > 100 || !ids.every((id) => typeof id === "string" && id.length <= 64)) return c.json({ error: "ids are the follow-ups' own ids, at most 100" }, 400);
    await call.service.followUpsDelivered(taskId, leaseId, ids);
    return c.body(null, 204);
  });

  onTask("POST /api/runner/tasks/:id/progress", async (c, call, taskId, leaseId) => {
    const progress = progressOf(call.body.progress, await maskOf(taskId));
    if (!progress) return c.json({ error: "progress names its stage, base, branch, tests, cost and session, each in its own shape" }, 400);
    await call.service.progress(taskId, leaseId, progress);
    return c.body(null, 204);
  });

  onTask("POST /api/runner/tasks/:id/request", async (c, call, taskId, leaseId) => {
    const { number, url, headSha } = call.body;
    if (!Number.isInteger(number) || !isText(url, 2000) || typeof headSha !== "string" || !/^[0-9a-f]{40}$/.test(headSha)) return c.json({ error: "a request is reported with its number, address and head commit" }, 400);
    const task = await ctx.store.getTask(ctx.tenant, taskId);
    const repo = task ? await ctx.store.getRepo(ctx.tenant, task.repoId) : null;
    const branch = (await ctx.store.taskLease(ctx.tenant, taskId))?.branch;
    if (!task || !repo) return notFound(c);
    if (!branch) return c.json({ ok: false, reason: "the task has no branch yet; report the request after the push" } satisfies ForgeRequestAnswer, 409);
    const match = await matchRunnerRequest(ctx, { repo, branch, starterEmail: task.createdBy, headSha, held: () => runnerHolds(ctx, call.machine, taskId, leaseId) }, number as number);
    if (match.ok) {
      const kept = await keepTaskRequest(ctx, task, repo, call.user, { ...match.request, branch }, task.title, `opened by ${call.machine.name} with its person's own forge sign-in`);
      return c.json({ ok: true, number: kept.number, url: kept.url } satisfies ForgeRequestAnswer);
    }
    if (match.unverified) {
      // The forge was not read: the request is shown as the runner reported it, and the task does not move to review on that alone.
      await ctx.store.appendTaskLog(ctx.tenant, taskId, [`${call.machine.name} opened request #${number} at ${url}; not verified, since ${match.reason}.`]);
      await recordEvent(ctx, call.user, "request.unverified", { repoId: repo.id, subject: `request:${number}`, detail: `reported by ${call.machine.name} for ${branch}, not verified: ${match.reason}` });
      return c.json({ ok: false, unverified: true, reason: match.reason } satisfies ForgeRequestAnswer);
    }
    return c.json({ ok: false, reason: match.reason } satisfies ForgeRequestAnswer, 409);
  });

  onTask("POST /api/runner/tasks/:id/finish", async (c, call, taskId, leaseId) => {
    const outcome = outcomeOf(call.body.outcome, await maskOf(taskId));
    if (!outcome) return c.json({ error: "an outcome names its status, error, session, branch, position and request" }, 400);
    await call.service.finish(taskId, leaseId, outcome);
    return c.body(null, 204);
  });

  return app;
}
