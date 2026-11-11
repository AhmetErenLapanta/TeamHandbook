import { expect, test } from "@playwright/test";
import type { Browser } from "@playwright/test";
import type { LabOrg, LabSsoPerson } from "../state.js";
import { as, lab, unique } from "./support.js";

interface Change {
  member: { email: string };
  gains: string[];
  loses: string[];
}

const org = lab.orgs.find((o) => o.sso.length && !o.extra);

/** One single sign-on through the orchestrator, picking the person on the stand-in provider's page. */
async function signInBySso(browser: Browser, org: LabOrg, person: LabSsoPerson): Promise<void> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${org.url}/api/auth/oidc/start`);
  await page.getByRole("button", { name: `${person.name} (${person.email})` }).click();
  await expect.poll(async () => (await page.request.get(`${org.url}/api/me`)).status()).toBe(200);
  await context.close();
}

async function setGroups(person: LabSsoPerson, groups: string[]): Promise<void> {
  await fetch(`${lab.idp!.url}/lab/groups`, { method: "POST", body: JSON.stringify({ sub: person.sub, groups }) });
}

async function tagsOf(email: string): Promise<string[]> {
  const { tags } = await (await as(org!, "admin")).ok<{ tags: { tag: string; members: { name: string }[] }[] }>("GET", "/api/tags");
  const name = org!.sso.find((p) => p.email === email)!.name;
  return tags.filter((t) => t.members.some((m) => m.name === name)).map((t) => t.tag);
}

test.describe("directory sync from the identity provider's groups", () => {
  test.skip(!org, "no organization of this lab signs in through the identity provider");

  test("given members whose sign-ins listed their groups, when the owner maps a group to a tag, then the preview names who gains it and nothing changes until the owner applies it with that preview, and a later sign-in without the group takes the tag away", async ({ browser }) => {
    // given
    const sam = org!.sso.find((p) => p.verified && p.groups.length > 1 && !org!.users.some((u) => u.email === p.email))!;
    const group = sam.groups[0]!;
    const tag = unique("lab-tag").slice(0, 30);
    await setGroups(sam, sam.groups);
    await signInBySso(browser, org!, sam);
    const owner = await as(org!, "admin");
    const { groups } = await owner.ok<{ sso: { groupsClaim: string }; groups: { group: string; members: number }[] }>("GET", "/api/directory");
    expect(groups.find((g) => g.group === group)?.members).toBeGreaterThanOrEqual(1);

    // when the owner previews the mapping
    const mapping = [{ group, tag }];
    const preview = await owner.ok<{ changes: Change[]; fingerprint: string }>("POST", "/api/directory/preview", { mapping });

    // then it names the gain and changes nothing yet
    expect(preview.changes.find((c) => c.member.email === sam.email)).toMatchObject({ gains: [tag], loses: [] });
    expect(await tagsOf(sam.email)).not.toContain(tag);

    // when an admin tries to apply it, and the owner applies it
    const byAdmin = await (await as(org!, "org-admin")).call<{ error: string }>("PUT", "/api/directory", { mapping, fingerprint: preview.fingerprint });
    await owner.ok("PUT", "/api/directory", { mapping, fingerprint: preview.fingerprint });

    // then only the owner's applies, and the member carries the tag
    expect([byAdmin.status, byAdmin.json.error]).toEqual([403, "only an owner changes directory sync"]);
    expect(await tagsOf(sam.email)).toContain(tag);

    // when the provider stops listing the group and the member signs in again
    await setGroups(sam, sam.groups.filter((g) => g !== group));
    await signInBySso(browser, org!, sam);

    // then the tag is gone
    expect(await tagsOf(sam.email)).not.toContain(tag);
    await setGroups(sam, sam.groups);
    await owner.ok("PUT", "/api/directory", { mapping: [], fingerprint: (await owner.ok<{ fingerprint: string }>("POST", "/api/directory/preview", { mapping: [] })).fingerprint });
  });

  test("given a preview, when a sign-in changes someone's groups before it is applied, then the old preview is refused, and a group no sign-in listed cannot be mapped; a member sees none of it", async ({ browser }) => {
    // given
    const sam = org!.sso.find((p) => p.verified && p.groups.length > 1 && !org!.users.some((u) => u.email === p.email))!;
    const owner = await as(org!, "admin");
    await setGroups(sam, sam.groups);
    await signInBySso(browser, org!, sam);
    const mapping = [{ group: sam.groups[1]!, tag: unique("stale").slice(0, 30) }];
    const preview = await owner.ok<{ fingerprint: string }>("POST", "/api/directory/preview", { mapping });

    // when the person's groups change at the provider and they sign in
    await setGroups(sam, [...sam.groups, unique("new-group")]);
    await signInBySso(browser, org!, sam);
    const stale = await owner.call<{ error: string }>("PUT", "/api/directory", { mapping, fingerprint: preview.fingerprint });
    const unknown = await owner.call<{ error: string }>("POST", "/api/directory/preview", { mapping: [{ group: unique("nobody-has"), tag: "x" }] });
    const member = await (await as(org!, "member")).call("GET", "/api/directory");

    // then
    expect([stale.status, stale.json.error]).toEqual([409, "the groups or tags changed since this preview; preview again before applying"]);
    expect(unknown.status).toBe(400);
    expect(unknown.json.error).toContain("no member's sign-in has listed the group");
    expect(member.status).toBe(403);
    await setGroups(sam, sam.groups);
  });
});
