import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { cleanMachine, freePort } from "../clean-machine.js";
import { browserStandIn, claudeStandIn, install, ORCHESTRATOR_DIR, signInAt, until } from "../solo.js";
import type { Started } from "../solo.js";
import { labDir } from "../state.js";

const REF = process.env.LAB_DEMO_REF ?? "HEAD";
const OUT = process.env.LAB_DEMO_OUT ?? join(labDir(), "demo-recording", Date.now().toString(36));
/** How far apart the stand-in's steps are, so a person watching the recording can read each line of the live run. */
const PACE_MS = Number(process.env.LAB_DEMO_PACE_MS ?? 1500);
const KIT = join(ORCHESTRATOR_DIR, "lab", "demo", "parcel-pricer");
const TASK = "In parcel-pricer, parcels exactly at a weight limit are priced one tier too high; make the failing test pass.";

/**
 * The demo as a screen recording: only the orchestrator's own tab, recorded by the browser that
 * shows it, never another window or the desktop. A person gives the task in a folder of theirs with
 * no Git, watches the agent's run live, sees the folder's test go from failing to passing, reviews
 * the change and keeps it. The agent here is the stand-in claude, paced so each step of its run
 * stays on screen; the same flow with a real agent is recorded on the person's own orchestrator,
 * started by hand. `sh lab/demo.sh --record` runs it and prints where the video is.
 */
test("given a clean machine and the parcel-pricer folder with a failing test, when a person gives the agent the task, watches its run, reviews the change and keeps it, then the recording of the orchestrator's tab holds each of those steps", async ({ browser }) => {
  test.setTimeout(900_000);
  mkdirSync(OUT, { recursive: true });
  const root = join(OUT, "machine");
  const machine = cleanMachine(root, process.env.PATH ?? "");
  const opened = browserStandIn(root);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const folder = join(machine.home, "work", "parcel-pricer");
  cpSync(KIT, folder, { recursive: true });
  const before = readFileSync(join(folder, "src", "price.js"), "utf8");
  const marks: { at: number; step: string }[] = [];
  let run: Started | null = null;
  run = await install("clone", machine, { ...machine.env, BROWSER: opened.command, ORCHESTRATOR_CLAUDE_BIN: claudeStandIn(root, PACE_MS) }, port, REF);
  // The recording starts once the orchestrator answers, so it shows the person's flow and not the install.
  await until(() => fetch(`${base}/api/health/ready`).then((r) => r.json() as Promise<{ ready?: boolean }>, (): { ready?: boolean } => ({})), (r) => r.ready === true, 2400);
  const link = await until(() => opened.opened(), (o) => o.length > 0, 120);
  const context = await browser.newContext({ recordVideo: { dir: OUT, size: { width: 1280, height: 800 } }, viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const started = Date.now();
  const mark = (step: string) => marks.push({ at: (Date.now() - started) / 1000, step });
  try {
    await signInAt(page, /url=([^"]+)"/.exec(readFileSync(link[0]!, "utf8"))![1]!.replace(/&amp;/g, "&"));
    mark("signed in");

    // when the person gives the task in the one box; the folder is found from their Claude Code history
    const seen = join(machine.home, ".claude", "projects", realpathSync(folder).replace(/[^a-zA-Z0-9]/g, "-"));
    mkdirSync(seen, { recursive: true });
    writeFileSync(join(seen, "session.jsonl"), "{}\n");
    await page.reload();
    const box = page.getByLabel("What needs doing?");
    await expect(box).toBeVisible({ timeout: 60_000 });
    await box.pressSequentially(TASK, { delay: 15 });
    mark("task given");
    await page.getByRole("button", { name: "Start task", exact: true }).click();
    await page.waitForURL(/\/tasks\/tsk_[0-9a-z]+$/, { timeout: 60_000 });

    // then the run shows live: the agent's plan, its test run and its edit, as they happen
    const stream = page.getByRole("list", { name: "What the agent did" });
    await expect(stream).toBeVisible({ timeout: 60_000 });
    mark("live run");
    await expect(page.getByRole("list", { name: "The agent's plan" })).toBeVisible({ timeout: 60_000 });
    await expect(stream).toContainText("npm test", { timeout: 60_000 });
    await expect(stream).toContainText("src/price.js", { timeout: 60_000 });

    // and the folder's test went from failing to passing, as the orchestrator checked it
    await expect(page.locator("ul.run-checks")).toContainText("npm test failed before, passed after", { timeout: 180_000 });
    mark("test red to green");

    // when they review the change
    const review = page.getByRole("region", { name: /^Changes \d+/ });
    await expect(review).toContainText("src/price.js", { timeout: 60_000 });
    await review.scrollIntoViewIfNeeded();
    await page.waitForTimeout(PACE_MS * 2);
    mark("review");

    // and keep it
    await page.getByRole("button", { name: "Keep these changes" }).click();
    await expect(page.getByText(/^Kept by /)).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(PACE_MS * 2);
    mark("keep");

    // then the folder holds the fix, and only that
    expect(readFileSync(join(folder, "src", "price.js"), "utf8")).toBe(before.replace("weightKg < TIERS[i].upToKg", "weightKg <= TIERS[i].upToKg"));
    expect(spawnSync("node", ["--test"], { cwd: folder, env: machine.env }).status).toBe(0);
    expect(machine.trapped().filter((call) => !["--version", "auth list"].includes(call.args))).toEqual([]);
  } finally {
    const video = page.video();
    await context.close();
    const path = join(OUT, "demo-recording.webm");
    if (video) renameSync(await video.path(), path);
    if (run) {
      process.kill(-(run as Started).child.pid!, "SIGINT");
      await Promise.race([(run as Started).exited, new Promise((r) => setTimeout(r, 20_000))]);
    }
    const seconds = (Date.now() - started) / 1000;
    const recording = { path, seconds: Math.round(seconds * 10) / 10, bytes: video ? statSync(path).size : 0, paceMs: PACE_MS, agent: "stand-in claude", marks };
    writeFileSync(join(OUT, "recording.json"), JSON.stringify(recording, null, 2) + "\n");
    appendFileSync(join(OUT, "recording.txt"), [`${path}  ${recording.seconds} s`, ...marks.map((m) => `${m.at.toFixed(1).padStart(6)} s  ${m.step}`)].join("\n") + "\n");
  }
});
