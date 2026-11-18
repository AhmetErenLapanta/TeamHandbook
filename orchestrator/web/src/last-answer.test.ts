import { describe, expect, it } from "vitest";
import { forgetAnswers, lastAnswer, rememberAnswer } from "./last-answer";

describe("last answer", () => {
  it("gives back the answer a read last had, by its address", () => {
    forgetAnswers();
    rememberAnswer("/api/integrations", { integrations: [] });
    expect(lastAnswer("/api/integrations")).toEqual({ integrations: [] });
    expect(lastAnswer("/api/work/boards?source=a")).toBeUndefined();
  });

  it("keeps only the newest answer of one address", () => {
    forgetAnswers();
    rememberAnswer("/api/work/boards?source=a", { boards: [1] });
    rememberAnswer("/api/work/boards?source=a", { boards: [1, 2] });
    expect(lastAnswer("/api/work/boards?source=a")).toEqual({ boards: [1, 2] });
  });
});
