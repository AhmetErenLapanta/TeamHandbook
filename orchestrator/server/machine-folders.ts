import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import type { FolderEntry, FolderList, FolderRefusal, GitState } from "../shared/projects.js";
import { FOLDER_ENTRIES_MAX, FOLDER_MARKERS_MAX, FOLDER_TEXT_MAX, POLL_WAIT_MAX_MS } from "../shared/runner-wire.js";
import type { ChecksAnswer, ChecksAsk, FolderAnswer as Answer, FolderAsk, LessonAnswer, LessonAsk, LessonOpAnswer, LessonOpAsk, PushAnswer, PushAsk, UndoAnswer, UndoAsk } from "../runner/link.js";
import type { CheckKind, DetectedStep, DetectedVerification } from "../shared/verification.js";
import type { OrchestratorContext } from "./app.js";
import type { OrchestratorEnv } from "./auth.js";
import { detectSecret } from "./plugin.js";
import { folderRefusalStatus, machineFolderOf } from "./projects.js";
import { WORKING_COPIES_MAX } from "../runner/workspace.js";
import { route } from "./route-scopes.js";
import type { MachineRecord } from "./runner-store.js";

/*
 * What the orchestrator asks of a person's machine through its signed poll: its folders, listed
 * for its own person, and the undo of a task's change in one of them. The list is the machine's,
 * made by its own folder rule, and passes through here only to the screen that asked: it is held
 * in memory until that screen has it, and never written to the store, the event log or a log
 * line, so one organization's request and answer never reach another's.
 */

/** How long the person's screen waits for the machine's folder list. */
export const FOLDER_ASK_WAIT_MS = 10_000;
/** How long an undo waits for the machine: it writes files, a list only reads names. */
export const UNDO_ASK_WAIT_MS = 30_000;
/** How long a lesson waits for the machine to queue it; nobody waits on a screen for it. */
export const LESSON_ASK_WAIT_MS = 30_000;
/** How long the project's checks screen waits for the machine to read its folder. */
export const CHECKS_ASK_WAIT_MS = 10_000;
/** How long the person's screen waits for the machine to read or decide one of its lessons. */
export const LESSON_OP_WAIT_MS = 15_000;
export const PUSH_ASK_WAIT_MS = 60_000;
/** A machine with no poll waiting and none for this long is not connected now. */
const ONLINE_MS = POLL_WAIT_MAX_MS + 10_000;
/** Asks one machine has open at once; past it the screen is told to wait. */
const ASKS_PER_MACHINE = 4;

/** What the orchestrator asks a machine between leases, and what each is answered with. */
interface Kinds {
  folders: { ask: FolderAsk; answer: Answer };
  undos: { ask: UndoAsk; answer: UndoAnswer };
  lessons: { ask: LessonAsk; answer: LessonAnswer };
  checks: { ask: ChecksAsk; answer: ChecksAnswer };
  lessonOps: { ask: LessonOpAsk; answer: LessonOpAnswer };
  pushes: { ask: PushAsk; answer: PushAnswer };
}
type Kind = keyof Kinds;

interface Pending {
  kind: Kind;
  ask: FolderAsk | UndoAsk | LessonAsk | ChecksAsk | LessonOpAsk | PushAsk;
  machineId: string;
  handed: boolean;
  settle: (answer: unknown) => void;
}

interface Polls {
  waiting: Set<AbortController>;
  lastAt: number;
}

export interface MachineAsks {
  /** A poll of this machine starting: it ends early when an ask arrives, and hands the asks waiting for it. */
  polling(machineId: string): { signal: AbortSignal; take(): { folders: FolderAsk[]; undos: UndoAsk[]; lessons: LessonAsk[]; checks: ChecksAsk[]; lessonOps: LessonOpAsk[]; pushes: PushAsk[] }; end(): void };
  /** Whether the machine polls now, or did within the last ONLINE_MS; an ask of one that does not is answered "offline". */
  online(machineId: string): boolean;
  /** Asks the machine; null when it did not answer in time. */
  ask<K extends Kind>(machineId: string, kind: K, ask: Omit<Kinds[K]["ask"], "nonce">): Promise<Kinds[K]["answer"] | "invalid" | "offline" | "busy" | null>;
  /** The machine's answer to one of its own asks of that kind; false for an ask that is not its or no longer open. */
  answer<K extends Kind>(machineId: string, kind: K, nonce: string, answer: Kinds[K]["answer"] | "invalid"): boolean;
}

function machineAsks(now: () => number = Date.now): MachineAsks {
  const polls = new Map<string, Polls>();
  const pending = new Map<string, Pending>();
  const pollsOf = (machineId: string) => {
    let found = polls.get(machineId);
    if (!found) polls.set(machineId, (found = { waiting: new Set(), lastAt: 0 }));
    return found;
  };
  const take = (machineId: string) => {
    const asks = { folders: [] as FolderAsk[], undos: [] as UndoAsk[], lessons: [] as LessonAsk[], checks: [] as ChecksAsk[], lessonOps: [] as LessonOpAsk[], pushes: [] as PushAsk[] };
    for (const p of pending.values()) {
      if (p.machineId !== machineId || p.handed) continue;
      p.handed = true;
      if (p.kind === "folders") asks.folders.push(p.ask as FolderAsk);
      else if (p.kind === "undos") asks.undos.push(p.ask as UndoAsk);
      else if (p.kind === "lessons") asks.lessons.push(p.ask as LessonAsk);
      else if (p.kind === "checks") asks.checks.push(p.ask as ChecksAsk);
      else if (p.kind === "pushes") asks.pushes.push(p.ask as PushAsk);
      else asks.lessonOps.push(p.ask as LessonOpAsk);
    }
    return asks;
  };
  return {
    polling(machineId) {
      const mine = pollsOf(machineId);
      const controller = new AbortController();
      mine.waiting.add(controller);
      mine.lastAt = now();
      return {
        signal: controller.signal,
        take: () => take(machineId),
        end() {
          mine.waiting.delete(controller);
          mine.lastAt = now();
        },
      };
    },
    online(machineId) {
      const mine = polls.get(machineId);
      return !!mine && (mine.waiting.size > 0 || now() - mine.lastAt <= ONLINE_MS);
    },
    ask(machineId, kind, fields) {
      const mine = pollsOf(machineId);
      if (!mine.waiting.size && now() - mine.lastAt > ONLINE_MS) return Promise.resolve("offline");
      if ([...pending.values()].filter((p) => p.machineId === machineId).length >= ASKS_PER_MACHINE) return Promise.resolve("busy");
      const nonce = randomBytes(18).toString("base64url");
      return new Promise((resolve) => {
        const timer = setTimeout(() => settle(null), kind === "undos" ? UNDO_ASK_WAIT_MS : kind === "lessons" ? LESSON_ASK_WAIT_MS : kind === "checks" ? CHECKS_ASK_WAIT_MS : kind === "lessonOps" ? LESSON_OP_WAIT_MS : kind === "pushes" ? PUSH_ASK_WAIT_MS : FOLDER_ASK_WAIT_MS);
        const settle = (answer: unknown) => {
          clearTimeout(timer);
          pending.delete(nonce);
          resolve(answer as Kinds[typeof kind]["answer"] | "invalid" | null);
        };
        pending.set(nonce, { kind, ask: { nonce, ...fields } as FolderAsk | UndoAsk | LessonAsk | ChecksAsk | LessonOpAsk | PushAsk, machineId, handed: false, settle });
        for (const waiting of mine.waiting) waiting.abort();
      });
    },
    answer(machineId, kind, nonce, answer) {
      const p = pending.get(nonce);
      if (!p || p.kind !== kind || p.machineId !== machineId || !p.handed) return false;
      p.settle(answer);
      return true;
    },
  };
}

const perOrg = new WeakMap<OrchestratorContext, MachineAsks>();

/** The asks of one organization, which another organization's machine never sees or answers. */
export function machineAsksOf(ctx: OrchestratorContext): MachineAsks {
  let found = perOrg.get(ctx);
  if (!found) perOrg.set(ctx, (found = machineAsks()));
  return found;
}

const REFUSALS = new Set<FolderRefusal>(["not-absolute", "not-found", "not-a-folder", "outside-home", "home-itself", "hidden", "library", "data-dir"]);
const GIT_STATES = new Set<GitState>(["none", "repo", "origin"]);
const text = (value: unknown, max = FOLDER_TEXT_MAX): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);

/** A path from the machine's home, as `~` or `~/...`, with no part that climbs or repeats; a full path names the account and is refused. */
export function homePath(value: unknown): value is string {
  return text(value) && (value === "~" || (value.startsWith("~/") && value.slice(2).split("/").every((part) => part !== "" && part !== "." && part !== "..")));
}

function entryOf(value: unknown): FolderEntry | null {
  if (!value || typeof value !== "object") return null;
  const e = value as Record<string, unknown>;
  if (!text(e.name) || e.name.includes("/") || !homePath(e.path) || !GIT_STATES.has(e.git as GitState)) return null;
  if (!Array.isArray(e.markers) || e.markers.length > FOLDER_MARKERS_MAX || !e.markers.every((m) => text(m, 100))) return null;
  if (e.touchedAt !== undefined && !(text(e.touchedAt, 40) && !Number.isNaN(Date.parse(e.touchedAt)))) return null;
  if (e.repos !== undefined && !(Number.isInteger(e.repos) && (e.repos as number) >= 0 && (e.repos as number) <= WORKING_COPIES_MAX)) return null;
  return { name: e.name, path: e.path, git: e.git as GitState, markers: e.markers as string[], ...(e.repos === undefined ? {} : { repos: e.repos as number }), ...(e.touchedAt === undefined ? {} : { touchedAt: e.touchedAt as string }) };
}

/**
 * A machine's answer, rebuilt from the fields a folder list has and nothing else; null when any
 * part is not one, so a malformed or oversized answer reaches no screen.
 */
export function machineAnswer(value: unknown): Answer | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const a = value as Record<string, unknown>;
  if ("refused" in a) return REFUSALS.has(a.refused as FolderRefusal) && text(a.message) ? { refused: a.refused as FolderRefusal, message: a.message } : null;
  if (!homePath(a.under) || !(a.parent === null || homePath(a.parent)) || typeof a.truncated !== "boolean") return null;
  const lists = [a.folders, a.suggestions, ...(a.matches === undefined ? [] : [a.matches])];
  if (!lists.every(Array.isArray) || lists.reduce((n, l) => n + (l as unknown[]).length, 0) > FOLDER_ENTRIES_MAX) return null;
  const [folders, suggestions, matches] = lists.map((l) => (l as unknown[]).map(entryOf));
  if (![folders, suggestions, matches ?? []].every((l) => l!.every(Boolean))) return null;
  const list: FolderList = { under: a.under, parent: a.parent as string | null, folders: folders as FolderEntry[], suggestions: suggestions as FolderEntry[], truncated: a.truncated };
  return matches ? { ...list, matches: matches as FolderEntry[] } : list;
}

export type MachineAskFailure = { error: string; code: string; status: 400 | 404 | 409 | 429 | 502 | 504 };

/** A machine's folder list, or what the screen is told instead, with the next step in its words. */
export async function askMachine(ctx: OrchestratorContext, machine: Pick<MachineRecord, "id" | "name">, ask: Omit<FolderAsk, "nonce">): Promise<{ list: FolderList } | MachineAskFailure> {
  const answer = await machineAsksOf(ctx).ask(machine.id, "folders", ask);
  if (answer === "offline") return { error: `${machine.name} is not connected now; start its runner and keep it running`, code: "machine-offline", status: 409 };
  if (answer === "busy") return { error: `${machine.name} is still answering earlier asks; try again in a moment`, code: "machine-busy", status: 429 };
  if (answer === null) return { error: `${machine.name} did not answer; its runner is stopped or older than this orchestrator, so update it and keep it running`, code: "machine-did-not-answer", status: 504 };
  if (answer === "invalid") return { error: `${machine.name} answered with something other than a folder list`, code: "machine-answer-invalid", status: 502 };
  if ("refused" in answer) return { error: answer.message, code: answer.refused, status: folderRefusalStatus(answer.refused) };
  return { list: answer };
}

/** The most paths one undo answer names, as many as a folder without git is tracked with. */
const UNDO_PATHS_MAX = 5_000;

/** A path inside a task's folder, as git names it: relative, with no part that climbs or repeats. */
export const insideFolder = (value: unknown): value is string => text(value) && !value.startsWith("/") && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");

/** A machine's undo answer, rebuilt from its fields alone; null when it is not one. */
export function undoAnswer(value: unknown): UndoAnswer | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const a = value as Record<string, unknown>;
  if ("refused" in a) return text(a.refused) ? { refused: a.refused } : null;
  const lists = [a.undone, a.kept];
  if (!lists.every((l) => Array.isArray(l) && l.every(insideFolder)) || (a.undone as unknown[]).length + (a.kept as unknown[]).length > UNDO_PATHS_MAX) return null;
  return { undone: a.undone as string[], kept: a.kept as string[] };
}

const CHECKS_MAX = 8;
const STEP_TEXT_MAX = 4_000;
const CHECK_KINDS = new Set<CheckKind>(["test", "lint", "build", "typecheck"]);

function detectedStep(value: unknown): DetectedStep | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const s = value as Record<string, unknown>;
  if (![s.command, s.runs, s.source].every((t) => text(t, STEP_TEXT_MAX)) || typeof s.network !== "boolean" || typeof s.long !== "boolean" || typeof s.digest !== "string" || !/^[0-9a-f]{64}$/.test(s.digest)) return null;
  return { command: s.command as string, runs: s.runs as string, source: s.source as string, network: s.network, long: s.long, digest: s.digest };
}

/** A machine's reading of a folder's checks, rebuilt from its fields alone; null when it is not one. */
export function checksAnswer(value: unknown): ChecksAnswer | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const a = value as Record<string, unknown>;
  if ("refused" in a) return text(a.refused) ? { refused: a.refused } : null;
  const d = a.detected as Record<string, unknown> | null;
  if (!d || typeof d !== "object" || !Array.isArray(d.checks) || d.checks.length > CHECKS_MAX) return null;
  const setup = d.setup === null ? null : detectedStep(d.setup);
  if (d.setup !== null && !setup) return null;
  const checks = d.checks.map((c) => {
    const step = detectedStep(c);
    const kind = (c as Record<string, unknown> | null)?.kind;
    return step && CHECK_KINDS.has(kind as CheckKind) ? { ...step, kind: kind as CheckKind } : null;
  });
  return checks.every(Boolean) ? { detected: { setup, checks: checks as DetectedVerification["checks"] } } : null;
}

/** A folder project's checks, read on the machine the folder is on, waiting for its answer; why not, when it was not read. */
export async function checksOnMachine(ctx: OrchestratorContext, repo: { name: string; url: string; id: string }): Promise<{ detected: DetectedVerification } | { unread: string }> {
  const folder = machineFolderOf(repo.url);
  if (!folder) return { unread: `${repo.name} is not a folder on a person's machine` };
  const name = (await ctx.store.listMachines(ctx.tenant, null)).find((m) => m.id === folder.machineId)?.name ?? "its machine";
  const answer = await machineAsksOf(ctx).ask(folder.machineId, "checks", { projectId: repo.id, path: folder.path });
  if (answer === "offline") return { unread: `${name} is not connected now; start its runner to read this folder's checks` };
  if (answer === "busy") return { unread: `${name} is still answering earlier asks; open this again in a moment` };
  if (answer === null) return { unread: `${name} did not answer; its runner is stopped or older than this orchestrator` };
  if (answer === "invalid") return { unread: `${name} answered with something other than this folder's checks` };
  return "refused" in answer ? { unread: `${name} did not read the folder: ${answer.refused}` } : answer;
}

export function pushAnswer(value: unknown): PushAnswer | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const a = value as Record<string, unknown>;
  if ("refused" in a) return text(a.refused) ? { refused: a.refused } : null;
  return a.pushed === true ? { pushed: true } : null;
}

export async function pushOnMachine(ctx: OrchestratorContext, project: { name: string; url: string; id: string }, entry: { path: string; branch: string; head: string }): Promise<{ pushed: true } | { unread: string }> {
  const folder = machineFolderOf(project.url);
  if (!folder) return { unread: `${project.name} is not a folder on a person's machine` };
  const name = (await ctx.store.listMachines(ctx.tenant, null)).find((m) => m.id === folder.machineId)?.name ?? "its machine";
  const answer = await machineAsksOf(ctx).ask(folder.machineId, "pushes", { projectId: project.id, path: folder.path, repo: entry.path, branch: entry.branch, head: entry.head });
  if (answer === "offline") return { unread: `${name} is not connected now; start its runner to push ${entry.branch}` };
  if (answer === "busy") return { unread: `${name} is still answering earlier asks; try again in a moment` };
  if (answer === null) return { unread: `${name} did not answer; its runner is stopped or older than this orchestrator` };
  if (answer === "invalid") return { unread: `${name} answered with something other than a push` };
  return "refused" in answer ? { unread: `${name} did not push ${entry.branch}: ${answer.refused}` } : answer;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;
const DROPS = new Set(["secret", "muted", "duplicate"]);

export function lessonAnswer(value: unknown): LessonAnswer | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const a = value as Record<string, unknown>;
  if ("refused" in a) return text(a.refused) ? { refused: a.refused } : null;
  if ("dropped" in a) return typeof a.dropped === "string" && DROPS.has(a.dropped) ? { dropped: a.dropped as "secret" | "muted" | "duplicate" } : null;
  return typeof a.slug === "string" && SLUG.test(a.slug) ? { slug: a.slug } : null;
}

// What a machine read back passes the same screen a lesson was written past, since it can have been edited in the queue since.
export function lessonOpAnswer(value: unknown): LessonOpAnswer | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const a = value as Record<string, unknown>;
  if ("refused" in a) return text(a.refused) ? { refused: a.refused } : null;
  if ("decided" in a) return (a.decided === "approved" || a.decided === "rejected") && typeof a.muted === "boolean" ? { decided: a.decided, muted: a.muted } : null;
  const r = a.read as Record<string, unknown> | undefined;
  if (!r || typeof r !== "object") return null;
  const fits = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
  if (!fits(r.status, 20) || !fits(r.description, 1024) || !fits(r.skillMd, 64_000) || !(r.quote === null || fits(r.quote, 1000))) return null;
  if ([r.description, r.skillMd, r.quote ?? ""].some((t) => detectSecret(t as string))) return null;
  return { read: { status: r.status, description: r.description, skillMd: r.skillMd, quote: r.quote as string | null } };
}

/** The folders of a machine, for its own person signed in to this organization; anyone else is told no such machine exists. */
export function machineFolderRoutes(ctx: OrchestratorContext): Hono<OrchestratorEnv> {
  const app = new Hono<OrchestratorEnv>();
  route(app, "GET /api/machines/:id/folders", async (c) => {
    const user = c.get("user");
    const unknown = () => c.json({ error: "unknown machine" }, 404);
    if (user.key || user.id.startsWith("service:")) return unknown();
    const machine = (await ctx.store.listMachines(ctx.tenant, user.id)).find((m) => m.id === c.req.param("id") && m.userId === user.id && !m.revokedAt);
    if (!machine) return unknown();
    const under = c.req.query("under") || null;
    const q = c.req.query("q") || null;
    if (under !== null && !homePath(under)) return c.json({ error: "give the folder as ~ or a path from ~/", code: "not-absolute" }, 400);
    if (q !== null && !text(q, 200)) return c.json({ error: "a search is 1 to 200 characters", code: "bad-search" }, 400);
    const answer = await askMachine(ctx, machine, { under, q });
    return "list" in answer ? c.json(answer.list) : c.json({ error: answer.error, code: answer.code }, answer.status);
  });
  return app;
}
