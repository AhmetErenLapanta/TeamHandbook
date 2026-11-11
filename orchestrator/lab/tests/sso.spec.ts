import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { LabOrg, LabSsoPerson } from "../state.js";
import { as, expectSignedIn, lab } from "./support.js";

const ssoOrgs = lab.orgs.filter((o) => o.sso.length);

/** Through the orchestrator's own Sign in with SSO, picking the person on the stand-in provider's page. */
async function signInBySso(page: Page, org: LabOrg, person: LabSsoPerson): Promise<void> {
  await page.goto(`${org.url}/api/auth/oidc/start`);
  await page.getByRole("button", { name: `${person.name} (${person.email})` }).click();
}

test.describe("single sign-on through the lab's identity provider", () => {
  test.skip(!ssoOrgs.length, "no organization of this lab signs in through the identity provider");

  for (const org of ssoOrgs) {
    const fresh = org.sso.find((p) => p.verified && !org.users.some((u) => u.email === p.email))!;
    const unverified = org.sso.find((p) => !p.verified)!;
    const taken = org.sso.find((p) => org.users.some((u) => u.email === p.email))!;

    test(`given ${org.name}, when someone the provider verified and the orchestrator does not know signs in through SSO, then they arrive as a member and sign in again as the same person`, async ({ browser }) => {
      // given
      const context = await browser.newContext();
      const page = await context.newPage();

      // when
      await signInBySso(page, org, fresh);

      // then
      await expectSignedIn(page, fresh.name);
      const me = (await (await page.request.get(`${org.url}/api/me`)).json()) as { user: { email: string; role: string; id: string } };
      expect([me.user.email, me.user.role]).toEqual([fresh.email, "member"]);
      const { users } = await (await as(org, "admin")).ok<{ users: { email: string }[] }>("GET", "/api/users");
      expect(users.filter((u) => u.email === fresh.email)).toHaveLength(1);

      // when they sign in again in a new browser
      const again = await browser.newContext();
      const second = await again.newPage();
      await signInBySso(second, org, fresh);

      // then it is the same account
      expect(((await (await second.request.get(`${org.url}/api/me`)).json()) as typeof me).user.id).toBe(me.user.id);
      await context.close();
      await again.close();
    });

    test(`given ${org.name}, when someone whose address the provider did not verify, or whose address a password account holds, signs in through SSO, then neither is signed in and the sign-in page says why`, async ({ browser }) => {
      for (const person of [unverified, taken]) {
        // given
        const context = await browser.newContext();
        const page = await context.newPage();

        // when
        await signInBySso(page, org, person);

        // then
        expect((await page.request.get(`${org.url}/api/me`)).status()).toBe(401);
        if (person === taken) await expect(page).toHaveURL(/(?:#\/|\/)login\?problem=/);
        await context.close();
      }
    });
  }
});
