import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { HOME, OPENED } from "../playwright.folder.config.js";
import { signInWithOpenedLink } from "./one-time-link.js";

const git = (args: string[], cwd: string) => execFileSync("git", ["-c", "user.name=Ada Example", "-c", "user.email=ada@example.invalid", ...args], { cwd, encoding: "utf8" });

test("given a folder holding two repositories that Claude Code has worked in, when a task is started from the one box and changes both, then nothing asks for a folder or a repository and the review shows each one's change under its name with its own request and what it reaches", async ({ page }) => {
  // given
  const code = join(HOME, "code");
  for (const name of ["alpha", "beta"]) {
    const repo = join(code, name);
    mkdirSync(repo, { recursive: true });
    git(["init", "--quiet", "-b", "main"], repo);
    writeFileSync(join(repo, "README.md"), `${name}\n`);
    git(["add", "README.md"], repo);
    git(["commit", "--quiet", "-m", "First commit"], repo);
  }
  // Claude Code names a project's folder after its path, every character but a letter or a digit turned into "-".
  const seen = join(HOME, ".claude", "projects", realpathSync(code).replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(seen, { recursive: true });
  writeFileSync(join(seen, "session.jsonl"), "{}\n");
  await expect.poll(() => { try { return readFileSync(OPENED, "utf8"); } catch { return ""; } }, { timeout: 30_000 }).not.toBe("");
  await signInWithOpenedLink(page, OPENED);

  // when the work is said in the one box
  const box = page.getByRole("form", { name: "New task" });
  await box.getByLabel("What needs doing?").fill("Add a skill to each repository\nstand-in: work in alpha\nstand-in: work in beta");

  // then no folder, repository or project is asked
  await expect(box.getByRole("combobox", { name: "Repository" })).toHaveCount(0);
  await expect(box.getByRole("group", { name: /^Repositories/ })).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Pick a folder" })).toHaveCount(0);

  // when
  await box.getByRole("button", { name: "Start task" }).click();

  // then, if the orchestrator asks which folder, one answer starts it; the run's first line says where it works
  const which = box.getByRole("group", { name: "Which folder" });
  const where = page.getByRole("list", { name: "What the agent did" }).locator(":scope > li").first();
  await which.or(where).first().waitFor();
  if (await which.isVisible()) await which.getByRole("button", { name: /^code/ }).click();
  await expect(where).toContainText("Working in ~/code");

  // then
  await expect(page.locator("[data-status]").first()).toHaveText("needs you", { timeout: 60_000 });
  await expect(page.locator("header.page-head .page-summary")).toHaveText(/, changing alpha and beta; each change waits for your review\.$/);
  const changes = page.getByRole("region", { name: "Changes", exact: true });
  for (const name of ["alpha", "beta"]) {
    const group = changes.getByRole("region", { name, exact: true });
    await expect(group.getByRole("heading", { level: 3 })).toHaveText(name);
    await expect(group).toContainText("Your checkout changes only when you keep this.");
    await expect(group).not.toContainText("Request #");
    await expect(group).toContainText("SKILL.md");
  }
  await expect(page.getByRole("main").locator('a[href*="/repositories/"]')).toHaveCount(0);
  for (const name of ["alpha", "beta"]) expect(git(["status", "--porcelain"], join(code, name))).toBe("");

  // then with two repositories waiting, neither one's Keep is the page's one filled action
  for (const name of ["alpha", "beta"]) await expect(changes.getByRole("region", { name, exact: true }).getByRole("button", { name: "Keep these changes" })).toHaveClass(/secondary/);

  // when the person keeps alpha's change and discards beta's
  await changes.getByRole("region", { name: "alpha", exact: true }).getByRole("button", { name: "Keep these changes" }).click();
  await expect(changes.getByRole("region", { name: "alpha", exact: true }).getByRole("button", { name: "Keep these changes" })).toHaveCount(0);
  const beta = changes.getByRole("region", { name: "beta", exact: true });
  await beta.getByRole("button", { name: "Discard these changes…" }).click();
  await beta.getByRole("button", { name: "Discard changes" }).click();
  await expect(beta.getByRole("button", { name: "Keep these changes" })).toHaveCount(0);

  // then alpha's checkout holds the change and beta's does not, both clean
  expect(existsSync(join(code, "alpha", "skills", "add-a-skill-to-each-repository", "SKILL.md"))).toBe(true);
  expect(existsSync(join(code, "beta", "skills"))).toBe(false);
  for (const name of ["alpha", "beta"]) expect(git(["status", "--porcelain"], join(code, name))).toBe("");

  // when the person looks for where their code lives
  await page.getByRole("button", { name: /^Account:/ }).click();
  await page.getByRole("navigation", { name: "Account" }).getByRole("link", { name: "Settings" }).click();
  await page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Where your code lives" }).click();

  // then the folder is listed among the ones tasks work in, with what it gives every task
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Where your code lives");
  await expect(page.getByRole("region", { name: "Folders tasks work in" }).getByRole("listitem").filter({ hasText: /^code\s+~\/code\s/ })).toHaveCount(1);
  await expect(page.getByRole("region", { name: /^Skills and MCP servers/ })).toBeVisible();

  // when the next task is started from Tasks, with the folder's repositories now on record
  const options = await (await page.request.get("/api/tasks/options")).json();
  await page.getByRole("navigation", { name: "Orchestrator" }).getByRole("link", { name: "Tasks" }).click();
  const form = page.getByRole("form", { name: "New task" });
  await expect(form).toBeVisible();

  // then the form still asks for no repository: the records a task keeps for the folder's repositories are no project to pick
  expect(options.repos.map((r: { id: string }) => r.id)).toEqual(["code"]);
  await expect(form.getByRole("group", { name: /^Repositories/ })).toHaveCount(0);
  await expect(form.getByText("Pick repositories")).toHaveCount(0);
});
