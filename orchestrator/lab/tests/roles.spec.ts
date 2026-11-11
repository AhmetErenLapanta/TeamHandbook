import { expect, test } from "@playwright/test";
import { ownerKey } from "../state.js";
import type { LabRepo, LabUser } from "../state.js";
import { as, builtIn, lab, openRepo, orgLabel, signInOnPage } from "./support.js";

/** The organization's owner and admins manage everything; a team's owner changes that team's repositories. */
const manages = (user: LabUser) => user.role === "owner" || user.role === "admin";
const mayChange = (user: LabUser, repo: LabRepo) => manages(user) || user.teams.includes(repo.team);

// What a refusal and a pass look like on the routes below: a person who may not change the
// repository is stopped with 403 before anything else is read; one who may gets past that gate
// and meets the next check (a proposal, an unknown agent), which none of these calls clears.
const outcome = (status: number) => (status === 403 ? "refused" : "let through");

test.describe("who may change which team's repository", () => {
  for (const org of lab.orgs) {
    test(`given every person of ${orgLabel(org)} and every repository, when each prepares a change, syncs and starts a task, then only its owner, an admin or that team's owner gets through`, async () => {
      // given
      const seen: string[] = [];
      const expected: string[] = [];
      for (const user of org.users) {
        const client = await as(org, user.key);
        for (const repo of org.repos) {
          // when
          const proposal = await client.call("POST", `/api/repos/${repo.id}/changes/proposal`, {
            change: { kind: "skill.add", slug: "role-check", content: "---\nname: role-check\ndescription: Use when checking roles.\n---\n\nBody.\n" },
          });
          const sync = await client.call("POST", `/api/repos/${repo.id}/sync`);
          const task = await client.call("POST", "/api/tasks", { title: "role check", repoId: repo.id, agent: "no-such-agent" });

          seen.push(`${user.key} on ${repo.id}: proposal ${outcome(proposal.status)}, sync ${outcome(sync.status)}, task ${outcome(task.status)}`);
          const want = mayChange(user, repo) ? "let through" : "refused";
          expected.push(`${user.key} on ${repo.id}: proposal ${want}, sync ${want}, task ${want}`);
        }
      }

      // then
      expect(seen).toEqual(expected);
    });

    test(`given ${orgLabel(org)}, when each person asks for its people and its forge access, then only its owner and admins are answered`, async () => {
      for (const user of org.users) {
        // given
        const client = await as(org, user.key);

        // when
        const people = await client.call("GET", "/api/users");
        const forge = await client.call("GET", `/api/repos/${org.repos[0]!.id}/forge`);

        // then
        const want = manages(user) ? 200 : 403;
        expect([user.key, people.status, forge.status]).toEqual([user.key, want, want]);
      }
    });
  }

  for (const org of builtIn) {
    test(`given an owner of one ${org.name} team, when they open their own and another team's repository, then only their own offers changes`, async ({ browser }) => {
      // given
      const [own, other] = org.repos as [LabRepo, LabRepo];
      const context = await browser.newContext();
      const page = await context.newPage();
      await signInOnPage(page, org, ownerKey(own.team));

      // when
      await openRepo(page, org, other.id, "Skills");

      // then
      await expect(page.getByText(`Changes to it are proposed by an admin or an owner of ${other.team}.`)).toBeVisible();
      await expect(page.getByRole("button", { name: "Add a skill" })).toHaveCount(0);

      // when
      await openRepo(page, org, own.id, "Skills");

      // then
      await expect(page.getByRole("button", { name: "Add a skill" })).toBeVisible();
      await context.close();
    });
  }

  test("given one repository's contents arriving slowly, when another repository is opened meanwhile, then the page shows the one opened last", async ({ browser }) => {
    // given
    const org = builtIn.find((o) => o.repos.length > 1)!;
    const [first, second] = org.repos as [LabRepo, LabRepo];
    const context = await browser.newContext();
    const page = await context.newPage();
    let held = true;
    await page.route(`**/api/repos/${first.id}/inventory`, async (route) => {
      const answer = await route.fetch();
      while (held) await new Promise((r) => setTimeout(r, 100));
      await route.fulfill({ response: answer });
    });
    await signInOnPage(page, org, "admin");
    await page.goto(`${org.url}/#/repo/${first.id}`);

    // when
    await openRepo(page, org, second.id);
    held = false;

    // then
    await page.waitForTimeout(1_000);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(second.id);
    await context.close();
  });
});
