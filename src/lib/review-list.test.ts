import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveOlderLessons,
  foldedAllRefusal,
  formatLessonArchive,
  formatReviewQueue,
  reviewQueue,
} from "./review-list.js";
import {
  candidateMetaFile,
  formatCandidateList,
  listCandidates,
  readArchiveManifest,
  readCandidateMeta,
  restoreArchived,
  writeCandidateMeta,
} from "./queue.js";
import type { CandidateMeta } from "./queue.js";
import { candidatesDir } from "./skill-index.js";

let home: string;
const NOW = Date.parse("2026-10-06T12:00:00Z");

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "handbook-review-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function seed(slug: string, overrides: Partial<CandidateMeta> = {}): void {
  const dir = join(candidatesDir(home), slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${slug}\ndescription: ${slug} description\n---\n\nBody.\n`);
  writeCandidateMeta(dir, {
    slug,
    status: "pending",
    createdAt: "2026-10-05T12:00:00Z",
    scope: "team",
    description: `${slug} description`,
    fingerprint: `fp-${slug}`,
    sessionId: "s1",
    gate: { total: 6, scores: {} },
    origin: "harvest",
    kind: "discovery",
    ...overrides,
  });
}

function lessonHarvestOn(): void {
  writeFileSync(join(home, "config.json"), JSON.stringify({ harvest: { lessons: true } }));
}

/** A queue as it stands after months of the lesson harvest, with the history miner's
 * drafts arriving behind it. */
function backlogWithDrafts(): void {
  seed("prefer-rg-over-grep", { kind: "correction", createdAt: "2026-09-01T12:00:00Z" });
  seed("flaky-port-retry", { kind: "error-fix", createdAt: "2026-09-02T12:00:00Z" });
  seed("cache-busting-note", { createdAt: "2026-10-06T11:00:00Z" });
  seed("add-route", {
    origin: "mine",
    kind: "procedure",
    scope: "project",
    gate: null,
    createdAt: "2026-10-04T12:00:00Z",
  });
}

describe("the review first screen", () => {
  it("given the lesson harvest is off, when the queue is listed, then the drafts lead and the older lessons are one line", () => {
    backlogWithDrafts();

    const screen = formatReviewQueue(reviewQueue(home), NOW);

    expect(screen).toBe(
      [
        "Pending candidates (1), newest first:",
        "",
        "  1. add-route  [procedure]  [project]  gate n/a  ·  2d ago  ·  from unknown project",
        "     add-route description",
        "     draft from repository history: a skeleton and a measured file map; steps the history cannot show are listed, not guessed",
        "",
        '3 older lesson candidates from before the harvest was switched off are not listed: archive them all with "review.js archive-lessons" (reversible, nothing is deleted) or show them with "review.js list --lessons".',
      ].join("\n"),
    );
  });

  it("given the lesson harvest is on, when the queue is listed, then the screen is the one it always was", () => {
    backlogWithDrafts();
    lessonHarvestOn();

    const screen = formatReviewQueue(reviewQueue(home), NOW);

    expect(screen).toBe(formatCandidateList(listCandidates(home, "pending"), NOW));
    expect(screen).toBe(
      [
        "Pending candidates (4), newest first:",
        "",
        "  1. cache-busting-note  [discovery]  [team]  gate 6/10  ·  1h ago  ·  from unknown project",
        "     cache-busting-note description",
        "  2. add-route  [procedure]  [project]  gate n/a  ·  2d ago  ·  from unknown project",
        "     add-route description",
        "     draft from repository history: a skeleton and a measured file map; steps the history cannot show are listed, not guessed",
        "  3. flaky-port-retry  [error-fix]  [team]  gate 6/10  ·  34d ago  ·  from unknown project",
        "     flaky-port-retry description",
        "  4. prefer-rg-over-grep  [correction]  [team]  gate 6/10  ·  35d ago  ·  from unknown project",
        "     prefer-rg-over-grep description",
      ].join("\n"),
    );
  });

  it("given only older lessons are waiting, when the queue is listed, then the one line is the whole screen", () => {
    seed("cache-busting-note");

    expect(formatReviewQueue(reviewQueue(home), NOW)).toBe(
      '1 older lesson candidate from before the harvest was switched off is not listed: archive it with "review.js archive-lessons" (reversible, nothing is deleted) or show it with "review.js list --lessons".',
    );
  });

  it("given a draft and a newer capture, when the harvest is off, then the draft leads and the header says the order is not recency", () => {
    seed("add-route", { origin: "mine", kind: "procedure", gate: null, createdAt: "2026-10-04T12:00:00Z" });
    seed("asked-for-capture", { origin: undefined, kind: "procedure", createdAt: "2026-10-06T11:00:00Z" });

    const screen = formatReviewQueue(reviewQueue(home), NOW);

    expect(screen.split("\n")[0]).toBe("Pending candidates (2), repository drafts first, then newest first:");
    expect(screen.indexOf("1. add-route")).toBeLessThan(screen.indexOf("2. asked-for-capture"));
  });

  it("given a capture the person asked for, when the harvest is off, then it stays on the screen rather than in the folded line", () => {
    seed("cache-busting-note");
    seed("asked-for-capture", { origin: undefined, kind: "procedure" });

    const queue = reviewQueue(home);

    expect(queue.listed.map((m) => m.slug)).toEqual(["asked-for-capture"]);
    expect(queue.olderLessons.map((m) => m.slug)).toEqual(["cache-busting-note"]);
  });
});

describe("archiving the older lessons in one step", () => {
  it("given the harvest is off, when they are archived, then each candidate.json stays with its status archived and the drafts stay pending", () => {
    backlogWithDrafts();

    const result = archiveOlderLessons(home, () => "2026-10-06T12:00:00.000Z");

    expect(result.archived.sort()).toEqual(["cache-busting-note", "flaky-port-retry", "prefer-rg-over-grep"]);
    for (const slug of result.archived) {
      const dir = join(candidatesDir(home), slug);
      expect(existsSync(candidateMetaFile(dir))).toBe(true);
      expect(existsSync(join(dir, "SKILL.md"))).toBe(true);
      expect(readCandidateMeta(dir)?.status).toBe("archived");
    }
    expect(readCandidateMeta(join(candidatesDir(home), "add-route"))?.status).toBe("pending");
    expect(reviewQueue(home)).toMatchObject({ olderLessons: [] });
  });

  it("given an archive was made, when it is restored from its manifest, then every lesson is pending again", () => {
    backlogWithDrafts();
    const result = archiveOlderLessons(home, () => "2026-10-06T12:00:00.000Z");

    const restored = restoreArchived(home, readArchiveManifest(result.manifestPath!)!);

    expect(restored.restored.sort()).toEqual(["cache-busting-note", "flaky-port-retry", "prefer-rg-over-grep"]);
    expect(listCandidates(home, "pending")).toHaveLength(4);
  });

  it("given an archive was made, when it is reported, then it says nothing was deleted and how to list and undo it", () => {
    backlogWithDrafts();

    const result = archiveOlderLessons(home, () => "2026-10-06T12:00:00.000Z");

    expect(formatLessonArchive(result)).toBe(
      [
        "Archived 3 older lesson candidates - archived, not deleted.",
        "  list them:          review.js list --archived",
        `  put them all back:  review.js restore "${result.manifestPath}"`,
      ].join("\n"),
    );
  });

  it("given the harvest is on, when archiving is asked for, then nothing moves because those lessons are the live queue", () => {
    backlogWithDrafts();
    lessonHarvestOn();

    const result = archiveOlderLessons(home);

    expect(result).toEqual({ archived: [], skipped: [] });
    expect(formatLessonArchive(result)).toBe("No older lesson candidates are waiting, so nothing was archived.");
    expect(listCandidates(home, "pending")).toHaveLength(4);
  });
});

describe("--all on a screen that folded everything", () => {
  it("given only folded lessons wait, when approve --all is asked for, then it says they are folded and how to reach them", () => {
    seed("cache-busting-note");
    seed("flaky-port-retry", { kind: "error-fix" });

    expect(foldedAllRefusal(reviewQueue(home), "approve")).toBe(
      'nothing on the review screen to approve: 2 older lesson candidates are folded, and --all reaches only what ' +
        'the screen lists. Show them with "review.js list --lessons" and name the ones to approve, or archive them ' +
        'with "review.js archive-lessons".',
    );
  });

  it("given the screen lists a draft, when reject --all is asked for, then there is nothing to explain", () => {
    backlogWithDrafts();

    expect(foldedAllRefusal(reviewQueue(home), "reject")).toBeNull();
  });

  it("given nothing is pending at all, when approve --all is asked for, then there is nothing folded to point at", () => {
    expect(foldedAllRefusal(reviewQueue(home), "approve")).toBeNull();
  });
});
