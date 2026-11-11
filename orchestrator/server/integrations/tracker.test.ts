import { describe, expect, it } from "vitest";
import { cleanTracker, issueAddress } from "./tracker.js";

describe("a Linear workspace's address", () => {
  it("given linear.app with no workspace, when the tracker is saved, then it is refused", () => {
    // given
    const body = { kind: "linear", url: "https://linear.app" };

    // when
    const save = () => cleanTracker(body);

    // then
    expect(save).toThrow("a Linear workspace's address is https://linear.app/<workspace>");
  });

  it("given a pasted link inside the workspace, when the tracker is saved, then the workspace alone is kept and an identifier becomes a link in it", () => {
    // given
    const body = { kind: "linear", url: "https://linear.app/acme/team/ENG/active" };

    // when
    const tracker = cleanTracker(body);

    // then
    expect(tracker).toEqual({ kind: "linear", url: "https://linear.app/acme" });
    expect(issueAddress("ENG-12", tracker)).toBe("https://linear.app/acme/issue/ENG-12");
  });
});
