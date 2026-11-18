import { describe, expect, it } from "vitest";
import { chosen } from "./remembered";

const boards = [{ id: "a" }, { id: "b" }, { id: "c" }];

describe("chosen", () => {
  it("given a board in the address and one remembered, when chosen, then the address wins", () => {
    expect(chosen(boards, "c", "b")).toEqual({ id: "c" });
  });

  it("given nothing in the address, when the remembered board is still listed, then it is chosen", () => {
    expect(chosen(boards, null, "b")).toEqual({ id: "b" });
  });

  it("given a remembered board that is gone, when chosen, then nothing is chosen and the default applies", () => {
    expect(chosen(boards, null, "gone")).toBeUndefined();
  });
});
