import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";

/** The link inside the page the orchestrator handed its browser: a refresh to it, so no token sits in a command's arguments. */
export function oneTimeLink(opened: string): string {
  const page = readFileSync(readFileSync(opened, "utf8"), "utf8");
  const link = /url=([^"'>]+)/i.exec(page)?.[1];
  if (!link) throw new Error("the page the orchestrator opened holds no link");
  return link;
}

/** Follows the one-time link and presses the Continue the sign-in page asks for, as a person does: the page spends the link only on that press. */
export async function signInWithOpenedLink(page: Page, opened: string): Promise<void> {
  await page.goto(oneTimeLink(opened));
  await page.getByRole("button", { name: "Continue", exact: true }).click();
}
