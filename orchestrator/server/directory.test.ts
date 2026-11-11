import { describe, expect, it } from "vitest";
import { createUser, principalOf, setupFirstOwner, startSession } from "./accounts.js";
import { createApp } from "./app.js";
import { CSRF_HEADER, sessionCookie } from "./auth.js";
import type { Principal } from "./auth.js";
import { applyMapping, groupsFrom, memberTags, previewMapping, setTagsByHand } from "./directory.js";
import { checkClaims } from "./oidc.js";
import { openSqliteStore } from "./store.js";
import type { Store } from "./store.js";

const TENANT = "acme";
const CODE = "setup-code-for-tests";
const PASSWORD = "correct horse battery";
const TEAMS = new Set(["Payments", "Platform"]);

async function organization(): Promise<{ store: Store; owner: Principal; admin: Principal; kim: string; lee: string }> {
  const store = openSqliteStore(":memory:");
  const owner = await principalOf(store, await setupFirstOwner(store, TENANT, CODE, { code: CODE, email: "ada@example.invalid", name: "Ada", password: PASSWORD }));
  const admin = await principalOf(store, await createUser(store, TENANT, TEAMS, { email: "grace@example.invalid", role: "admin" }, owner));
  const kim = (await createUser(store, TENANT, TEAMS, { email: "kim@example.invalid", name: "Kim", role: "member" }, owner)).id;
  const lee = (await createUser(store, TENANT, TEAMS, { email: "lee@example.invalid", name: "Lee", role: "member" }, owner)).id;
  await store.setMemberGroups(TENANT, kim, ["eng-backend", "everyone"]);
  await store.setMemberGroups(TENANT, lee, ["eng-mobile", "everyone"]);
  return { store, owner, admin, kim, lee };
}

const names = async (store: Store, id: string) => ((await memberTags(store, TENANT)).get(id) ?? []).map((t) => `${t.tag}:${t.source}`);

describe("the groups an ID token lists", () => {
  it("given a token whose configured claim lists groups, and tokens that list none in a readable form, when its claims are checked, then only the readable list is kept, once each", () => {
    // given
    const config = { issuer: "https://idp.example.invalid", clientId: "orchestrator", clientSecret: "s", redirectUrl: "https://c.example.invalid/cb", groupsClaim: "roles" };
    const base = { iss: config.issuer, aud: "orchestrator", exp: Date.now() / 1000 + 60, nonce: "n", sub: "u-1" };

    // when
    const listed = checkClaims({ ...base, roles: ["eng", " eng ", "ops"] }, config, "n");
    const other = checkClaims({ ...base, groups: ["eng"] }, config, "n");
    const broken = checkClaims({ ...base, roles: "eng" }, config, "n");

    // then
    expect(listed.groups).toEqual(["eng", "ops"]);
    expect(other.groups).toBeUndefined();
    expect(broken.groups).toBeUndefined();
    expect(groupsFrom(Array.from({ length: 300 }, (_, i) => `g${i}`))).toHaveLength(200);
  });
});

describe("mapping groups to tags", () => {
  it("given members in groups, when an owner previews a mapping, then it says who gains which tag and nothing changes until it is applied with that preview", async () => {
    // given
    const { store, owner, kim, lee } = await organization();
    const mapping = [{ group: "eng-backend", tag: "backend" }, { group: "everyone", tag: "staff" }];

    // when
    const { preview } = await previewMapping(store, TENANT, mapping);

    // then
    expect(preview.changes.map((c) => [c.member.name, c.gains, c.loses])).toEqual([
      ["Kim", ["backend", "staff"], []],
      ["Lee", ["staff"], []],
    ]);
    expect(await names(store, kim)).toEqual([]);

    // when applied
    await applyMapping(store, TENANT, owner, { mapping, fingerprint: preview.fingerprint });

    // then
    expect(await names(store, kim)).toEqual(["backend:directory", "staff:directory"]);
    expect(await names(store, lee)).toEqual(["staff:directory"]);
  });

  it("given a preview, when a member's groups change before it is applied, then applying it is refused and the mapping stays as it was", async () => {
    // given
    const { store, owner, lee } = await organization();
    const mapping = [{ group: "eng-backend", tag: "backend" }];
    const { preview } = await previewMapping(store, TENANT, mapping);
    await store.setMemberGroups(TENANT, lee, ["eng-backend"]);

    // when
    const attempt = applyMapping(store, TENANT, owner, { mapping, fingerprint: preview.fingerprint });

    // then
    await expect(attempt).rejects.toMatchObject({ status: 409 });
    expect(await store.groupTags(TENANT)).toEqual([]);
  });

  it("given an admin, and an owner with a mapping other than the one previewed, when each applies, then both are refused", async () => {
    // given
    const { store, owner, admin } = await organization();
    const { preview } = await previewMapping(store, TENANT, [{ group: "everyone", tag: "staff" }]);

    // when
    const byAdmin = applyMapping(store, TENANT, admin, { mapping: [{ group: "everyone", tag: "staff" }], fingerprint: preview.fingerprint });
    const swapped = applyMapping(store, TENANT, owner, { mapping: [{ group: "everyone", tag: "admins" }], fingerprint: preview.fingerprint });

    // then
    await expect(byAdmin).rejects.toMatchObject({ status: 403 });
    await expect(swapped).rejects.toMatchObject({ status: 409 });
    expect(await store.groupTags(TENANT)).toEqual([]);
  });

  it("given a group nobody's sign-in listed, a group mapped twice, or a tag that is not a tag, when previewed, then each is refused", async () => {
    // given
    const { store } = await organization();

    // when
    const attempts = await Promise.allSettled([
      previewMapping(store, TENANT, [{ group: "ghosts", tag: "x" }]),
      previewMapping(store, TENANT, [{ group: "everyone", tag: "a" }, { group: "everyone", tag: "b" }]),
      previewMapping(store, TENANT, [{ group: "everyone", tag: "Not A Tag" }]),
    ]);

    // then
    expect(attempts.map((a) => a.status)).toEqual(["rejected", "rejected", "rejected"]);
  });

  it("given a member tagged by a group and by hand, when a later sign-in no longer lists the group, then the group's tag goes and the one added by hand stays", async () => {
    // given
    const { store, owner, kim } = await organization();
    const mapping = [{ group: "eng-backend", tag: "backend" }];
    await applyMapping(store, TENANT, owner, { mapping, fingerprint: (await previewMapping(store, TENANT, mapping)).preview.fingerprint });
    await setTagsByHand(store, TENANT, owner, kim, ["on-call"]);

    // when
    await store.setMemberGroups(TENANT, kim, ["everyone"]);

    // then
    expect(await names(store, kim)).toEqual(["on-call:manual"]);
  });
});

describe("the directory routes", () => {
  it("given an owner's session, when the directory is read, previewed and applied over the API, then the groups are counted and the tags list who has each", async () => {
    // given
    const { store, owner } = await organization();
    const app = createApp({ store, dataDir: "unused", tenant: TENANT, allowedHosts: null });
    const session = await startSession(store, TENANT, owner.id);
    const headers = { cookie: `${sessionCookie(TENANT)}=${session.token}`, [CSRF_HEADER]: session.csrf, "content-type": "application/json" };
    const mapping = [{ group: "everyone", tag: "staff" }];

    // when
    const directory = await (await app.request("/api/directory", { headers })).json();
    const preview = await (await app.request("/api/directory/preview", { method: "POST", headers, body: JSON.stringify({ mapping }) })).json();
    const applied = await app.request("/api/directory", { method: "PUT", headers, body: JSON.stringify({ mapping, fingerprint: preview.fingerprint }) });
    const tags = await (await app.request("/api/tags", { headers })).json();

    // then
    expect(directory.groups).toEqual([
      { group: "eng-backend", members: 1, tag: null },
      { group: "eng-mobile", members: 1, tag: null },
      { group: "everyone", members: 2, tag: null },
    ]);
    expect(applied.status).toBe(200);
    expect(tags.tags).toEqual([{ tag: "staff", members: [expect.objectContaining({ name: "Kim", source: "directory" }), expect.objectContaining({ name: "Lee", source: "directory" })] }]);
  });
});
