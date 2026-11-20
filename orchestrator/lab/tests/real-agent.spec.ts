import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { cleanMachine, freePort } from "../clean-machine.js";
import { browserStandIn, claudeStandIn, install, ORCHESTRATOR_DIR, signInAt, until } from "../solo.js";
import { labDir } from "../state.js";

/**
 * A measured run of the real agent, by hand and only on the person's word, on a scratch Git repository with no
 * remote: three tasks at most, the data and lesson queue in scratch directories, every MCP server and plugin of the
 * person's own setup turned off for each task. LAB_REAL_AGENT=1 starts the person's own Claude Code; LAB_REAL_REHEARSAL=1
 * runs the same steps with the stand-in claude, which is how the harness is tried first. Without either the scenario skips.
 */
const REAL = process.env.LAB_REAL_AGENT === "1";
const REHEARSAL = process.env.LAB_REAL_REHEARSAL === "1";
test.skip(!REAL && !REHEARSAL, "a real-agent run is made by hand");
const REF = process.env.LAB_REAL_REF ?? "HEAD";
const OUT = process.env.LAB_REAL_OUT ?? join(labDir(), "real-agent", Date.now().toString(36));
const KIT = join(ORCHESTRATOR_DIR, "lab", "demo", "parcel-pricer");
const TASK = "In parcel-pricer, parcels exactly at a weight limit are priced one tier too high; make the failing test pass.";
const CORRECTION = "Use for...of here; the index is not needed.";
const PACE_MS = 1500;
/** The last task of the permission: one task carries the red test, the stop, the correction, the Keep and the lesson, with the check approved first. */
const ONE = process.env.LAB_REAL_ONE === "1";
/** One task that makes the agent ask: it goes to the person as a question and is answered from the follow-up box in the same session. */
const ASK = process.env.LAB_REAL_ASK === "1";
const NOSTOP = process.env.LAB_REAL_NOSTOP === "1";

interface Seen { at: number; status: string; stage?: string | null }
interface Shown { status: string; stage?: string | null; error: string | null; requestNumber: number | null; result?: string | null; cost?: { usd: number | null; inputTokens?: number; outputTokens?: number }; costPartial?: boolean; startedAt?: string; finishedAt?: string | null; off?: unknown; request?: { branch: string } | null }

const names = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).map((n) => `${n}@${Math.round(statSync(join(dir, n)).mtimeMs / 1000)}`).sort() : []);

test("a measured run of the agent: a red test made green and stopped once, a correction kept, and its lesson", async ({ page }) => {
  test.setTimeout(3_600_000);
  mkdirSync(OUT, { recursive: true });
  const machine = cleanMachine(join(OUT, "machine"), process.env.PATH ?? "");
  const opened = browserStandIn(join(OUT, "machine"));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  // The product opens only folders inside the home, so the scratch repository sits in a folder of its own there and is removed at the end.
  const scratchHome = join(homedir(), `th-lab-scratch-${Date.now().toString(36)}`);
  const repo = join(scratchHome, "parcel-pricer");
  const dataDir = join(OUT, "data");
  const queue = join(OUT, "teamhandbook");
  for (const dir of [dataDir, queue]) mkdirSync(dir, { recursive: true });
  cpSync(KIT, repo, { recursive: true });
  for (const args of [["init", "--quiet", "--initial-branch=main"], ["add", "-A"], ["-c", "user.name=Solo Person", "-c", "user.email=solo@person.example.invalid", "commit", "--quiet", "-m", "Price parcels by weight"]]) {
    const done = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    if (done.status !== 0) throw new Error(`git ${args[0]} failed: ${done.stderr}`);
  }
  const hold = join(OUT, "hold");
  mkdirSync(hold, { recursive: true });
  const home = homedir();
  const watched = [join(home, ".claude", "skills"), join(home, ".teamhandbook"), join(home, ".claude", "projects")];
  const before = Object.fromEntries(watched.map((dir) => [dir, names(dir)]));
  const env: NodeJS.ProcessEnv = { ...process.env, BROWSER: opened.command, ORCHESTRATOR_DATA_DIR: dataDir, TEAMHANDBOOK_HOME: queue, ...(REAL ? {} : { ORCHESTRATOR_CLAUDE_BIN: claudeStandIn(join(OUT, "machine"), PACE_MS, { LAB_STANDIN_HOLD: hold, LAB_STANDIN_SESSION: "open" }) }) };
  const run = await install("clone", machine, env, port, REF);
  const report: Record<string, unknown> = { mode: REAL ? "real agent" : "stand-in rehearsal", ref: REF, tasks: [] };
  const log = (line: string) => writeFileSync(join(OUT, "run.log"), `${new Date().toISOString()} ${line}\n`, { flag: "a" });
  try {
    await until(() => fetch(`${base}/api/health/ready`).then((r) => r.json() as Promise<{ ready?: boolean }>, (): { ready?: boolean } => ({})), (r) => r.ready === true, 2400);
    const link = await until(() => opened.opened(), (o) => o.length > 0, 120);
    await signInAt(page, /url=([^"]+)"/.exec(readFileSync(link[0]!, "utf8"))![1]!.replace(/&amp;/g, "&"));
    const { csrf } = (await (await page.request.get(`${base}/api/me`)).json()) as { csrf: string };
    const call = async <T>(method: "GET" | "POST" | "PUT", path: string, data?: unknown) => {
      const res = await page.request.fetch(`${base}${path}`, { method, headers: { "x-csrf-token": csrf }, timeout: 180_000, ...(data ? { data } : {}) });
      return { status: res.status(), json: (await res.json().catch(() => ({}))) as T };
    };
    const ok = async <T>(method: "GET" | "POST" | "PUT", path: string, data?: unknown) => {
      const r = await call<T>(method, path, data);
      if (r.status < 200 || r.status >= 300) throw new Error(`${method} ${path} answered ${r.status}: ${JSON.stringify(r.json)}`);
      return r.json;
    };
    // The person's own Claude Code stays out of the run: every MCP server and plugin it reads is turned off for each task.
    const sources = await ok<{ available: boolean; sources: { id: string; kind: string; mcpServers?: { name: string }[] }[] }>("GET", `/api/handbook/sources?folder=${encodeURIComponent(repo)}`);
    const off = {
      sources: sources.sources.filter((s) => s.kind === "plugin").map((s) => s.id),
      mcpServers: sources.sources.flatMap((s) => (s.mcpServers ?? []).map((m) => ({ source: s.id, name: m.name }))),
    };
    report.off = { available: sources.available, sources: off.sources.length, mcpServers: off.mcpServers.length };
    log(`off list: ${JSON.stringify(report.off)}`);
    if (REAL) expect(sources.available, "the orchestrator reads the setup it turns off, so nothing of the person's own reaches the run unseen").toBe(true);
    const { project } = await ok<{ project: { id: string } }>("POST", "/api/projects", { path: repo });
    await ok("PUT", "/api/settings/task-limits", { maxUsd: 3, maxMinutes: 15 });

    const shot = (name: string) => page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true }).catch(() => undefined);
    const task = async (id: string) => (await ok<{ task: Shown }>("GET", `/api/tasks/${id}`)).task;
    const watch = async (id: string, until_: (t: Shown) => boolean, seen: Seen[], limitS: number): Promise<Shown> => {
      const t0 = Date.now();
      for (;;) {
        const t = await task(id);
        const last = seen[seen.length - 1];
        if (!last || last.status !== t.status || last.stage !== (t.stage ?? null)) seen.push({ at: Math.round((Date.now() - t0) / 100) / 10, status: t.status, stage: t.stage ?? null });
        if (until_(t)) return t;
        if (Date.now() - t0 > limitS * 1000) throw new Error(`task ${id} still ${t.status}/${t.stage} after ${limitS} s`);
        await new Promise((r) => setTimeout(r, 1500));
      }
    };
    let sample = false;
    const toolSeen = async (id: string) => {
      const r = await call<{ events?: { kind?: string; type?: string; text?: string }[] }>("GET", `/api/tasks/${id}/events?after=0`);
      const text = JSON.stringify(r.json);
      if (!sample) { sample = true; log(`events sample: ${text.slice(0, 400)}`); }
      return /tool_use|"tool"|Bash|npm test/.test(text);
    };
    const start = async (title: string, extra: Record<string, unknown> = {}) => (await ok<{ task: { id: string } }>("POST", "/api/tasks", { title, description: "", repoId: project.id, agent: "claude-code", off, ...extra })).task.id;
    const entry = (n: string, id: string, seen: Seen[], t: Shown, extra: Record<string, unknown> = {}) => (report.tasks as unknown[]).push({ n, id, transitions: seen, status: t.status, error: t.error, cost: t.cost ?? null, costPartial: t.costPartial ?? null, ...extra });

    if (ASK) {
      const seenQ: Seen[] = [];
      const q = await start("In parcel-pricer, add a test for a parcel over the heaviest tier", { description: `What price such a parcel has is stated nowhere: ask me which price before you write anything, and wait for my answer.\n${REHEARSAL ? "stand-in: ask and stop" : ""}` });
      log(`task Q ${q}`);
      const asked = await watch(q, (t) => t.status !== "running" && t.status !== "queued", seenQ, 600);
      const askedRaw = (await ok<{ task: Record<string, unknown> }>("GET", `/api/tasks/${q}`)).task;
      log(`asked state: ${asked.status}/${asked.stage ?? ""} question=${JSON.stringify(askedRaw.question ?? null).slice(0, 300)} lastSaid=${JSON.stringify(askedRaw.lastSaid ?? null).slice(0, 300)}`);
      const org = new URL(page.url()).pathname.split("/")[1]!;
      await page.goto(`${base}/${org}/tasks/${q}`);
      await new Promise((r) => setTimeout(r, 3000));
      await shot("Q-asked");
      const answered = await call("POST", `/api/tasks/${q}/messages`, { text: "Use the top tier's price for a parcel over the heaviest tier.", commandId: crypto.randomUUID() });
      log(`answer through the follow-up box: ${answered.status} ${JSON.stringify(answered.json).slice(0, 200)}`);
      const t1 = Date.now();
      const done = await watch(q, (t) => !["queued", "running"].includes(t.status), seenQ, 900);
      await shot("Q-review");
      entry("ask: question to the person, answered in the follow-up box", q, seenQ, done, { stateWhenAsked: `${asked.status}/${asked.stage ?? ""}`, question: askedRaw.question ?? null, lastSaid: String(askedRaw.lastSaid ?? "").slice(0, 400), answerStatus: answered.status, secondsAfterAnswer: Math.round((Date.now() - t1) / 100) / 10 });
      return;
    }
    // Task 1: a red test made green, stopped once on a step, and told more.
    const seenA: Seen[] = [];
    if (ONE) {
      const found = await ok<{ detected?: { checks?: { source: string; command: string; digest: string }[]; setup?: { source: string; command: string; digest: string } | null }; checks?: { source: string; command: string; digest: string }[] }>("GET", `/api/projects/${project.id}/verification`);
      log(`detected: ${JSON.stringify(found).slice(0, 400)}`);
      type Step = { source: string; command: string; digest: string };
      const detected = (found.detected ?? found) as { checks?: Step[]; setup?: Step | null };
      const picks = (detected.checks ?? []).map((c) => ({ source: c.source, command: c.command, digest: c.digest }));
      const approved = await call("PUT", `/api/projects/${project.id}/verification`, { checks: picks, setup: detected.setup ? { source: detected.setup.source, command: detected.setup.command, digest: detected.setup.digest } : null });
      log(`checks approved: ${approved.status} ${JSON.stringify(approved.json).slice(0, 200)}`);
    }
    if (REHEARSAL && process.env.LAB_REAL_REHEARSAL_STOP) writeFileSync(join(hold, "after-edit"), "");
    const a = await start(TASK);
    log(`task A ${a}`);
    await watch(a, (t) => t.status === "running", seenA, 180);
    const stops = (REAL || Boolean(process.env.LAB_REAL_REHEARSAL_STOP)) && !NOSTOP;
    let stepSeen = false;
    let stop: { status: number; json: unknown } = { status: 0, json: null };
    let said: { status: number } = { status: 0 };
    let stoppedAt: Shown = await task(a);
    if (stops) {
      stepSeen = ONE ? (await new Promise((r) => setTimeout(r, 9000)), true) : await until(() => toolSeen(a), Boolean, 60);
      stop = await call("POST", `/api/tasks/${a}/stop-step`);
      log(`stop-step answered ${stop.status}: ${JSON.stringify(stop.json).slice(0, 200)}`);
      await shot("A-stopped");
      stoppedAt = await task(a);
      said = await call("POST", `/api/tasks/${a}/messages`, { text: "Go on, and keep the change small.", commandId: crypto.randomUUID() });
      log(`follow-up answered ${said.status}`);
    }
    if (REHEARSAL) rmHold(hold, "after-edit");
    const doneA = await watch(a, (t) => !["queued", "running"].includes(t.status), seenA, 900);
    const verification = await call<{ verifications?: { verification?: { verdict?: string; checks?: { command: string; before: { code: number } | null; after: { code: number }[] }[] } }[] }>("GET", `/api/tasks/${a}/verification`);
    await shot("A-review");
    entry("1+2 red test, Stop this step, follow-up", a, seenA, doneA, { toolSeenBeforeStop: stepSeen, stopStatus: stop.status, stateAfterStop: `${stoppedAt.status}/${stoppedAt.stage ?? ""}`, followUpStatus: said.status, verification: verification.json });
    // The stand-in ends its session on an interrupt where Claude Code keeps it open, so only the real agent can go on after a stopped step.
    if (REAL) expect([doneA.status, doneA.error]).toEqual(["needs-review", null]);
    else if (doneA.status !== "needs-review") throw new Error("the rehearsal task A did not reach review");

    if (ONE) {
      await ok("POST", `/api/tasks/${a}/messages`, { text: CORRECTION, commandId: crypto.randomUUID() });
      const againA = await watch(a, (t) => !["queued", "running"].includes(t.status), seenA, 900);
      await shot("A-corrected");
      // Keep is the page's own button: a follow-up moves the branch past the checks it was kept on, so the first press can be only a check again.
      const shownA = await task(a);
      const org = new URL(page.url()).pathname.split("/")[1]!;
      await page.goto(`${base}/${org}/tasks/${a}`);
      let keepState = "open";
      for (let press = 0; press < 3 && keepState !== "merged"; press++) {
        await page.getByRole("button", { name: "Keep these changes" }).click();
        await new Promise((r) => setTimeout(r, 4000));
        keepState = (await ok<{ status: { detail: { status: string } } }>("GET", `/api/repos/${project.id}/requests/${shownA.requestNumber}/status`)).status.detail.status;
        log(`Keep pressed ${press + 1}: request ${keepState}`);
      }
      const keepA = { status: keepState === "merged" ? 200 : 409, json: { request: keepState } };
      const lessonsA = await until(() => ok<{ candidates: { slug: string; status: string }[] | null }>("GET", `/api/tasks/${a}/lessons`), (r) => (r.candidates ?? []).length > 0, 120);
      const slugA = lessonsA.candidates?.[0]?.slug;
      const keptA = slugA ? (await call("POST", `/api/tasks/${a}/lessons/${slugA}/keep`, { target: "folder" })).json : null;
      const outcomesA = slugA ? (await call("GET", `/api/skills/${slugA}/outcomes?days=30`)).json : null;
      await shot("A-lessons");
      entry("1+2+3 one task: red test, Stop this step, follow-up, correction, Keep, lesson", a, seenA, againA, { keepStatus: keepA.status, lessonCandidates: lessonsA.candidates, lessonKept: keptA, outcomes: outcomesA });
      return;
    }
    // Task 2: a task kept, its correction given in a follow-up, and the lesson that falls out of it.
    const seenB: Seen[] = [];
    const b = await start("In parcel-pricer, add a test that a parcel over the heaviest tier is priced at the top tier's price.");
    log(`task B ${b}`);
    const reviewB = await watch(b, (t) => !["queued", "running"].includes(t.status), seenB, 900);
    await ok("POST", `/api/tasks/${b}/messages`, { text: CORRECTION, commandId: crypto.randomUUID() });
    const againB = await watch(b, (t) => !["queued", "running"].includes(t.status), seenB, 900);
    await shot("B-review");
    const keep = await call("POST", `/api/tasks/${b}/keep`, { commandId: crypto.randomUUID() });
    log(`keep answered ${keep.status}: ${JSON.stringify(keep.json).slice(0, 200)}`);
    const lessons = await until(() => ok<{ candidates: { slug: string; status: string }[] | null }>("GET", `/api/tasks/${b}/lessons`), (r) => (r.candidates ?? []).length > 0, 120);
    const slug = lessons.candidates?.[0]?.slug;
    let kept: unknown = null;
    let outcomes: unknown = null;
    if (slug) {
      kept = (await call("POST", `/api/tasks/${b}/lessons/${slug}/keep`, { target: "folder" })).json;
      outcomes = (await call("GET", `/api/skills/${slug}/outcomes?days=30`)).json;
    }
    await shot("B-lessons");
    entry("3 correction kept, its lesson", b, seenB, againB, { firstReviewStatus: reviewB.status, keepStatus: keep.status, lessonCandidates: lessons.candidates, lessonKept: kept, outcomes });
    expect(slug, "a lesson candidate fell out of the correction").toBeDefined();
  } finally {
    const after = Object.fromEntries(watched.map((dir) => [dir, names(dir)]));
    report.homeChanges = Object.fromEntries(watched.map((dir) => [dir, { before: before[dir]!.length, after: after[dir]!.length, added: after[dir]!.filter((n) => !before[dir]!.includes(n)), removed: before[dir]!.filter((n) => !after[dir]!.includes(n)) }]));
    const sql = (query: string) => spawnSync("sqlite3", [join(dataDir, "orchestrator.db"), query], { encoding: "utf8" }).stdout.trim();
    report.lessonRows = sql("select value from settings where key like 'task.lessons.%'");
    report.lessonSpend = sql("select kind, usd, input_tokens, output_tokens from task_extra_spend where kind = 'lesson'");
    writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2) + "\n");
    process.kill(-run.child.pid!, "SIGINT");
    await Promise.race([run.exited, new Promise((resolve) => setTimeout(resolve, 20_000))]);
    if (scratchHome.startsWith(`${homedir()}/th-lab-scratch-`)) rmSync(scratchHome, { recursive: true, force: true });
  }
});

function rmHold(dir: string, point: string): void {
  spawnSync("rm", ["-f", join(dir, point)]);
}
