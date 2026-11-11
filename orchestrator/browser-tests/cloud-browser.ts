import type { Browser, BrowserContext, Page, Route } from "@playwright/test";
import { PUBLIC_URL } from "./cloud-setup.js";

// What every cloud spec does as a person: a browser of its own on the orchestrator's https address,
// signing in on a stand-in provider's page, and creating an organization.

/**
 * A redirect as a page that moves on by itself. A browser follows a redirect without asking the
 * routes again, so a hop to the orchestrator's https address would reach no server; a fresh navigation
 * is routed like any other request. Every cookie the redirect set is kept.
 */
async function hopping(route: Route, url: string): Promise<void> {
  const response = await route.fetch({ url, maxRedirects: 0 });
  const location = response.headers().location;
  if (response.status() < 300 || response.status() >= 400 || !location) return route.fulfill({ response });
  const cookies = response.headersArray().filter((h) => h.name.toLowerCase() === "set-cookie").map((h) => h.value);
  const target = new URL(location, route.request().url()).toString().replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`);
  return route.fulfill({ status: 200, headers: { "content-type": "text/html", ...(cookies.length ? { "set-cookie": cookies.join("\n") } : {}) }, body: `<!doctype html><meta http-equiv="refresh" content="0;url=${target}">` });
}

/** A browser of its own, reaching the orchestrator's https address through its port, and the stand-in providers as they are. */
export async function browserOf(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  await context.route(`${PUBLIC_URL}/**`, (route) => hopping(route, route.request().url().replace(PUBLIC_URL, process.env.CLOUD_E2E_ORIGIN!)));
  await context.route(`${process.env.CLOUD_E2E_PROVIDERS}/**`, (route) => hopping(route, route.request().url()));
  return { context, page: await context.newPage() };
}

/** Signing in on the provider's own page, as the person named. */
export async function pick(page: Page, provider: string, name: string) {
  await page.getByRole("link", { name: `Sign in with ${provider}` }).or(page.getByRole("button", { name: `Sign in with ${provider}` })).first().click();
  await page.getByRole("button", { name: new RegExp(`^Continue as ${name}`) }).click();
}

export async function createOrganization(page: Page, name: string) {
  const form = page.getByRole("form", { name: "Create your organization" });
  await form.getByLabel("Organization name").fill(name);
  await form.getByLabel(/I accept the terms of use/).check();
  await form.getByRole("button", { name: "Create organization" }).click();
}
