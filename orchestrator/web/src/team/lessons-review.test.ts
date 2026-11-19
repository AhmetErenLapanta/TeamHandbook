import { describe, expect, it } from "vitest";
import { decidedOf, refusedSaid, rowOf, stillThere, toggled } from "./lessons-review";

const item = { slug: "log-ids", description: "Use when logging.", origin: "task", sessionId: "tsk_1", createdAt: "2026-11-04T09:00:00.000Z", firstLine: "Log the request id." };

describe("lessons review", () => {
  it("given a task lesson and a session lesson, when read, then each says where it came from and shows its first line", () => {
    expect(rowOf(item)).toMatchObject({ slug: "log-ids", source: { kind: "task", label: "From a task" }, taskId: "tsk_1", firstLine: "Log the request id." });
    expect(rowOf({ ...item, origin: "harvest", firstLine: "" })).toMatchObject({ source: { kind: "session", label: "From a session" }, taskId: null, firstLine: "Use when logging." });
  });

  it("given a selection, when a box is pressed twice, then the lesson is picked and then not", () => {
    const once = toggled(new Set(), "a");

    expect([...once]).toEqual(["a"]);
    expect([...toggled(once, "a")]).toEqual([]);
  });

  it("given a selection with a decided lesson, when the list is read again, then only lessons still listed stay picked", () => {
    expect([...stillThere(new Set(["a", "log-ids"]), [rowOf(item)])]).toEqual(["log-ids"]);
  });

  it("given one lesson kept and one refused, when the answer is read, then the kept leaves the list and the refusal says why", () => {
    const results = [{ slug: "a", ok: true }, { slug: "b", ok: false, error: "unknown lesson" }];

    expect(decidedOf(results)).toEqual(["a"]);
    expect(refusedSaid(results)).toBe("1 lesson was not decided: unknown lesson");
    expect(refusedSaid([{ slug: "a", ok: true }])).toBeNull();
  });
});
