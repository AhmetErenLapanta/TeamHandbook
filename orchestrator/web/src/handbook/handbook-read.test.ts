import { afterEach, describe, expect, it, vi } from "vitest";
import { forgetAnswers } from "../last-answer";
import { handbookRead } from "./handbook-read";

afterEach(() => {
  forgetAnswers();
  vi.unstubAllGlobals();
});

describe("what the handbook reads keep for the next time", () => {
  it("given a sources read and a defaults read that answered, when the form asks for the last of each, then it has them at once, and a folder's read is its own", async () => {
    // given
    const answers: Record<string, unknown> = {
      "/api/handbook/sources": { sources: [{ id: "yours" }], readAt: "2026-01-01T00:00:00.000Z" },
      "/api/handbook/defaults": { off: { skills: [{ source: "yours", name: "triage" }] } },
    };
    vi.stubGlobal("fetch", async (url: string) => new Response(JSON.stringify(answers[new URL(url, "http://x").pathname]), { headers: { "content-type": "application/json" } }));

    // when
    const before = [handbookRead.lastSources(), handbookRead.lastDefaults()];
    await handbookRead.sources();
    await handbookRead.defaults();

    // then
    expect(before).toEqual([undefined, undefined]);
    expect(handbookRead.lastSources()).toMatchObject({ sources: [{ id: "yours" }] });
    expect(handbookRead.lastDefaults()).toMatchObject({ skills: [{ source: "yours", name: "triage" }], sources: [] });
    expect(handbookRead.lastSources("/work/payments-api")).toBeUndefined();
  });
});
