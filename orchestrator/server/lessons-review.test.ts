import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hostIdentityOf, queueTaskLesson, taskLessonCandidate } from "./plugin.js";

const REVIEW = join(import.meta.dirname, "..", "..", "dist", "review.js");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// The plugin's own review command, run in a home of its own: what the orchestrator wrote has to be
// something /handbook:review lists, shows and approves, not only something the orchestrator reads back.
function review(home: string, ...args: string[]) {
  const ran = spawnSync(process.execPath, [REVIEW, ...args], { env: { PATH: process.env.PATH, HOME: home, TEAMHANDBOOK_HOME: join(home, ".teamhandbook") }, encoding: "utf8", cwd: home });
  return { code: ran.status, out: `${ran.stdout}${ran.stderr}` };
}

describe("a lesson from a task in the plugin's review queue", () => {
  it("given a lesson the orchestrator queued from a task's review, when /handbook:review lists, shows and approves it for the person, then it is listed as a correction with the person's words, shown unscored, and installed in their skills folder", () => {
    // given
    const home = mkdtempSync(join(tmpdir(), "orchestrator-lessons-review-"));
    dirs.push(home);
    const built = taskLessonCandidate(
      {
        taskId: "tsk_01example",
        title: "Add a refund endpoint",
        scope: "shop-api",
        secretValues: [],
        createdAt: "2026-11-12T09:00:00.000Z",
        draft: { slug: "log-with-the-app-logger", description: "Use when adding logging to shop-api code: log through the app logger, never console.log.", body: "## Rule\n\nLog through `logger` from `src/log.ts`.\n\n## Check\n\n- No `console.log` in the diff.", expect: "no console.log in the diff" },
        signals: [{ kind: "follow-up", text: "use our logger here, never console.log", quotes: [{ path: "src/refunds.ts", lines: "12", text: "console.log(order)" }] }],
      },
      hostIdentityOf([]),
    );
    if ("dropped" in built) throw new Error(built.dropped);
    queueTaskLesson(join(home, ".teamhandbook"), built);

    // when
    const listed = review(home, "list");
    const shown = review(home, "show", "log-with-the-app-logger");
    const approved = review(home, "approve", "log-with-the-app-logger", "--to", "personal");

    // then
    expect(listed.code).toBe(0);
    expect(listed.out).toContain("log-with-the-app-logger");
    expect(listed.out).toContain("[correction]");
    expect(shown.code).toBe(0);
    expect(shown.out).toContain('you said:  "use our logger here, never console.log"');
    expect(shown.out).toContain("score:     n/a");
    expect(approved.code).toBe(0);
    const installed = join(home, ".claude", "skills", "log-with-the-app-logger");
    expect(readFileSync(join(installed, "SKILL.md"), "utf8")).toContain("name: log-with-the-app-logger");
    expect(existsSync(join(installed, "candidate.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(home, ".teamhandbook", "candidates", "log-with-the-app-logger", "candidate.json"), "utf8")).status).toBe("approved");
  });
});
