import type { Page } from "@playwright/test";

/**
 * The demo's repositories are reached by path, so the forge form is never drawn for them. This
 * answers for payments-skills as if it lived on a hosted forge with no access saved yet, and
 * refuses a save with `refusal`; nothing reaches the orchestrator's own records.
 */
export async function hostedPayments(page: Page, refusal = "the token was refused by the forge"): Promise<void> {
  const hosted = "https://gitlab.example.invalid/payments/skills.git";
  await page.route("**/api/repos", async (route) => {
    const body = await (await route.fetch()).json();
    await route.fulfill({ json: { repos: body.repos.map((r: { id: string }) => (r.id === "payments-skills" ? { ...r, url: hosted } : r)) } });
  });
  await page.route("**/api/repos/payments-skills/inventory", async (route) => {
    const body = await (await route.fetch()).json();
    await route.fulfill({ json: { ...body, repo: { ...body.repo, url: hosted } } });
  });
  await page.route("**/api/repos/payments-skills/forge", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: { config: null, token: { set: false }, vault: true } })
      : route.fulfill({ status: 400, json: { error: refusal } }),
  );
}

/** The Integrations page with the GitLab card's other ways to connect open and payments-skills' row set up, where its forge access is set. */
export async function openForgeCard(page: Page): Promise<void> {
  await page.goto("/demo/integrations");
  const card = page.locator("#card-gitlab");
  await card.getByText("Other ways to connect", { exact: true }).click();
  await card.getByRole("button", { name: "Set up GitLab for payments-skills" }).click();
}
