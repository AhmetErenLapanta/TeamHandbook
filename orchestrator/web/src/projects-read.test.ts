import { describe, expect, it } from "vitest";
import { cloneName, homeRelative, looksLikePath, pastedPath, placeSteps } from "./projects-read";

describe("pastedPath", () => {
  it("given a path pasted from home, a full one and one with spaces around it, when read, then home is filled in and nothing else changes", () => {
    // then
    expect(pastedPath("~/code/shop", "/Users/you")).toBe("/Users/you/code/shop");
    expect(pastedPath("~", "/Users/you")).toBe("/Users/you");
    expect(pastedPath("  /Users/you/code/shop  ", "/Users/you")).toBe("/Users/you/code/shop");
    expect(pastedPath("~/code", null)).toBe("~/code");
  });
});

describe("looksLikePath", () => {
  it("given a path and a word, when typed in the picker, then only the path opens and the word searches", () => {
    // then
    expect(["~/code", "/tmp/x", "shop", " ~ "].map(looksLikePath)).toEqual([true, true, false, true]);
  });
});

describe("placeSteps", () => {
  it("given a folder two levels under home, when its place is shown, then each step leads back up to home", () => {
    // when
    const steps = placeSteps("/Users/you/code/shop", "/Users/you");

    // then
    expect(steps).toEqual([{ label: "~", path: "/Users/you" }, { label: "code", path: "/Users/you/code" }, { label: "shop", path: "/Users/you/code/shop" }]);
  });

  it("given home itself and a place outside it, when shown, then home is one step and the outside place is itself", () => {
    // then
    expect(placeSteps("/Users/you", "/Users/you")).toEqual([{ label: "~", path: "/Users/you" }]);
    expect(placeSteps("/Volumes/disk", "/Users/you")).toEqual([{ label: "/Volumes/disk", path: "/Volumes/disk" }]);
  });
});

describe("homeRelative", () => {
  it("given home, a folder under it, one outside it and no home yet, when shown, then home reads as ~ and only folders under it shorten", () => {
    // then
    expect(homeRelative("/Users/you", "/Users/you")).toBe("~");
    expect(homeRelative("/Users/you/code/x", "/Users/you")).toBe("~/code/x");
    expect(homeRelative("/home/younger/x", "/home/you")).toBe("/home/younger/x");
    expect(homeRelative("/Users/you/code/x", null)).toBe("/Users/you/code/x");
  });
});

describe("cloneName", () => {
  it("given https and ssh addresses, with and without .git or a trailing slash, when a clone is placed, then its folder is the last part without .git", () => {
    // then
    expect(cloneName("https://github.com/team/shop.git")).toBe("shop");
    expect(cloneName("https://gitlab.com/group/sub/api/")).toBe("api");
    expect(cloneName("git@github.com:team/shop.git")).toBe("shop");
  });

  it("given an address whose last part is no folder name, when a clone is placed, then no name is offered", () => {
    // then
    expect(cloneName("https://github.com/team/.hidden")).toBeNull();
    expect(cloneName("")).toBeNull();
  });
});
