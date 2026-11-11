import { expect, test } from "@playwright/test";
import { OrchestratorClient } from "../client.js";
import type { LabOrg } from "../state.js";
import { as, lab, SHAPES, unique } from "./support.js";

const USER = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group";
const PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
/** The SCIM resource paths, held as constants like the orchestrator holds them. */
const USERS = "/Users";
const GROUPS = "/Groups";

/** An identity provider's call to the organization's SCIM endpoint with `token`. */
async function scim(org: LabOrg, token: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${org.url}/api/scim/v2${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/scim+json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

const signIn = (org: LabOrg, email: string) =>
  fetch(`${org.url}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: lab.password }) }).then(async (r) => [r.status, ((await r.json()) as { error?: string }).error]);

test.describe("an identity provider keeping the organization's people through SCIM", () => {
  for (const org of [...new Set(SHAPES.map((s) => s.org))]) {
    test(`given ${org.name}, when its owner gives the identity provider a SCIM token, then the provider adds a person, turns someone off so their session and key stop and their password is refused, turns them on again, groups people into a tag through directory sync, cannot turn the only owner off, and removes them, all logged; an admin makes no token and an old token stops working`, async () => {
      test.setTimeout(120_000);
      // given
      const owner = await as(org, "admin");
      const byAdmin = await (await as(org, "org-admin")).call<{ error?: string }>("POST", "/api/scim/token");
      const { token } = await owner.ok<{ token: string; baseUrl: string }>("POST", "/api/scim/token");
      const added = `${unique("scim-added")}@${org.name}.example.invalid`;
      const existing = `${unique("scim-existing")}@${org.name}.example.invalid`;
      await owner.ok("POST", "/api/users", { email: existing, name: "Directory Person", role: "member", teams: [], password: lab.password });
      const person = await OrchestratorClient.signIn(org.url, existing, lab.password);
      const { secret } = await person.ok<{ secret: string }>("POST", "/api/keys", { name: unique("scim-key"), scopes: { repositories: "read" }, expiresInDays: 1 });
      const group = unique("lab-scim-group");
      const tag = unique("scim").toLowerCase().slice(0, 30);
      const ids: string[] = [];
      try {
        // when the provider adds one person, finds another, and is refused a second account for the same address
        const forged = await scim(org, `${token}x`, "GET", USERS);
        const created = await scim(org, token, "POST", USERS, { schemas: [USER], userName: added, name: { givenName: "Added", familyName: "Person" }, active: true, externalId: unique("ext") });
        const twice = await scim(org, token, "POST", USERS, { schemas: [USER], userName: added });
        const found = await scim(org, token, "GET", `${USERS}?filter=${encodeURIComponent(`userName eq "${existing}"`)}`);
        const existingId = ((found.json.Resources as { id: string }[]) ?? [])[0]!.id;
        ids.push(String(created.json.id), existingId);

        // then
        expect([byAdmin.status, byAdmin.json.error]).toEqual([403, "only an owner sets up directory provisioning"]);
        expect([forged.status, forged.json.detail]).toEqual([401, "the SCIM token is not valid"]);
        expect(created.status).toBe(201);
        expect(created.json).toMatchObject({ userName: added, active: true, displayName: "Added Person" });
        expect(twice.status).toBe(409);
        expect(found.json.totalResults).toBe(1);

        // when the provider turns the found person off
        const off = await scim(org, token, "PATCH", `${USERS}/${existingId}`, { schemas: [PATCH], Operations: [{ op: "replace", path: "active", value: false }] });

        // then their session and key stop, and their password is refused
        expect([off.status, off.json.active]).toEqual([200, false]);
        expect((await person.call("GET", "/api/me")).status).toBe(401);
        expect((await OrchestratorClient.withKey(org.url, secret).call("GET", "/api/repos")).status).toBe(401);
        expect(await signIn(org, existing)).toEqual([403, "this account is turned off by the organization's directory"]);

        // when it turns them on again, then they sign in
        await scim(org, token, "PATCH", `${USERS}/${existingId}`, { schemas: [PATCH], Operations: [{ op: "replace", path: "active", value: true }] });
        expect((await signIn(org, existing))[0]).toBe(200);

        // when the provider puts both in a group the owner maps to a tag, then takes one out
        const grouped = await scim(org, token, "POST", GROUPS, { schemas: [GROUP], displayName: group, members: [{ value: created.json.id }, { value: existingId }] });
        const mapping = [{ group, tag }];
        const preview = await owner.ok<{ fingerprint: string }>("POST", "/api/directory/preview", { mapping });
        await owner.ok("PUT", "/api/directory", { mapping, fingerprint: preview.fingerprint });
        const tagged = async () => ((await owner.ok<{ tags: { tag: string; members: { id: string }[] }[] }>("GET", "/api/tags")).tags.find((t) => t.tag === tag)?.members.map((m) => m.id) ?? []).sort();
        const both = await tagged();
        await scim(org, token, "PATCH", `${GROUPS}/${grouped.json.id}`, { schemas: [PATCH], Operations: [{ op: "remove", path: `members[value eq "${existingId}"]` }] });
        const one = await tagged();

        // then
        expect(grouped.status).toBe(201);
        expect(both).toEqual([String(created.json.id), existingId].sort());
        expect(one).toEqual([String(created.json.id)]);
        await owner.ok("PUT", "/api/directory", { mapping: [], fingerprint: (await owner.ok<{ fingerprint: string }>("POST", "/api/directory/preview", { mapping: [] })).fingerprint });
        expect((await scim(org, token, "DELETE", `${GROUPS}/${grouped.json.id}`)).status).toBe(204);

        // when it tries to turn the only owner off
        const ownerEmail = (await owner.ok<{ user: { email: string } }>("GET", "/api/me")).user.email;
        const ownerId = ((await scim(org, token, "GET", `${USERS}?filter=${encodeURIComponent(`userName eq "${ownerEmail}"`)}`)).json.Resources as { id: string }[])[0]!.id;
        const lastOwner = await scim(org, token, "PATCH", `${USERS}/${ownerId}`, { schemas: [PATCH], Operations: [{ op: "replace", path: "active", value: false }] });

        // then it is refused, and the owner stays signed in
        expect([lastOwner.status, lastOwner.json.detail]).toEqual([409, "this is the organization's only owner still on; make someone else an owner first"]);
        expect((await owner.call("GET", "/api/me")).status).toBe(200);
      } finally {
        for (const id of ids) await scim(org, token, "DELETE", `${USERS}/${id}`);
      }

      // then the log names each step, and once the token is turned off it works no more
      const { events } = await owner.ok<{ events: { kind: string; detail: string }[] }>("GET", "/api/events?kind=scim");
      expect(events.map((e) => [e.kind, e.detail])).toContainEqual(["scim.user.created", `${added} added as member`]);
      expect(events.some((e) => e.kind === "scim.user.deleted" && e.detail.startsWith(`${existing}, who was member`))).toBe(true);
      await owner.ok("DELETE", "/api/scim/token");
      expect((await scim(org, token, "GET", USERS)).status).toBe(401);
    });
  }
});
