import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostIdentityOf, keepTaskLesson, queueTaskLesson, readTaskLessonReply, readTaskLessonWire, rejectTaskLesson, taskLesson, taskLessonCandidate, taskLessons } from "./task-lesson.js";
import type { TaskLessonInput, TaskLessonSignal } from "./task-lesson.js";
import { listCandidates, loadMutedFingerprints, readCandidateMeta, writeCandidateMeta } from "./queue.js";
import { candidatesDir } from "./skill-index.js";

const HOST = { names: ["octavia"] };
const TOKEN = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";

const followUp: TaskLessonSignal = {
  kind: "follow-up",
  text: "use our logger here, never console.log",
  quotes: [{ path: "src/payments.ts", lines: "12-14", text: "console.log(order)" }],
};

function input(overrides: Partial<TaskLessonInput> = {}): TaskLessonInput {
  return {
    taskId: "tsk_01example",
    title: "Add a refund endpoint",
    scope: "shop-api",
    draft: {
      slug: "log-with-the-app-logger",
      description: "Use when adding logging to shop-api code: log through the app logger, never console.log.",
      body: "## Rule\n\nLog through `logger` from `src/log.ts`.\n\n## Check\n\n- No `console.log` in the diff.",
      expect: "the diff logs through logger and has no console.log",
    },
    signals: [followUp],
    secretValues: [],
    createdAt: "2026-11-04T09:00:00.000Z",
    ...overrides,
  };
}

describe("task lessons", () => {
  let home: string;
  let skills: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "th-task-lesson-"));
    skills = mkdtempSync(join(tmpdir(), "th-task-lesson-skills-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(skills, { recursive: true, force: true });
  });

  it("given a follow-up a model turned into a draft, when it is queued, then the person's queue holds a pending lesson from the task with their words as its receipt", () => {
    // given
    const lesson = taskLessonCandidate(input(), HOST);
    if ("dropped" in lesson) throw new Error(lesson.dropped);

    // when
    const queued = queueTaskLesson(home, lesson);

    // then
    expect(queued).toEqual({ slug: "log-with-the-app-logger" });
    const meta = readCandidateMeta(join(candidatesDir(home), "log-with-the-app-logger"))!;
    expect(meta).toMatchObject({ status: "pending", origin: "task", kind: "correction", sessionId: "tsk_01example", scope: "shop-api", suggestedTarget: "personal", gate: null });
    const shown = taskLesson(home, "log-with-the-app-logger")!;
    expect(shown.quote).toBe("use our logger here, never console.log");
    expect(shown.skillMd).toContain("name: log-with-the-app-logger");
    expect(shown.skillMd).toContain("Applies ONLY in the shop-api repository");
    expect(shown.skillMd).toContain("distilled from a real review the developer gave an agent's task");
    const grounded = JSON.parse(readFileSync(join(candidatesDir(home), "log-with-the-app-logger", "grounded-case.json"), "utf8"));
    expect(grounded).toMatchObject({ edits: ["src/payments.ts"], task: { goal: "Add a refund endpoint" }, expect: "the diff logs through logger and has no console.log" });
  });

  it("given a denied command whose target carries a token, when the candidate is built, then it is dropped and nothing reaches the queue", () => {
    // given
    const denial: TaskLessonSignal = { kind: "denial", note: "never push from a task", tool: "Bash", target: `git remote set-url origin https://${TOKEN}@example.test/x.git` };

    // when
    const lesson = taskLessonCandidate(input({ signals: [denial] }), HOST);

    // then
    expect(lesson).toEqual({ dropped: "secret" });
    expect(existsSync(candidatesDir(home))).toBe(false);
  });

  it("given a diff line quoted back that holds a key, when the candidate is built, then it is dropped", () => {
    // given
    const quoted: TaskLessonSignal = { kind: "follow-up", text: "read this from the environment instead", quotes: [{ path: "src/client.ts", lines: "3", text: `const key = "${TOKEN}";` }] };

    // when
    const lesson = taskLessonCandidate(input({ signals: [quoted] }), HOST);

    // then
    expect(lesson).toEqual({ dropped: "secret" });
  });

  it("given the names a caller read itself, when they are made a host, then a name that is an ordinary word is left out, so the skill keeps its words", () => {
    // given
    const names = ["node", "dev", "octavia", "Octavia", undefined, null];

    // when
    const host = hostIdentityOf(names);
    const lesson = taskLessonCandidate(input({ draft: { ...input().draft, body: "Run node scripts/build.mjs before octavia reviews it." } }), host);

    // then
    expect(host).toEqual({ names: ["octavia"] });
    if ("dropped" in lesson) throw new Error(lesson.dropped);
    expect(lesson.skillMd).toContain("Run node scripts/build.mjs before <user> reviews it.");
  });

  it("given a task secret no pattern knows, when the person's words or the model's draft hold its value, then the candidate is dropped", () => {
    // given
    const secretValues = ["correct-horse-battery-staple"];
    const said: TaskLessonSignal = { kind: "follow-up", text: "the staging password is correct-horse-battery-staple, use it", quotes: [] };
    const draft = { ...input().draft, body: "Sign in to staging with correct-horse-battery-staple." };

    // when
    const fromWords = taskLessonCandidate(input({ signals: [said], secretValues }), HOST);
    const fromDraft = taskLessonCandidate(input({ draft, secretValues }), HOST);
    const clean = taskLessonCandidate(input({ secretValues }), HOST);

    // then
    expect(fromWords).toEqual({ dropped: "secret" });
    expect(fromDraft).toEqual({ dropped: "secret" });
    expect("dropped" in clean).toBe(false);
  });

  it("given a draft whose body holds a credential the model copied, when the candidate is built, then it is dropped", () => {
    // given
    const draft = { ...input().draft, body: `Authenticate with ${TOKEN} before calling the API.` };

    // when
    const lesson = taskLessonCandidate(input({ draft }), HOST);

    // then
    expect(lesson).toEqual({ dropped: "secret" });
  });

  it("given the machine's account name and home path in what the person said, when the candidate is built, then both are masked in the receipt and the skill", () => {
    // given
    const signal: TaskLessonSignal = { kind: "follow-up", text: "octavia prefers the logger in /home/octavia/shop-api/src/log.ts", quotes: [] };
    const draft = { ...input().draft, description: "Use when logging the way octavia does.", body: "Import it from /home/octavia/shop-api/src/log.ts as octavia does." };

    // when
    const lesson = taskLessonCandidate(input({ signals: [signal], draft }), HOST);

    // then
    if ("dropped" in lesson) throw new Error(lesson.dropped);
    expect(lesson.groundedCase.quote).not.toContain("octavia");
    expect(lesson.skillMd).not.toContain("octavia");
    expect(lesson.skillMd).toContain("~/shop-api/src/log.ts");
    expect(lesson.meta.description).toBe("Use when logging the way <user> does.");
  });

  it("given a lesson the person rejected for good, when a later task teaches the same rule, then it is not queued again", () => {
    // given
    const first = taskLessonCandidate(input(), HOST);
    if ("dropped" in first) throw new Error(first.dropped);
    queueTaskLesson(home, first);
    rejectTaskLesson(home, "log-with-the-app-logger", "2026-11-04T10:00:00.000Z", true);

    // when
    const again = taskLessonCandidate(input({ taskId: "tsk_02example" }), HOST);
    if ("dropped" in again) throw new Error(again.dropped);
    const queued = queueTaskLesson(home, again);

    // then
    expect(queued).toEqual({ dropped: "muted" });
    expect(loadMutedFingerprints(home).has(first.fingerprint)).toBe(true);
    expect(taskLessons(home).map((m) => m.status)).toEqual(["rejected"]);
  });

  it("given the same lesson already pending, when it is queued again, then it is a duplicate", () => {
    // given
    const lesson = taskLessonCandidate(input(), HOST);
    if ("dropped" in lesson) throw new Error(lesson.dropped);
    queueTaskLesson(home, lesson);

    // when
    const queued = queueTaskLesson(home, lesson);

    // then
    expect(queued).toEqual({ dropped: "duplicate" });
    expect(listCandidates(home)).toHaveLength(1);
  });

  it("given another candidate already holds the name, when a different lesson takes it, then it is written under the next name with its frontmatter renamed", () => {
    // given
    const taken = join(candidatesDir(home), "log-with-the-app-logger");
    mkdirSync(taken, { recursive: true });
    writeFileSync(join(taken, "SKILL.md"), "---\nname: log-with-the-app-logger\ndescription: x\nscope: team\n---\n");
    writeCandidateMeta(taken, { slug: "log-with-the-app-logger", status: "pending", createdAt: "2026-11-01T00:00:00.000Z", scope: "team", description: "x", fingerprint: "0000000000000000", sessionId: "s", gate: null, origin: "harvest" });
    const lesson = taskLessonCandidate(input(), HOST);
    if ("dropped" in lesson) throw new Error(lesson.dropped);

    // when
    const queued = queueTaskLesson(home, lesson);

    // then
    expect(queued).toEqual({ slug: "log-with-the-app-logger-2" });
    expect(readFileSync(join(candidatesDir(home), "log-with-the-app-logger-2", "SKILL.md"), "utf8")).toContain("name: log-with-the-app-logger-2");
    expect(readFileSync(join(taken, "SKILL.md"), "utf8")).toContain("scope: team");
  });

  it("given a pending lesson, when the person keeps it, then it is installed in their skills folder once and the queue records the approval", () => {
    // given
    const lesson = taskLessonCandidate(input(), HOST);
    if ("dropped" in lesson) throw new Error(lesson.dropped);
    queueTaskLesson(home, lesson);

    // when
    const kept = keepTaskLesson(home, "log-with-the-app-logger", skills, "2026-11-04T10:00:00.000Z", HOST);
    const twice = keepTaskLesson(home, "log-with-the-app-logger", skills, "2026-11-04T10:01:00.000Z", HOST);

    // then
    expect(kept.ok).toBe(true);
    expect(readFileSync(join(skills, "log-with-the-app-logger", "SKILL.md"), "utf8")).toContain("name: log-with-the-app-logger");
    expect(existsSync(join(skills, "log-with-the-app-logger", "candidate.json"))).toBe(false);
    expect(taskLessons(home)[0]).toMatchObject({ status: "approved", deliveredMode: "personal" });
    expect(twice).toEqual({ ok: false, error: 'lesson "log-with-the-app-logger" is already approved' });
  });

  it("given a harvested candidate in the same queue, when the orchestrator asks to keep or reject it, then it is refused and left pending", () => {
    // given
    const other = join(candidatesDir(home), "fix-npm-test");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "SKILL.md"), "---\nname: fix-npm-test\ndescription: x\nscope: team\n---\n");
    writeCandidateMeta(other, { slug: "fix-npm-test", status: "pending", createdAt: "2026-11-01T00:00:00.000Z", scope: "team", description: "x", fingerprint: "1111111111111111", sessionId: "s", gate: null, origin: "harvest" });

    // when
    const kept = keepTaskLesson(home, "fix-npm-test", skills, "2026-11-04T10:00:00.000Z", HOST);
    const rejected = rejectTaskLesson(home, "fix-npm-test", "2026-11-04T10:00:00.000Z", false);

    // then
    expect(kept.ok).toBe(false);
    expect(rejected.ok).toBe(false);
    expect(readCandidateMeta(other)!.status).toBe("pending");
    expect(taskLesson(home, "fix-npm-test")).toBeNull();
  });

  it("given the makings a team's orchestrator sent a machine, when they are read there, then a well-formed lesson comes through whole and a malformed part refuses it", () => {
    // given
    const { secretValues: _values, ...wire } = input();
    const malformed = [
      { ...wire, signals: [{ ...followUp, quotes: [{ path: "/etc/passwd", lines: "1", text: "x" }] }] },
      { ...wire, signals: [{ ...followUp, quotes: [{ path: "src/../../.ssh/id_rsa", lines: "1", text: "x" }] }] },
      { ...wire, draft: { ...wire.draft, slug: "Log With Logger" } },
      { ...wire, draft: { ...wire.draft, body: "x".repeat(8001) } },
      { ...wire, signals: [] },
      { ...wire, title: "Add a refund\0 endpoint" },
      { ...wire, taskId: "tsk_01/../x" },
    ];

    // when
    const read = readTaskLessonWire(JSON.parse(JSON.stringify(wire)));
    const refused = malformed.map((m) => readTaskLessonWire(JSON.parse(JSON.stringify(m))));

    // then
    expect(read).toEqual(wire);
    expect(refused).toEqual(malformed.map(() => null));
  });

  it("given an undo's reason, when the machine reads it and builds the candidate, then a reason with a key drops the lesson and an empty one is out of shape", () => {
    // given
    const wire = { ...input(), signals: [{ kind: "undo", reason: "never add a lock file, we use pnpm" }] };
    const leaking = { ...wire, signals: [{ kind: "undo", reason: `use ${TOKEN} instead` }] };
    const empty = { ...wire, signals: [{ kind: "undo", reason: "" }] };

    // when
    const read = readTaskLessonWire(JSON.parse(JSON.stringify(wire)));
    const built = taskLessonCandidate({ ...read!, secretValues: [] }, HOST);
    const dropped = taskLessonCandidate({ ...readTaskLessonWire(JSON.parse(JSON.stringify(leaking)))!, secretValues: [] }, HOST);

    // then
    if ("dropped" in built) throw new Error(built.dropped);
    expect(built.groundedCase.quote).toBe("never add a lock file, we use pnpm");
    expect(dropped).toEqual({ dropped: "secret" });
    expect(readTaskLessonWire(JSON.parse(JSON.stringify(empty)))).toBeNull();
  });

  it("given makings that passed the orchestrator, when the machine builds the candidate with its own account and secrets, then its account name is masked and a value only it knows drops the lesson", () => {
    // given
    const wire = readTaskLessonWire(JSON.parse(JSON.stringify({ ...input(), draft: { ...input().draft, body: "Ask octavia before changing the logger; the vault key is mysecretvaultkey99." } })))!;

    // when
    const masked = taskLessonCandidate({ ...wire, secretValues: [] }, hostIdentityOf(["octavia"]));
    const screened = taskLessonCandidate({ ...wire, secretValues: ["mysecretvaultkey99"] }, hostIdentityOf(["octavia"]));

    // then
    if ("dropped" in masked) throw new Error(masked.dropped);
    expect(masked.skillMd).toContain("Ask <user> before changing the logger");
    expect(screened).toEqual({ dropped: "secret" });
  });

  it("given the model's reply, when it is read, then a draft, an explicit no and anything else are told apart", () => {
    // given
    const draft = JSON.stringify({ name: "Log With The App Logger", description: "Use when logging.", body: "Use logger.", expect: "no console.log" });

    // when
    const read = [readTaskLessonReply(draft), readTaskLessonReply("NO LESSON"), readTaskLessonReply("I think you should use the logger.")];

    // then
    expect(read[0]).toMatchObject({ slug: "log-with-the-app-logger" });
    expect(read[1]).toBe("none");
    expect(read[2]).toBeNull();
  });
});
