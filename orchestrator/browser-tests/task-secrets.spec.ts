import { expect, test } from "@playwright/test";
import { stateFor } from "./roles.js";
import { choose } from "./task-form.js";

const VALUE = "stand-in-task-secret-0001";

test.describe("task secrets, as the owner", () => {
  test("given a team secret, when it is saved, then the list names it with who set it and the page never shows the value, and deleting asks first and then removes it", async ({ page }) => {
    // given
    const name = `E2E_TOKEN_${Date.now()}`;
    await page.goto("/demo/settings/task-secrets");
    const form = page.getByRole("form", { name: "Add a secret" });

    // when
    await choose(form, "Applies to", "Every repository of a team");
    await choose(form, "Team", "Payments");
    await form.getByLabel("Name").fill(name);
    await form.getByLabel("Value", { exact: true }).fill(VALUE);
    await form.getByRole("button", { name: "Save secret" }).click();

    // then
    await expect(page.getByRole("status")).toHaveText(`Saved ${name} for team Payments. The value is not shown again.`);
    const row = page.getByRole("row", { name: new RegExp(name) });
    await expect(row).toContainText("by ada@example.invalid");
    await expect(form.getByLabel("Value", { exact: true })).toHaveValue("");
    expect(await page.content()).not.toContain(VALUE);
    await page.reload();
    expect(await page.content()).not.toContain(VALUE);

    // when deleted, with a second answer
    await row.getByRole("button", { name: `Delete ${name} for team Payments` }).click();
    await expect(row).toContainText(`starts without ${name}`);
    await row.getByRole("button", { name: "Delete secret" }).click();

    // then
    await expect(page.getByRole("row", { name: new RegExp(name) })).toHaveCount(0);
  });

  test("given an orchestrator that reads a 1Password vault, when a secret is saved as a reference, then the reference is sent in place of a value and the list names where each task reads it", async ({ page }) => {
    // given
    const reference = "op://Engineering/registry/token";
    let saved: unknown = null;
    let listed: unknown[] = [];
    await page.route("**/api/task-secrets", async (route) => {
      if (route.request().method() === "PUT") {
        saved = route.request().postDataJSON();
        const secret = { scope: "team", target: "Payments", name: "REGISTRY_TOKEN", updatedAt: "2026-11-03T12:00:00Z", updatedBy: "ada@example.invalid", reference };
        listed = [secret];
        return route.fulfill({ json: { secret } });
      }
      return route.fulfill({ json: { secrets: listed, vault: true, op: ["Engineering"] } });
    });
    await page.goto("/demo/settings/task-secrets");
    const form = page.getByRole("form", { name: "Add a secret" });

    // when
    await choose(form, "Applies to", "Every repository of a team");
    await choose(form, "Team", "Payments");
    await form.getByLabel("Name").fill("REGISTRY_TOKEN");
    await choose(form, "Value", "Read from 1Password");
    await expect(form).toContainText("Read when each task starts, from the vault Engineering");
    await form.getByLabel("1Password reference").fill(reference);
    await form.getByRole("button", { name: "Save secret" }).click();

    // then
    expect(saved).toEqual({ scope: "team", target: "Payments", name: "REGISTRY_TOKEN", secret: { provider: "op", reference } });
    await expect(page.getByRole("status")).toHaveText(`Saved REGISTRY_TOKEN for team Payments; each task reads it from ${reference}.`);
    await expect(page.getByRole("row", { name: /REGISTRY_TOKEN/ })).toContainText(reference);
  });

  test("given an orchestrator that reads no vault, when the form opens, then it asks for a typed value and offers no 1Password", async ({ page }) => {
    // given
    await page.route("**/api/task-secrets", (route) => route.fulfill({ json: { secrets: [], vault: true, op: null } }));

    // when
    await page.goto("/demo/settings/task-secrets");

    // then
    const form = page.getByRole("form", { name: "Add a secret" });
    await expect(form.getByLabel("Value", { exact: true })).toHaveAttribute("type", "password");
    await expect(form).not.toContainText("1Password");
  });

  test("given a name the orchestrator keeps for every task, when it is saved, then it is refused and named", async ({ page }) => {
    // given
    await page.goto("/demo/settings/task-secrets");
    const form = page.getByRole("form", { name: "Add a secret" });

    // when
    await form.getByLabel("Name").fill("PATH");
    await form.getByLabel("Value", { exact: true }).fill("/tmp");
    await form.getByRole("button", { name: "Save secret" }).click();

    // then
    await expect(form.getByRole("alert")).toHaveText("PATH is set by the orchestrator or the system for every task; pick another name.");
  });
});

test.describe("task secrets, as a member who owns a team", () => {
  test.use({ storageState: stateFor("paymentsOwner") });

  test("given a member, when task secrets open, then they are told only owners and admins manage them, and the API refuses the list", async ({ page }) => {
    await page.goto("/demo/settings/task-secrets");
    await expect(page.getByText("Only owners and admins manage task secrets.")).toBeVisible();
    expect((await page.request.get("/api/task-secrets")).status()).toBe(403);
  });
});
