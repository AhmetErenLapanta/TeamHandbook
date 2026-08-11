import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSkillUsage, recordSkillUse, handbookSkills, summarizeUsage, usageFile } from "./usage.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "handbook-usage-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("recordSkillUse", () => {
  it("given no prior usage, when a skill fires, then it starts at one", () => {
    recordSkillUse("no-db-mocks", home, "2026-08-11T10:00:00.000Z");

    expect(readSkillUsage(home)).toEqual({
      "no-db-mocks": { count: 1, lastAt: "2026-08-11T10:00:00.000Z" },
    });
  });

  it("given prior usage, when the same skill fires again, then the count accumulates and the timestamp moves", () => {
    recordSkillUse("no-db-mocks", home, "2026-08-11T10:00:00.000Z");
    recordSkillUse("no-db-mocks", home, "2026-08-12T09:00:00.000Z");

    expect(readSkillUsage(home)["no-db-mocks"]).toEqual({
      count: 2,
      lastAt: "2026-08-12T09:00:00.000Z",
    });
  });

  it("given a hook payload without a skill name, when recording, then nothing is written", () => {
    recordSkillUse("", home);

    expect(readSkillUsage(home)).toEqual({});
  });

  it("given a corrupted usage file, when a skill fires, then it recovers instead of throwing", () => {
    writeFileSync(usageFile(home), "{not json");

    recordSkillUse("no-db-mocks", home, "2026-08-11T10:00:00.000Z");

    expect(readSkillUsage(home)["no-db-mocks"]?.count).toBe(1);
  });

  it("given a file whose entries are the wrong shape, when read, then the junk entries are dropped", () => {
    writeFileSync(usageFile(home), JSON.stringify({ good: { count: 3, lastAt: "x" }, bad: 7 }));

    expect(readSkillUsage(home)).toEqual({ good: { count: 3, lastAt: "x" } });
  });
});

describe("summarizeUsage", () => {
  it("given usage for a skill the user deleted, when summarizing, then it is not counted", () => {
    const usage = { kept: { count: 4, lastAt: "x" }, deleted: { count: 9, lastAt: "x" } };

    expect(summarizeUsage(usage, ["kept"])).toEqual({
      fired: 1,
      totalUses: 4,
      topSkill: { slug: "kept", count: 4 },
    });
  });

  it("given installed skills that have never fired, when summarizing, then nothing is reported as used", () => {
    expect(summarizeUsage({}, ["a", "b"])).toEqual({ fired: 0, totalUses: 0, topSkill: null });
  });

  it("given several used skills, when summarizing, then the most-used one is named", () => {
    const usage = { a: { count: 2, lastAt: "x" }, b: { count: 7, lastAt: "x" } };

    expect(summarizeUsage(usage, ["a", "b"]).topSkill).toEqual({ slug: "b", count: 7 });
  });
});

describe("handbookSkills", () => {
  const approve = (slug: string, mode: string, deliveredTo: string) => {
    mkdirSync(join(home, "candidates", slug), { recursive: true });
    writeFileSync(
      join(home, "candidates", slug, "candidate.json"),
      JSON.stringify({
        status: "approved",
        description: "d",
        scope: "repo",
        createdAt: "2026-08-01T00:00:00Z",
        deliveredMode: mode,
        deliveredTo,
      }),
    );
  };

  it("given delivery renamed the skill on a slug collision, when listing, then the installed name is used", () => {
    approve("no-db-mocks", "personal", "/home/u/.claude/skills/no-db-mocks-2");

    expect(handbookSkills(home)).toEqual(["no-db-mocks-2"]);
  });

  it("given a team-mode candidate, when listing, then its PR url is not mistaken for an installed skill", () => {
    approve("shared-one", "team", "https://github.com/acme/skills/pull/7");

    expect(handbookSkills(home)).toEqual([]);
  });

  it("given a candidate approved before delivery paths were recorded, when listing, then the slug is used", () => {
    approve("older-one", "personal", "");

    expect(handbookSkills(home)).toEqual(["older-one"]);
  });
});
