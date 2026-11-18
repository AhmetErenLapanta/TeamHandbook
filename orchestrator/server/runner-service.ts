import { EventEmitter } from "node:events";
import { plainFailure } from "./tasks/plain-failure.js";
import { startedWithOf, readOff, SOURCE_ID, UNKNOWN_SOURCE } from "./tasks/handbook-use.js";
import type { AgentEvent, AgentRequest, Decision } from "./tasks/adapters/contract.js";
import { calledSkill } from "./skill-rules.js";
import { agentTimeMs, PLAN_DECLINED } from "./task-requests.js";
import type { TaskDecision, TaskRequestKind, TaskRequestStore } from "./task-requests.js";
import type { TaskStore, TestOutcome } from "./tasks/types.js";
import { LAST_SAID_MAX } from "./tasks/types.js";
import type { FollowUpStore } from "./task-followups.js";
import type { LeasedTaskEnd, MachineFeature, RunnerEvent, RunnerStore } from "./runner-store.js";
import type { MachineMcpServer } from "../runner/machine-mcp.js";
import type { Lease, NumberedEvent, RemoteWork, RunnerCommand, TaskOutcome, TaskProgress } from "../runner/link.js";
import { newId } from "./ids.js";
import { resetAtFromTime } from "./tasks/adapters/failure.js";
import { detectSecret, POLICY_ACTIONS } from "./plugin.js";

/** The orchestrator's hold on a task leased to a runner: given up after this long without a renewal. */
export const LEASE_MS = 90_000;
/** How often a waiting poll looks at the store again, for a change another process made. */
export const POLL_TICK_MS = 1_000;

/**
 * The store a runner's calls rest on. Every write names the lease and changes nothing when the
 * lease is no longer the one the task holds, so a runner that lost its task cannot write to it.
 */
export type RunnerServiceStore = Pick<RunnerStore, "claimLocalTask" | "renewLease" | "heldTasks" | "appendRunnerEvents" | "updateLeasedTask" | "finishLeasedTask" | "taskLease" | "requestStop"> &
  Pick<TaskRequestStore, "recordTaskRequest" | "taskRequests" | "endTaskRequests" | "withdrawTaskRequest"> &
  Pick<TaskStore, "appendTaskLog" | "noteTaskContext" | "noteTaskContextUsed" | "noteUsedSkill" | "noteTaskUse" | "updateTask"> &
  Pick<FollowUpStore, "pendingFollowUps" | "markFollowUpsDelivered">;

/**
 * A description fit to leave the orchestrator, or a refusal: the clone address is https or ssh and
 * carries no password or token, since a forge token put there would reach the person's machine and
 * its shell history; MCP tools travel by name only. Checked here whoever described the task.
 */
export function checkedWork<W extends RemoteWork>(work: W): W {
  const fromHome = (path: string) => /^~(\/[^/\u0000]+)*$/.test(path) && !path.split("/").some((part) => part === "." || part === "..");
  if ("folder" in work) {
    // Named from the machine's home and nothing else, so no lease points a machine at a path it would read as given; the machine holds it to its own folder rule again.
    if (!fromHome(work.folder.path)) throw new Error("its folder is not named from the machine's home");
  } else if ("workspace" in work) {
    if (!fromHome(work.workspace.path)) throw new Error("its work folder is not named from the machine's home");
  } else {
    let url: URL;
    try {
      url = new URL(work.repo.url);
    } catch {
      throw new Error("its repository address is not one a machine can clone");
    }
    // file:// names a path on the person's machine and ext:: has git run a command: only https, or ssh to the forge.
    if (url.protocol !== "https:" && url.protocol !== "ssh:") throw new Error("its repository address is neither https nor ssh, the only ways a machine clones");
    // An ssh address names the forge's account (git@); an https user part is where a token is put.
    if (url.password || (url.protocol === "https:" && url.username)) throw new Error("its repository address carries a credential, which no machine is handed");
    if (work.continues && (work.continues.branch !== work.branch || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(work.continues.head))) throw new Error("it goes on from a request whose branch or head a machine cannot take");
  }
  if (work.attachments !== undefined && !(Array.isArray(work.attachments) && work.attachments.length <= 20 && work.attachments.every((a) => typeof a.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(a.id) && typeof a.name === "string" && a.name.length > 0 && a.name.length <= 200 && !/[/\\\u0000]/.test(a.name) && a.name !== "." && a.name !== ".." && ["image", "pdf", "text"].includes(a.kind)))) throw new Error("its attachments are not ones a machine fetches");
  if (!Array.isArray(work.rules) || !work.rules.every((r) => (POLICY_ACTIONS as readonly string[]).includes(r.action) && r.effect === "deny" && typeof r.resource === "string" && typeof r.reason === "string")) throw new Error("its team's policies are not ones a machine holds a change to");
  const tools = work.setup.mcpTools.map(({ server, tool }) => ({ server, tool }));
  const plugin = work.setup.plugin && { name: work.setup.plugin.name, version: work.setup.plugin.version };
  const servers = work.setup.mcpServers ? checkedServers(work.setup.mcpServers) : null;
  const off = readOff(work.setup.off);
  return { ...work, setup: { plugin, mcpTools: tools, deniedTools: work.setup.deniedTools.filter((t): t is string => typeof t === "string"), ownSetup: work.setup.ownSetup === true, folderSettings: work.setup.folderSettings === true, ...(servers ? { mcpServers: servers } : {}), ...(off && !("error" in off) ? { off } : {}) } };
}

const strings = (value: unknown): value is Record<string, string> => !!value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every((v) => typeof v === "string");

/**
 * The project's servers as a machine is handed them: their shape alone, and every value a template
 * of variable names and plain text. A value that looks like a secret is the organization's and stays
 * here, whoever put it in the description, so the lease is refused naming the server, never the value.
 */
function checkedServers(servers: Record<string, MachineMcpServer>): Record<string, MachineMcpServer> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => {
      const values = server.type === "stdio" ? server.env : server.type === "http" || server.type === "sse" ? server.headers : null;
      if (!strings(values)) throw new Error(`its MCP server ${name} is not one a machine is handed`);
      if (Object.values(values).some((value) => detectSecret(value.replace(/\$\{[A-Z_][A-Z0-9_]*\}/g, "")))) throw new Error(`its MCP server ${name} carries a value of its own, which no machine is handed`);
      if (server.type === "stdio") {
        if (typeof server.command !== "string" || !Array.isArray(server.args) || !server.args.every((a) => typeof a === "string")) throw new Error(`its MCP server ${name} is not one a machine is handed`);
        return [name, { type: "stdio", command: server.command, args: [...server.args], env: { ...server.env } }];
      }
      if (typeof server.url !== "string") throw new Error(`its MCP server ${name} is not one a machine is handed`);
      return [name, { type: server.type, url: server.url, headers: { ...server.headers } }];
    }),
  );
}

/** Thrown for a call on a task the runner does not hold; routes answer it 404, so an id reveals nothing. */
export class NotHeld extends Error {
  constructor() {
    super("not found");
  }
}

const sourceOf = (event: { source?: string; sourceLabel?: string }) => (event.source && event.sourceLabel && SOURCE_ID.test(event.source) ? { source: event.source, sourceLabel: event.sourceLabel } : UNKNOWN_SOURCE);

const DECISIONS: Record<TaskDecision, Decision> = { allow_once: "allow-once", allow_for_task: "allow-for-task", deny: "deny" };

/** The line a runner event leaves in the task's log. */
export function eventText(event: RunnerEvent): string {
  switch (event.type) {
    case "message":
    case "output":
    case "notice":
    case "log":
      return event.text;
    case "steer":
      return `${event.by}: ${event.text}`;
    case "tool_call":
      return `${event.status === "refused" ? "refused " : event.status === "failed" ? "failed " : ""}tool ${event.tool}${event.target ? ` ${event.target}` : ""}${event.status === "done" ? " done" : ""}`;
    case "tool_output":
      return event.lines.join("\n");
    case "edit":
      return `edited ${event.path} (+${event.additions} -${event.deletions})`;
    case "todos":
      return `to do: ${event.items.filter((i) => i.state === "done").length} of ${event.items.length} done`;
    case "context":
      return `context at the start: ${event.tokens} tokens`;
    case "mcp_status":
      return `MCP servers waiting for a sign-in: ${event.needsSignIn.join(", ")}`;
    case "context_parts":
      return "the agent counted what its setup takes of the context";
    case "loaded":
      return "the agent's setup was read";
    case "context_used":
      return `context in use: ${event.tokens} tokens${event.window ? ` of ${event.window}` : ""}`;
    case "spend":
      return `estimated cost of this turn so far: $${event.usd.toFixed(4)}`;
    case "request":
      return `asks: ${event.request.tool} ${event.request.summary}`;
    case "request_resolved":
      return `answered: ${event.decision}`;
    case "request_withdrawn":
      return "the agent took its question back";
    case "usage":
      return "usage reported";
    case "turn_finished":
      return `agent finished a turn${event.summary ? `: ${event.summary}` : ""}`;
    case "error":
      return event.failure.message;
    case "limit":
      return `plan limit ${event.window}: ${event.status}${event.resetAt ? `, resets ${event.resetAt}` : ""}`;
    case "background":
      return event.pending ? `background work still running: ${event.pending}` : "background work done";
    case "terminal":
      return `agent ended: ${event.status}${event.failure ? `, ${event.failure.message}` : ""}`;
    case "turn":
      return `turn ${event.n} ended: ${event.files} file(s) changed`;
  }
}

export interface RunnerService {
  /** `work`: the holder is a machine away from the orchestrator, so its lease carries the task's whole description. */
  poll(person: string, holder: string, waitMs: number, canTake: boolean, signal: AbortSignal, options?: { work?: boolean; features?: readonly MachineFeature[] }): Promise<{ lease: Lease | null; commands: RunnerCommand[] }>;
  renew(taskId: string, leaseId: string): Promise<boolean>;
  events(taskId: string, leaseId: string, events: NumberedEvent[]): Promise<void>;
  request(taskId: string, leaseId: string, request: AgentRequest): Promise<void>;
  progress(taskId: string, leaseId: string, progress: TaskProgress): Promise<void>;
  /** Marks these of the task's own follow-ups as reached its agent; another task's are left as they are. */
  followUpsDelivered(taskId: string, leaseId: string, ids: readonly string[]): Promise<void>;
  finish(taskId: string, leaseId: string, outcome: TaskOutcome): Promise<void>;
  /** Wakes the polls waiting now: a task was queued for a machine, or a person answered a request. */
  wake(): void;
  /**
   * Asks the runner holding the task to stop it, kept in the store so a runner polling another of
   * the orchestrator's processes, or one that reconnects after a deploy, hears it too; its outcome
   * comes back as for any other end. False when no runner holds the task.
   */
  stop(taskId: string): Promise<boolean>;
  /** Ends as interrupted every task a holder still leases: a runner starting again has lost what it ran before. */
  recover(holder: string, reason: string): Promise<string[]>;
}

export interface RunnerServiceOptions {
  tenant: string;
  store: RunnerServiceStore;
  now?: () => number;
  /** Told when a runner reported a task's end, for what follows it on the orchestrator: the request from the pushed branch. */
  onFinished?: (taskId: string, outcome: TaskOutcome) => Promise<void>;
  /** After a task a runner held ends, however it ended: what its starter gave it for this run is dropped. */
  onEnded?: (taskId: string) => Promise<void>;
  /** What the agent said of one of its person's usage windows, kept for the warning before their next start. */
  onLimit?: (taskId: string, event: Extract<AgentEvent, { type: "limit" }>) => Promise<void>;
  /** What the task's agent counted of the context its person's setup takes; kept for the person, never a line of the log. */
  onContextParts?: (taskId: string, event: Extract<AgentEvent, { type: "context_parts" }>) => Promise<void>;
  /** A turn of a change a machine kept in its folder's shadow, kept here as the task's turn. */
  onTurn?: (taskId: string, turn: Extract<RunnerEvent, { type: "turn" }>) => Promise<void>;
  /** What a machine away from the orchestrator is handed of a task it leased; a task this cannot describe ends failed with its reason. */
  describeWork?: (taskId: string) => Promise<RemoteWork>;
  /**
   * The task's checks on the orchestrator's side: `record` keeps what a machine's checks showed as the
   * task's evidence and gives the tests' outcome, null for a report that does not read; `handed` says
   * whether the task was handed checks, when only their report, never a machine's word, sets its tests.
   */
  checks?: { record: (taskId: string, raw: unknown) => Promise<TestOutcome | null>; handed: (taskId: string) => Promise<boolean> };
  /**
   * Told what a running task spent beyond its kept cost: a turn's estimate as it comes, or 0 once a report of cost was
   * kept, so the task's cost cap stops it before the turn's own end.
   */
  onSpend?: (taskId: string, usd: number) => Promise<unknown>;
  nameOf?: (who: string) => Promise<string>;
  /** Whether a task is a question, which changes nothing wherever it runs. */
  isQuestion?: (taskId: string) => Promise<boolean>;
}

/**
 * The calls a runner makes, the same for the one running inside a local orchestrator and for a
 * machine that reaches a team's over HTTP: both links end here. An answer is handed to the runner
 * again on every poll until the request is no longer waiting; the runner hands each answer to its
 * agent once, so a repeat after a restart changes nothing.
 */
/** How long a run's session waits on its person's card before it closes. */
export const IDLE_SESSION_MS = 30 * 60_000;

export const QUESTION_CHANGED_AWAY = "The task was a question, and its agent changed files on your machine; none of it was kept here and no request was opened. What it changed is still on that machine.";

export function createRunnerService({ tenant, store, now = Date.now, onFinished = async () => {}, onEnded = async () => {}, onLimit, onContextParts, onTurn, describeWork, checks, onSpend, nameOf, isQuestion }: RunnerServiceOptions): RunnerService {
  const woken = new EventEmitter();
  // What each holder was already handed. A command stays in the store until its task ends, so
  // without this every poll would come back at once with the same answer: a poll that never
  // waits keeps the process in promise callbacks and starves the agent's own output.
  const handed = new Map<string, Set<string>>();
  const iso = (ms: number) => new Date(ms).toISOString();

  const keyOf = (command: RunnerCommand) => (command.type === "stop" ? `${command.taskId} stop` : command.type === "follow_up" ? `${command.taskId} follow ${command.followUp.id}` : `${command.taskId} answer ${command.requestId}`);

  /** The commands for the tasks a holder leases that it has not been handed yet; handing them marks them. */
  const commandsFor = async (holder: string, idles: boolean): Promise<RunnerCommand[]> => {
    const commands: RunnerCommand[] = [];
    const tasks = await store.heldTasks(tenant, holder, iso(now()));
    const seen = handed.get(holder) ?? new Set<string>();
    const live = new Set(tasks.map((t) => t.taskId));
    for (const key of seen) if (!live.has(key.split(" ")[0]!)) seen.delete(key);
    handed.set(holder, seen);
    for (const { taskId, leaseId, stopRequested } of tasks) {
      const requests = await store.taskRequests(tenant, taskId);
      if (stopRequested) commands.push({ type: "stop", taskId });
      // A session left waiting on a card closes rather than hold the machine; the task waits as interrupted for Continue.
      else if (idles && requests.some((r) => r.status === "pending" && now() - Date.parse(r.createdAt) >= IDLE_SESSION_MS)) commands.push({ type: "stop", taskId, idle: true });
      for (const request of requests) {
        if (request.status !== "answered" || request.answeredVia !== "web" || !request.answer) continue;
        if ("answers" in request.answer) commands.push({ type: "answer", taskId, requestId: request.sourceKey, decision: "allow-once", answers: request.answer.answers });
        else if ("decision" in request.answer) {
          const { decision, note, plan } = request.answer;
          commands.push({ type: "answer", taskId, requestId: request.sourceKey, decision: DECISIONS[decision], ...(note === undefined ? {} : { note }), ...(plan === undefined ? {} : { plan }) });
          // A declined plan ends the task: the agent stays in plan mode otherwise, so its run is stopped with the reason.
          if (request.kind === "plan" && decision === "deny" && !stopRequested && (await store.requestStop(tenant, taskId, iso(now()), PLAN_DECLINED))) commands.push({ type: "stop", taskId });
        }
      }
      // Words the lease's first message already carried are not handed again.
      for (const { id, source, text, quotes, createdBy, handedLease, attachments } of await store.pendingFollowUps(tenant, taskId)) if (handedLease !== leaseId) commands.push({ type: "follow_up", taskId, followUp: { id, source, text, quotes, createdBy, ...(attachments ? { attachments } : {}) } });
    }
    const fresh = commands.filter((c) => !seen.has(keyOf(c)));
    for (const c of fresh) seen.add(keyOf(c));
    return fresh;
  };

  const waitForWake = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        woken.off("wake", done);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      woken.once("wake", done);
      signal.addEventListener("abort", done, { once: true });
    });

  const held = async (write: () => Promise<boolean>) => {
    if (!(await write())) throw new NotHeld();
  };

  return {
    async poll(person, holder, waitMs, canTake, signal, options = {}) {
      const deadline = now() + waitMs;
      for (;;) {
        const commands = await commandsFor(holder, !options.work || options.features?.includes("idle-stop") === true);
        if (canTake && !signal.aborted) {
          const leaseId = newId("eff", now());
          const claimed = await store.claimLocalTask(tenant, person, holder, leaseId, iso(now() + LEASE_MS), iso(now()));
          if (claimed) {
            const { task, nextEvent } = claimed;
            const nativeSession = (await store.taskLease(tenant, task.id))?.nativeSession ?? null;
            if (!options.work) {
              // The moment this orchestrator's own runner took the task, before its checkout, which is the runner's first line otherwise.
              await store.appendTaskLog(tenant, task.id, ["Started on this machine."]);
              return { lease: { leaseId, nextEvent, task: { id: task.id, title: task.title, agent: task.agent, nativeSession } }, commands };
            }
            const work = await (describeWork ? describeWork(task.id).then(checkedWork) : Promise.reject(new Error("this orchestrator runs tasks only on the machine it runs on")))
              .then((described) => {
                if (described.readOnly && !options.features?.includes("read-only")) throw new Error("its runner is older than holding a question to reading, so it could change files or write through a tool; update the runner and ask again");
                if (described.setup.off && !options.features?.includes("task-off")) throw new Error("its runner is older than leaving things out of a task, so it would run with them on; update the runner and start the task again");
                if (("folder" in described && described.folder.machineId !== holder) || ("workspace" in described && described.workspace.machineId !== holder)) throw new Error("its folder is on another of its person's machines");
                return described;
              })
              .catch((error: Error) => error);
            if (!(work instanceof Error)) return { lease: { leaseId, nextEvent, task: { id: task.id, title: task.title, agent: task.agent, nativeSession, work } }, commands };
            await store.finishLeasedTask(tenant, task.id, leaseId, { status: "failed", error: `The task could not be handed to this machine: ${work.message}`, nativeSession: null, branch: null }, iso(now()));
            continue;
          }
        }
        if (commands.length || signal.aborted || now() >= deadline) return { lease: null, commands };
        await waitForWake(Math.min(POLL_TICK_MS, deadline - now()), signal);
      }
    },
    renew(taskId, leaseId) {
      return store.renewLease(tenant, taskId, leaseId, iso(now() + LEASE_MS), iso(now()));
    },
    async events(taskId, leaseId, given) {
      const events = nameOf ? await Promise.all(given.map(async (numbered) => (numbered.event.type === "steer" ? { ...numbered, event: { ...numbered.event, by: await nameOf(numbered.event.by) } } : numbered))) : given;
      const rows = events.filter(({ event }) => event.type !== "context" && event.type !== "context_used" && event.type !== "context_parts" && event.type !== "loaded" && event.type !== "mcp_status" && event.type !== "spend").map(({ n, event }) => ({ n, kind: event.type, text: eventText(event), data: event }));
      await held(() => store.appendRunnerEvents(tenant, taskId, leaseId, rows));
      for (const { event } of events) {
        if (event.type === "request_withdrawn") await store.withdrawTaskRequest(tenant, taskId, event.requestId, iso(now()));
        else if (event.type === "context") await store.noteTaskContext(tenant, taskId, event.tokens);
        else if (event.type === "context_used") await store.noteTaskContextUsed(tenant, taskId, { tokens: event.tokens, window: event.window });
        else if (event.type === "context_parts") await onContextParts?.(taskId, event);
        else if (event.type === "loaded") await store.updateTask(tenant, taskId, { startedWith: startedWithOf(event) });
        else if (event.type === "limit") await onLimit?.(taskId, event);
        else if (event.type === "turn") await onTurn?.(taskId, event);
        else if (event.type === "mcp_status") await store.updateTask(tenant, taskId, { mcpNeedsSignIn: event.needsSignIn });
        else if (event.type === "tool_call" && event.tool.toLowerCase() === "skill" && event.status === "started" && calledSkill(event.target)) {
          await store.noteUsedSkill(tenant, taskId, calledSkill(event.target)!);
          await store.noteTaskUse(tenant, taskId, "skills", calledSkill(event.target)!, sourceOf(event));
        } else if (event.type === "tool_call" && event.mcp?.server && event.status === "started") await store.noteTaskUse(tenant, taskId, "mcpServers", event.mcp.server, sourceOf(event));
        else if (event.type === "spend") await onSpend?.(taskId, event.usd);
      }
      // The latest estimate of the turn is kept on the task until the turn's own cost replaces it.
      const estimate = events.map(({ event }) => event).filter((event) => event.type === "spend").at(-1);
      if (estimate) await held(() => store.updateLeasedTask(tenant, taskId, leaseId, { turnEstimate: estimate.usd }));
    },
    async request(taskId, leaseId, request) {
      if (!(await store.renewLease(tenant, taskId, leaseId, iso(now() + LEASE_MS), iso(now())))) throw new NotHeld();
      const at = iso(now());
      await store.recordTaskRequest({
        tenant,
        id: newId("evt", now()),
        taskId,
        targetPosition: null,
        sourceKey: request.id,
        kind: request.kind as TaskRequestKind,
        payload: { tool: request.tool, summary: request.summary, ...(request.questions ? { questions: request.questions } : {}), ...(request.plan ? { plan: request.plan } : {}) },
        createdAt: at,
        // A request waits for its person as long as its runner holds the task: the lease ending, not a clock, ends it (t3code sets no timeout either).
        expiresAt: null,
      });
    },
    async progress(taskId, leaseId, progress) {
      const { cost, verification, tests, ...rest } = progress;
      let outcome = tests;
      if (verification !== undefined) {
        if ((await store.taskLease(tenant, taskId))?.leaseId !== leaseId) throw new NotHeld();
        outcome = (await checks?.record(taskId, verification)) ?? undefined;
      } else if (tests !== undefined && (await checks?.handed(taskId))) outcome = undefined;
      await held(() => store.updateLeasedTask(tenant, taskId, leaseId, { ...rest, ...(outcome ? { tests: outcome } : {}), ...(cost ? { addCost: cost } : {}) }));
      if (cost) await onSpend?.(taskId, 0);
    },
    async followUpsDelivered(taskId, leaseId, ids) {
      if ((await store.taskLease(tenant, taskId))?.leaseId !== leaseId) throw new NotHeld();
      const own = new Set((await store.pendingFollowUps(tenant, taskId)).map((f) => f.id));
      const reached = ids.filter((id) => own.has(id));
      if (reached.length) await store.markFollowUpsDelivered(tenant, reached, iso(now()));
    },
    async finish(taskId, leaseId, sent) {
      // A question changes nothing: a machine whose agent changed files all the same has its run end failed here, with
      // none of it kept and no request opened, whatever the machine did with what it changed.
      const outcome: TaskOutcome = sent.status === "needs-review" && (await isQuestion?.(taskId)) ? { ...sent, status: "failed", error: QUESTION_CHANGED_AWAY, branch: null, request: null } : sent;
      // A reset that is no time, already past or a month off is not believed: the task stays interrupted for its person.
      const limitResetAt = outcome.status === "interrupted" ? resetAtFromTime(outcome.limitResetAt, now()) : undefined;
      const since = (await store.taskLease(tenant, taskId))?.runStartedAt;
      const ranMs = since ? agentTimeMs(since, now(), await store.taskRequests(tenant, taskId)) : null;
      // A run that changed nothing finished; what it said last is its answer, kept only when nothing in it looks like a secret.
      const unchanged = outcome.status === "failed" && outcome.nothingChanged === true;
      // A run that went on from a review and changed nothing more comes back for review with its answer too.
      const answers = unchanged || outcome.status === "needs-review";
      const lastSaid = answers && outcome.lastSaid && !detectSecret(outcome.lastSaid) ? outcome.lastSaid.slice(0, LAST_SAID_MAX) : null;
      const end: LeasedTaskEnd = { status: unchanged ? "nothing-changed" : outcome.status, error: unchanged ? null : outcome.status === "failed" && outcome.error ? plainFailure(outcome.error) : outcome.error, nativeSession: outcome.nativeSessionId, branch: outcome.branch, ...(ranMs !== null ? { ranMs } : {}), ...(limitResetAt ? { limitResetAt } : {}), ...(lastSaid ? { lastSaid } : {}) };
      await held(() => store.finishLeasedTask(tenant, taskId, leaseId, end, iso(now())));
      await store.endTaskRequests(tenant, taskId, iso(now()));
      try {
        await onFinished(taskId, outcome);
      } finally {
        // What follows the end is done, however it went: the task is in review, and its page stops following it.
        if (outcome.status === "needs-review") await store.updateTask(tenant, taskId, { stage: null });
        await onEnded(taskId);
      }
    },
    wake() {
      woken.emit("wake");
    },
    async stop(taskId) {
      const asked = await store.requestStop(tenant, taskId, iso(now()));
      woken.emit("wake");
      return asked;
    },
    async recover(holder, reason) {
      const ended: string[] = [];
      for (const { taskId, leaseId } of await store.heldTasks(tenant, holder, iso(now()))) {
        if (!(await store.finishLeasedTask(tenant, taskId, leaseId, { status: "interrupted", error: reason, nativeSession: null, branch: null }, iso(now())))) continue;
        await store.endTaskRequests(tenant, taskId, iso(now()));
        await onEnded(taskId);
        ended.push(taskId);
      }
      return ended;
    },
  };
}
