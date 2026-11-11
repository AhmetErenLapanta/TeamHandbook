import { describe, expect, it } from "vitest";
import { createUser, deleteSelf, deletionSummary, principalOf, renameSelf, setupFirstOwner, signInWithPassword, startSession } from "./accounts.js";
import { createApp } from "./app.js";
import { CSRF_HEADER, hashToken, sessionCookie } from "./auth.js";
import type { Principal } from "./auth.js";
import { createKey } from "./keys.js";
import { openSqliteStore } from "./store.js";
import type { Store } from "./store.js";
import type { TaskRecord } from "./tasks/types.js";

const TENANT = "acme";
const CODE = "setup-code-for-tests";
const PASSWORD = "correct horse battery";
const TEAMS = new Set(["Payments"]);

async function organization(): Promise<{ store: Store; owner: Principal; max: Principal }> {
  const store = openSqliteStore(":memory:");
  const owner = await principalOf(store, await setupFirstOwner(store, TENANT, CODE, { code: CODE, email: "ada@example.invalid", name: "Ada", password: PASSWORD }));
  const max = await principalOf(store, await createUser(store, TENANT, TEAMS, { email: "max@example.invalid", name: "Max", role: "member", teams: ["Payments"], password: PASSWORD }, owner));
  return { store, owner, max };
}

function task(id: string, status: TaskRecord["status"], createdBy: string): TaskRecord {
  return {
    tenant: TENANT, id, repoId: "payments-skills", team: "Payments", title: `task ${id}`, description: "", issueUrl: null, issueKey: null, agent: "fake", status,
    createdBy, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, baseSha: null, tests: null,
    cost: { usd: null, inputTokens: null, outputTokens: null }, requestNumber: null, error: null, template: null,
  };
}

describe("a person's own name", () => {
  it("given a member, when they change their name with spaces around it, then it is stored trimmed, and an empty one or a key is refused", async () => {
    // given
    const { store, max } = await organization();

    // when
    const name = await renameSelf(store, max, TENANT, "  Max Mustermann ");
    const empty = renameSelf(store, max, TENANT, "   ");
    const byKey = renameSelf(store, { ...max, key: { id: "k", owner: { kind: "user", id: max.id }, scopes: {} as never, expiresAt: null } }, TENANT, "Someone");

    // then
    expect(name).toBe("Max Mustermann");
    await expect(empty).rejects.toMatchObject({ status: 400 });
    await expect(byKey).rejects.toMatchObject({ status: 403 });
    expect((await store.getUser(TENANT, max.id))!.name).toBe("Max Mustermann");
  });
});

describe("deleting one's own account", () => {
  it("given a member with a team, a key, an open request and one running and one finished task, when the summary is read, then it names each and nothing blocks the deletion", async () => {
    // given
    const { store, max } = await organization();
    await createKey(store, TENANT, max, { name: "ci", scopes: { usage: "read" } });
    await store.saveRequest({ tenant: TENANT, repoId: "payments-skills", number: 1, provider: "local", url: "local://requests/payments-skills/1", branch: "handbook/a", headSha: "a".repeat(40), title: "t", status: "open", createdAt: new Date().toISOString(), createdBy: "max@example.invalid" });
    await store.createTask(task("aaaaaaaaaaaa", "running", "max@example.invalid"));
    await store.createTask(task("bbbbbbbbbbbb", "needs-review", "max@example.invalid"));

    // when
    const summary = await deletionSummary(store, TENANT, max);

    // then
    expect(summary).toEqual({
      tenant: TENANT, email: "max@example.invalid", role: "member", ownedTeams: ["Payments"], activeKeys: 1, openRequests: 1,
      unfinishedTasks: [{ id: "aaaaaaaaaaaa", title: "task aaaaaaaaaaaa", status: "running" }], blocked: null,
    });
  });

  it("given a member, when they delete their account with their address typed back, then the account, its sessions and keys are gone, its request stays, and it cannot sign in", async () => {
    // given
    const { store, max } = await organization();
    const session = await startSession(store, TENANT, max.id);
    await createKey(store, TENANT, max, { name: "ci", scopes: { usage: "read" } });
    await store.saveRequest({ tenant: TENANT, repoId: "payments-skills", number: 1, provider: "local", url: "local://requests/payments-skills/1", branch: "handbook/a", headSha: "a".repeat(40), title: "t", status: "open", createdAt: new Date().toISOString(), createdBy: "max@example.invalid" });

    // when
    await deleteSelf(store, TENANT, max, " MAX@example.invalid ");

    // then
    expect(await store.getUser(TENANT, max.id)).toBeNull();
    expect(await store.getSession(hashToken(session.token))).toBeNull();
    expect(await store.listKeys(TENANT, { kind: "user", id: max.id })).toEqual([]);
    expect(await store.listRequests(TENANT)).toHaveLength(1);
    await expect(signInWithPassword(store, TENANT, "max@example.invalid", PASSWORD)).rejects.toMatchObject({ status: 403 });
  });

  it("given the only owner, and a member who types another address, when each deletes their account, then both are refused and both accounts stay, while an owner beside another owner may go", async () => {
    // given
    const { store, owner, max } = await organization();

    // when
    const lastOwner = deleteSelf(store, TENANT, owner, "ada@example.invalid");
    const wrong = deleteSelf(store, TENANT, max, "ada@example.invalid");

    // then
    await expect(lastOwner).rejects.toMatchObject({ status: 409 });
    await expect(wrong).rejects.toMatchObject({ status: 400 });
    expect(await store.countUsers(TENANT)).toBe(2);
    expect((await deletionSummary(store, TENANT, owner)).blocked).toMatch(/only owner/);
    await createUser(store, TENANT, TEAMS, { email: "bo@example.invalid", role: "owner" }, owner);
    await expect(deleteSelf(store, TENANT, owner, "ada@example.invalid")).resolves.toBeUndefined();
  });

  it("given a member's session, when they rename themselves and delete their account over the API, then both are in the event log, the cookie is cleared, and the session no longer answers", async () => {
    // given
    const { store, max } = await organization();
    const app = createApp({ store, dataDir: "unused", tenant: TENANT, allowedHosts: null });
    const session = await startSession(store, TENANT, max.id);
    const headers = { cookie: `${sessionCookie(TENANT)}=${session.token}`, [CSRF_HEADER]: session.csrf, "content-type": "application/json" };

    // when
    const renamed = await app.request("/api/me", { method: "PATCH", headers, body: JSON.stringify({ name: "Max M" }) });
    const summary = await (await app.request("/api/me/deletion", { headers })).json();
    const deleted = await app.request("/api/me/deletion", { method: "POST", headers, body: JSON.stringify({ confirm: "max@example.invalid" }) });
    const after = await app.request("/api/me", { headers });
    const { events } = await store.eventPage(TENANT, {}, null, 10);

    // then
    expect((await renamed.json()).user.name).toBe("Max M");
    expect(summary.summary).toMatchObject({ email: "max@example.invalid", blocked: null });
    expect(deleted.status).toBe(200);
    expect(deleted.headers.get("set-cookie")).toMatch(new RegExp(`^${sessionCookie(TENANT)}=;`));
    expect(after.status).toBe(401);
    expect(events.map((e) => e.kind).sort()).toEqual(["account.changed", "account.deleted"]);
  });
});
