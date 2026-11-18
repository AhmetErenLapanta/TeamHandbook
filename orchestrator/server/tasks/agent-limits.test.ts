import { describe, expect, it } from "vitest";
import { openSqliteStore } from "../store.js";
import { lastLimits, LIMIT_SHOWN_MS, noteLimit } from "./agent-limits.js";

describe("what an agent last said of a person's usage windows", () => {
  it("given readings of two windows, a later one of the first and another person's, when one person's are read, then each window keeps its latest, newest first, and a week-old one is left out", async () => {
    // given
    const store = openSqliteStore(":memory:");
    const now = Date.parse("2026-11-12T12:00:00.000Z");
    const at = (ms: number) => new Date(now - ms).toISOString();
    await noteLimit(store, "acme", "claude-code", "ada@example.invalid", { window: "seven_day", status: "allowed", used: 0.5 }, at(60_000));
    await noteLimit(store, "acme", "claude-code", "ada@example.invalid", { window: "five_hour", status: "warning", used: 0.85, resetAt: "2026-11-12T14:00:00.000Z" }, at(30_000));
    await noteLimit(store, "acme", "claude-code", "ada@example.invalid", { window: "seven_day", status: "allowed", used: 0.66 }, at(10_000));
    await noteLimit(store, "acme", "claude-code", "bo@example.invalid", { window: "seven_day", status: "allowed", used: 0.1 }, at(10_000));
    await noteLimit(store, "acme", "opencode", "ada@example.invalid", { window: "old", status: "allowed", used: 0.2 }, at(LIMIT_SHOWN_MS + 1));

    // when
    const ada = await lastLimits(store, "acme", "claude-code", "ada@example.invalid", now);
    const old = await lastLimits(store, "acme", "opencode", "ada@example.invalid", now);

    // then
    expect(ada).toEqual([
      { window: "seven_day", status: "allowed", used: 0.66, resetAt: null, at: at(10_000) },
      { window: "five_hour", status: "warning", used: 0.85, resetAt: "2026-11-12T14:00:00.000Z", at: at(30_000) },
    ]);
    expect(old).toEqual([]);
  });
});
