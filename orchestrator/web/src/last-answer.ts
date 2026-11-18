import { apiPath } from "./api";

const answers = new Map<string, unknown>();
const keyOf = (path: string) => apiPath(path);

/** The last successful answer to a read, kept for the page's life so a screen revisited draws it at once and reads again behind it. */
export const lastAnswer = <T>(path: string): T | undefined => answers.get(keyOf(path)) as T | undefined;

export function rememberAnswer<T>(path: string, answer: T): T {
  answers.set(keyOf(path), answer);
  return answer;
}

export const forgetAnswers = () => answers.clear();
