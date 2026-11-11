import { describe, expect, it } from "vitest";
import { cardState, cardUnread, daySentence, whenShort } from "./task-board";
import type { BoardCard } from "./task-board";

const card = (over: Partial<BoardCard> = {}): BoardCard => ({
  id: "t1", title: "Retry a capture", repoId: "shop", status: "needs-review", phase: "review", next: null, createdBy: "ada@example.invalid",
  createdAt: "2026-11-04T09:00:00Z", finishedAt: null, waitingFor: null, changes: null, request: null, cost: { usd: null, inputTokens: null, outputTokens: null },
  agent: "claude-code", startedAt: null, issueKey: null, ...over,
});

describe("cardState", () => {
  it("given cards in each turn, when their state is read, then your turn says what it waits for and done says how it ended", () => {
    // then
    const said = (c: BoardCard) => {
      const { label, tone } = cardState(c);
      return [label, tone];
    };
    expect(said(card({ next: "review" }))).toEqual(["needs you", "warn"]);
    expect(said(card({ status: "running", phase: "working", next: "answer" }))).toEqual(["needs you", "warn"]);
    expect(said(card({ status: "running", phase: "working" }))).toEqual(["working", "info"]);
    expect(said(card({ status: "queued", phase: "planned" }))).toEqual(["waiting its turn", "neutral"]);
    expect(said(card({ status: "queued", phase: "planned", waitingFor: "connect" }))).toEqual(["waiting for your machine", "warn"]);
    expect(said(card({ status: "interrupted", phase: "working", waitingFor: "limit" }))).toEqual(["at the usage limit", "warn"]);
    expect(said(card({ status: "needs-review", phase: "merged" }))).toEqual(["kept on this machine", "ok"]);
    expect(said(card({ status: "needs-review", phase: "merged", request: { repoId: "shop", number: 7, status: "merged", url: "https://gitlab.example/x/-/merge_requests/7" } }))).toEqual(["merged", "ok"]);
    expect(said(card({ status: "needs-review", phase: "review", state: "in-review", forge: { kind: "github", number: 3, url: "https://github.com/x/y/pull/3" } }))).toEqual(["in review on GitHub", "info"]);
    expect(said(card({ status: "needs-review", phase: "failed" }))).toEqual(["undone", "neutral"]);
    expect(said(card({ status: "cancelled" }))).toEqual(["stopped", "neutral"]);
  });
});

describe("cardUnread", () => {
  it("given a card waiting on a question, when its page marked the question seen, then it is read, and a review not yet seen is new", () => {
    // given
    const seen = new Set(["t1:answer"]);

    // then
    expect(cardUnread(card({ next: "answer" }), seen)).toBe(false);
    expect(cardUnread(card({ next: "review" }), seen)).toBe(true);
    expect(cardUnread(card({ next: "continue" }), seen)).toBe(false);
  });

  it("given a card waiting on a teammate's follow-up, when its page marked the follow-up seen, then it is read, and before that it is new and says so", () => {
    // then
    expect(cardState(card({ next: "follow-up" }))).toMatchObject({ label: "needs you", tone: "warn" });
    expect(cardUnread(card({ next: "follow-up" }), new Set())).toBe(true);
    expect(cardUnread(card({ next: "follow-up" }), new Set(["t1:follow-up"]))).toBe(false);
  });
});

describe("daySentence", () => {
  const board = (counts: { yours?: number; agents?: number; waiting?: number }, kept: BoardCard[] = []) => ({
    counts: { yours: 0, agents: 0, waiting: 0, done: kept.length, ...counts },
    sections: { yours: [], agents: [], waiting: [], done: kept },
  });
  const keptCard = (usd: number | null) => card({ status: "needs-review", phase: "merged", cost: { usd, inputTokens: null, outputTokens: null } });

  it("given what waits, runs and was kept this week, when the day is said, then each part is named, a part at zero is left out and nothing at all says nothing", () => {
    // then
    expect(daySentence(board({ yours: 2, agents: 1 }, [keptCard(1.5), keptCard(2.6), keptCard(0)]))).toBe("2 wait on you, 1 is working; 3 kept this week for $4.10.");
    expect(daySentence(board({ yours: 1 }))).toBe("1 waits on you.");
    expect(daySentence(board({}, [keptCard(null)]))).toBe("1 kept this week.");
    expect(daySentence(board({ agents: 2, waiting: 1 }))).toBe("2 are working, 1 waits for a computer.");
    expect(daySentence(board({}))).toBeNull();
  });
});

describe("whenShort", () => {
  it("given times today, yesterday and last week, when shown in a row, then today is a time, yesterday a word and older a weekday", () => {
    // given
    const now = new Date(2026, 10, 4, 15, 0);

    // then
    expect(whenShort(new Date(2026, 10, 4, 14, 8).toISOString(), now)).toMatch(/14[:.]08/);
    expect(whenShort(new Date(2026, 10, 3, 9, 0).toISOString(), now)).toBe("Yesterday");
    expect(whenShort(new Date(2026, 10, 1, 9, 0).toISOString(), now)).not.toBe("Yesterday");
  });
});
