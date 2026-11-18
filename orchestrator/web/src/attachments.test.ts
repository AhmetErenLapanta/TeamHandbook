import { describe, expect, it } from "vitest";
import { fileProblem, MOST_BYTES, MOST_FILES, typeOf } from "./attachments";

describe("fileProblem", () => {
  it("given a screenshot, a text note with no type, a zip, a file over the limit, an empty one and a task already full, when each is checked, then only the first two are taken", () => {
    // given
    const png = { name: "a.png", type: "image/png", size: 1000 };
    const note = { name: "notes.md", type: "", size: 40 };

    // then
    expect(fileProblem(png, 0)).toBeNull();
    expect(fileProblem(note, 3)).toBeNull();
    expect(fileProblem({ name: "a.zip", type: "application/zip", size: 10 }, 0)).toContain("is not a file the agent reads");
    expect(fileProblem({ name: "big.pdf", type: "application/pdf", size: MOST_BYTES + 1 }, 0)).toBe("big.pdf is over 10 MB.");
    expect(fileProblem({ name: "e.txt", type: "text/plain", size: 0 }, 0)).toBe("e.txt is empty.");
    expect(fileProblem(png, MOST_FILES)).toBe(`A task takes up to ${MOST_FILES} files.`);
  });

  it("given names with and without a type, when their type is read, then the extension speaks only for text and JSON", () => {
    // then
    expect([typeOf({ name: "a.log", type: "" }), typeOf({ name: "a.json", type: "" }), typeOf({ name: "a.bin", type: "" }), typeOf({ name: "a.png", type: "image/png" })]).toEqual(["text/plain", "application/json", "", "image/png"]);
  });
});
