import { basename, join } from "node:path";
import { detectSecret, hostIdentityOf, keepTaskLesson, queueTaskLesson, readTaskLessonWire, rejectTaskLesson, taskLesson, taskLessonCandidate } from "../server/plugin.js";
import type { LessonAnswer, LessonAsk, LessonOpAnswer, LessonOpAsk } from "./link.js";
import { environmentSecrets } from "./mask.js";

// The orchestrator screened the lesson for what it knows; this machine screens it again for what
// only it knows - its person's account and the credentials in their environment - before anything
// reaches their review queue, and a lesson out of shape writes nothing.
export function queueLessonHere(ask: LessonAsk, home: string, env: Record<string, string | undefined>): LessonAnswer {
  const wire = readTaskLessonWire(ask.lesson);
  if (!wire) return { refused: "the lesson's makings are out of shape" };
  const lesson = taskLessonCandidate({ ...wire, secretValues: machineSecrets(env) }, hostOf(home, env));
  if ("dropped" in lesson) return { dropped: lesson.dropped };
  const queued = queueTaskLesson(queueHome(home, env), lesson);
  return "dropped" in queued ? { dropped: queued.dropped } : { slug: queued.slug };
}

// The redactor's floor: a shorter value of a credential-named variable matches ordinary words.
const machineSecrets = (env: Record<string, string | undefined>) => environmentSecrets(env).filter((v) => v.length >= 8);
const queueHome = (home: string, env: Record<string, string | undefined>) => env.TEAMHANDBOOK_HOME || join(home, ".teamhandbook");
const hostOf = (home: string, env: Record<string, string | undefined>) => hostIdentityOf([env.USER, env.LOGNAME, basename(home)]);
const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;
const OPS = new Set(["read", "keep", "reject"]);

// Only a lesson this machine queued from the task the person is looking at: the queue's other
// candidates, and another task's lessons, are /handbook:review's alone. A lesson edited since it was
// queued is read only while it holds nothing shaped like a credential, its own or the environment's.
export function lessonOpHere(ask: LessonOpAsk, home: string, env: Record<string, string | undefined>): LessonOpAnswer {
  if (typeof ask.slug !== "string" || !SLUG.test(ask.slug) || !OPS.has(ask.op)) return { refused: "the lesson's name or what to do with it is out of shape" };
  const queue = queueHome(home, env);
  const lesson = taskLesson(queue, ask.slug);
  if (!lesson || lesson.meta.sessionId !== ask.taskId) return { refused: "this machine holds no lesson of that name from this task" };
  const now = new Date().toISOString();
  if (ask.op === "read") {
    const secrets = machineSecrets(env);
    if ([lesson.skillMd, lesson.quote ?? ""].some((text) => detectSecret(text) || secrets.some((value) => text.includes(value)))) return { refused: "the lesson holds what looks like a credential; open it with /handbook:review on this machine" };
    return { read: { status: lesson.meta.status, description: lesson.meta.description, skillMd: lesson.skillMd, quote: lesson.quote } };
  }
  if (ask.op === "keep") {
    const kept = keepTaskLesson(queue, ask.slug, join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "skills"), now, hostOf(home, env));
    return kept.ok ? { decided: "approved", muted: false } : { refused: kept.error ?? "the lesson was not kept" };
  }
  const rejected = rejectTaskLesson(queue, ask.slug, now, ask.never === true);
  return rejected.ok ? { decided: "rejected", muted: rejected.muted === true } : { refused: rejected.error ?? "the lesson was not rejected" };
}
