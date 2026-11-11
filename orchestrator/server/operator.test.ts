import { describe, expect, it } from "vitest";
import { hashToken } from "./auth.js";
import { identityCookie } from "./cloud-identity.js";
import { operatorEmails, operatorRoutes } from "./operator.js";
import { openSqliteStore } from "./store.js";
import type { Store } from "./store.js";

const NOW = new Date().toISOString();
const LATER = new Date(Date.now() + 86_400_000).toISOString();

/** A person signed in to the cloud orchestrator through GitHub, and the cookie their browser holds. */
async function signedIn(store: Store, id: string, email: string, verified = true): Promise<string> {
  await store.insertIdentity({ id, email, name: id, emailVerifiedAt: verified ? NOW : "", termsUrl: null, termsAcceptedAt: null, createdAt: NOW }, { provider: "github", subject: `gh-${id}`, identityId: id, email, addedAt: NOW });
  const token = `token-of-${id}`;
  await store.saveIdentitySession({ tokenHash: hashToken(token), identityId: id, csrf: "c", method: "github", domain: null, authenticatedAt: NOW, expiresAt: LATER });
  return `${identityCookie(false)}=${token}`;
}

describe("who runs a cloud orchestrator", () => {
  it("given a list with spaces and capitals, when it is read, then each address is one lower-case operator, and a name that is no address stops the start", () => {
    expect([...operatorEmails({ ORCHESTRATOR_OPERATOR_EMAILS: " Ops@Example.invalid, lee@example.invalid ," })]).toEqual(["ops@example.invalid", "lee@example.invalid"]);
    expect(operatorEmails({}).size).toBe(0);
    expect(() => operatorEmails({ ORCHESTRATOR_OPERATOR_EMAILS: "ops" })).toThrow('ORCHESTRATOR_OPERATOR_EMAILS holds "ops", which is not an email address');
  });
});

describe("the operator's page", () => {
  it("given a signup that made no organization and an operator, when the operator reads the page, then the signup shows with its domain only, the read is recorded and the operator is not counted as a signup", async () => {
    // given
    const store = openSqliteStore(":memory:");
    await store.recordIdentityEvent({ id: "evt_signup0000000000000001", identityId: "idn_nia", at: NOW, kind: "signup.completed", provider: "google", emailDomain: "nia-labs.example.invalid", org: null });
    const cookie = await signedIn(store, "idn_ops", "ops@example.invalid");
    const app = operatorRoutes({ store, secure: false, operators: new Set(["ops@example.invalid"]) });

    // when
    const res = await app.request("/api/operator/funnel", { headers: { cookie } });

    // then
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.people).toEqual([expect.objectContaining({ identityId: "idn_nia", provider: "google", emailDomain: "nia-labs.example.invalid", orgCreated: null, lastStep: "signed up" })]);
    expect(JSON.stringify(body)).not.toContain("@");
    expect((await store.identityEventsSince("1970-01-01")).map((e) => [e.identityId, e.kind])).toEqual([["idn_nia", "signup.completed"], ["idn_ops", "operator.viewed"]]);
  });

  it("given someone signed in who is not listed, an operator whose address is not verified, nobody signed in, and an empty list, when each asks, then each gets the same 404 and nothing is recorded", async () => {
    // given
    const store = openSqliteStore(":memory:");
    const stranger = await signedIn(store, "idn_max", "max@example.invalid");
    const unverified = await signedIn(store, "idn_ops", "ops@example.invalid", false);
    const listed = operatorRoutes({ store, secure: false, operators: new Set(["ops@example.invalid"]) });
    const empty = operatorRoutes({ store, secure: false, operators: new Set() });

    // when
    const answers = [
      await listed.request("/api/operator/funnel", { headers: { cookie: stranger } }),
      await listed.request("/api/operator/funnel", { headers: { cookie: unverified } }),
      await listed.request("/api/operator/funnel"),
      await empty.request("/api/operator/funnel", { headers: { cookie: stranger } }),
    ];

    // then
    expect(answers.map((a) => a.status)).toEqual([404, 404, 404, 404]);
    expect(await store.identityEventsSince("1970-01-01")).toEqual([]);
  });
});
