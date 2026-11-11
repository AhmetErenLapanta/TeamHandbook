import { detectSecret } from "./plugin.js";
import { PLAN_TEXT_MAX } from "../shared/runner-wire.js";

/**
 * What an agent asks a person while it works: to run a command, change or read a file, call an
 * MCP tool, answer a question, or provide a secret. The question is kept before anyone answers
 * it, and an answer is kept before it reaches the agent. Only the browser session of the person
 * who started the task answers it; a member who only sees the task, an admin, a service account,
 * an API key, an OAuth token and an MCP tool do not, and every answer goes to the event log.
 */
/** permission is a tool outside the agent's fixed list that is none of the others. */
export type TaskRequestKind = "command" | "file-change" | "file-read" | "mcp" | "permission" | "question" | "secret" | "plan";
/** withdrawn: the agent took the question back before anyone answered it. */
export type TaskRequestStatus = "pending" | "answered" | "expired" | "withdrawn";
/** Whether the agent that asked is still there to hear an answer. */
export type ResponseCapability = "live" | "not_resumable";
/** allow_for_task lasts until the task ends: no decision outlives the task it was given in. */
export type TaskDecision = "allow_once" | "allow_for_task" | "deny";

/**
 * An answer: a decision for a permission, with a note to the agent on a deny only, every question
 * of a question request answered by its key, and for a secret only that it was given, since the
 * value goes to the runner over its own channel and is never kept here.
 */
/** A plan is approved as it came or as its person changed it (`plan`, with allow_once alone). */
export type TaskAnswer = { decision: TaskDecision; note?: string; plan?: string } | { answers: QuestionAnswers } | { provided: true };

/** One question's answer: the option values chosen, and the person's own words when they wrote some. */
export type QuestionAnswers = Record<string, { chosen: string[]; other: string | null }>;

/** A question as the agent asked it, kept in the request's payload as `questions`. */
export interface AskedQuestion {
  key: string;
  choice: "one" | "many" | "text";
  options?: { value: string }[];
  /** Whether the person's own words are taken beside the options. */
  other?: boolean;
}

/** A deny's note is a line to the agent, not a document. */
export const NOTE_MAX = 2000;

/** Why a task ends when its starter declines the plan its agent put to them. */
export const PLAN_DECLINED = "The plan was declined; nothing changed.";

/** The most a person's own words in an answer carry. */
export const OTHER_MAX = 4096;

/** Why an answer is refused: `answer-looks-secret` when a person's own words look like a password or key, which never reach the agent. */
export interface AnswerProblem {
  code: "answer-shape" | "answer-looks-secret";
  message: string;
}

export interface TaskRequestRecord {
  tenant: string;
  id: string;
  taskId: string;
  /** Which repository of a task over several asked; null for a task over one. */
  targetPosition: number | null;
  /** The agent's own id for the question, so a runner that reports it twice records it once. */
  sourceKey: string;
  kind: TaskRequestKind;
  /** What the person is shown, with names and references only; one that looks like it holds a secret is refused. */
  payload: Record<string, unknown>;
  status: TaskRequestStatus;
  responseCapability: ResponseCapability;
  answer: TaskAnswer | null;
  answeredBy: string | null;
  answeredVia: "web" | "runner" | null;
  createdAt: string;
  answeredAt: string | null;
  /** Null for a question that waits as long as its runner holds the task: the lease ending, not a clock, ends it. */
  expiresAt: string | null;
}

export type NewTaskRequest = Omit<TaskRequestRecord, "status" | "responseCapability" | "answer" | "answeredBy" | "answeredVia" | "answeredAt">;

export interface TaskRequestStore {
  /** Keeps a question once per task and source key; `created` is false when it was already kept, and that one comes back. */
  recordTaskRequest(request: NewTaskRequest): Promise<{ created: boolean; request: TaskRequestRecord }>;
  /**
   * The first answer to a question still pending, unexpired and live wins; any later one, or one
   * after the agent has gone, gets null. An answer of the wrong shape for its kind is refused.
   */
  answerTaskRequest(tenant: string, id: string, answer: TaskAnswer, by: string, via: "web" | "runner", now: string): Promise<TaskRequestRecord | null>;
  taskRequests(tenant: string, taskId: string): Promise<TaskRequestRecord[]>;
  /** Pending questions past their time become expired; says how many. */
  expireTaskRequests(now: string): Promise<number>;
  /** The agent of a task has gone: its pending questions expire and can no longer be answered. */
  endTaskRequests(tenant: string, taskId: string, now: string): Promise<number>;
  /** The agent took its question back: it is withdrawn while still pending and can no longer be answered; null when it was not pending. */
  withdrawTaskRequest(tenant: string, taskId: string, sourceKey: string, now: string): Promise<TaskRequestRecord | null>;
}

const DECISION_KINDS: readonly TaskRequestKind[] = ["command", "file-change", "file-read", "mcp", "permission"];
const DECISIONS: readonly TaskDecision[] = ["allow_once", "allow_for_task", "deny"];

const shape = (message: string): AnswerProblem => ({ code: "answer-shape", message });

/** Why an answer does not fit what was asked, or null when it does. */
export function answerProblem(asked: { kind: TaskRequestKind; payload: Record<string, unknown> }, answer: TaskAnswer): AnswerProblem | null {
  const { kind } = asked;
  const keys = Object.keys(answer);
  if (kind === "plan") return planProblem(answer, keys);
  // A question is turned down as a permission is, with a deny and a note when there is one.
  if (DECISION_KINDS.includes(kind) || (kind === "question" && "decision" in answer)) {
    if (!("decision" in answer) || !DECISIONS.includes(answer.decision) || keys.some((k) => k !== "decision" && k !== "note")) return shape(`a ${kind} request is answered with allow_once, allow_for_task or deny`);
    if (kind === "question" && answer.decision !== "deny") return shape("a question is answered with answers, or turned down with deny");
    if (answer.note === undefined) return null;
    if (answer.decision !== "deny") return shape("only a deny carries a note");
    return typeof answer.note === "string" && answer.note.length <= NOTE_MAX ? null : shape(`a deny's note is text of at most ${NOTE_MAX} characters`);
  }
  if (kind === "question") return questionProblem(asked.payload.questions, answer);
  return keys.length === 1 && "provided" in answer && answer.provided === true ? null : shape("a secret is answered only with whether it was provided; its value never reaches the orchestrator's store");
}

/** A plan goes ahead once, as it came or changed, or is declined; it is never allowed for the rest of the task. */
function planProblem(answer: TaskAnswer, keys: string[]): AnswerProblem | null {
  if (!("decision" in answer) || (answer.decision !== "allow_once" && answer.decision !== "deny") || keys.some((k) => k !== "decision" && k !== "note" && k !== "plan")) return shape("a plan is approved with allow_once, with the plan as you changed it if you did, or declined with deny");
  if (answer.plan !== undefined && (answer.decision !== "allow_once" || typeof answer.plan !== "string" || !answer.plan.trim() || answer.plan.length > PLAN_TEXT_MAX)) return shape(`a changed plan goes with allow_once, as text of at most ${PLAN_TEXT_MAX} characters`);
  if (answer.note !== undefined && (answer.decision !== "deny" || typeof answer.note !== "string" || answer.note.length > NOTE_MAX)) return shape(`only a deny carries a note, of at most ${NOTE_MAX} characters`);
  return null;
}

/** Every question answered, by its key and in its own shape; a person's own words checked last, for a secret. */
function questionProblem(questions: unknown, answer: TaskAnswer): AnswerProblem | null {
  if (Object.keys(answer).length !== 1 || !("answers" in answer) || !answer.answers || typeof answer.answers !== "object") return shape("a question is answered with answers, one for each of its questions by key");
  if (!Array.isArray(questions) || !questions.length) return shape("this request holds no question to answer");
  const asked = questions as AskedQuestion[];
  const given = answer.answers;
  if (Object.keys(given).sort().join("\n") !== asked.map((q) => q.key).sort().join("\n")) return shape("answer every question, each by its key, and no other");
  for (const q of asked) {
    const a = given[q.key];
    if (!a || !Array.isArray(a.chosen) || !a.chosen.every((v) => typeof v === "string") || !(a.other === null || typeof a.other === "string")) return shape(`the answer to ${q.key} names what was chosen and the person's own words, or null`);
    const values = new Set((q.options ?? []).map((o) => o.value));
    if (!a.chosen.every((v) => values.has(v))) return shape(`the answer to ${q.key} chooses only among its options`);
    if ((q.choice === "one" && a.chosen.length > 1) || (q.choice === "text" && a.chosen.length)) return shape(q.choice === "one" ? `${q.key} takes one choice` : `${q.key} takes the person's own words, not a choice`);
    if (a.other !== null && q.choice !== "text" && !q.other) return shape(`${q.key} takes no words of the person's own`);
    if (a.other !== null && a.other.length > OTHER_MAX) return shape(`the person's own words are at most ${OTHER_MAX} characters`);
    if (!a.chosen.length && !a.other?.trim()) return shape(`answer ${q.key} before sending`);
  }
  // The person's own words go to the agent, so one that looks like a password or key is not sent.
  if (Object.values(given).some((a) => a.other && detectSecret(a.other))) return { code: "answer-looks-secret", message: "part of the answer looks like a password or key; write it without that, then send" };
  return null;
}
