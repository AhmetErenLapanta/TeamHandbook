import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { stateFor } from "./roles.js";

// The demo's bare repositories are on this machine for an orchestrator the suite starts itself; one
// run elsewhere is not reachable this way, and these specs are skipped against it.
const scratch = process.env.ORCHESTRATOR_E2E_SCRATCH!;
const external = Boolean(process.env.ORCHESTRATOR_E2E_BASE_URL);
const bare = (repo: string) => join(scratch, "demo", "repos", `${repo}.git`);
const RULES = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];

/** Merges a branch into platform-skills the way GitLab does, its commit carrying Claude Code's trailer, and has the orchestrator read it. */
async function mergedWithClaude(request: APIRequestContext) {
  const work = mkdtempSync(join(tmpdir(), "orchestrator-e2e-ai-"));
  const env = { PATH: process.env.PATH, HOME: work, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Pat Payments", GIT_AUTHOR_EMAIL: "pat@example.invalid", GIT_COMMITTER_NAME: "Forge", GIT_COMMITTER_EMAIL: "forge@example.invalid" };
  const git = (args: string[]) => execFileSync("git", args, { cwd: work, env, encoding: "utf8" });
  try {
    git(["clone", "-q", bare("platform-skills"), "."]);
    git(["checkout", "-q", "-b", "ai-runbook"]);
    writeFileSync(join(work, "ai-runbook.md"), "runbook\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "docs: runbook\n\nCo-Authored-By: Claude <noreply@anthropic.com>"]);
    const main = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).trim().replace("origin/", "");
    git(["checkout", "-q", main]);
    git(["merge", "-q", "--no-ff", "ai-runbook", "-m", "Merge branch 'ai-runbook' into 'main'\n\nSee merge request acme/platform-skills!41"]);
    execFileSync("git", ["fetch", "-q", work, `${main}:${main}`], { cwd: bare("platform-skills"), env, encoding: "utf8" });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  const { csrf } = await (await request.get("/api/me")).json();
  expect((await request.post("/api/repos/platform-skills/sync", { headers: { "x-csrf-token": csrf } })).status()).toBe(200);
}

test.describe("AI-assisted requests", () => {
  test.skip(external, "needs the demo's repositories on this machine");

  test("given a request merged with Claude Code's trailer, when an owner opens AI requests, then it counts for Claude Code, Platform has a row and its author is named", async ({ page }) => {
    // given
    await mergedWithClaude(page.request);

    // when
    await page.goto("/demo/activity/ai");

    // then
    await expect(page.getByRole("heading", { name: "AI requests", level: 1 })).toBeVisible();
    await expect(page.getByText("Claude Code: 1")).toBeVisible();
    const teams = page.getByRole("region", { name: "By team" });
    await expect(teams.getByRole("row", { name: /Platform/ })).toBeVisible();
    await expect(page.getByRole("region", { name: /By person/ })).toContainText("pat@example.invalid");
    expect((await new AxeBuilder({ page }).withTags(RULES).analyze()).violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(" ")}`))).toEqual([]);
  });

  test.describe("for a member", () => {
    test.use({ storageState: stateFor("member") });

    test("given the same page, when a member opens it, then they read the teams and repositories and no person", async ({ page }) => {
      // when
      await page.goto("/demo/activity/ai");

      // then
      await expect(page.getByRole("region", { name: "By team" })).toBeVisible();
      await expect(page.getByRole("region", { name: /By person/ })).toHaveCount(0);
      expect(await page.content()).not.toContain("pat@example.invalid");
    });
  });
});
