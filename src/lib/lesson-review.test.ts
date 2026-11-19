import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keepLessonInto, pendingLesson, pendingLessons, rejectLesson } from "./lesson-review.js";
import { listCandidates, loadMutedFingerprints, writeCandidateMeta } from "./queue.js";
import { candidatesDir } from "./skill-index.js";

const HOST = { names: ["octavia"] };

function candidate(home: string, slug: string, fields: Record<string, unknown> = {}, body = "Run the snapshot update before the suite, and commit it.") {
  const dir = join(candidatesDir(home), slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${slug}\ndescription: Use when the snapshot is stale.\n---\n\n${body}\n`);
  writeFileSync(join(dir, "grounded-case.json"), JSON.stringify({ quote: "update the snapshot first" }));
  writeCandidateMeta(dir, { slug, status: "pending", createdAt: "2026-11-01T00:00:00.000Z", scope: "team", description: "Use when the snapshot is stale.", fingerprint: `fp-${slug}`, sessionId: "ses_1", gate: null, origin: "harvest", ...fields } as never);
}

describe("the lessons waiting in the review queue", () => {
  let home: string;
  let skills: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "th-lesson-review-"));
    skills = mkdtempSync(join(tmpdir(), "th-lesson-review-skills-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(skills, { recursive: true, force: true });
  });

  it("given pending lessons from sessions and a task, one decided and one of the demo, when a page is listed, then only the pending ones come newest first with their first line and the total", () => {
    // given
    candidate(home, "fix-stale-snapshot", { createdAt: "2026-11-02T00:00:00.000Z" });
    candidate(home, "log-with-the-app-logger", { createdAt: "2026-11-03T00:00:00.000Z", origin: "task", sessionId: "tsk_01example" }, "## Rule\n\nLog through the app logger.");
    candidate(home, "already-kept", { status: "approved" });
    candidate(home, "demo-draft", { demo: true });

    // when
    const first = pendingLessons(home, 0, 1);
    const second = pendingLessons(home, 1, 1);

    // then
    expect(first.total).toBe(2);
    expect(first.items.map((i) => [i.slug, i.origin, i.sessionId, i.firstLine])).toEqual([["log-with-the-app-logger", "task", "tsk_01example", "Rule"]]);
    expect(second.items.map((i) => i.slug)).toEqual(["fix-stale-snapshot"]);
  });

  it("given a lesson whose first line looks like a credential, when it is listed, then the line is withheld", () => {
    // given
    candidate(home, "leaky", {}, "Sign in with ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8");

    // when
    const { items } = pendingLessons(home, 0, 10);

    // then
    expect(items[0]!.firstLine).toContain("withheld");
  });

  it("given a pending lesson, when it is read and kept into a skills folder, then its text and quote are read first and the queue records the approval; a second keep is refused", () => {
    // given
    candidate(home, "fix-stale-snapshot");

    // when
    const read = pendingLesson(home, "fix-stale-snapshot");
    const kept = keepLessonInto(home, "fix-stale-snapshot", skills, "2026-11-05T00:00:00.000Z", HOST);
    const again = keepLessonInto(home, "fix-stale-snapshot", skills, "2026-11-05T00:00:00.000Z", HOST);

    // then
    expect(read).toMatchObject({ quote: "update the snapshot first" });
    expect(read!.skillMd).toContain("Run the snapshot update");
    expect(kept.ok).toBe(true);
    expect(readFileSync(join(skills, "fix-stale-snapshot", "SKILL.md"), "utf8")).toContain("name: fix-stale-snapshot");
    expect(listCandidates(home, "approved").map((m) => m.slug)).toEqual(["fix-stale-snapshot"]);
    expect(again.ok).toBe(false);
  });

  it("given a lesson that holds a credential, when it is kept into a skills folder, then it is refused, nothing is written and it stays pending", () => {
    // given
    candidate(home, "leaky", {}, "Sign in with ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8");

    // when
    const kept = keepLessonInto(home, "leaky", skills, "2026-11-05T00:00:00.000Z", HOST);

    // then
    expect(kept).toMatchObject({ ok: false, error: expect.stringContaining("credential") });
    expect(existsSync(join(skills, "leaky"))).toBe(false);
    expect(listCandidates(home, "pending").map((m) => m.slug)).toEqual(["leaky"]);
  });

  it("given pending lessons, when one is rejected for good and an unsafe name and a decided lesson are asked for, then the first is muted and the others are refused", () => {
    // given
    candidate(home, "fix-stale-snapshot");
    candidate(home, "already-kept", { status: "approved" });

    // when
    const rejected = rejectLesson(home, "fix-stale-snapshot", "2026-11-05T00:00:00.000Z", true);
    const unsafe = rejectLesson(home, "../../etc", "2026-11-05T00:00:00.000Z", false);
    const decided = rejectLesson(home, "already-kept", "2026-11-05T00:00:00.000Z", false);

    // then
    expect(rejected).toMatchObject({ ok: true, muted: true });
    expect(loadMutedFingerprints(home).size).toBe(1);
    expect(unsafe.ok).toBe(false);
    expect(decided.ok).toBe(false);
    expect(existsSync(join(skills, "already-kept"))).toBe(false);
  });
});
