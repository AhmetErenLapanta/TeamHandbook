import { describe, expect, it } from "vitest";
import type { RequestStatusRead } from "../../shared/forge-read";
import { statusLine } from "./ForgeState";

const read = (over: Partial<RequestStatusRead["detail"]>, source: RequestStatusRead["source"] = "forge", comments: RequestStatusRead["comments"] = []): Pick<RequestStatusRead, "source" | "detail" | "comments"> => ({
  source,
  comments,
  detail: { number: 7, status: "open", headSha: "a1", checks: { state: "passing", checks: [] }, review: { decision: "approved", approvedBy: ["grace"] }, mergeability: { state: "mergeable", reason: null }, ...over },
});

describe("statusLine", () => {
  it("given a request on its forge with two comments, when its line is worded, then it merges in green and names its checks, its review and who spoke last", () => {
    // given
    const said = [{ id: "c2", author: "lin", kind: "person" as const, body: "", at: "2026-11-03T10:00:00Z", path: null, line: null, url: null }, { id: "c1", author: "grace", kind: "person" as const, body: "", at: "2026-11-02T10:00:00Z", path: null, line: null, url: null }];

    // when
    const line = statusLine(read({}, "forge", said));

    // then
    expect(line).toEqual({ merge: "ready to merge", tone: "ok", rest: "checks passing, approved by grace, 2 comments, the newest from lin" });
  });

  it("given a bot's note newest among a person's comments, when its line is worded, then only the person's count and name show", () => {
    // given
    const said = [{ id: "c3", author: "ci-bot", kind: "bot" as const, body: "", at: "2026-11-03T11:00:00Z", path: null, line: null, url: null }, { id: "c1", author: "grace", kind: "person" as const, body: "", at: "2026-11-02T10:00:00Z", path: null, line: null, url: null }];

    // when
    const line = statusLine(read({}, "forge", said));

    // then
    expect(line.rest).toBe("checks passing, approved by grace, 1 comment, the newest from grace");
  });

  it("given a request on this machine's own copy that conflicts, when its line is worded, then it says only that, with no checks or review", () => {
    // when
    const line = statusLine(read({ checks: { state: "no-ci", checks: [] }, review: { decision: "none", approvedBy: [] }, mergeability: { state: "conflict", reason: "the branch conflicts with its base" } }, "local"));

    // then
    expect(line).toEqual({ merge: "has a conflict to resolve", tone: "warn", rest: "" });
  });

  it("given a mergeable request whose checks fail, when its line is worded, then it is not shown as ready in green", () => {
    // when
    const line = statusLine(read({ checks: { state: "failing", checks: [{ name: "unit", group: "ci", state: "failure", url: null }] } }));

    // then
    expect(line.tone).toBe("warn");
    expect(line.rest).toContain("1 check failing");
  });
});
