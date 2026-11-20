import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { SERVERS } from "../playwright.handbook.config.js";
import { signInWithOpenedLink } from "./one-time-link.js";

export const server = () => SERVERS[test.info().project.name]!;

export async function signIn(page: Page): Promise<void> {
  // A first start makes its key and database before it hands the browser the link, slower on a busy machine.
  await expect.poll(() => { try { return readFileSync(server().opened, "utf8"); } catch { return ""; } }, { timeout: 60_000 }).not.toBe("");
  await page.goto("/");
  await signInWithOpenedLink(page, server().opened);
  await expect(page.getByLabel("What needs doing?")).toBeVisible();
}

/** A change request the way the page makes one: with the CSRF token the orchestrator handed this session. */
export async function send(page: Page, method: "PUT" | "POST" | "DELETE", url: string, data?: unknown) {
  const { csrf } = (await (await page.request.get("/api/me")).json()) as { csrf: string };
  return page.request.fetch(url, { method, headers: { "x-csrf-token": csrf }, ...(data === undefined ? {} : { data }) });
}

export async function finished(page: Page, id: string): Promise<void> {
  await expect.poll(async () => ((await (await page.request.get(`/api/tasks/${id}`)).json()) as { task: { status: string } }).task.status, { timeout: 90_000 }).toMatch(/needs-review|nothing-changed|failed|completed|cancelled/);
}

/** Starts a task from the one box and waits until its run is over; the id of the task it made. */
export async function startTask(page: Page, words: string): Promise<string> {
  const form = page.getByRole("form", { name: "New task" });
  await form.getByLabel("What needs doing?").fill(words);
  await form.getByRole("button", { name: "Start task" }).click();
  await page.waitForURL(/\/tasks\/tsk_[0-9a-z]+/);
  const id = new URL(page.url()).pathname.split("/").pop()!;
  await finished(page, id);
  return id;
}

export const handbooksOf = (page: Page): Locator => page.locator("section.turn").filter({ has: page.getByRole("heading", { name: /^Your handbooks/ }) });
