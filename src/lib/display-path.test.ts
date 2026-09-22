import { describe, it, expect } from "vitest";
import { displayPath } from "./display-path.js";

describe("displayPath", () => {
  it("collapses a path under the home to ~", () => {
    expect(displayPath("/home/dev/.teamhandbook/candidates/slug", "/home/dev")).toBe(
      "~/.teamhandbook/candidates/slug",
    );
  });

  it("prints the home itself as ~", () => {
    expect(displayPath("/home/dev", "/home/dev")).toBe("~");
  });

  it("leaves a sibling that shares the home's prefix alone", () => {
    expect(displayPath("/home/dev-backup/.teamhandbook", "/home/dev")).toBe(
      "/home/dev-backup/.teamhandbook",
    );
  });

  it("leaves a path outside the home alone", () => {
    expect(displayPath("/opt/teamhandbook/candidates/slug", "/home/dev")).toBe(
      "/opt/teamhandbook/candidates/slug",
    );
  });

  it("leaves every path alone when the home is unknown", () => {
    expect(displayPath("/home/dev/.teamhandbook", "")).toBe("/home/dev/.teamhandbook");
  });
});
