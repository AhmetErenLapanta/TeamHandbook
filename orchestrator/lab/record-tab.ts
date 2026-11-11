import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * A screen recording of the orchestrator's own tab, and nothing else: a visible browser window the
 * person uses, recorded by that browser (Playwright's recordVideo), so no other window, the desktop
 * or the address bar is ever in it. It opens the one-time sign-in link it is handed, and reads no
 * secret itself. It ends when the person closes the window, when the time cap passes, or on
 * Ctrl-C, and writes recording.webm and recording.json (its path, length and marks).
 *
 *   sh lab/record.sh --link-file <file holding the link> | --link <link> [--out <dir>] [--minutes 30] [--rehearse]
 *
 * --link-file is the way a script hands the link over: the file is read once, must be readable by
 * its owner alone (0600), and is deleted as soon as the link is read, so the link reaches no output.
 *
 * --watch only watches, next to the person's own browser: it presses no button, moves between pages
 * by their address alone, and scrolls. It opens Tasks, follows the first task started after it
 * began to its page, keeps the live run in view while it runs, then shows the review and ends.
 *
 * --rehearse plays the person's clicks in the same window, for a rehearsal with the stand-in claude:
 * Work, the first issue, Start an agent, the live run, the review, and Keep when the page offers it.
 */

const args = process.argv.slice(2);
const value = (flag: string) => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
};
const USAGE = "usage: sh lab/record.sh --link-file <file holding the orchestrator's one-time sign-in link> | --link <link> [--out <dir>] [--minutes 30] [--rehearse]";
const linkFile = value("--link-file");
let link = value("--link");
if (linkFile) {
  if ((statSync(linkFile).mode & 0o077) !== 0) {
    console.error(`record: ${linkFile} is readable by others than its owner; write it 0600`);
    process.exit(2);
  }
  link = readFileSync(linkFile, "utf8").trim();
  rmSync(linkFile, { force: true });
}
if (!link || !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(link)) {
  console.error(USAGE);
  process.exit(2);
}
const out = value("--out") ?? join(process.cwd(), `recording-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const minutes = Number(value("--minutes") ?? 30);
const rehearse = args.includes("--rehearse");
const watch = args.includes("--watch");
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ headless: (rehearse || watch) && process.env.LAB_RECORD_HEADED !== "1" });
const context = await browser.newContext({ recordVideo: { dir: out, size: { width: 1280, height: 800 } }, viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const started = Date.now();
const marks: { at: number; step: string }[] = [];
const mark = (step: string) => {
  marks.push({ at: Math.round((Date.now() - started) / 100) / 10, step });
  console.log(`record: ${marks.at(-1)!.at} s  ${step}`);
};

/** The person's clicks, played for a rehearsal; each step waits for what the screen shows next. */
async function personFlow(p: Page): Promise<void> {
  const base = new URL(p.url()).origin;
  await p.getByRole("link", { name: "Work", exact: true }).first().click();
  mark("work");
  const card = p.locator(".work-card").first();
  await card.waitFor({ timeout: 60_000 });
  await card.click();
  await p.getByRole("button", { name: /^Start (an )?agent/ }).first().click();
  const form = p.getByRole("form", { name: /Start agents?/ });
  if (await form.count()) await form.getByRole("button", { name: /^Start/ }).last().click();
  mark("task started");
  await p.waitForURL(/\/tasks\/tsk_[0-9a-z]+$/, { timeout: 60_000 }).catch(async () => {
    await p.getByRole("link", { name: /Agent (queued|working)/ }).first().click({ timeout: 60_000 });
  });
  await p.getByRole("list", { name: "What the agent did" }).waitFor({ timeout: 120_000 });
  mark("live run");
  await p.getByText(/waits for your review|needs review|Changes in this folder/).first().waitFor({ timeout: minutes * 60_000 });
  mark("review");
  const keep = p.getByRole("button", { name: "Keep these changes" });
  if (await keep.count()) {
    await keep.click();
    await p.getByText(/^Kept by /).waitFor({ timeout: 30_000 });
    mark("keep");
  }
  await p.waitForTimeout(3_000);
  void base;
}

/** Watching alone: Tasks, then the first task started after the recording began, followed to its review. No button is pressed. */
async function watchFlow(p: Page): Promise<void> {
  const base = new URL(p.url()).origin;
  const org = new URL(p.url()).pathname.split("/").filter(Boolean)[0] ?? "default";
  const since = new Date(started).toISOString();
  type Listed = { id: string; status: string; createdAt: string };
  const read = async (path: string) => (await p.request.get(`${base}${path}`)).json().catch(() => ({}));
  // The person's own browser moves through the first screen, the tracker's connection and Work; this tab
  // shows each as it comes to stand, by reloading it, until a task starts.
  let shown = "";
  const show = async (where: string, path: string) => {
    if (shown === where) return p.reload().catch(() => {});
    shown = where;
    await p.goto(`${base}${path}`);
    mark(where);
  };
  let task: Listed | null = null;
  while (!task) {
    const { tasks } = (await read("/api/tasks")) as { tasks?: Listed[] };
    task = (tasks ?? []).find((t) => t.createdAt >= since) ?? null;
    if (task) break;
    const { sources } = (await read("/api/work/sources")) as { sources?: { problem: string | null }[] };
    await show(sources?.some((s) => !s.problem) ? "work" : "first screen", sources?.some((s) => !s.problem) ? `/${org}/work` : "/");
    await p.waitForTimeout(8_000);
  }
  // The cap is for waiting on a start; once a task runs it is recorded to its review, an hour at most.
  clearTimeout(cap);
  setTimeout(() => void end("an hour after the task started").then(() => process.exit(0)), 60 * 60_000);
  await p.goto(`${base}/${org}/tasks/${task.id}`);
  mark(`task ${task.id}`);
  // While the agent works, the page is kept at the live run's newest line.
  for (;;) {
    const { task: now } = (await read(`/api/tasks/${task.id}`)) as { task: Listed };
    if (!["queued", "running"].includes(now.status)) {
      mark(`task ${now.status}`);
      break;
    }
    await p.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }));
    await p.waitForTimeout(4_000);
  }
  // The review as it stands at the end: the page's head, then down through the changes and checks.
  await p.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  await p.waitForTimeout(15_000);
  mark("review");
  for (let i = 0; i < 6; i++) {
    await p.evaluate(() => window.scrollBy({ top: 400, behavior: "smooth" }));
    await p.waitForTimeout(4_000);
  }
  await p.waitForTimeout(10_000);
}

let ending: Promise<void> | null = null;
const end = (why: string) =>
  (ending ??= (async () => {
    mark(why);
    const video = page.video();
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    const path = join(out, "recording.webm");
    if (video) renameSync(await video.path(), path);
    const seconds = Math.round((Date.now() - started) / 100) / 10;
    writeFileSync(join(out, "recording.json"), JSON.stringify({ path, seconds, bytes: video ? statSync(path).size : 0, marks }, null, 2) + "\n");
    console.log(`record: ${path}  ${seconds} s`);
  })());

process.once("SIGINT", () => void end("stopped with Ctrl-C").then(() => process.exit(0)));
const cap = setTimeout(() => void end(`the ${minutes}-minute cap`).then(() => process.exit(0)), minutes * 60_000);
page.once("close", () => void end("the window was closed").then(() => process.exit(0)));

await page.goto(link);
// The address opens a page whose Continue signs in; a rehearsal presses it as the person does, a recording leaves it to them.
if (rehearse) await page.getByRole("button", { name: "Continue", exact: true }).click();
mark("signed in");
if (watch) {
  try {
    await watchFlow(page);
  } catch (err) {
    mark(`the watch stopped: ${(err as Error).message.split("\n")[0]}`);
  }
  clearTimeout(cap);
  await end("watch ended");
  process.exit(0);
}
if (rehearse) {
  try {
    await personFlow(page);
  } catch (err) {
    mark(`the rehearsal stopped: ${(err as Error).message.split("\n")[0]}`);
    clearTimeout(cap);
    await end("rehearsal ended");
    process.exit(1);
  }
  clearTimeout(cap);
  await end("rehearsal ended");
  process.exit(0);
}
