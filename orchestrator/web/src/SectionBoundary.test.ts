import { describe, expect, it } from "vitest";
import { errorReport } from "./SectionBoundary";

describe("errorReport", () => {
  it("given a fault with a stack, when it is written for a report, then it names the error, the page and where it was thrown", () => {
    // given
    const error = new TypeError("Cannot read properties of null (reading 'open')");
    error.stack = "TypeError: Cannot read properties of null\n    at Tiles (Activity.tsx:120:40)";

    // when
    const report = errorReport(error, "/acme/activity");

    // then
    expect(report.split("\n")).toEqual(["TypeError: Cannot read properties of null (reading 'open')", "at /acme/activity", "TypeError: Cannot read properties of null", "    at Tiles (Activity.tsx:120:40)"]);
  });
});
