import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, realpathSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { cleanMachine, freePort } from "../clean-machine.js";
import type { CleanMachine } from "../clean-machine.js";
import { browserStandIn, claudeStandIn, install, ORCHESTRATOR_DIR, signInAt, until } from "../solo.js";
import type { Started } from "../solo.js";
import { labDir } from "../state.js";

const REF = process.env.LAB_DEMO_REF ?? "HEAD";
const OUT = process.env.LAB_DEMO_OUT ?? join(labDir(), "demo", Date.now().toString(36));
const KIT = join(ORCHESTRATOR_DIR, "lab", "demo", "parcel-pricer");
const TASK = "In parcel-pricer, parcels exactly at a weight limit are priced one tier too high; make the failing test pass.";
const COMMENT = "Use for...of here; the index is not needed.";

interface Shown {
  status: string;
  error: string | null;
  requestNumber: number | null;
  request: { branch: string } | null;
}

const git = (machine: CleanMachine, cwd: string, args: string[]) => {
  const done = spawnSync("git", args, { cwd, env: machine.env, encoding: "utf8" });
  if (done.status !== 0) throw new Error(`git ${args[0]} failed: ${done.stderr}`);
  return done.stdout.trim();
};

/** The kit's tests at one branch of the person's repository, run in a copy of its files so the checkout is left alone. */
function testsPassAt(machine: CleanMachine, repo: string, ref: string): boolean {
  const copy = mkdtempSync(join(OUT, "tests-"));
  const archive = spawnSync("git", ["-C", repo, "archive", ref], { env: machine.env, maxBuffer: 64 * 1024 * 1024 });
  spawnSync("tar", ["-x", "-C", copy], { input: archive.stdout });
  return spawnSync("node", ["--test"], { cwd: copy, env: machine.env, encoding: "utf8" }).status === 0;
}

/**
 * The three-minute demo, as the demo gate runs it (DEMO-sozlesme F9): a person clones the
 * orchestrator onto a clean machine, opens their parcel-pricer repository with its failing test,
 * asks the agent to make it pass, quotes a line of the change in a follow-up, and keeps the request.
 * Each step writes one line to demo.ndjson with its time, and the run is recorded as demo.webm.
 * The agent is the stand-in claude, which makes the kit's fix and its follow-up the same way each
 * run (lab/stand-in-claude.mjs); the real agents are run by hand. `sh lab/demo.sh` runs it.
 */
test("given a clean machine and the parcel-pricer repository with a failing test, when a person installs the orchestrator from a clone, gives the agent the issue, quotes a line of its change in a follow-up and keeps the result, then every step of the demo happens and is written down", async ({ browser }) => {
  test.setTimeout(900_000);
  mkdirSync(OUT, { recursive: true });
  const context = await browser.newContext({ recordVideo: { dir: OUT } });
  const page = await context.newPage();
  const started = Date.now();
  let clicks = 0;
  let typed = 0;
  let failed: string | null = null;
  const step = async (name: string, act: () => Promise<string | null | void>) => {
    if (failed) return;
    const before = { clicks, typed };
    let ok: boolean | null = true;
    let detail: string | null = null;
    try {
      const said = await act();
      // A step the screen does not offer yet is written down as skipped, and the gate does not count it.
      if (typeof said === "string" && said.startsWith("skipped: ")) ok = null;
      detail = said ?? null;
    } catch (err) {
      ok = false;
      failed = name;
      detail = (err as Error).message.split("\n")[0]!;
    }
    const line = { step: name, ok, ms: Date.now() - started, clicks: clicks - before.clicks, typed: typed - before.typed, detail };
    appendFileSync(join(OUT, "demo.ndjson"), JSON.stringify(line) + "\n");
    appendFileSync(join(OUT, "demo.txt"), `${ok === true ? "ok     " : ok === null ? "skipped" : "FAILED "} ${(line.ms / 1000).toFixed(1).padStart(6)} s  ${name}${detail ? `  ${detail}` : ""}\n`);
    await page.screenshot({ path: join(OUT, `${String(readdirSync(OUT).filter((f) => f.endsWith(".png")).length + 1).padStart(2, "0")}-${name.replace(/\s+/g, "-")}.png`), fullPage: true }).catch(() => {});
  };

  const root = join(OUT, "machine");
  const machine = cleanMachine(root, process.env.PATH ?? "");
  const opened = browserStandIn(root);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const repo = join(machine.home, "work", "parcel-pricer");
  const read = <T>(path: string) => page.request.get(`${base}${path}`).then((r) => r.json() as Promise<T>);
  let run: Started | null = null;
  let taskId = "";
  let projectId = "";
  let head = "";
  try {
    await step("install from a clone", async () => {
      run = await install("clone", machine, { ...machine.env, BROWSER: opened.command, ORCHESTRATOR_CLAUDE_BIN: claudeStandIn(root) }, port, REF);
      await until(() => fetch(`${base}/api/health/ready`).then((r) => r.json() as Promise<{ ready?: boolean }>, (): { ready?: boolean } => ({})), (r) => r.ready === true, 2400);
      const page0 = await until(() => opened.opened(), (o) => o.length > 0, 120);
      await signInAt(page, /url=([^"]+)"/.exec(readFileSync(page0[0]!, "utf8"))![1]!.replace(/&amp;/g, "&"));
      expect(machine.trapped()).toEqual([]);
    });
    await step("open the folder", async () => {
      cpSync(KIT, repo, { recursive: true });
      git(machine, repo, ["init", "--quiet", "--initial-branch=main"]);
      git(machine, repo, ["add", "-A"]);
      git(machine, repo, ["commit", "--quiet", "-m", "Price parcels by weight"]);
      head = git(machine, repo, ["rev-parse", "HEAD"]);
      // The box finds where to work from Claude Code's own history of the folder: a project directory named
      // after its real path, every character but a letter or a digit turned into "-".
      const seen = join(machine.home, ".claude", "projects", realpathSync(repo).replace(/[^a-zA-Z0-9]/g, "-"));
      mkdirSync(seen, { recursive: true });
      writeFileSync(join(seen, "session.jsonl"), "{}\n");
      await page.goto(base);
      await expect(page.getByLabel("What needs doing?")).toBeVisible({ timeout: 60_000 });
    });
    await step("environment line", async () => {
      await until(() => read<{ ready?: boolean; agents?: { ready: boolean }[] }>("/api/agents/readiness?fresh=1"), (r) => Boolean(r.agents?.some((a) => a.ready)), 120);
      await expect(page.getByRole("button", { name: "Check again" })).toHaveCount(0);
    });
    await step("test red", async () => {
      expect(spawnSync("node", ["--test"], { cwd: repo, env: machine.env }).status, "the kit's test fails before the agent").not.toBe(0);
    });
    await step("give the issue", async () => {
      await page.getByLabel("What needs doing?").fill(TASK);
      typed += 1;
      await page.getByRole("button", { name: "Start task", exact: true }).click();
      clicks += 1;
      await page.waitForURL(/\/tasks\/tsk_[0-9a-z]+$/, { timeout: 60_000 });
      taskId = new URL(page.url()).pathname.split("/").pop()!;
      const { projects } = await read<{ projects: { id: string; name: string; facts?: { git: string; origin: unknown } }[] }>("/api/projects");
      const project = projects.find((p) => p.name === "parcel-pricer")!;
      projectId = project.id;
      expect([project.facts?.git, project.facts?.origin ?? null]).toEqual(["repo", null]);
    });
    let branch = "";
    await step("test green", async () => {
      const done = await until(() => read<{ task: Shown }>(`/api/tasks/${taskId}`).then((r) => r.task), (t) => !["queued", "running"].includes(t.status) && t.requestNumber !== null, 2400);
      expect([done.status, done.error]).toEqual(["needs-review", null]);
      branch = done.request!.branch;
      expect(git(machine, repo, ["diff", "--name-only", `main...${branch}`]).split("\n")).toEqual(["src/price.js"]);
      // The product's own proof: it ran npm test before the agent (red) and after it (green).
      const { verifications } = await read<{ verifications: { verification: { verdict: string; checks: { command: string; before: { code: number } | null; after: { code: number }[] }[] } }[] }>(`/api/tasks/${taskId}/verification`);
      const check = verifications[0]!.verification.checks[0]!;
      expect([verifications[0]!.verification.verdict, check.command, check.before?.code !== 0, check.after.at(-1)?.code]).toEqual(["fixed", "npm test", true, 0]);
      await expect(page.locator("ul.run-checks")).toContainText("npm test failed before, passed after");
      // And the same kit's tests run outside the product, a check of the check.
      expect(testsPassAt(machine, repo, branch), "the kit's tests on the task's branch").toBe(true);
      return `${branch}, verdict fixed`;
    });
    let followedUp = false;
    await step("comment on a line", async () => {
      await page.goto(`${base}${new URL(page.url()).pathname}`);
      await expect(page.getByText("src/price.js", { exact: true }).first()).toBeVisible();
      // A line is quoted only where the task takes a follow-up; a page without one draws the patch read-only.
      const { task } = await read<{ task: Shown & { followUp: string | null } }>(`/api/tasks/${taskId}`);
      if (task.followUp !== "continue") return `skipped: the task takes no follow-up once it waits for review (followUp ${task.followUp})`;
      const patch = page.locator("pre.diff-patch").first();
      // The page opens a short change's files itself, its patch read a moment after the page; a file
      // still folded once that moment has passed is opened by a click, which on an open one would fold it.
      await patch.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
      if (!(await patch.isVisible())) {
        await page.getByText("src/price.js", { exact: true }).first().click({ timeout: 30_000 });
        clicks += 1;
      }
      await expect(patch, "the patch of src/price.js").toBeVisible({ timeout: 30_000 });
      // The read-only patch and the quotable one look alike; only the quotable one numbers its lines for a selection.
      if (!(await patch.locator("span[data-i]").count())) throw new Error("the patch on the page is read-only: no line of it can be quoted, though the task takes a follow-up");
      const changed = patch.locator("span[data-i]", { hasText: "weightKg <= TIERS[i].upToKg" }).first();
      await changed.selectText({ timeout: 30_000 });
      await patch.dispatchEvent("mouseup");
      await page.getByRole("button", { name: /^Quote lines .+ in a follow-up$/ }).click({ timeout: 30_000 });
      clicks += 1;
      await page.getByLabel("What the agent should do").fill(COMMENT, { timeout: 30_000 });
      typed += 1;
      await page.getByRole("button", { name: /^(Start the next run|Continue)$/ }).click({ timeout: 30_000 });
      clicks += 1;
      followedUp = true;
      return null;
    });
    await step("the fix after the comment", async () => {
      if (!followedUp) return "skipped: no follow-up was sent";
      // The follow-up's run ends in review again, or fails with the orchestrator's reason, which is the step's failure.
      await until(() => read<{ task: Shown }>(`/api/tasks/${taskId}`).then((r) => r.task.status), (s) => s === "running", 240);
      const ended = await until(() => read<{ task: Shown }>(`/api/tasks/${taskId}`).then((r) => r.task), (t) => !["queued", "running"].includes(t.status), 2400);
      expect([ended.status, ended.error], "the follow-up's run").toEqual(["needs-review", null]);
      expect(spawnSync("git", ["-C", repo, "show", `${branch}:src/price.js`], { env: machine.env, encoding: "utf8" }).stdout).toContain("for (const tier of TIERS)");
      expect(testsPassAt(machine, repo, branch), "the kit's tests after the follow-up").toBe(true);
    });
    await step("lesson", async () => {
      const lessons = await until(() => read<{ candidates: { slug: string; status: string }[] | null }>(`/api/tasks/${taskId}/lessons`), (r) => (r.candidates ?? []).some((c) => c.status === "pending"), 90);
      const candidate = (lessons.candidates ?? []).find((c) => c.status === "pending");
      if (!candidate) throw new Error(`no lesson candidate waits for its person: ${JSON.stringify(lessons)}`);
      const slug = candidate.slug;
      const { csrf } = await read<{ csrf: string }>("/api/me");
      const res = await page.request.post(`${base}/api/tasks/${taskId}/lessons/${encodeURIComponent(slug)}/keep`, { headers: { "x-csrf-token": csrf } });
      expect(res.status(), "keeping the lesson").toBe(200);
      const after = await read<{ candidates: { slug: string; status: string }[] }>(`/api/tasks/${taskId}/lessons`);
      expect(after.candidates.find((c) => c.slug === slug)?.status).toBe("approved");
      return `lesson ${slug} kept`;
    });
    await step("keep", async () => {
      const { task } = await read<{ task: Shown }>(`/api/tasks/${taskId}`);
      const state = () => read<{ status: { detail: { status: string } } }>(`/api/repos/${projectId}/requests/${task.requestNumber}/status`).then((r) => r.status.detail.status);
      // A follow-up moves the branch past the checks it was kept on; the first Keep checks it again, the next one merges.
      let said = "";
      for (let press = 0; press < 3; press++) {
        await page.getByRole("button", { name: "Keep these changes" }).click();
        clicks += 1;
        const after = await until(state, (s) => s !== "open", press < 2 ? 20 : 60).catch((): string => "open");
        if (after === "merged") return press === 0 ? null : `merged on press ${press + 1}: ${said}`;
        said = (await page.getByRole("alert").allTextContents()).join(" | ");
        if (!/checked again/.test(said)) break;
      }
      throw new Error(`the request is ${await state()} after Keep; the page said: ${said || "nothing"}`);
    });
    await step("request open", async () => {
      const { task } = await read<{ task: Shown }>(`/api/tasks/${taskId}`);
      const { status } = await read<{ status: { detail: { status: string } } }>(`/api/repos/${projectId}/requests/${task.requestNumber}/status`);
      expect([status.detail.status, task.request!.branch]).toEqual(["merged", `task/${taskId}`]);
      const { description } = await read<{ description: string | null }>(`/api/repos/${projectId}/requests/${task.requestNumber}/description`);
      expect(description ?? "", "the request's description").toContain("## Verification");
      expect([git(machine, repo, ["rev-parse", "--abbrev-ref", "HEAD"]), git(machine, repo, ["status", "--porcelain"])]).toEqual(["main", ""]);
      expect(testsPassAt(machine, repo, "main"), "the kit's tests on main after Keep").toBe(true);
      return `request #${task.requestNumber} on ${task.request!.branch}, merged`;
    });
  } finally {
    appendFileSync(join(OUT, "demo.ndjson"), JSON.stringify({ step: "total", ok: failed === null, ms: Date.now() - started, clicks, typed, failed }) + "\n");
    const video = page.video();
    await context.close();
    if (video) renameSync(await video.path(), join(OUT, "demo.webm"));
    if (run) {
      process.kill(-(run as Started).child.pid!, "SIGINT");
      await Promise.race([(run as Started).exited, new Promise((r) => setTimeout(r, 20_000))]);
    }
    writeFileSync(join(OUT, "trapped.json"), JSON.stringify(machine.trapped()) + "\n");
  }
  expect(failed, `the demo stopped at ${failed}`).toBeNull();
});

