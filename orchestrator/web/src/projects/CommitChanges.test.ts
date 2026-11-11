import { describe, expect, it } from "vitest";
import { commitMessage } from "./CommitChanges";

describe("commitMessage", () => {
  it("given a repository's first commit, when its message is filled in, then it is the server's, whatever the task was called", () => {
    // then
    expect(commitMessage({ first: true, message: "Start shop" }, "Tidy the checkout copy")).toBe("Start shop");
  });

  it("given a later commit, when its message is filled in, then it is the task's title, or the server's when the title is blank", () => {
    // then
    expect(commitMessage({ first: false, message: "Update shop" }, "  Tidy the checkout copy ")).toBe("Tidy the checkout copy");
    expect(commitMessage({ first: false, message: "Update shop" }, " ")).toBe("Update shop");
  });
});
