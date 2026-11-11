import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { browserOf, createOrganization, pick } from "../../browser-tests/cloud-browser.js";
import { Evidence } from "../evidence.js";
import { personsRepository } from "../solo.js";
import { cloudOrchestrator, PUBLIC_URL } from "./cloud-orchestrator.js";
import type { CloudOrchestrator } from "./cloud-orchestrator.js";
import { runOnMachine, stopRunner } from "./machines.js";
import { lab, unique } from "./support.js";

const at = (path: string) => `${PUBLIC_URL}${path}`;

interface Step {
  step: string;
  ok: boolean;
  /** Seconds since the person opened the sign-up page. */
  at: number;
  clicks: number;
  typed: number;
  screen: string;
  detail?: string;
}

/**
 * A person new to a cloud orchestrator, from the landing page's sign-up address to their first
 * agent task in review, with no help: sign up, create the company, connect their computer with
 * the command shown, pick a folder of it, start a task, see it in review. Each step is timed from
 * the first page and counts the clicks and typed fields it took and the screen it ended on; the
 * first step that does not happen is where the person is stuck, kept with its screen. The cloud
 * orchestrator is the lab's own, with no Docker (lab/tests/cloud-orchestrator.ts); the computer is a
 * clean machine running the packed orchestrator's runner with the stand-in claude.
 */
test.describe("a person's first agent task on a cloud orchestrator", () => {
  test.skip(!lab.postgres, "this lab has no Postgres");
  let cloud: CloudOrchestrator;
  test.beforeAll(async () => {
    cloud = await cloudOrchestrator("cloud-first-task");
  });
  test.afterAll(async () => {
    await cloud.stop();
  });

  test("given a person new to a cloud orchestrator, when they go from the landing page's sign-up to a task in review with no help, then each step happens, and its time, clicks, typed fields and screen are kept", async ({ browser }) => {
    test.setTimeout(600_000);
    const proof = new Evidence(lab.dir, "cloud-first-task", [lab.password]);
    const steps: Step[] = [];
    const { page } = await browserOf(browser);
    const started = Date.now();
    let clicks = 0;
    let typed = 0;
    const screenOf = (p: Page) => new URL(p.url()).pathname.replace(/\/tsk_[0-9a-z]+$/, "/<task>");
    /** One step the person takes; the first that fails is kept as where they are stuck, with its screen. */
    const step = async (name: string, act: () => Promise<string | void>) => {
      const before = { clicks, typed };
      try {
        const detail = (await act()) ?? undefined;
        steps.push({ step: name, ok: true, at: (Date.now() - started) / 1000, clicks: clicks - before.clicks, typed: typed - before.typed, screen: screenOf(page), ...(detail ? { detail } : {}) });
      } catch (err) {
        steps.push({ step: name, ok: false, at: (Date.now() - started) / 1000, clicks: clicks - before.clicks, typed: typed - before.typed, screen: screenOf(page), detail: (err as Error).message.split("\n")[0] });
        await page.screenshot({ path: join(proof.dir, `stuck-${name}.png`), fullPage: true });
        throw err;
      }
      await page.screenshot({ path: join(proof.dir, `${String(steps.length).padStart(2, "0")}-${name}.png`), fullPage: true });
    };
    const root = join(lab.dir, "cloud-first-task", unique("computer"));
    mkdirSync(root, { recursive: true });
    let runner: ReturnType<typeof runOnMachine> | null = null;
    try {
      await step("signed up", async () => {
        await page.goto(at("/signup?from=landing"));
        await pick(page, "Google", "Ada Okafor");
        clicks += 2;
        await expect(page).toHaveURL(/\/signup\/organization$/);
      });
      await step("company created", async () => {
        await createOrganization(page, "Okafor Labs");
        typed += 1;
        clicks += 2;
        await expect(page).toHaveURL(/\/okafor-labs\/welcome$/);
      });
      let command: string[] = [];
      await step("connect command shown", async () => {
        const connect = page.getByRole("region", { name: "Connect this computer" });
        command = (await connect.locator(".copy-text code").first().textContent({ timeout: 30_000 }))!.trim().split(/\s+/);
        proof.add(command.at(-1)!);
        await connect.getByRole("button", { name: "Copy the command" }).click();
        clicks += 1;
        return command.slice(0, 3).join(" ");
      });
      await step("computer connected", async () => {
        // The person pastes the command in a terminal of their computer: one command, no click. The
        // public address is the lab's https name, which only the browser is routed to; the computer
        // reaches the same orchestrator at its port, the host alone swapped, as DNS and TLS would.
        runner = runOnMachine(root, command.map((part) => part.replace(PUBLIC_URL, cloud.origin)), "ada-laptop");
        await expect(page.getByRole("region", { name: "Connect this computer" })).toBeHidden({ timeout: 120_000 });
      });
      await step("folder picked", async () => {
        const folder = personsRepository(runner!.machine);
        await page.getByLabel(/Folder name or path|Folder/).first().fill(`~/${folder.slice(runner!.machine.home.length + 1)}`);
        typed += 1;
        await page.keyboard.press("Enter");
        await expect(page.getByLabel(/What should the agent do/)).toBeVisible({ timeout: 60_000 });
      });
      await step("task started", async () => {
        await page.getByLabel(/What should the agent do/).fill("Expose the delivery-window endpoint");
        typed += 1;
        await page.getByRole("button", { name: "Start" }).click();
        clicks += 1;
        await expect(page).toHaveURL(/\/okafor-labs\/tasks\//, { timeout: 60_000 });
      });
      await step("task in review", async () => {
        await expect(page.getByText(/waits for your review|needs review|Request in review|Review changes/i).first()).toBeVisible({ timeout: 240_000 });
      });
    } finally {
      if (runner) {
        proof.write("computer.txt", (runner as ReturnType<typeof runOnMachine>).runner.said());
        await stopRunner((runner as ReturnType<typeof runOnMachine>).runner);
      }
      const screens = [...new Set(steps.map((s) => s.screen))];
      const flow = { steps, total: { seconds: steps.at(-1)?.at ?? 0, clicks: steps.reduce((n, s) => n + s.clicks, 0), typed: steps.reduce((n, s) => n + s.typed, 0), screens: screens.length, terminalCommands: steps.some((s) => s.step === "computer connected") ? 1 : 0 }, stuck: steps.find((s) => !s.ok)?.step ?? null };
      proof.json("flow.json", flow);
      proof.copy("orchestrator.log", cloud.log);
      writeFileSync(join(proof.dir, "flow.txt"), steps.map((s) => `${s.ok ? "ok   " : "STUCK"} ${s.at.toFixed(1).padStart(6)} s  ${s.step}  (clicks ${s.clicks}, typed ${s.typed}, ${s.screen})${s.detail ? `  ${s.detail}` : ""}`).join("\n") + "\n");
    }
  });
});
