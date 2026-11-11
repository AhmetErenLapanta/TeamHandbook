import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openTab } from "./repo-tabs.js";

// The plugin half runs from the bundles the plugin ships, as Claude Code would run them on a
// teammate's machine; this spec needs the repositories on the same disk as the orchestrator, so it
// does not run against an orchestrator in a container.
test.skip(!!process.env.ORCHESTRATOR_E2E_BASE_URL, "needs the orchestrator's repositories on this machine");

const pluginDist = join(import.meta.dirname, "..", "..", "dist");
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv });
}

/** What a forge does when a person merges the request: the default branch moves to a merge commit. */
function mergeAsTheTeam(bare: string, branch: string): void {
  const work = mkdtempSync(join(tmpdir(), "orchestrator-e2e-merge-"));
  try {
    git(["init", "--quiet"], work);
    git(["fetch", "--quiet", bare, "main:main", `${branch}:request`], work);
    git(["checkout", "--quiet", "main"], work);
    git(["-c", "user.name=Grace Example", "-c", "user.email=grace@example.invalid", "merge", "--no-ff", "--quiet", "-m", "Merge the usage request", "request"], work);
    git(["fetch", "--quiet", work, "main:main"], bare);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** A teammate's machine: the team copy Claude Code keeps, and a TeamHandbook joined to it. */
function teammate(bare: string, consent?: boolean): { home: string; handbook: string } {
  const home = mkdtempSync(join(tmpdir(), "orchestrator-e2e-teammate-"));
  const copy = join(home, ".claude", "plugins", "marketplaces", "payments-skills");
  mkdirSync(join(home, ".claude", "plugins", "marketplaces"), { recursive: true });
  git(["clone", "--quiet", bare, copy], home);
  // A teammate who agrees names the exact address the team file asks for.
  const endpoint = JSON.parse(readFileSync(join(copy, ".teamhandbook.json"), "utf8")).usage.endpoint;
  const handbook = join(home, ".teamhandbook");
  mkdirSync(handbook, { recursive: true });
  writeFileSync(
    join(handbook, "config.json"),
    JSON.stringify({
      team: { repoUrl: "https://git.example.com/acme/payments-skills.git", marketplaceName: "payments-skills" },
      ...(consent === undefined ? {} : { usage: { shareWith: consent ? endpoint : false } }),
    }),
  );
  return { home, handbook };
}

function useTeamSkill(machine: { home: string; handbook: string }, skill: string): void {
  const env = { PATH: process.env.PATH, HOME: machine.home, TEAMHANDBOOK_HOME: machine.handbook };
  spawnSync("node", [join(pluginDist, "post-tool-use.js")], { input: JSON.stringify({ session_id: "s1", tool_name: "Skill", tool_input: { skill } }), env });
  spawnSync("node", [join(pluginDist, "stop.js")], { input: JSON.stringify({ session_id: "s1" }), env });
}

test("given a team that asked to see skill use, when a teammate has not agreed and then agrees, then the orchestrator shows nothing and then the use", async ({ page }) => {
  const request = page.request;
  // given the team is asked from the orchestrator
  await page.goto("/demo/repositories/payments-skills/settings");
  await page.getByRole("button", { name: "Ask this team to report skill use" }).click();
  await page.getByRole("button", { name: "Review the request" }).click();
  await expect(page.getByLabel("Commit message")).toHaveValue("PAY chore: ask teammates' TeamHandbook to report skill-use counts");
  await page.getByRole("button", { name: "Open request" }).click();
  await expect(page.getByRole("status")).toContainText(/Request #\d+ opened/);
  await openTab(page, "payments-skills", "Requests");
  await expect(page.getByRole("row", { name: /report skill-use counts/ }).getByRole("cell", { name: "awaiting review" })).toBeVisible();

  // and the team merges the request
  const { repos } = await (await request.get("/api/repos")).json();
  const bare = repos.find((r: { id: string }) => r.id === "payments-skills").url.replace("file://", "");
  const { requests } = await (await request.get("/api/requests?repo=payments-skills")).json();
  mergeAsTheTeam(bare, requests.find((r: { title: string }) => r.title.includes("skill-use")).branch);
  const { csrf } = await (await request.get("/api/me")).json();
  expect((await request.post("/api/repos/payments-skills/sync", { headers: { "x-csrf-token": csrf } })).ok()).toBe(true);
  await page.goto("/demo/repositories/payments-skills/skills");
  // The skill's row in the skills table; its fourth cell is the count, whatever columns follow.
  const used = page.getByRole("row", { name: /^release-checklist/ }).getByRole("cell").nth(3);
  await expect(used).toHaveText("0");

  // when a teammate who has not answered uses a team skill
  useTeamSkill(teammate(bare), "payments-skills:release-checklist");
  await page.reload();

  // then nothing arrived
  await expect(used).toHaveText("0");

  // when a teammate who agreed uses it, and also a personal skill of the same name
  const agreed = teammate(bare, true);
  useTeamSkill(agreed, "payments-skills:release-checklist");
  useTeamSkill(agreed, "release-checklist");
  await page.reload();

  // then exactly the team skill's use is shown
  await expect(used).toHaveText("1");
});
