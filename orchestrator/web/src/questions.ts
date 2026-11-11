/** A question as the agent asked it: its own words, shown as data, never as links or markup. */
export interface AgentQuestion {
  key: string;
  title: string;
  description?: string;
  choice: "one" | "many" | "text";
  options?: { value: string; label: string; description?: string }[];
  /** Whether the person's own words are taken beside the options. */
  other?: boolean;
}

/** One question's answer: the option values chosen, and the person's own words when they wrote some. */
export type QuestionAnswers = Record<string, { chosen: string[]; other: string | null }>;

/** The most a person's own words in an answer carry, as the orchestrator takes them. */
export const OTHER_MAX = 4096;

export function emptyAnswers(questions: AgentQuestion[]): QuestionAnswers {
  return Object.fromEntries(questions.map((q) => [q.key, { chosen: [], other: null }]));
}

/** An option picked: the one choice of a one-choice question, or one more or less of a many-choice one. */
export function pick(answers: QuestionAnswers, question: AgentQuestion, value: string): QuestionAnswers {
  const now = answers[question.key] ?? { chosen: [], other: null };
  const chosen = question.choice === "one" ? [value] : now.chosen.includes(value) ? now.chosen.filter((v) => v !== value) : [...now.chosen, value];
  return { ...answers, [question.key]: { ...now, chosen } };
}

/** The person's own words for a question, none once they are only spaces. */
export function write(answers: QuestionAnswers, question: AgentQuestion, text: string): QuestionAnswers {
  const now = answers[question.key] ?? { chosen: [], other: null };
  return { ...answers, [question.key]: { ...now, other: text.trim() ? text.slice(0, OTHER_MAX) : null } };
}

/** Sent only whole: every question has a choice or the person's own words. */
export function answerReady(questions: AgentQuestion[], answers: QuestionAnswers): boolean {
  return questions.every((q) => {
    const a = answers[q.key];
    return Boolean(a && (a.chosen.length || a.other?.trim()));
  });
}

/** An answered question in a line: the labels chosen, then the person's own words. */
export function answerLine(question: AgentQuestion, answer: { chosen: string[]; other: string | null } | undefined): string {
  if (!answer) return "no answer";
  const labels = answer.chosen.map((v) => question.options?.find((o) => o.value === v)?.label ?? v);
  return [labels.join(", "), answer.other ?? ""].filter(Boolean).join("; ") || "no answer";
}
