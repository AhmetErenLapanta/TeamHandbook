import { readFileSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { OrchestratorClient } from "../client.js";
import { as, lab, unique } from "./support.js";

interface DomainView {
  domain: string;
  verified: boolean;
  record: { name: string; value: string };
}

/** A TXT record published on the lab's stand-in DNS, or taken down when `value` is null. */
function publish(name: string, value: string | null): void {
  const records = JSON.parse(readFileSync(lab.dns!.records, "utf8")) as Record<string, string[]>;
  if (value === null) delete records[name];
  else records[name] = [value];
  writeFileSync(lab.dns!.records, JSON.stringify(records, null, 2) + "\n");
}

const signIn = (org: { url: string }, email: string) =>
  fetch(`${org.url}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: lab.password }) }).then(async (r) => [r.status, ((await r.json()) as { error?: string }).error]);

test.describe("an email domain that signs in through single sign-on", () => {
  const org = lab.orgs.find((o) => !o.extra && o.sso.length)!;

  test(`given ${org?.name ?? "the lab"}'s orchestrator with single sign-on, when its owner verifies a domain by its TXT record, then everyone at it but owners is sent to SSO, their sessions end, an invitation there takes no password, and removing the domain lets passwords back in`, async () => {
    test.skip(!org || !lab.dns, "this lab has no orchestrator with single sign-on or no stand-in DNS");
    // given
    const owner = await as(org, "admin");
    const admin = await as(org, "org-admin");
    const domain = `${unique("verified")}.example.invalid`;
    const people = { member: `member@${domain}`, owner: `second-owner@${domain}` };
    await owner.ok("POST", "/api/users", { email: people.member, name: "Domain Member", role: "member", teams: [], password: lab.password });
    await owner.ok("POST", "/api/users", { email: people.owner, name: "Domain Owner", role: "owner", teams: [], password: lab.password });
    const memberSession = await OrchestratorClient.signIn(org.url, people.member, lab.password);

    // when an admin, then the owner, adds the domain, and it is verified before and after its record is published
    const byAdmin = await admin.call<{ error?: string }>("POST", "/api/sso/domains", { domain });
    const { domain: added } = await owner.ok<{ domain: DomainView }>("POST", "/api/sso/domains", { domain });
    const early = await owner.call<{ error?: string }>("POST", `/api/sso/domains/${domain}/verify`);
    publish(added.record.name, added.record.value);
    try {
      const { domain: verified } = await owner.ok<{ domain: DomainView }>("POST", `/api/sso/domains/${domain}/verify`);

      // then
      expect([byAdmin.status, byAdmin.json.error]).toEqual([403, "only an owner manages SSO domains"]);
      expect([early.status, early.json.error]).toEqual([409, `no TXT record at ${added.record.name} carries this domain's value yet; DNS changes can take a while to show`]);
      expect(verified.verified).toBe(true);
      expect((await memberSession.call("GET", "/api/me")).status).toBe(401);
      expect(await signIn(org, people.member)).toEqual([403, `addresses at ${domain} sign in with SSO`]);
      expect((await signIn(org, people.owner))[0]).toBe(200);

      // when someone at the domain is invited
      const { invited } = await owner.ok<{ invited: { link: string }[] }>("POST", "/api/invites", { emails: `invited@${domain}`, role: "member", teams: [] });
      const token = invited[0]!.link.split("join/").pop()!;
      const read = await fetch(`${org.url}/api/join/read`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) }).then((r) => r.json() as Promise<{ invite: { ssoRequired: boolean } }>);
      const joined = await fetch(`${org.url}/api/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, name: "Invited At Domain", password: lab.password }) });

      // then the invitation asks for SSO and refuses a password
      expect(read.invite.ssoRequired).toBe(true);
      expect(joined.status).toBe(403);
      const { events } = await owner.ok<{ events: { kind: string; detail: string }[] }>("GET", "/api/events?kind=sso.domain");
      expect(events.map((e) => [e.kind, e.detail])).toEqual(expect.arrayContaining([["sso.domain.added", `${domain}, waiting for its TXT record`], ["sso.domain.verified", `${domain} verified; everyone at it but owners signs in with SSO`]]));
    } finally {
      await owner.ok("DELETE", `/api/sso/domains/${domain}`);
      publish(added.record.name, null);
    }

    // then passwords work there again
    try {
      expect((await signIn(org, people.member))[0]).toBe(200);
    } finally {
      const { users } = await owner.ok<{ users: { id: string; email: string }[] }>("GET", "/api/users");
      for (const u of users.filter((u) => u.email.endsWith(`@${domain}`))) await owner.ok("DELETE", `/api/users/${u.id}`);
    }
  });
});
