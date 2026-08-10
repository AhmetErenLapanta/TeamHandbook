import { describe, it, expect } from "vitest";
import { MAX_CORRECTIONS, noteCorrection, teachingKind } from "./corrections.js";
import type { CorrectionNote } from "./corrections.js";

describe("teachingKind", () => {
  it.each([
    ["always run make fmt before you commit", "rule"],
    ["never commit directly to main, open a PR", "rule"],
    ["don't use var here, this codebase is strict mode", "rule"],
    ["we never use Lombok in this repo, plain records only", "convention"],
    ["in this project we keep feature flags in config", "convention"],
    ["our convention is kebab-case for file names", "convention"],
    ["no, that's wrong — the gateway wants camelCase", "correction"],
    ["use pnpm instead of npm for this workspace", "preference"],
  ])("flags %s as a teaching (%s)", (prompt, kind) => {
    expect(teachingKind(prompt)).toBe(kind);
  });

  it.each([
    ["ok"],
    ["go on"],
    ["devam et"],
    ["add a test for the parser and run the suite"],
    ["/handbook:review"],
    ["<local-command-stdout>done</local-command-stdout>"],
  ])("leaves ordinary work alone: %s", (prompt) => {
    expect(teachingKind(prompt)).toBeNull();
  });

  it("ignores very long prompts — those are task briefs, not rules", () => {
    expect(teachingKind(`always ${"x".repeat(700)}`)).toBeNull();
  });
});

describe("noteCorrection", () => {
  const at = "2026-08-10T10:00:00Z";

  it("appends a teaching with its kind and timestamp", () => {
    const next = noteCorrection([], "always run make fmt before committing", at);
    expect(next).toEqual([{ at, kind: "rule", text: "always run make fmt before committing" }]);
  });

  it("returns null for non-teachings, duplicates, and secret-bearing prompts", () => {
    expect(noteCorrection([], "run the tests", at)).toBeNull();
    const existing: CorrectionNote[] = [{ at, kind: "rule", text: "always run make fmt" }];
    expect(noteCorrection(existing, "always run make fmt", at)).toBeNull();
    expect(
      noteCorrection([], "always use Bearer sk-proj-abcdef1234567890ABCDEFGH for that call", at),
    ).toBeNull();
  });

  it("keeps only the most recent notes", () => {
    let notes: CorrectionNote[] = [];
    for (let i = 0; i < MAX_CORRECTIONS + 3; i++) {
      notes = noteCorrection(notes, `always do thing number ${i}`, at) ?? notes;
    }
    expect(notes).toHaveLength(MAX_CORRECTIONS);
    expect(notes.at(-1)!.text).toContain(`number ${MAX_CORRECTIONS + 2}`);
    expect(notes.some((n) => n.text.includes("number 0"))).toBe(false);
  });

  it("truncates a long teaching instead of dropping it", () => {
    const notes = noteCorrection([], `never ${"y".repeat(500)}`, at)!;
    expect(notes[0]!.text.length).toBeLessThanOrEqual(400);
  });
});

describe("teachingKind — bare correction forms (regression: trailing \\b made these dead)", () => {
  it.each([
    ["no, the gateway wants camelCase"],
    ["nope, use the v2 endpoint"],
    ["actually, the config lives in etc/"],
    ["wrong. the token goes in the header"],
    ["that is wrong, we use records here"],
  ])("flags %s", (prompt) => {
    expect(teachingKind(prompt)).not.toBeNull();
  });

  it("does not mistake a first-person question for a rule", () => {
    expect(teachingKind("I don't know why this test fails, can you look?")).toBeNull();
    expect(teachingKind("we don't know what broke it, please investigate")).toBeNull();
  });
});
