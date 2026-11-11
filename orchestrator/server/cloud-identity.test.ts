import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SIGN_IN_PEOPLE, signInClients } from "../lab/cloud.js";
import { startSignInProviders } from "../lab/sign-in-providers.js";
import { createApp } from "./app.js";
import { identityRoutes, SIGN_IN_METHODS } from "./cloud-identity.js";
import { socialClientsFromEnv } from "./social.js";
import type { SocialProvider } from "./social.js";
import { openSqliteStore } from "./store.js";
import type { Store } from "./store.js";

const ORCHESTRATOR = "http://127.0.0.1:18999";
const OFF_PREFIX = "scim.off.";

let providers: { base: string; close: () => Promise<void> };
let env: NodeJS.ProcessEnv;

beforeAll(async () => {
  const clients = signInClients([ORCHESTRATOR]);
  providers = await startSignInProviders({ port: 0, people: SIGN_IN_PEOPLE, clients, log: join(mkdtempSync(join(tmpdir(), "sign-in-")), "log") });
  env = {
    ORCHESTRATOR_SIGN_IN_GOOGLE_CLIENT_ID: clients.google[0]!.id,
    ORCHESTRATOR_SIGN_IN_GOOGLE_CLIENT_SECRET: clients.google[0]!.secret,
    ORCHESTRATOR_SIGN_IN_GOOGLE_ISSUER: `${providers.base}/google`,
    ORCHESTRATOR_SIGN_IN_GITHUB_CLIENT_ID: clients.github[0]!.id,
    ORCHESTRATOR_SIGN_IN_GITHUB_CLIENT_SECRET: clients.github[0]!.secret,
    ORCHESTRATOR_SIGN_IN_GITHUB_URL: `${providers.base}/github`,
    ORCHESTRATOR_SIGN_IN_GITHUB_API_URL: `${providers.base}/github/api`,
  };
});
afterAll(() => providers.close());
beforeEach(() => {
  vi.stubEnv("ORCHESTRATOR_MODE", "cloud");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

function cookiesOf(res: Response): Record<string, string> {
  return Object.fromEntries(res.headers.getSetCookie().map((line) => line.split(";")[0]!.split("=")).map(([k, ...v]) => [k!, v.join("=")]));
}
const header = (cookies: Record<string, string>) => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");

function cloud(store: Store) {
  return identityRoutes({ store, secure: false, clients: socialClientsFromEnv(env, ORCHESTRATOR), landing: (m) => (m.length ? `/${m[0]!.tenant}/` : "/signup/organization") });
}

/** A browser signing in: start here, pick the person at the provider, come back with its answer. */
async function signIn(app: ReturnType<typeof cloud>, provider: SocialProvider, name: string): Promise<{ answer: Response; cookies: Record<string, string> }> {
  const start = await app.request(`/api/auth/${provider}/start`);
  const page = new URL(start.headers.get("location")!);
  const person = SIGN_IN_PEOPLE[provider].find((p) => p.name === name)!;
  const consent = await fetch(`${page.origin}${page.pathname}`, { method: "POST", body: new URLSearchParams({ ...Object.fromEntries(page.searchParams), person: person.id }), redirect: "manual" });
  const back = new URL(consent.headers.get("location")!);
  const answer = await app.request(`${back.pathname}${back.search}`, { headers: { cookie: header(cookiesOf(start)) } });
  return { answer, cookies: cookiesOf(answer) };
}

async function member(store: Store, tenant: string, identityId: string, email: string) {
  await store.insertUser({ tenant, id: `usr_${tenant}`, email, name: "Ada", role: "owner", passwordHash: null, oidcIssuer: null, oidcSubject: null, forgeLogin: null, createdAt: new Date().toISOString(), identityId });
}

describe("one sign-in across organizations", () => {
  it("given a person who belongs to one of two organizations, when they sign in with Google, then the session reaches that organization and not the other", async () => {
    // given
    const store = openSqliteStore(":memory:");
    const app = cloud(store);
    const first = await signIn(app, "google", "Ada Okafor");
    const identity = (await store.getIdentityByLogin("google", "104857600123456789012"))!;
    await member(store, "acme", identity.id, identity.email);

    // when
    const again = await signIn(app, "google", "Ada Okafor");
    const own = await createApp({ store, dataDir: "unused", tenant: "acme", allowedHosts: null }).request("/api/me", { headers: { cookie: header(again.cookies) } });
    const other = await createApp({ store, dataDir: "unused", tenant: "globex", allowedHosts: null }).request("/api/me", { headers: { cookie: header(again.cookies) } });

    // then
    expect(first.answer.headers.get("location")).toBe("/signup/organization");
    expect(again.answer.headers.get("location")).toBe("/acme/");
    expect(own.status).toBe(200);
    expect((await own.json()).user.email).toBe("ada@okafor-labs.example.invalid");
    expect(other.status).toBe(401);
  });

  it("given a signed-in member, when the organization ends their sessions, the directory turns them off, or it takes only GitHub, then the session no longer reaches it, and a fresh sign-in after the end does", async () => {
    // given
    const store = openSqliteStore(":memory:");
    const app = cloud(store);
    await signIn(app, "google", "Ada Okafor");
    const identity = (await store.getIdentityByLogin("google", "104857600123456789012"))!;
    await member(store, "acme", identity.id, identity.email);
    const acme = createApp({ store, dataDir: "unused", tenant: "acme", allowedHosts: null });
    const me = async (cookies: Record<string, string>) => (await acme.request("/api/me", { headers: { cookie: header(cookies) } })).status;
    const before = (await signIn(app, "google", "Ada Okafor")).cookies;

    // when
    await new Promise((done) => setTimeout(done, 5));
    await store.deleteSessions("acme", "usr_acme");
    const ended = await me(before);
    await new Promise((done) => setTimeout(done, 5));
    const fresh = (await signIn(app, "google", "Ada Okafor")).cookies;
    const afterFresh = await me(fresh);
    await store.setSetting("acme", `${OFF_PREFIX}usr_acme`, "{}");
    const off = await me(fresh);
    await store.deleteSetting("acme", `${OFF_PREFIX}usr_acme`);
    await store.setSetting("acme", SIGN_IN_METHODS, JSON.stringify(["github"]));
    const githubOnly = await me(fresh);

    // then
    expect([ended, afterFresh, off, githubOnly]).toEqual([401, 200, 401, 401]);
  });

  it("given a sign-in another browser started, when its callback is opened here, then this browser is not signed in", async () => {
    // given
    const store = openSqliteStore(":memory:");
    const app = cloud(store);
    const start = await app.request("/api/auth/google/start");
    const page = new URL(start.headers.get("location")!);
    const consent = await fetch(`${page.origin}${page.pathname}`, { method: "POST", body: new URLSearchParams({ ...Object.fromEntries(page.searchParams), person: SIGN_IN_PEOPLE.google[0]!.id }), redirect: "manual" });
    const back = new URL(consent.headers.get("location")!);

    // when
    const here = await app.request(`${back.pathname}${back.search}`);

    // then
    expect(here.headers.get("location")).toBe("/signup?problem=browser");
    expect(cookiesOf(here).th_identity).toBeUndefined();
    expect(await store.getIdentityByLogin("google", SIGN_IN_PEOPLE.google[0]!.id)).toBeNull();
  });

  it("given an address one identity signs in with through Google, when GitHub brings the same address, then it is refused, not tied to that identity, and the page is told to name Google", async () => {
    // given
    const store = openSqliteStore(":memory:");
    const app = cloud(store);
    await signIn(app, "google", "Ada Okafor");
    const ada = (await store.getIdentityByLogin("google", "104857600123456789012"))!;
    await store.insertIdentity({ ...ada, id: "idn_other", email: "ben@ortiz-builds.example.invalid" }, { provider: "google", subject: "other", identityId: "idn_other", email: "ben@ortiz-builds.example.invalid", addedAt: ada.createdAt });

    // when
    const ben = await signIn(app, "github", "Ben Ortiz");

    // then
    expect(ben.answer.headers.get("location")).toBe("/signup?problem=address-taken&with=google");
    expect(ben.cookies.th_identity).toBeUndefined();
    expect(await store.getIdentityByLogin("github", "4401")).toBeNull();
  });
});
