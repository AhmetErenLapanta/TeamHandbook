import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lessonOpHere, queueLessonHere } from "./lessons.js";

const makings = (body = "Log through `logger` from `src/log.ts`, never console.log.") => ({
  taskId: "tsk_01example",
  title: "Add a refund endpoint",
  scope: "shop-api",
  createdAt: "2026-11-04T09:00:00.000Z",
  draft: { slug: "log-with-the-app-logger", description: "Use when adding logging to shop-api: log through the app logger.", body, expect: "no console.log in the diff" },
  signals: [{ kind: "follow-up", text: "use our logger here, never console.log", quotes: [{ path: "src/refunds.ts", lines: "12-14", text: "console.log(order)" }] }],
});

describe("a lesson queued on its person's machine", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "runner-lessons-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("given makings in shape, when the machine queues them, then the lesson waits in the person's own review queue with the account name masked", () => {
    // given
    const ask = { nonce: "n1", lesson: makings("Ask octavia before changing the logger.") };

    // when
    const answer = queueLessonHere(ask, join(home, "octavia"), { USER: "octavia", TEAMHANDBOOK_HOME: join(home, "handbook") });

    // then
    expect(answer).toEqual({ slug: "log-with-the-app-logger" });
    const dir = join(home, "handbook", "candidates", "log-with-the-app-logger");
    expect(JSON.parse(readFileSync(join(dir, "candidate.json"), "utf8"))).toMatchObject({ status: "pending", origin: "task", sessionId: "tsk_01example" });
    expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toContain("Ask <user> before changing the logger.");
  });

  it("given makings that hold the value of a credential in the person's environment, when the machine queues them, then nothing is written", () => {
    // given
    const ask = { nonce: "n2", lesson: makings("Sign in with plainvaultpassword42 first.") };

    // when
    const answer = queueLessonHere(ask, home, { USER: "octavia", TEAMHANDBOOK_HOME: join(home, "handbook"), VAULT_PASSWORD: "plainvaultpassword42" });

    // then
    expect(answer).toEqual({ dropped: "secret" });
    expect(existsSync(join(home, "handbook", "candidates"))).toBe(false);
  });

  it("given makings out of shape, when the machine reads them, then it refuses and writes nothing", () => {
    // given
    const outside = { ...makings(), signals: [{ kind: "follow-up", text: "read this", quotes: [{ path: "../../.ssh/id_rsa", lines: "1", text: "x" }] }] };

    // when
    const answers = [queueLessonHere({ nonce: "n3", lesson: outside }, home, { TEAMHANDBOOK_HOME: join(home, "handbook") }), queueLessonHere({ nonce: "n4", lesson: "not a lesson" }, home, {})];

    // then
    expect(answers).toEqual([{ refused: "the lesson's makings are out of shape" }, { refused: "the lesson's makings are out of shape" }]);
    expect(existsSync(join(home, "handbook"))).toBe(false);
    expect(existsSync(join(home, ".teamhandbook"))).toBe(false);
  });

  it("given no TEAMHANDBOOK_HOME, when the machine queues a lesson, then it lands under the person's own home", () => {
    // when
    const answer = queueLessonHere({ nonce: "n5", lesson: makings() }, home, { USER: "octavia" });

    // then
    expect(answer).toEqual({ slug: "log-with-the-app-logger" });
    expect(existsSync(join(home, ".teamhandbook", "candidates", "log-with-the-app-logger", "SKILL.md"))).toBe(true);
  });

  it("given a lesson queued from a task, when its person keeps it from the task's page, then it is installed in their skills folder and the queue records the approval", () => {
    // given
    const env = { USER: "octavia", TEAMHANDBOOK_HOME: join(home, "handbook"), CLAUDE_CONFIG_DIR: join(home, "claude") };
    queueLessonHere({ nonce: "n1", lesson: makings() }, home, env);

    // when
    const kept = lessonOpHere({ nonce: "n2", taskId: "tsk_01example", slug: "log-with-the-app-logger", op: "keep" }, home, env);

    // then
    expect(kept).toEqual({ decided: "approved", muted: false });
    expect(readFileSync(join(home, "claude", "skills", "log-with-the-app-logger", "SKILL.md"), "utf8")).toContain("name: log-with-the-app-logger");
    expect(JSON.parse(readFileSync(join(home, "handbook", "candidates", "log-with-the-app-logger", "candidate.json"), "utf8")).status).toBe("approved");
  });

  it("given a harvested candidate, another task's lesson and an unsafe name, when the page asks to keep each, then the machine refuses all three and installs nothing", () => {
    // given
    const env = { USER: "octavia", TEAMHANDBOOK_HOME: join(home, "handbook"), CLAUDE_CONFIG_DIR: join(home, "claude") };
    queueLessonHere({ nonce: "n1", lesson: makings() }, home, env);
    const harvested = join(home, "handbook", "candidates", "fix-npm-test");
    mkdirSync(harvested, { recursive: true });
    writeFileSync(join(harvested, "SKILL.md"), "---\nname: fix-npm-test\ndescription: x\nscope: team\n---\n");
    writeFileSync(join(harvested, "candidate.json"), JSON.stringify({ slug: "fix-npm-test", status: "pending", createdAt: "2026-11-01T00:00:00.000Z", scope: "team", description: "x", fingerprint: "1111111111111111", sessionId: "tsk_01example", gate: null, origin: "harvest" }));

    // when
    const answers = [
      lessonOpHere({ nonce: "n2", taskId: "tsk_01example", slug: "fix-npm-test", op: "keep" }, home, env),
      lessonOpHere({ nonce: "n3", taskId: "tsk_02other", slug: "log-with-the-app-logger", op: "keep" }, home, env),
      lessonOpHere({ nonce: "n4", taskId: "tsk_01example", slug: "../../.ssh", op: "keep" }, home, env),
      lessonOpHere({ nonce: "n5", taskId: "tsk_01example", slug: "log-with-the-app-logger", op: "delete" as "keep" }, home, env),
    ];

    // then
    expect(answers.every((a) => "refused" in a)).toBe(true);
    expect(existsSync(join(home, "claude", "skills"))).toBe(false);
  });

  it("given a lesson edited in the queue to hold an environment credential, when the page asks to read it, then the machine refuses rather than send it", () => {
    // given
    const env = { USER: "octavia", TEAMHANDBOOK_HOME: join(home, "handbook"), VAULT_PASSWORD: "plainvaultpassword42" };
    queueLessonHere({ nonce: "n1", lesson: makings() }, home, env);
    const file = join(home, "handbook", "candidates", "log-with-the-app-logger", "SKILL.md");
    writeFileSync(file, readFileSync(file, "utf8") + "\nSign in with plainvaultpassword42.\n");

    // when
    const read = lessonOpHere({ nonce: "n2", taskId: "tsk_01example", slug: "log-with-the-app-logger", op: "read" }, home, env);
    const rejected = lessonOpHere({ nonce: "n3", taskId: "tsk_01example", slug: "log-with-the-app-logger", op: "reject", never: true }, home, env);

    // then
    expect(read).toEqual({ refused: "the lesson holds what looks like a credential; open it with /handbook:review on this machine" });
    expect(rejected).toEqual({ decided: "rejected", muted: true });
  });
});
