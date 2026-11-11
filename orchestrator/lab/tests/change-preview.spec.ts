import { expect, test } from "@playwright/test";
import { ORGS } from "../orgs.js";
import { ownerKey } from "../state.js";
import { openRepo, SHAPES, signInOnPage } from "./support.js";

test.describe("what a change touches, on the review step before its request opens", () => {
  for (const { shape, org, repo } of SHAPES) {
    test(`given ${org.name}'s ${repo.id}, ${shape}, when its team's owner reviews removing a skill, then the step says the team loses it and how much it was used, and nothing opens until it is sent`, async ({ page }) => {
      // given
      const slug = ORGS.find((o) => o.name === org.name)!.teams.find((t) => t.id === repo.id)!.skills[0]!.slug;
      await signInOnPage(page, org, ownerKey(repo.team));
      await openRepo(page, org, repo.id, "Skills");

      // when
      await page.getByRole("row", { name: new RegExp(`^${slug}`) }).getByRole("button", { name: "Remove" }).click();
      await page.getByRole("button", { name: `Review removing ${slug}` }).click();

      // then
      const touched = page.getByRole("region", { name: "What this change touches" });
      await expect(touched).toContainText(`Once merged, teammates on ${repo.team} lose ${slug}.`);
      await expect(touched).toContainText(/(Used [\d,]+ times? in the last 30 days|No reported use in the last 30 days)/);
    });
  }
});
