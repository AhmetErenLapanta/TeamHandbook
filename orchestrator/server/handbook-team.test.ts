import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createUser, principalOf, setupFirstOwner, startSession } from "./accounts.js";
import { createApp } from "./app.js";
import type { OrchestratorContext } from "./app.js";
import { CSRF_HEADER, sessionCookie } from "./auth.js";
import type { Principal } from "./auth.js";
import { changesTeamHandbook, cleanSources } from "./handbook-team.js";
import { createKey } from "./keys.js";
import { SIGNATURE_HEADER, signRunnerRequest } from "./runner-auth.js";
import { openSqliteStore } from "./store.js";
import type { Store } from "./store.js";

const PASSWORD = "correct horse battery";

// What a person's machine reports of one plugin: names only.
const REPORT = [{ id: "plugin:payments-skills@payments-market", kind: "plugin", name: "payments-skills", version: "1.4.0", marketplace: "payments-market", enabled: true, skills: [{ name: "add-endpoint", description: "Adds an endpoint." }], commands: [{ name: "release" }], mcpServers: [{ name: "jira" }], hooks: [{ name: "PreToolUse" }] }];

/** An organization of `tenant` in `store`, with Ada its owner and Max a member, each signed in. */
async function organization(store: Store, tenant: string) {
  const ada = await principalOf(store, await setupFirstOwner(store, tenant, "code", { code: "code", email: "ada@example.invalid", password: PASSWORD }));
  const max = await createUser(store, tenant, new Set(["Payments"]), { email: "max@example.invalid", role: "member", password: PASSWORD }, ada);
  const ctx: OrchestratorContext = { store, dataDir: "unused", tenant, allowedHosts: null };
  const app = createApp(ctx);
  const browser = async (userId: string): Promise<(path: string, method?: string, body?: unknown) => Response | Promise<Response>> => {
    const cookie = `${sessionCookie(tenant)}=${(await startSession(store, tenant, userId)).token}`;
    const { csrf } = await (await app.request("/api/me", { headers: { cookie } })).json();
    return (path: string, method = "GET", body?: unknown) => app.request(path, { method, headers: { cookie, [CSRF_HEADER]: csrf, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  };
  return { app, ada, max, as: { ada: await browser(ada.id), max: await browser(max.id) } };
}

/** Max's machine, paired from his browser and claimed, reporting signed. */
async function maxsMachine(app: ReturnType<typeof createApp>, asMax: (path: string, method?: string, body?: unknown) => Response | Promise<Response>) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const sent = (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32).toString("base64url");
  const { code } = await (await asMax("/api/machines/pair", "POST", {})).json();
  const { token } = await (await app.request("/api/runner/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: "max-laptop", platform: "darwin-arm64", publicKey: sent }) })).json();
  return (sources: unknown, signed = true) => {
    const body = JSON.stringify({ sources });
    return app.request("/api/runner/handbooks", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(signed ? { [SIGNATURE_HEADER]: signRunnerRequest(privateKey, { method: "POST", path: "/api/runner/handbooks", body }) } : {}) }, body });
  };
}

describe("a person's handbooks on a team's orchestrator", () => {
  it("given Max's connected machine, when it reports his handbooks signed, then only Max reads them: not Ada the owner, not a key, not another organization, and an unsigned report is turned away", async () => {
    // given
    const store = openSqliteStore(":memory:");
    const acme = await organization(store, "acme");
    const beta = await organization(store, "beta");
    const report = await maxsMachine(acme.app, acme.as.max);
    const { secret } = await createKey(store, "acme", await principalOf(store, acme.max), { name: "max-key", scopes: { tasks: "read" } });

    // when
    const unsigned = await report(REPORT, false);
    const sent = await report(REPORT);
    const max = await (await acme.as.max("/api/handbook/machines")).json();
    const ada = await (await acme.as.ada("/api/handbook/machines")).json();
    const byKey = await acme.app.request("/api/handbook/machines", { headers: { authorization: `Bearer ${secret}` } });
    const elsewhere = await (await beta.as.max("/api/handbook/machines")).json();

    // then
    expect([unsigned.status, sent.status, byKey.status]).toEqual([401, 204, 403]);
    expect(max.reports).toEqual([{ machine: { id: expect.any(String), name: "max-laptop" }, readAt: expect.any(String), sources: REPORT }]);
    expect([ada.reports, elsewhere.reports]).toEqual([[], []]);
  });

  it("given Max's reported handbooks, when he disconnects his machine and again when his account is deleted, then nothing of them is read or kept", async () => {
    // given
    const store = openSqliteStore(":memory:");
    const acme = await organization(store, "acme");
    const report = await maxsMachine(acme.app, acme.as.max);
    await report(REPORT);
    const [machine] = await store.listMachines("acme", acme.max.id);

    // when
    await acme.as.max(`/api/machines/${machine!.id}`, "DELETE");
    const afterDisconnect = (await (await acme.as.max("/api/handbook/machines")).json()).reports;
    const keptAfterDisconnect = await store.getSetting("acme", `handbook.user.${acme.max.id}.machine.${machine!.id}`);
    const again = await maxsMachine(acme.app, acme.as.max);
    await again(REPORT);
    await store.deleteUser("acme", acme.max.id);
    const keptAfterDeletion = (await store.listMachines("acme", acme.max.id)).map((m) => store.getSetting("acme", `handbook.user.${acme.max.id}.machine.${m.id}`));

    // then
    expect(afterDisconnect).toEqual([]);
    expect(keptAfterDisconnect).toBeNull();
    expect(await Promise.all(keptAfterDeletion)).toEqual(keptAfterDeletion.map(() => null));
  });

  it("given reports carrying more than names, an unknown kind or no list, when each is cleaned, then only the names and the declared fields stay and the malformed ones are refused", () => {
    // when
    const extra = cleanSources([{ ...REPORT[0], settings: { env: { TOKEN: "x" } }, mcpServers: [{ name: "jira", command: "npx jira", env: { JIRA_TOKEN: "x" } }], hooks: [{ name: "PreToolUse", command: "rm -rf /" }] }]);
    const secretSentence = cleanSources([{ ...REPORT[0], skills: [{ name: "deploy", description: `Uses ${"gh" + "p_" + "a1".repeat(18)} to push` }] }]);
    const unknownKind = cleanSources([{ ...REPORT[0], kind: "home" }]);
    const notAList = cleanSources({ sources: REPORT });

    // then
    expect(extra).toEqual(REPORT);
    expect(JSON.stringify(extra)).not.toMatch(/TOKEN|npx|rm -rf/);
    expect(secretSentence![0]!.skills).toEqual([{ name: "deploy" }]);
    expect([unknownKind, notAList]).toEqual([null, null]);
  });
});

describe("who changes a team's handbook", () => {
  it("given each kind of person, when a team's handbook change is asked of them, then the organization's owners and admins and that team's owners change it, and a member, a viewer and a key only read it", () => {
    // given
    const base: Principal = { id: "u", name: "U", email: "u@example.invalid", role: "member", ownedTeams: [] };
    const key = { id: "k", owner: { kind: "user" as const, id: "u" }, scopes: { repositories: "write" as const, requests: "write" as const, tasks: "write" as const, usage: "none" as const, members: "none" as const, settings: "none" as const, keys: "none" as const }, expiresAt: null };

    // when
    const can = [
      { ...base, role: "owner" as const },
      { ...base, role: "admin" as const },
      { ...base, ownedTeams: ["Payments"] },
      base,
      { ...base, role: "viewer" as const },
      { ...base, role: "owner" as const, key },
    ].map((user) => changesTeamHandbook(user, "Payments"));

    // then
    expect(can).toEqual([true, true, true, false, false, false]);
  });
});
