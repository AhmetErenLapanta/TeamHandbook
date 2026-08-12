import { describe, it, expect } from "vitest";
import { MAX_CORRECTIONS, couldTeach, noteCorrection } from "./corrections.js";
import type { CorrectionNote } from "./corrections.js";

describe("couldTeach", () => {
  it.each([
    ["always run make fmt before you commit"],
    ["we never use Lombok in this repo, plain records only"],
    ["no, that's wrong — the gateway wants camelCase"],
    // the whole point of dropping the English patterns: these used to score zero
    ["burada db'yi asla mocklamayız, testcontainer kullan"],
    ["hayır önce review sonra e2e test yapılsın, max 4 olsun"],
    ["в этом репозитории мы не используем моки"],
    ["このリポジトリではモックを使いません"],
  ])("keeps developer prose that could carry a lesson: %s", (prompt) => {
    expect(couldTeach(prompt)).toBe(true);
  });

  it.each([
    ["ok"],
    ["go on"],
    ["devam et"],
    ["/handbook:review"],
    ["<local-command-stdout>done</local-command-stdout>"],
    // the harness writes these, not the developer — and across the transcripts on one
    // machine "[Request interrupted by user]" was the single most repeated line of all
    ["[Request interrupted by user]"],
    ["[Your previous response had no visible output. Please continue.]"],
  ])("drops what the developer did not type as prose: %s", (prompt) => {
    expect(couldTeach(prompt)).toBe(false);
  });

  it("ignores very long prompts — those are task briefs, not rules", () => {
    expect(couldTeach(`always ${"x".repeat(700)}`)).toBe(false);
  });
});

describe("noteCorrection", () => {
  const at = "2026-08-10T10:00:00Z";

  it("records a prompt with its timestamp", () => {
    const next = noteCorrection([], "always run make fmt before committing", at);

    expect(next).toEqual([{ at, text: "always run make fmt before committing" }]);
  });

  it("records a Turkish rule, which the English patterns could never see", () => {
    const next = noteCorrection([], "burada db'yi asla mocklamayız", at);

    expect(next).toEqual([{ at, text: "burada db'yi asla mocklamayız" }]);
  });

  it("returns null for acks, duplicates, and secret-bearing prompts", () => {
    expect(noteCorrection([], "ok thanks", at)).toBeNull();
    const existing: CorrectionNote[] = [{ at, text: "always run make fmt" }];
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

  it("truncates a long prompt instead of dropping it", () => {
    const notes = noteCorrection([], `never ${"y".repeat(500)}`, at)!;

    expect(notes[0]!.text.length).toBeLessThanOrEqual(400);
  });
});
