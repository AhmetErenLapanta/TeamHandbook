import { principalOf } from "../accounts.js";
import type { OrchestratorContext } from "../app.js";
import { manages } from "../auth.js";
import type { Principal } from "../auth.js";
import { ChangeRefused } from "../changes.js";
import { ORCHESTRATOR_ACTOR, recordEvent } from "../events.js";
import { newId } from "../ids.js";
import { windowLimiter } from "../limits.js";
import type { Verdict } from "../limits.js";
import { canStartOnTeam, everyTask } from "../tasks/guards.js";
import { startTask } from "../tasks/routes.js";
import type { WorkAutomation, WorkDraft } from "../../shared/work.js";
import { board, columns, listItems, listSprints } from "./service.js";
import type { WorkDeps } from "./service.js";

type Ctx = OrchestratorContext;

export type Automation = WorkAutomation;
export type Draft = WorkDraft;

export const AUTOMATIONS_KEY = "work.automations";
export const AUTOMATIONS_OFF = "work.automations.off";
export const DRAFTS_KEY = "work.drafts";
const MAX_AUTOMATIONS = 50;
const MAX_DRAFTS = 200;
const SEEN_MAX = 1_000;
const NAME = /^[\p{L}\p{N} ._-]{1,60}$/u;

async function readList<T>(ctx: Pick<OrchestratorContext, "store" | "tenant">, key: string): Promise<T[]> {
  const raw = await ctx.store.getSetting(ctx.tenant, key);
  try {
    return raw ? (JSON.parse(raw) as T[]) : [];
  } catch {
    return [];
  }
}

export const readAutomations = (ctx: Pick<OrchestratorContext, "store" | "tenant">) => readList<Automation>(ctx, AUTOMATIONS_KEY);
export const readDrafts = (ctx: Pick<OrchestratorContext, "store" | "tenant">) => readList<Draft>(ctx, DRAFTS_KEY);
const saveAutomations = (ctx: Pick<OrchestratorContext, "store" | "tenant">, list: Automation[]) => ctx.store.setSetting(ctx.tenant, AUTOMATIONS_KEY, JSON.stringify(list));
const saveDrafts = (ctx: Pick<OrchestratorContext, "store" | "tenant">, list: Draft[]) => ctx.store.setSetting(ctx.tenant, DRAFTS_KEY, JSON.stringify(list));
export const automationsOn = async (ctx: Pick<OrchestratorContext, "store" | "tenant">) => (await ctx.store.getSetting(ctx.tenant, AUTOMATIONS_OFF)) !== "1";

const strings = (value: unknown, what: string): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20 || !value.every((v) => typeof v === "string" && v.trim() && v.length <= 100)) throw new ChangeRefused(`${what} is a list of up to 20 names`);
  return (value as string[]).map((v) => v.trim());
};

/** An automation as an owner or an admin set it, checked against the board it reads and the repository it runs on. */
export async function cleanAutomation(ctx: Ctx, user: Principal, given: unknown, deps: WorkDeps, current?: Automation): Promise<Automation> {
  if (!manages(user)) throw new ChangeRefused("only an owner or an admin sets up automations");
  const body = (given ?? {}) as Record<string, unknown>;
  const name = typeof body.name === "string" ? body.name.trim() : current?.name ?? "";
  if (!NAME.test(name)) throw new ChangeRefused("name the automation in up to 60 letters, digits, spaces, dots, dashes or underscores");
  const boardId = typeof body.board === "string" ? body.board : current?.board ?? "";
  if (!boardId.startsWith("tracker~")) throw new ChangeRefused("an automation reads a board of the organization's issue tracker, whose webhook brings the changes");
  const found = await board(ctx, user, boardId, deps);
  if (!found.shown.project) throw new ChangeRefused("that board names no project to match the tracker's changes against");
  const t = (body.trigger ?? current?.trigger) as Record<string, unknown> | undefined;
  let trigger: Automation["trigger"];
  if (t?.kind === "column" && typeof t.column === "string") {
    const column = (await columns(found.opened, found.native, deps)).find((c) => c.name === t.column);
    if (!column) throw new ChangeRefused(`${t.column} is not a column of this board`);
    trigger = { kind: "column", column: column.name, statuses: column.statuses };
  } else if (t?.kind === "label" && typeof t.label === "string" && t.label.trim() && t.label.length <= 100) {
    trigger = { kind: "label", label: t.label.trim() };
  } else {
    throw new ChangeRefused("the trigger is an issue moving into a column of the board, or getting a label");
  }
  const f = (body.filter ?? current?.filter ?? {}) as Record<string, unknown>;
  const filter = { labels: strings(f.labels, "the labels an issue needs"), types: strings(f.types, "the issue types") };
  const repoId = typeof body.repoId === "string" ? body.repoId : current?.repoId ?? "";
  const repo = repoId ? await ctx.store.getRepo(ctx.tenant, repoId) : null;
  if (!repo) throw new ChangeRefused("pick the repository the task runs on");
  const agent = typeof body.agent === "string" && body.agent.trim() ? body.agent.trim() : current?.agent ?? "";
  if (!agent) throw new ChangeRefused("pick the agent the task runs with");
  const action = body.action === undefined ? current?.action ?? "draft" : body.action;
  if (action !== "draft" && action !== "start") throw new ChangeRefused("an automation drafts a task for someone to start, or starts it");
  const perMinute = body.perMinute === undefined ? current?.perMinute ?? 3 : body.perMinute;
  if (typeof perMinute !== "number" || !Number.isInteger(perMinute) || perMinute < 1 || perMinute > 30) throw new ChangeRefused("an automation acts on 1 to 30 changes a minute");
  const enabled = typeof body.enabled === "boolean" ? body.enabled : current?.enabled ?? true;
  // Starting in someone's name is that person's choice: a change to it records who made it.
  const by = current && action === current.action ? current.by : { id: user.id, name: user.name };
  return { id: current?.id ?? newId("aut"), name, board: boardId, project: found.shown.project, trigger, filter, repoId: repo.id, agent, action, enabled, perMinute, by, at: current && action === current.action ? current.at : new Date().toISOString() };
}

export async function addAutomation(ctx: Ctx, user: Principal, given: unknown, deps: WorkDeps): Promise<Automation> {
  const list = await readAutomations(ctx);
  if (list.length >= MAX_AUTOMATIONS) throw new ChangeRefused(`an organization keeps up to ${MAX_AUTOMATIONS} automations`);
  const made = await cleanAutomation(ctx, user, given, deps);
  await saveAutomations(ctx, [...list, made]);
  await recordEvent(ctx, user, "automation.changed", { repoId: made.repoId, subject: `automation:${made.id}`, detail: `set up the automation ${made.name}: ${describe(made)}` });
  return made;
}

export async function changeAutomation(ctx: Ctx, user: Principal, id: string, given: unknown, deps: WorkDeps): Promise<Automation> {
  const list = await readAutomations(ctx);
  const current = list.find((a) => a.id === id);
  if (!current) throw new ChangeRefused("no such automation");
  const changed = await cleanAutomation(ctx, user, given, deps, current);
  await saveAutomations(ctx, list.map((a) => (a.id === id ? changed : a)));
  await recordEvent(ctx, user, "automation.changed", { repoId: changed.repoId, subject: `automation:${id}`, detail: `changed the automation ${changed.name}: ${describe(changed)}${changed.enabled ? "" : ", turned off"}` });
  return changed;
}

export async function removeAutomation(ctx: Ctx, user: Principal, id: string): Promise<void> {
  if (!manages(user)) throw new ChangeRefused("only an owner or an admin sets up automations");
  const list = await readAutomations(ctx);
  const gone = list.find((a) => a.id === id);
  if (!gone) throw new ChangeRefused("no such automation");
  await saveAutomations(ctx, list.filter((a) => a.id !== id));
  await saveDrafts(ctx, (await readDrafts(ctx)).filter((d) => d.automation !== id));
  await recordEvent(ctx, user, "automation.removed", { repoId: gone.repoId, subject: `automation:${id}`, detail: `removed the automation ${gone.name} and its drafts` });
}

export async function turnAutomations(ctx: Ctx, user: Principal, on: boolean): Promise<void> {
  if (!manages(user)) throw new ChangeRefused("only an owner or an admin turns the organization's automations on or off");
  if (on) await ctx.store.deleteSetting(ctx.tenant, AUTOMATIONS_OFF);
  else await ctx.store.setSetting(ctx.tenant, AUTOMATIONS_OFF, "1");
  await recordEvent(ctx, user, "automation.switched", { subject: "automations", detail: on ? "turned the organization's automations on" : "turned every automation of the organization off" });
}

function describe(a: Automation): string {
  const when = a.trigger.kind === "column" ? `an issue of ${a.project} moves into ${a.trigger.column}` : `an issue of ${a.project} gets the label ${a.trigger.label}`;
  return `when ${when}, ${a.action === "start" ? `start a task in ${a.by.name}'s name` : "draft a task"} on ${a.repoId} with ${a.agent}`;
}

/** What changed about one issue between two reads of its board. */
export interface Change {
  delivery: string;
  key: string;
  url: string;
  project: string;
  toStatus: string | null;
  addedLabels: string[];
  labels: string[];
  type: string | null;
}

const matches = (a: Automation, c: Change) =>
  a.enabled &&
  a.project === c.project &&
  (a.trigger.kind === "column" ? c.toStatus !== null && a.trigger.statuses.includes(c.toStatus) : c.addedLabels.includes(a.trigger.label)) &&
  a.filter.labels.every((l) => c.labels.includes(l)) &&
  (!a.filter.types.length || (c.type !== null && a.filter.types.includes(c.type)));

/** Each automation's own pace and the deliveries already acted on, kept by this process. */
export class AutomationState {
  private readonly limits = new Map<string, (key: string) => Verdict>();
  private readonly seen: string[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  allowed(a: Automation): boolean {
    const key = `${a.id}:${a.perMinute}`;
    if (!this.limits.has(key)) this.limits.set(key, windowLimiter(a.perMinute, this.now));
    return this.limits.get(key)!(a.id).ok;
  }

  /** True the first time a delivery reaches an automation; a delivery the tracker sends again is acted on once. */
  first(a: Automation, c: Change): boolean {
    const key = `${a.id}:${c.delivery}`;
    if (this.seen.includes(key)) return false;
    this.seen.push(key);
    if (this.seen.length > SEEN_MAX) this.seen.shift();
    return true;
  }
}


/** An issue as one read of its board left it: what a later read is compared with. */
interface Seen {
  url: string;
  status: string;
  labels: string[];
  type: string | null;
}

/**
 * What the orchestrator last read of each automation's board, kept in this process alone: an
 * issue's fields never reach the store. A board an automation has not read before, after a start
 * or once it is turned on, is read and kept, and nothing is acted on, so a restart does not
 * start a task for every issue already sitting in its column.
 */
export class AutomationWatch {
  readonly last = new Map<string, Map<string, Seen>>();
  /** Automations whose board went unread because the person who set them up no longer manages, said once each. */
  readonly unread = new Set<string>();
  constructor(readonly state: AutomationState = new AutomationState()) {}
}

/**
 * One read of every board an enabled automation watches, each compared with the read before it:
 * an issue now in one of a trigger column's statuses that was not before, or carrying a label it
 * did not, is a change, matched, paced and logged as a delivery under `automation:<id>`. The
 * tracker is only read, the active sprint and the backlog, as the automation's owner or admin
 * reads them; nothing is read with the organization's automations off or none enabled.
 */
export async function pollAutomations(ctx: Ctx, deps: WorkDeps, watch: AutomationWatch): Promise<number> {
  const enabled = (await readAutomations(ctx)).filter((a) => a.enabled);
  const on = enabled.length > 0 && (await automationsOn(ctx));
  for (const id of [...watch.last.keys()]) if (!on || !enabled.some((a) => a.id === id)) watch.last.delete(id);
  if (!on) return 0;
  let delivered = 0;
  for (const boardId of new Set(enabled.map((a) => a.board))) {
    const watching = enabled.filter((a) => a.board === boardId);
    const now = await readBoard(ctx, deps, boardId, watching);
    if (now === "no reader") {
      for (const a of watching.filter((x) => !watch.unread.has(x.id))) {
        watch.unread.add(a.id);
        await recordEvent(ctx, ORCHESTRATOR_ACTOR, "automation.delivery", { repoId: a.repoId, subject: `automation:${a.id}`, detail: `${a.project} is not read: ${a.by.name} set this up and is no longer an owner or an admin` });
      }
      continue;
    }
    if (!now) continue;
    for (const a of watching) watch.unread.delete(a.id);
    for (const a of watching) {
      const before = watch.last.get(a.id);
      watch.last.set(a.id, now);
      if (!before) continue;
      for (const [key, seen] of now) {
        const was = before.get(key);
        if (!was) continue;
        const change: Change = {
          delivery: `${boardId}:${key}:${was.status}>${seen.status}:${seen.labels.filter((l) => !was.labels.includes(l)).join(",")}`,
          key,
          url: seen.url,
          project: a.project,
          toStatus: seen.status !== was.status ? seen.status : null,
          addedLabels: seen.labels.filter((l) => !was.labels.includes(l)),
          labels: seen.labels,
          type: seen.type,
        };
        if (!matches(a, change) || !watch.state.first(a, change)) continue;
        const said = !watch.state.allowed(a) ? `not acted on: more than ${a.perMinute} changes in a minute` : await act(ctx, a, change);
        await recordEvent(ctx, ORCHESTRATOR_ACTOR, "automation.delivery", { repoId: a.repoId, subject: `automation:${a.id}`, detail: `${change.key}${change.toStatus ? ` moved to ${change.toStatus}` : ` labelled ${change.addedLabels.join(", ")}`}: ${said}` });
        delivered++;
      }
    }
  }
  return delivered;
}

/** A board's active sprints and backlog, read fresh as the first of its automations' owners and admins who still is one; null when the read fails. */
async function readBoard(ctx: Ctx, deps: WorkDeps, boardId: string, watching: Automation[]): Promise<Map<string, Seen> | "no reader" | null> {
  let reader: Principal | null = null;
  for (const a of watching) {
    const account = await ctx.store.getUser(ctx.tenant, a.by.id);
    const who = account ? await principalOf(ctx.store, account) : null;
    if (who && manages(who)) {
      reader = who;
      break;
    }
  }
  if (!reader) return "no reader";
  try {
    const { sprints } = await listSprints(ctx, reader, boardId, deps, true);
    const reads = [...sprints.filter((s) => s.state === "active").map((s) => ({ sprint: s.id })), { backlog: boardId }];
    const seen = new Map<string, Seen>();
    for (const scope of reads) for (const item of (await listItems(ctx, reader, scope, deps, true)).items) seen.set(item.key, { url: item.url, status: item.status.name, labels: item.labels, type: item.type });
    return seen;
  } catch (err) {
    console.error(`automations: ${boardId} was not read: ${(err as Error).message}`);
    return null;
  }
}

/** Reads the automations' boards once a minute, one round at a time, until stopped; the timer keeps no process alive. */
export function startAutomationWatch(ctx: Ctx, deps: WorkDeps, everyMs = 60_000): () => void {
  const watch = new AutomationWatch();
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    pollAutomations(ctx, deps, watch)
      .catch((err: Error) => console.error(`automations: ${err.message}`))
      .finally(() => (running = false));
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}

async function act(ctx: Ctx, a: Automation, c: Change): Promise<string> {
  const open = await everyTask(ctx.store, ctx.tenant, { issueKeys: [c.key], statuses: ["queued", "running", "interrupted"] });
  if (open.some((t) => t.repoId === a.repoId)) return "not acted on: a task on this issue is already running there";
  if (a.action === "draft") {
    const drafts = await readDrafts(ctx);
    if (drafts.some((d) => d.automation === a.id && d.issueKey === c.key)) return "not acted on: a draft for this issue is waiting";
    if (drafts.length >= MAX_DRAFTS) return `not acted on: ${MAX_DRAFTS} drafts are waiting`;
    await saveDrafts(ctx, [...drafts, { id: newId("drf"), automation: a.id, issueKey: c.key, issueUrl: c.url, repoId: a.repoId, agent: a.agent, at: new Date().toISOString() }]);
    return "a task is drafted for someone to start";
  }
  const account = await ctx.store.getUser(ctx.tenant, a.by.id);
  const starter = account ? await principalOf(ctx.store, account) : null;
  if (!starter || !manages(starter)) return `not started: ${a.by.name} chose to start tasks and is no longer an owner or an admin`;
  if (!ctx.tasks) return "not started: this orchestrator runs no tasks";
  const started = await startTask(ctx, ctx.tasks, starter, { repoId: a.repoId, agent: a.agent, issueUrl: c.url, title: "", description: "" });
  return "task" in started ? `task ${started.task.id} started in ${starter.name}'s name` : `not started: ${started.error}`;
}

/** The drafts this person may start: those on repositories of teams they may start tasks for. */
export async function draftsFor(ctx: Ctx, user: Principal): Promise<Draft[]> {
  const repos = new Map((await ctx.store.listRepos(ctx.tenant)).map((r) => [r.id, r]));
  return (await readDrafts(ctx)).filter((d) => repos.has(d.repoId) && canStartOnTeam(user, repos.get(d.repoId)!.team));
}

export async function startDraft(ctx: Ctx, user: Principal, id: string): Promise<{ task: { id: string } } | { error: string; status: 400 | 403 | 404 | 409 }> {
  const draft = (await draftsFor(ctx, user)).find((d) => d.id === id);
  if (!draft) return { error: "no such draft", status: 404 };
  if (!ctx.tasks) return { error: "this orchestrator runs no tasks", status: 409 };
  const started = await startTask(ctx, ctx.tasks, user, { repoId: draft.repoId, agent: draft.agent, issueUrl: draft.issueUrl, title: "", description: "" });
  if (!("task" in started)) return started;
  await saveDrafts(ctx, (await readDrafts(ctx)).filter((d) => d.id !== id));
  return { task: { id: started.task.id } };
}

export async function dismissDraft(ctx: Ctx, user: Principal, id: string): Promise<boolean> {
  if (!(await draftsFor(ctx, user)).some((d) => d.id === id)) return false;
  await saveDrafts(ctx, (await readDrafts(ctx)).filter((d) => d.id !== id));
  return true;
}
