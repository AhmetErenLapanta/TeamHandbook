import { describe, expect, it } from "vitest";
import { answerLine, answerReady, emptyAnswers, OTHER_MAX, pick, write } from "./questions";
import type { AgentQuestion } from "./questions";

const rounding: AgentQuestion = { key: "rounding", title: "How should refunds round?", choice: "one", options: [{ value: "even", label: "Half to even" }, { value: "up", label: "Half up" }], other: true };
const files: AgentQuestion = { key: "files", title: "Which files may change?", choice: "many", options: [{ value: "api", label: "The API" }, { value: "docs", label: "The docs" }] };
const reason: AgentQuestion = { key: "reason", title: "Why the change?", choice: "text" };

describe("answering the agent's questions", () => {
  it("given three questions, when only some are answered, then the answer is not ready, and once each has a choice or words it is", () => {
    // given
    let answers = emptyAnswers([rounding, files, reason]);

    // when
    answers = pick(answers, rounding, "up");
    answers = pick(answers, rounding, "even");
    answers = pick(answers, files, "api");
    const partly = answerReady([rounding, files, reason], answers);
    answers = write(answers, reason, "  Finance asked for it.  ");

    // then
    expect(partly).toBe(false);
    expect(answerReady([rounding, files, reason], answers)).toBe(true);
    expect(answers).toEqual({ rounding: { chosen: ["even"], other: null }, files: { chosen: ["api"], other: null }, reason: { chosen: [], other: "  Finance asked for it.  " } });
  });

  it("given a many-choice question, when an option is picked twice, then it is chosen and then not; and words that are only spaces are no answer", () => {
    // when
    const twice = pick(pick(emptyAnswers([files]), files, "docs"), files, "docs");
    const blank = write(emptyAnswers([reason]), reason, "   ");

    // then
    expect(twice.files!.chosen).toEqual([]);
    expect(blank.reason!.other).toBeNull();
    expect(answerReady([reason], blank)).toBe(false);
  });

  it("given words longer than an answer carries, when written, then they stop at the most it carries", () => {
    // when
    const long = write(emptyAnswers([reason]), reason, "x".repeat(OTHER_MAX + 10));

    // then
    expect(long.reason!.other).toHaveLength(OTHER_MAX);
  });

  it("given answers with labels and the person's own words, when an answered question is said in a line, then it shows the labels and then the words", () => {
    // then
    expect(answerLine(files, { chosen: ["api", "docs"], other: null })).toBe("The API, The docs");
    expect(answerLine(rounding, { chosen: ["even"], other: "only for refunds" })).toBe("Half to even; only for refunds");
    expect(answerLine(reason, undefined)).toBe("no answer");
  });
});
