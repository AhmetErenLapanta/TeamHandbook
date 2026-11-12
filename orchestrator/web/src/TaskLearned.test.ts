import { describe, expect, it } from "vitest";
import { learnedSentence, outcomeWords, skillText } from "./TaskLearned";
import type { OutcomeBucket, TaskLessonRow } from "./TaskLearned";

const lesson = (slug: string, status: TaskLessonRow["status"], machine?: string): TaskLessonRow => ({ slug, description: "Use when logging.", status, createdAt: "2026-11-04T09:00:00.000Z", taskId: "tsk_1", ...(machine ? { machine } : {}) });

describe("learnedSentence", () => {
  it("given a task started with team skills whose review left one lesson waiting, when the sentence is made, then it says both and calls the skills started with, not used", () => {
    // given
    const read = { skills: { team: ["release-notes", "add-field", "db-query"], project: [] }, candidates: [lesson("log-with-logger", "pending")] };

    // when
    const sentence = learnedSentence(read);

    // then
    expect(sentence).toBe("Started with 3 team skills; 1 lesson waits for your review.");
  });

  it("given lessons kept, rejected and sent to a machine, when the sentence is made, then a kept one is your skill, a rejected one is not counted and a sent one names its machine", () => {
    // given
    const read = { skills: { team: [], project: ["shop-conventions"] }, candidates: [lesson("a", "approved"), lesson("b", "rejected"), lesson("c", "sent", "ada-laptop")] };

    // when
    const sentence = learnedSentence(read);

    // then
    expect(sentence).toBe("Started with 1 project skill; 1 lesson kept as your skill; 1 lesson waits in your review queue on ada-laptop.");
  });

  it("given a task with no skill and no lesson, or only a rejected one, when the sentence is made, then there is none and the section is left out", () => {
    // given
    const none = { skills: { team: [], project: [] }, candidates: null };
    const rejected = { skills: { team: [], project: [] }, candidates: [lesson("b", "rejected")] };

    // when
    const sentences = [learnedSentence(none), learnedSentence(rejected)];

    // then
    expect(sentences).toEqual([null, null]);
  });

  it("given an agent that called skills, when the sentence is made, then it says how many it called beside what the task started with, and alone when it started with none", () => {
    // given
    const started = { skills: { team: ["a", "b", "c"], project: [], used: ["a", "personal-one"] }, candidates: null };
    const alone = { skills: { team: [], project: [], used: ["personal-one"] }, candidates: null };

    // when
    const sentences = [learnedSentence(started), learnedSentence(alone)];

    // then
    expect(sentences).toEqual(["Started with 3 team skills, the agent called 2.", "The agent called 1 skill."]);
  });

  it("given two lessons waiting and no skill, when the sentence is made, then it starts with the count in the plural", () => {
    // when
    const sentence = learnedSentence({ skills: { team: [], project: [] }, candidates: [lesson("a", "pending"), lesson("b", "pending")] });

    // then
    expect(sentence).toBe("2 lessons wait for your review.");
  });
});

const bucket = (tasks: number, acceptedWithoutRevision: number, rejected: number, revisionRoundsMedian: number | null): OutcomeBucket => ({ tasks, accepted: tasks - rejected, acceptedWithoutRevision, revisionRoundsMedian, rejected });

describe("outcomeWords", () => {
  it("given a kept lesson with enough tasks on both sides, when its outcome is put in words, then the line compares since with before and the fold holds the three measures", () => {
    // given
    const o = { pivot: "2026-11-01T00:00:00.000Z", minimum: 5, before: bucket(5, 1, 2, 1), with: bucket(6, 4, 1, 0) };

    // when
    const words = outcomeWords(o);

    // then
    expect(words).toEqual({
      phrase: "kept without a follow-up in 4 of 6 tasks since, 1 of 5 before",
      facts: [
        { term: "Kept without a follow-up", value: "4 of 6; before, 1 of 5" },
        { term: "Follow-ups, median", value: "0; before, 1" },
        { term: "Undone or closed", value: "1 of 6; before, 2 of 5" },
      ],
    });
  });

  it("given fewer decided tasks since than a comparison takes, when its outcome is put in words, then it gives the count alone and no rate", () => {
    // given
    const o = { pivot: "2026-11-01T00:00:00.000Z", minimum: 5, before: bucket(9, 2, 1, 1), with: bucket(2, 2, 0, 0) };

    // when
    const words = outcomeWords(o);

    // then
    expect(words).toEqual({ phrase: "2 tasks decided since, compared from 5", facts: [] });
  });

  it("given too few tasks before, when its outcome is put in words, then the since side stands alone; and with no pivot there is nothing to say", () => {
    // given
    const thin = { pivot: "2026-11-01T00:00:00.000Z", minimum: 5, before: bucket(3, 1, 1, 1), with: bucket(5, 3, 1, 0) };
    const none = { pivot: null, minimum: 5, before: bucket(0, 0, 0, null), with: bucket(5, 3, 1, 0) };

    // when
    const words = [outcomeWords(thin), outcomeWords(none)];

    // then
    expect(words[0]!.phrase).toBe("kept without a follow-up in 3 of 5 tasks since");
    expect(words[0]!.facts[0]).toEqual({ term: "Kept without a follow-up", value: "3 of 5" });
    expect(words[1]).toBeNull();
  });
});

describe("skillText", () => {
  it("given a SKILL.md written with either line ending, when its text is shown, then the frontmatter is left out and the body kept", () => {
    // given
    const unix = "---\nname: log-with-logger\ndescription: x\n---\n## Rule\n\nUse logger.\n";
    const windows = unix.replace(/\n/g, "\r\n");

    // when
    const shown = [skillText(unix), skillText(windows)];

    // then
    expect(shown[0]).toBe("## Rule\n\nUse logger.\n");
    expect(shown[1]).toBe("## Rule\r\n\r\nUse logger.\r\n");
  });
});
