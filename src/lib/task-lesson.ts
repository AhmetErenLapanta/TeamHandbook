import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deliverPersonal } from "./deliver.js";
import type { DeliverResult } from "./deliver.js";
import { assembleSkillMd, parseDistillResponse, renameSkillMd } from "./distill.js";
import type { DistilledDraft, GroundedCase } from "./distill.js";
import { lessonFingerprint } from "./harvest.js";
import { maskIdentity } from "./identity.js";
import type { HostIdentity } from "./identity.js";
import { decideCandidate, isSafeSlug, listCandidates, loadMutedFingerprints, writeCandidateMeta } from "./queue.js";
import type { CandidateMeta, DecideResult } from "./queue.js";
export type { CandidateMeta } from "./queue.js";
export { hostIdentityOf } from "./identity.js";
import { detectSecret } from "./secrets.js";
import { candidatesDir } from "./skill-index.js";

// Every function here takes the queue's home as an argument and defaults none of it: the
// orchestrator is a server, and a home it did not name would be whatever account runs it.

export type TaskLessonSignal =
  | { kind: "follow-up"; text: string; quotes: readonly { path: string; lines: string; text: string }[] }
  | { kind: "denial"; note: string; tool: string; target: string }
  | { kind: "undo"; reason: string };

export interface TaskLessonInput {
  taskId: string;
  title: string;
  scope: string;
  cwd?: string;
  // The values the task's secrets hold: a password no pattern knows is still the task's secret.
  secretValues: readonly string[];
  draft: DistilledDraft;
  signals: readonly TaskLessonSignal[];
  createdAt: string;
}

export interface TaskLesson {
  slug: string;
  fingerprint: string;
  skillMd: string;
  groundedCase: GroundedCase;
  meta: CandidateMeta;
}

export type TaskLessonDrop = "secret" | "muted" | "duplicate";

// What a team's orchestrator sends a person's machine: the lesson's makings, never its files. The
// machine builds the candidate itself, masked with its own account and screened for its own
// secrets, so what is written is decided where it is written.
export type TaskLessonWire = Omit<TaskLessonInput, "secretValues" | "cwd">;

const fits = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max && !value.includes("\0");
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const relativePath = (value: unknown): value is string => fits(value, 300) && value !== "" && !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes("..");

function wireSignal(value: unknown): TaskLessonSignal | null {
  if (!record(value)) return null;
  if (value.kind === "undo") return fits(value.reason, 2000) && value.reason !== "" ? { kind: "undo", reason: value.reason } : null;
  if (value.kind === "denial") return fits(value.note, 2000) && fits(value.tool, 200) && fits(value.target, 4000) ? { kind: "denial", note: value.note, tool: value.tool, target: value.target } : null;
  if (value.kind !== "follow-up" || !fits(value.text, 8000) || !Array.isArray(value.quotes) || value.quotes.length > 20) return null;
  const quotes = value.quotes.map((q) => (record(q) && relativePath(q.path) && fits(q.lines, 40) && fits(q.text, 4000) ? { path: q.path, lines: q.lines, text: q.text } : null));
  return quotes.every((q) => q !== null) ? { kind: "follow-up", text: value.text, quotes: quotes as { path: string; lines: string; text: string }[] } : null;
}

export function readTaskLessonWire(value: unknown): TaskLessonWire | null {
  if (!record(value) || !record(value.draft) || !Array.isArray(value.signals) || value.signals.length === 0 || value.signals.length > 20) return null;
  const { taskId, title, scope, createdAt, draft } = value;
  if (!fits(taskId, 64) || !/^[A-Za-z0-9_-]+$/.test(taskId) || !fits(title, 500) || !fits(scope, 200) || !fits(createdAt, 40) || Number.isNaN(Date.parse(createdAt))) return null;
  if (!fits(draft.slug, 64) || !isSafeSlug(draft.slug) || !fits(draft.description, 1024) || !fits(draft.body, 8000) || !fits(draft.expect, 500)) return null;
  const signals = value.signals.map(wireSignal);
  if (signals.some((s) => s === null)) return null;
  return { taskId, title, scope, createdAt, draft: { slug: draft.slug, description: draft.description, body: draft.body, expect: draft.expect }, signals: signals as TaskLessonSignal[] };
}

const MAX_QUOTE_CHARS = 600;
const MAX_SUFFIX = 50;

function words(signal: TaskLessonSignal): string {
  return signal.kind === "follow-up" ? signal.text : signal.kind === "undo" ? signal.reason : signal.note;
}

// The denied tool's target is scanned too: a command's arguments can carry a credential.
function signalStrings(signal: TaskLessonSignal): string[] {
  if (signal.kind === "undo") return [signal.reason];
  return signal.kind === "follow-up" ? [signal.text, ...signal.quotes.flatMap((q) => [q.path, q.lines, q.text])] : [signal.note, signal.tool, signal.target];
}

const leaks = (text: string, secretValues: readonly string[]) => !!detectSecret(text) || secretValues.some((value) => text.includes(value));

export function signalIsSafe(signal: TaskLessonSignal, secretValues: readonly string[]): boolean {
  return !signalStrings(signal).some((s) => leaks(s, secretValues));
}

export function readTaskLessonReply(text: string): DistilledDraft | "none" | null {
  if (/^NO LESSON\s*$/m.test(text)) return "none";
  return parseDistillResponse(text);
}

// A secret in what would be written, or in what the person said and the model read, drops the
// whole candidate: masking it would still leave the rule built around it.
export function taskLessonCandidate(input: TaskLessonInput, host: HostIdentity): TaskLesson | { dropped: TaskLessonDrop } {
  if (input.signals.some((s) => !signalIsSafe(s, input.secretValues))) return { dropped: "secret" };
  const mask = (text: string) => maskIdentity(text, host);
  const draft: DistilledDraft = { slug: input.draft.slug, description: mask(input.draft.description), body: mask(input.draft.body), expect: mask(input.draft.expect) };
  const fingerprint = lessonFingerprint("correction", draft.slug);
  const quote = mask(input.signals.map(words).join(" / ")).slice(0, MAX_QUOTE_CHARS);
  const edits = [...new Set(input.signals.flatMap((s) => (s.kind === "follow-up" ? s.quotes.map((q) => mask(q.path)) : [])))];
  const groundedCase: GroundedCase = {
    fingerprint,
    capturedAt: input.createdAt,
    command: "",
    error: "",
    resolvedCommand: null,
    edits,
    expect: draft.expect,
    gate: null,
    task: { goal: mask(input.title), steps: [] },
    quote,
  };
  const skillMd = assembleSkillMd(draft, input.scope, "review");
  // The parts are read as written, before YAML and JSON escape what a value holds.
  const written = [draft.description, draft.body, draft.expect, quote, groundedCase.task!.goal, ...edits];
  if (written.some((text) => leaks(text, input.secretValues)) || [skillMd, JSON.stringify(groundedCase)].some((text) => detectSecret(text))) return { dropped: "secret" };
  const meta: CandidateMeta = {
    slug: draft.slug,
    status: "pending",
    createdAt: input.createdAt,
    scope: input.scope,
    description: draft.description,
    fingerprint,
    // candidate.json stays in the queue and never travels with the skill.
    sessionId: input.taskId,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    gate: null,
    origin: "task",
    kind: "correction",
    suggestedTarget: "personal",
  };
  return { slug: draft.slug, fingerprint, skillMd, groundedCase, meta };
}

// The directory is created exclusively, so a harvest writing beside it takes the next name
// rather than the same one.
export function queueTaskLesson(home: string, lesson: TaskLesson): { slug: string } | { dropped: TaskLessonDrop } {
  if (loadMutedFingerprints(home).has(lesson.fingerprint)) return { dropped: "muted" };
  if (listCandidates(home).some((m) => m.fingerprint === lesson.fingerprint && (m.status === "pending" || m.status === "approved"))) return { dropped: "duplicate" };
  const base = candidatesDir(home);
  mkdirSync(base, { recursive: true });
  for (let n = 1; n <= MAX_SUFFIX; n++) {
    const slug = n === 1 ? lesson.slug : `${lesson.slug}-${n}`;
    const dir = join(base, slug);
    try {
      mkdirSync(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw err;
    }
    writeFileSync(join(dir, "SKILL.md"), slug === lesson.slug ? lesson.skillMd : renameSkillMd(lesson.skillMd, slug));
    writeFileSync(join(dir, "grounded-case.json"), JSON.stringify(lesson.groundedCase, null, 2) + "\n");
    writeCandidateMeta(dir, { ...lesson.meta, slug });
    return { slug };
  }
  throw new Error(`the review queue already holds ${MAX_SUFFIX} candidates named ${lesson.slug}`);
}

export function taskLessons(home: string): CandidateMeta[] {
  return listCandidates(home).filter((m) => m.origin === "task");
}

export function taskLesson(home: string, slug: string): { meta: CandidateMeta; skillMd: string; quote: string | null } | null {
  const meta = taskLessons(home).find((m) => m.slug === slug);
  if (!meta) return null;
  const dir = join(candidatesDir(home), meta.slug);
  const grounded = JSON.parse(readFileSync(join(dir, "grounded-case.json"), "utf8")) as Partial<GroundedCase>;
  return { meta, skillMd: readFileSync(join(dir, "SKILL.md"), "utf8"), quote: typeof grounded.quote === "string" ? grounded.quote : null };
}

// Only a lesson from a task: the orchestrator decides nothing else in the queue.
export function keepTaskLesson(home: string, slug: string, skillsDir: string, decidedAt: string, host: HostIdentity): DeliverResult | { ok: false; error: string } {
  const meta = taskLessons(home).find((m) => m.slug === slug);
  if (!meta) return { ok: false, error: `no lesson from a task named "${slug}"` };
  if (meta.status !== "pending") return { ok: false, error: `lesson "${slug}" is already ${meta.status}` };
  return deliverPersonal(join(candidatesDir(home), slug), meta, decidedAt, skillsDir, { host });
}

export function rejectTaskLesson(home: string, slug: string, decidedAt: string, never: boolean): DecideResult {
  const meta = taskLessons(home).find((m) => m.slug === slug);
  if (!meta) return { ok: false, error: `no lesson from a task named "${slug}"` };
  return decideCandidate(home, slug, "rejected", decidedAt, { mute: never });
}
