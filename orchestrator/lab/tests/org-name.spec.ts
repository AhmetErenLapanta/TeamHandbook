import { expect, test } from "@playwright/test";
import { OrchestratorClient } from "../client.js";
import { as, SHAPES, unique } from "./support.js";

test.describe("the organization's name", () => {
  for (const org of [...new Set(SHAPES.map((s) => s.org))]) {
    test(`given ${org.name}, when people rename the organization, then only its owner does, signed in, the name is checked, the org picker shows it, and the rename is logged`, async () => {
      // given
      const owner = await as(org, "admin");
      const admin = await as(org, "org-admin");
      const { secret } = await owner.ok<{ secret: string }>("POST", "/api/keys", { name: unique("owner-key"), scopes: { repositories: "read" }, expiresInDays: 1 });
      const was = (await owner.ok<{ tenant: string; name: string }>("GET", "/api/org")).name;
      const name = `Lab ${unique("Renamed")}`;

      // when
      const byAdmin = await admin.call<{ error?: string }>("PUT", "/api/org", { name });
      const byKey = await OrchestratorClient.withKey(org.url, secret).call<{ error?: string }>("PUT", "/api/org", { name });
      const empty = await owner.call<{ error?: string }>("PUT", "/api/org", { name: "  " });
      const long = await owner.call<{ error?: string }>("PUT", "/api/org", { name: "x".repeat(81) });
      await owner.ok("PUT", "/api/org", { name });
      try {
        // then
        expect([byAdmin.status, byAdmin.json.error]).toEqual([403, "only an owner renames the organization"]);
        expect(byKey.status).toBe(403);
        expect([empty.status, empty.json.error]).toEqual([400, "name the organization to continue"]);
        expect([long.status, long.json.error]).toEqual([400, "an organization's name is at most 80 characters with no control character"]);
        expect((await owner.ok<{ name: string }>("GET", "/api/org")).name).toBe(name);
        const { orgs } = await OrchestratorClient.withCookie(org.url, owner.cookie).ok<{ orgs: { tenant: string; orgName: string }[] }>("GET", "/api/orgs");
        expect(orgs.find((o) => o.tenant === org.name)?.orgName).toBe(name);
        const { events } = await owner.ok<{ events: { kind: string; detail: string }[] }>("GET", "/api/events?kind=org.renamed");
        expect(events[0]?.detail).toBe(`renamed the organization from "${was}" to "${name}"`);
      } finally {
        await owner.ok("PUT", "/api/org", { name: was });
      }
    });
  }
});
