import { describe, expect, it } from "vitest";
import { openSqliteStore } from "../store.js";
import { keepMeasuredContext, measuredContext } from "./handbook-context.js";

describe("what a person's last task counted of the context their setup takes", () => {
  it("given an agent's count with a name that holds a control character, a count that is no number and a negative one among good ones, when it is kept and read, then only the good ones are held, whole, with when they were counted, and another person has none", async () => {
    // given
    const store = openSqliteStore(":memory:");
    const said = { mcpServers: [{ name: "docs", tokens: 1200.4 }, { name: "bad\u0007name", tokens: 5 }, { name: "deploys", tokens: "many" }], skills: [{ name: "review-checklist", tokens: 90 }, { name: "release-notes", tokens: -1 }] };

    // when
    await keepMeasuredContext(store, "acme", "u-ada", said, "2026-03-04T05:06:07.000Z");
    await keepMeasuredContext(store, "acme", "u-max", { ...said, window: 200_000 }, "2026-03-04T05:06:07.000Z");

    // then
    expect(await measuredContext(store, "acme", "u-ada")).toEqual({ at: "2026-03-04T05:06:07.000Z", mcpServers: [{ name: "docs", tokens: 1200 }], skills: [{ name: "review-checklist", tokens: 90 }] });
    expect((await measuredContext(store, "acme", "u-max"))?.window).toBe(200_000);
    expect(await measuredContext(store, "acme", "u-grace")).toBeNull();
  });
});
