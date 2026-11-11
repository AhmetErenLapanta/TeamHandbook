import { expect, test } from "@playwright/test";
import { OrchestratorClient } from "../client.js";
import type { LabOrg, LabRepo } from "../state.js";
import { as, close, lab, propose, SHAPES, unique } from "./support.js";

interface Invited {
  id: string;
  email: string;
  link: string;
}

/** Accepting an invitation as the invited person would: the token from the link, a name and a password. */
async function accept(org: LabOrg, link: string, name: string): Promise<number> {
  const token = link.split("join/").pop()!;
  return (await fetch(`${org.url}/api/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, name, password: lab.password }) })).status;
}

const skillText = (slug: string) => `---\nname: ${slug}\ndescription: Use when the lab checks an invited team owner.\n---\n\nBody.\n`;
const otherRepo = (org: LabOrg, repo: LabRepo) => org.repos.find((r) => r.team !== repo.team && r.forge === repo.forge) ?? org.repos.find((r) => r.team !== repo.team)!;

test.describe("people, invitations and organization roles", () => {
  for (const { shape, org, repo } of SHAPES) {
    test(`given ${org.name}'s ${repo.id}, ${shape}, when its owner invites two people at once to own its team, then each link works once and makes a member who changes that team's repository and no other, and a revoked link is gone`, async () => {
      // given
      const owner = await as(org, "admin");
      const [one, two] = [unique("invited-one"), unique("invited-two")].map((n) => `${n}@${org.name}.example.invalid`) as [string, string];

      // when
      const { invited, skipped } = await owner.ok<{ invited: Invited[]; skipped: { email: string }[] }>("POST", "/api/invites", { emails: `${one} ${two} member@${org.name}.example.invalid`, role: "member", teams: [repo.team] });
      const first = await accept(org, invited.find((i) => i.email === one)!.link, "Invited One");
      const again = await accept(org, invited.find((i) => i.email === one)!.link, "Invited Again");
      await owner.ok("DELETE", `/api/invites/${invited.find((i) => i.email === two)!.id}`);
      const revoked = await accept(org, invited.find((i) => i.email === two)!.link, "Invited Two");

      // then
      expect(skipped.map((s) => s.email)).toEqual([`member@${org.name}.example.invalid`]);
      expect([first, again, revoked]).toEqual([200, 404, 404]);
      const person = await OrchestratorClient.signIn(org.url, one, lab.password);
      const me = (await person.ok<{ user: { role: string; ownedTeams: string[] } }>("GET", "/api/me")).user;
      expect([me.role, me.ownedTeams]).toEqual(["member", [repo.team]]);
      const slug = unique("invited-change");
      const own = await propose(person, org, repo, { kind: "skill.add", slug, content: skillText(slug) }, `add ${slug}`);
      const elsewhere = await propose(person, org, otherRepo(org, repo), { kind: "skill.add", slug, content: skillText(slug) }, `add ${slug}`);
      expect([own.status, elsewhere.status]).toEqual([200, 403]);
      if (own.request) await close(org, repo, own.request.number);
      // The lab's people stay exactly as it set them up, which the tenant scenarios read.
      const { users } = await owner.ok<{ users: { id: string; email: string }[] }>("GET", "/api/users");
      await owner.ok("DELETE", `/api/users/${users.find((u) => u.email === one)!.id}`);
    });
  }

  for (const org of lab.orgs.filter((o) => !o.extra)) {
    test(`given ${org.name}, when an admin reaches above their role or at the owner, the owner changes their own role, or the owner leaves, then each is refused, while a member can leave`, async () => {
      // given
      const owner = await as(org, "admin");
      const admin = await as(org, "org-admin");
      const { users } = await owner.ok<{ users: { id: string; email: string; role: string }[] }>("GET", "/api/users");
      const ownerId = users.find((u) => u.role === "owner")!.id;
      const adminId = users.find((u) => u.role === "admin")!.id;
      expect(users.filter((u) => u.role === "owner")).toHaveLength(1);
      const leaverEmail = `${unique("leaver")}@${org.name}.example.invalid`;
      await owner.ok("POST", "/api/users", { email: leaverEmail, name: "Lab Leaver", role: "member", teams: [], password: lab.password });
      const leaver = await OrchestratorClient.signIn(org.url, leaverEmail, lab.password);

      // when
      const adminInvitesOwner = await admin.call("POST", "/api/invites", { emails: `${unique("x")}@${org.name}.example.invalid`, role: "owner", teams: [] });
      const adminRaisesItself = await admin.call("PATCH", `/api/users/${adminId}`, { role: "owner" });
      const adminDemotesOwner = await admin.call("PATCH", `/api/users/${ownerId}`, { role: "member" });
      const ownerDemotesItself = await owner.call("PATCH", `/api/users/${ownerId}`, { role: "admin" });
      const lastOwnerRemoved = await admin.call("DELETE", `/api/users/${ownerId}`);
      const ownerLeaves = await owner.call("POST", "/api/me/leave");
      const memberLeaves = await leaver.call("POST", "/api/me/leave");

      // then
      const said = (r: { status: number; json: unknown }) => [r.status, (r.json as { error?: string }).error];
      expect(said(adminInvitesOwner)).toEqual([403, "nobody grants a role above their own"]);
      expect(said(adminRaisesItself)).toEqual([403, "nobody grants a role above their own"]);
      expect(said(adminDemotesOwner)).toEqual([403, "only an owner changes or removes an owner"]);
      expect(said(ownerDemotesItself)).toEqual([403, "nobody changes their own role; ask another owner"]);
      expect(said(lastOwnerRemoved)).toEqual([403, "only an owner changes or removes an owner"]);
      expect(said(ownerLeaves)).toEqual([409, "can't leave as owner; make another member an owner, and have them change your role"]);
      expect(memberLeaves.status).toBe(200);
      const after = await owner.ok<{ users: { email: string; role: string }[] }>("GET", "/api/users");
      expect(after.users.filter((u) => u.role === "owner")).toHaveLength(1);
      expect(after.users.map((u) => u.email)).not.toContain(leaverEmail);
    });
  }
});
