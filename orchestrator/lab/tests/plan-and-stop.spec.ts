import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { cleanMachine, freePort } from "../clean-machine.js";
import { browserStandIn, claudeStandIn, install, ORCHESTRATOR_DIR, signInAt, until } from "../solo.js";
import type { Started } from "../solo.js";
import { labDir } from "../state.js";

const REF = process.env.LAB_PLAN_REF ?? "HEAD";
const OUT = process.env.LAB_PLAN_OUT ?? join(labDir(), "plan-and-stop", Date.now().toString(36));
/** How long the plan waits for its person; the task's time cap is one minute, so any wait past it shows the wait is not on that clock. */
const WAIT_S = Number(process.env.LAB_PLAN_WAIT_S ?? 75);
const KIT = join(ORCHESTRATOR_DIR, "lab", "demo", "parcel-pricer");
const TASK = "In parcel-pricer, parcels exactly at a weight limit are priced one tier too high; make the failing test pass.";
const STOPPED = "Stopped by the person who started the task.";

type Shown = { status: string; error: string | null; requestNumber: number | null; request?: { branch: string } | null };

interface Session {
  page: Page;
  repo: string;
  hold: (point: string, on: boolean) => void;
  reached: (point: string) => boolean;
  put: (path: string, data: unknown) => Promise<void>;
  task: () => Promise<Shown>;
  start: (planFirst: boolean) => Promise<string>;
  planAsked: () => Promise<string>;
  answerPlan: (id: string) => Promise<void>;
  stopTask: () => Promise<void>;
  fixedOn: (branch: string) => boolean;
  finish: () => Promise<void>;
}

/**
 * A clean machine with the orchestrator cloned onto it, the parcel-pricer repository opened, and the stand-in claude as
 * its agent, which keeps its session as Claude Code does (stdin open after its answer, a follow-up taken into the turn it
 * is in, plan mode ending in an ExitPlanMode question) and stays at the points a scenario holds it at.
 */
async function session(name: string, page: Page): Promise<Session> {
  const root = join(OUT, name);
  mkdirSync(root, { recursive: true });
  const machine = cleanMachine(root, process.env.PATH ?? "");
  const opened = browserStandIn(root);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const holdDir = join(root, "hold");
  mkdirSync(holdDir, { recursive: true });
  const repo = join(machine.home, "work", "parcel-pricer");
  const git = (cwd: string, args: string[]) => {
    const done = spawnSync("git", args, { cwd, env: machine.env, encoding: "utf8" });
    if (done.status !== 0) throw new Error(`git ${args[0]} failed: ${done.stderr}`);
    return done.stdout;
  };
  cpSync(KIT, repo, { recursive: true });
  git(repo, ["init", "--quiet", "--initial-branch=main"]);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "--quiet", "-m", "Price parcels by weight"]);
  const seen = join(machine.home, ".claude", "projects", realpathSync(repo).replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(seen, { recursive: true });
  writeFileSync(join(seen, "session.jsonl"), "{}\n");

  const run: Started = await install("clone", machine, { ...machine.env, BROWSER: opened.command, ORCHESTRATOR_CLAUDE_BIN: claudeStandIn(root, 0, { LAB_STANDIN_HOLD: holdDir, LAB_STANDIN_SESSION: "open" }) }, port, REF);
  await until(() => fetch(`${base}/api/health/ready`).then((r) => r.json() as Promise<{ ready?: boolean }>, (): { ready?: boolean } => ({})), (r) => r.ready === true, 2400);
  const link = await until(() => opened.opened(), (o) => o.length > 0, 120);
  await signInAt(page, /url=([^"]+)"/.exec(readFileSync(link[0]!, "utf8"))![1]!.replace(/&amp;/g, "&"));
  await expect(page.getByLabel("What needs doing?")).toBeVisible({ timeout: 60_000 });
  const { csrf } = (await (await page.request.get(`${base}/api/me`)).json()) as { csrf: string };
  let taskId = "";
  const task = async () => ((await (await page.request.get(`${base}/api/tasks/${taskId}`)).json()) as { task: Shown }).task;
  return {
    page,
    repo,
    hold: (point, on) => (on ? writeFileSync(join(holdDir, point), "") : rmSync(join(holdDir, point), { force: true })),
    reached: (point) => existsSync(join(holdDir, `reached-${point}`)),
    put: async (path, data) => {
      const res = await page.request.put(`${base}${path}`, { headers: { "x-csrf-token": csrf }, data });
      expect(res.status(), `PUT ${path}`).toBe(200);
    },
    task,
    start: async (planFirst) => {
      await page.goto(base);
      await page.getByLabel("What needs doing?").fill(TASK);
      if (planFirst) await page.getByLabel("Show me the plan before it changes anything").check();
      await page.getByRole("button", { name: "Start task", exact: true }).click();
      await page.waitForURL(/\/tasks\/tsk_[0-9a-z]+$/, { timeout: 60_000 });
      taskId = new URL(page.url()).pathname.split("/").pop()!;
      return taskId;
    },
    // The plan the agent put to its person, read from the task's requests: the plan card of the page is checked beside it.
    planAsked: async () => {
      const pending = await until(
        async () => ((await (await page.request.get(`${base}/api/tasks/${taskId}/requests`)).json()) as { requests: { id: string; kind: string; status: string }[] }).requests.find((r) => r.kind === "plan" && r.status === "pending") ?? null,
        Boolean,
        480,
      );
      expect(pending, "the plan the agent put to its person").not.toBeNull();
      return pending!.id;
    },
    answerPlan: async (id) => {
      const res = await page.request.post(`${base}/api/tasks/${taskId}/requests/${encodeURIComponent(id)}`, { headers: { "x-csrf-token": csrf }, data: { answer: { decision: "allow_once" }, commandId: crypto.randomUUID() } });
      expect(res.status(), "answering the plan").toBe(200);
    },
    stopTask: async () => {
      await page.getByRole("button", { name: "Stop…" }).click();
      await page.getByRole("button", { name: "Stop task", exact: true }).click();
    },
    fixedOn: (branch) => {
      const price = git(repo, ["show", `${branch}:src/price.js`]);
      return price.includes("weightKg <= TIERS[i].upToKg");
    },
    finish: async () => {
      process.kill(-run.child.pid!, "SIGINT");
      await Promise.race([run.exited, new Promise((r) => setTimeout(r, 20_000))]);
      expect(machine.trapped().filter((call) => !["--version", "auth list"].includes(call.args))).toEqual([]);
    },
  };
}

const leftRunning = (s: Shown) => !["queued", "running"].includes(s.status);

/**
 * Three faults a person's real task met, each held by the scenario that would have shown it. Each runs on a
 * clean machine from a clone, against the stand-in claude (lab/stand-in-claude.mjs); the real agents are run by hand.
 * The fixes: a plan card waits for its person past the task's time (1af3b8e1), a follow-up an agent that steers takes
 * into its turn counts as no turn of its own (98caa550), and a stopped task keeps what its agent changed (1441b93c).
 */
test.describe("a person's task with a plan, a follow-up and a stop", () => {
  test.setTimeout(900_000);


  test("given a task that shows its plan first, when the agent puts its plan to its person, then the task's page draws the plan card with a way to start with it", async ({ page }) => {
    // given
    const s = await session("plan-card", page);
    try {
      // when
      await s.start(true);
      await s.planAsked();

      // then
      const card = page.getByRole("listitem", { name: "The agent's plan" });
      await expect(card).toBeVisible({ timeout: 20_000 });
      await expect(card.getByRole("button", { name: "Start with this plan" })).toBeVisible();
    } finally {
      await s.finish();
    }
  });

  test("given a task that shows its plan first and a time cap of one minute, when its person answers the plan well past that minute, then the plan was still waiting, and the run goes on from it to review", async ({ page }) => {
    test.setTimeout(900_000 + WAIT_S * 1000);
    // given
    const s = await session("plan-waits", page);
    try {
      // A build before the cap was a setting has none to set; its clock is a fixed half hour, which a wait of that length passes.
      if (!process.env.LAB_PLAN_NO_CAP) await s.put("/api/settings/task-limits", { maxUsd: null, maxMinutes: 1 });
      const id = await s.start(true);
      const plan = await s.planAsked();

      // when
      await page.waitForTimeout(WAIT_S * 1000);

      // then the plan still waits for its person, the task still runs, and answering it carries on
      expect((await s.task()).status).toBe("running");
      await s.answerPlan(plan);
      const ended = await until(s.task, leftRunning, 480);
      expect([ended.status, ended.error]).toEqual(["needs-review", null]);
      expect(s.fixedOn(`task/${id}`)).toBe(true);
    } finally {
      await s.finish();
    }
  });

  test("given a task stopped while its plan waited, when its person approves the plan and continues, then the run takes the approved plan as the turn it is in, ends it once, and the task leaves running for review", async ({ page }) => {
    // given
    const s = await session("plan-continues", page);
    try {
      const id = await s.start(true);
      await s.planAsked();
      await s.stopTask();
      await until(s.task, leftRunning, 120);

      // when
      await page.getByRole("button", { name: /^Approve the plan and continue/ }).click();

      // then
      const ended = await until(s.task, (t) => leftRunning(t) && t.status !== "interrupted", 480);
      expect([ended.status, ended.error]).toEqual(["needs-review", null]);
      expect(s.fixedOn(`task/${id}`)).toBe(true);
    } finally {
      await s.finish();
    }
  });

  test("given an agent that changed a file and a person who stops the task then, when it is stopped, then what the agent changed waits for review with the stop as the reason, and a stop before any change still cancels", async ({ page, browser }) => {
    // given
    const s = await session("stop-after-change", page);
    const other = await session("stop-before-change", await (await browser.newContext()).newPage());
    try {
      s.hold("after-edit", true);
      const id = await s.start(false);
      await until(() => s.reached("after-edit"), Boolean, 480);
      other.hold("before-edit", true);
      await other.start(false);
      await until(() => other.reached("before-edit"), Boolean, 480);

      // when
      await s.stopTask();
      await other.stopTask();

      // then
      const kept = await until(s.task, leftRunning, 120);
      expect([kept.status, kept.error]).toEqual(["needs-review", STOPPED]);
      expect(s.fixedOn(`task/${id}`)).toBe(true);
      await expect(page.getByText("Your checkout changes only when you keep this.")).toBeVisible();
      await expect(page.getByText("src/price.js", { exact: true }).first()).toBeVisible();
      await expect(page.getByText(STOPPED).first()).toBeVisible();
      await expect(page.getByRole("button", { name: "Keep these changes" })).toBeVisible();
      expect((await until(other.task, leftRunning, 120)).status).toBe("cancelled");
    } finally {
      await s.finish();
      await other.finish();
    }
  });
});
