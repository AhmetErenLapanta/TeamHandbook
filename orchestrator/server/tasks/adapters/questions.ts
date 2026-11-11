import type { AgentAnswers, AgentQuestion } from "./contract.js";
import { OPTIONS_MAX, QUESTIONS_MAX } from "./contract.js";

/** The longest text a question card shows in one place; a longer one makes no card. */
const TEXT_MAX = 4096;

/** What a card says when the agent asked in a way this page cannot show, so the person knows where the question went. */
export const UNSHOWN_QUESTION = "The agent asked with a form this page cannot show and stopped at that step; answer it in a follow-up message.";

/** What the agent is told when its question makes no card, so it asks in its own reply instead of waiting. */
export const QUESTION_NOT_SHOWN = "This question cannot be shown to the person. Ask it in your reply instead.";

const short = (text: string | undefined) => text === undefined || text.length <= TEXT_MAX;

/** The questions as a card shows them, or null when they are none, too many, offer too many choices or run too long: refused, never cut. */
export function showable(questions: AgentQuestion[]): AgentQuestion[] | null {
  if (!questions.length || questions.length > QUESTIONS_MAX) return null;
  for (const q of questions) {
    const options = q.options ?? [];
    if (!q.title.trim() || options.length > OPTIONS_MAX || (q.choice !== "text" && !options.length)) return null;
    if (!short(q.title) || !short(q.description) || !options.every((o) => short(o.label) && short(o.description))) return null;
  }
  return questions;
}

/**
 * One question's answer as the values the agent takes: the options chosen, then the person's own
 * words when they wrote some. Null when the question has no answer, so nothing half-answered is sent.
 */
export function answerValues(question: AgentQuestion, answers: AgentAnswers): string[] | null {
  const given = answers[question.key];
  if (!given) return null;
  const values = [...given.chosen, ...(given.other?.trim() ? [given.other] : [])];
  return values.length ? values : null;
}
