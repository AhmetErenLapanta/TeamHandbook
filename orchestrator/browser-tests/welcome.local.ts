import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { HOME, OPENED } from "../playwright.local.config.js";
import { PROMISE } from "../web/src/words.js";
import { folderField } from "./folder-picker.js";
import { signInWithOpenedLink } from "./one-time-link.js";

// The README's local-mode picture: the first screen a person sees after one command. Opt-in, as the
// other README pictures are: `ORCHESTRATOR_E2E_SCREENSHOTS=1`.
const OUT = fileURLToPath(new URL("../docs/screenshots/", import.meta.url));

test.use({ viewport: { width: 1280, height: 800 }, colorScheme: "light" });

test("given a local orchestrator started with nothing configured, when the link it opened is followed, then the first screen is the promise over one box with no folder asked and no sign-in, a task with no folder to go to says so, and a folder added in Settings opens as one", async ({ page }) => {
  // when
  // A first start makes its key and its database before it hands the browser the link, slower on a busy machine.
  await expect.poll(() => { try { return readFileSync(OPENED, "utf8"); } catch { return ""; } }, { timeout: 30_000 }).not.toBe("");
  await signInWithOpenedLink(page, OPENED);

  // then
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(PROMISE);
  const form = page.getByRole("form", { name: "New task" });
  await expect(form.getByLabel("What needs doing?")).toBeVisible();
  await expect(page.getByRole("group", { name: "Pick a folder" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /sign in/i })).toHaveCount(0);

  if (process.env.ORCHESTRATOR_E2E_SCREENSHOTS) {
    await expect(page.getByText(/^Checking\b/)).toHaveCount(0, { timeout: 30_000 });
    const text = await page.content();
    for (const trace of [homedir(), tmpdir(), userInfo().username].filter((t) => t.length >= 4)) expect(text, `the picture shows ${trace}`).not.toContain(trace);
    mkdirSync(OUT, { recursive: true });
    await page.screenshot({ path: join(OUT, "0-local-welcome.png") });
  }

  // when the person starts a task with no folder of theirs to go to
  await form.getByLabel("What needs doing?").fill("Add retries to the capture call");
  await form.getByRole("button", { name: "Start task" }).click();

  // then it asks which folder, with a field for a path
  await expect(form.getByRole("group", { name: "Which folder" })).toContainText("Which folder does this task work in?");

  // when a folder in the home is pasted into Settings' picker
  const shop = join(HOME, "shop");
  mkdirSync(shop, { recursive: true });
  writeFileSync(join(shop, "package.json"), "{}\n");
  await page.getByRole("button", { name: /^Account:/ }).click();
  await page.getByRole("navigation", { name: "Account" }).getByRole("link", { name: "Settings" }).click();
  await page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Where your code lives" }).click();
  await page.getByRole("button", { name: "Add a folder" }).click();
  const picker = page.getByRole("group", { name: "Pick a folder" });
  await expect(picker.getByRole("alert")).toHaveCount(0);
  await folderField(picker).fill("~/shop");
  await folderField(picker).press("Enter");

  // then the server opens it as a project and the picker closes
  await expect(picker).toHaveCount(0);
});
