import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SIGN_IN_PEOPLE, signInClients } from "../lab/cloud.js";
import { startSignInProviders } from "../lab/sign-in-providers.js";
import { createApp } from "./app.js";
import { identityRoutes } from "./cloud-identity.js";
import type { LegalLinks } from "./legal.js";
import { cloudRegistry, orgRoutes } from "./orgs.js";
import { signupRoutes } from "./signup.js";
import { socialClientsFromEnv } from "./social.js";
import type { SocialProvider } from "./social.js";
import { openSqliteStore } from "./store.js";
import type { Store } from "./store.js";

const ORCHESTRATOR = "http://127.0.0.1:18999";
const LEGAL: LegalLinks = { privacyUrl: "http://127.0.0.1:3050/en/privacy", termsUrl: "http://127.0.0.1:3050/en/terms" };
const QUOTAS = { members: null, tasksPerMonth: null, concurrentTasks: null };

// A second person in Ada's Workspace, so joining by directory has someone to join.
// Ada's own GitHub account, under her address, so linking a second provider has one to link.
const PEOPLE = {
  ...SIGN_IN_PEOPLE,
  google: [...SIGN_IN_PEOPLE.google, { id: "104857600123456789013", name: "Noor Okafor", email: "noor@okafor-labs.example.invalid", verified: true, domain: "okafor-labs.example.invalid" }],
  github: [...SIGN_IN_PEOPLE.github, { id: "4403", name: "Ada on GitHub", login: "ada-okafor", email: "ada@okafor-labs.example.invalid", verified: true }, { id: "4404", name: "Ada's other GitHub", login: "ada-elsewhere", email: "ada@elsewhere.example.invalid", verified: true }],
};

let providers: { base: string; close: () => Promise<void> };
let env: NodeJS.ProcessEnv;

beforeAll(async () => {
  const clients = signInClients([ORCHESTRATOR]);
  providers = await startSignInProviders({ port: 0, people: PEOPLE, clients, log: join(mkdtempSync(join(tmpdir(), "sign-in-")), "log") });
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

/** A cloud orchestrator with no organization yet, as it first starts. */
function cloudOrchestrator(store: Store, options: { legal?: LegalLinks; perDay?: number; served?: string[] } = {}) {
  const served = (options.served ?? []).map((tenant) => {
    const ctx = { store, dataDir: "unused", tenant, allowedHosts: null };
    return { ctx, app: createApp(ctx) };
  });
  const registry = cloudRegistry(served, store, async (tenant) => {
    const ctx = { store, dataDir: "unused", tenant, allowedHosts: null };
    return { ctx, app: createApp(ctx) };
  });
  const legal = options.legal ?? LEGAL;
  const identity = new Hono();
  identity.route("/", identityRoutes({ store, secure: false, clients: socialClientsFromEnv(env, ORCHESTRATOR), legal, readmeUrl: "https://pages.example.invalid/readme", registry, landing: (m) => (m.length ? `/${m[0]!.tenant}/` : "/signup/organization") }));
  identity.route("/", signupRoutes({ store, secure: false, registry, legal, quotas: () => QUOTAS, perDay: options.perDay ?? 3 }));
  return orgRoutes([], { mode: "local", secure: false, allowedHosts: null, cloud: { registry, store, secure: false, identity } });
}

function cookiesOf(res: Response): Record<string, string> {
  return Object.fromEntries(res.headers.getSetCookie().map((line) => line.split(";")[0]!.split("=")).map(([k, ...v]) => [k!, v.join("=")]));
}

/** A browser that signs in from the landing page and then calls the orchestrator with its session. */
async function person(app: Hono, provider: SocialProvider, name: string, invite?: string) {
  const start = invite
    ? await app.request(`/api/auth/${provider}/start`, { method: "POST", headers: { "sec-fetch-site": "same-origin" }, body: new URLSearchParams({ invite }) })
    : await app.request(`/api/auth/${provider}/start`);
  const page = new URL(start.headers.get("location")!);
  const who = PEOPLE[provider].find((p) => p.name === name)!;
  const consent = await fetch(`${page.origin}${page.pathname}`, { method: "POST", body: new URLSearchParams({ ...Object.fromEntries(page.searchParams), person: who.id }), redirect: "manual" });
  const back = new URL(consent.headers.get("location")!);
  const answer = await app.request(`${back.pathname}${back.search}`, { headers: { cookie: Object.entries(cookiesOf(start)).map(([k, v]) => `${k}=${v}`).join("; ") } });
  // A cookie the answer deletes, such as the sign-in's state, is one the browser no longer sends.
  const cookie = Object.entries(cookiesOf(answer)).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join("; ");
  const { csrf } = (await (await app.request("/api/identity", { headers: { cookie } })).json()) as { csrf: string };
  return {
    landing: answer.headers.get("location"),
    cookie,
    get: (path: string) => app.request(path, { headers: { cookie } }),
    post: (path: string, body: unknown, withCsrf = true, method = "POST") => app.request(path, { method, headers: { cookie, "content-type": "application/json", ...(withCsrf ? { "x-csrf-token": csrf } : {}) }, body: JSON.stringify(body) }),
  };
}

/** A signed-in person adding a provider from their account page, consenting as `name` there, and the browser that the provider sends back to. */
async function link(app: Hono, someone: Awaited<ReturnType<typeof person>>, provider: SocialProvider, name: string, backIn: Awaited<ReturnType<typeof person>> = someone) {
  const started = await someone.post(`/api/identity/logins/${provider}`, {});
  if (started.status !== 200) return { status: started.status, body: await started.json(), landing: null };
  const page = new URL(((await started.json()) as { url: string }).url);
  const who = PEOPLE[provider].find((p) => p.name === name)!;
  const consent = await fetch(`${page.origin}${page.pathname}`, { method: "POST", body: new URLSearchParams({ ...Object.fromEntries(page.searchParams), person: who.id }), redirect: "manual" });
  const back = new URL(consent.headers.get("location")!);
  const state = Object.entries(cookiesOf(started)).map(([k, v]) => `${k}=${v}`).join("; ");
  const answer = await app.request(`${back.pathname}${back.search}`, { headers: { cookie: `${backIn.cookie}; ${state}` } });
  return { status: 200, body: null, landing: answer.headers.get("location") };
}

describe("signing up and creating an organization", () => {
  it("given a person new to the orchestrator, when they sign in with Google and create an organization, then they are its owner, it is theirs alone, and the orchestrator lands them on its welcome page", async () => {
    // given
    const store = openSqliteStore(":memory:");
    const app = cloudOrchestrator(store);
    const ada = await person(app, "google", "Ada Okafor");

    // when
    const created = await ada.post("/api/signup/organization", { name: "Okafor Labs", slug: "okafor", acceptTerms: true });
    const me = await ada.get("/api/orgs/okafor/me");
    const orgs = await (await ada.get("/api/orgs")).json();
    const ben = await person(app, "github", "Ben Ortiz");

    // then
    expect(ada.landing).toBe("/signup/organization");
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual({ tenant: "okafor", name: "Okafor Labs", next: "/okafor/welcome" });
    expect((await me.json()).user).toMatchObject({ email: "ada@okafor-labs.example.invalid", role: "owner" });
    expect(orgs).toEqual({ default: null, orgs: [{ tenant: "okafor", orgName: "Okafor Labs", name: "Ada Okafor", role: "owner" }] });
    expect(ben.landing).toBe("/signup/organization");
    expect((await ben.get("/api/orgs/okafor/me")).status).toBe(401);
    expect((await ben.get("/api/orgs/globex/me")).status).toBe(404);
    expect((await store.getIdentityByLogin("google", "104857600123456789012"))!.termsUrl).toBe(LEGAL.termsUrl);
    expect((await store.eventPage("okafor", {}, null, 10)).events.map((e) => e.kind)).toContain("org.created");
    const steps = await store.identityEventsSince("");
    expect(steps.map((e) => [e.kind, e.provider, e.emailDomain, e.org])).toEqual([
      ["signup.started", "google", "okafor-labs.example.invalid", null],
      ["signup.completed", "google", "okafor-labs.example.invalid", null],
      ["org.created", "google", "okafor-labs.example.invalid", "okafor"],
      ["signup.started", "github", "ortiz-builds.example.invalid", null],
    ]);
    expect(JSON.stringify(steps)).not.toContain("ada@");
  });

  it("given a signed-in person, when they skip the terms, pick a path the orchestrator keeps, a taken slug, or send no CSRF token, then each is refused and no second organization is made", async () => {
    // given
    const store = openSqliteStore(":memory:");
    const app = cloudOrchestrator(store);
    const ada = await person(app, "google", "Ada Okafor");
    await ada.post("/api/signup/organization", { name: "Okafor Labs", slug: "okafor", acceptTerms: true });
    const ben = await person(app, "github", "Ben Ortiz");

    // when
    const answers = await Promise.all([
      ben.post("/api/signup/organization", { name: "Ortiz", slug: "ortiz" }),
      ben.post("/api/signup/organization", { name: "Ortiz", slug: "api", acceptTerms: true }),
      ben.post("/api/signup/organization", { name: "Ortiz", slug: "okafor", acceptTerms: true }),
      ben.post("/api/signup/organization", { name: "Ortiz", slug: "ortiz", acceptTerms: true }, false),
    ]);

    // then
    expect(answers.map((a) => a.status)).toEqual([400, 400, 409, 403]);
    expect((await store.listOrgs()).map((o) => o.tenant)).toEqual(["okafor"]);
    expect((await ben.get("/api/orgs/okafor/me")).status).toBe(401);
  });

  it("given an orchestrator without its terms of use, or a person who created their day's organizations, when an organization is created, then signup is refused", async () => {
    // given
    const closed = cloudOrchestrator(openSqliteStore(":memory:"), { legal: { privacyUrl: null, termsUrl: null } });
    const limited = cloudOrchestrator(openSqliteStore(":memory:"), { perDay: 1 });
    const ada = await person(closed, "google", "Ada Okafor");
    const cem = await person(limited, "google", "Ada Okafor");
    await cem.post("/api/signup/organization", { name: "First", slug: "first", acceptTerms: true });

    // when
    const noTerms = await ada.post("/api/signup/organization", { name: "Okafor Labs", slug: "okafor", acceptTerms: true });
    const second = await cem.post("/api/signup/organization", { name: "Second", slug: "second", acceptTerms: true });

    // then
    expect(noTerms.status).toBe(409);
    expect((await noTerms.json()).error).toContain("privacy policy and terms of use");
    expect(second.status).toBe(429);
  });
});

describe("joining a second organization by invitation", () => {
  it("given Ada's organization and Ben who owns his own, when Ada invites Ben's address and he follows the link with GitHub, then he is a member of Ada's with the invited role and team, keeps his own, and picks between the two", async () => {
    // given
    const store = openSqliteStore(":memory:");
    const app = cloudOrchestrator(store);
    const ada = await person(app, "google", "Ada Okafor");
    await ada.post("/api/signup/organization", { name: "Okafor Labs", slug: "okafor", acceptTerms: true });
    const ben = await person(app, "github", "Ben Ortiz");
    await ben.post("/api/signup/organization", { name: "Ortiz Builds", slug: "ortiz", acceptTerms: true });
    const sent = await (await ada.post("/api/orgs/okafor/invites", { emails: "ben@ortiz-builds.example.invalid", role: "admin", teams: [] })).json();
    const token = new URL(sent.invited[0].link).hash.replace("#/join/", "");

    // when
    const joined = await person(app, "github", "Ben Ortiz", token);

    // then
    expect(joined.landing).toBe("/okafor/");
    expect((await (await joined.get("/api/orgs/okafor/me")).json()).user).toMatchObject({ email: "ben@ortiz-builds.example.invalid", role: "admin" });
    expect((await (await joined.get("/api/orgs")).json()).orgs.map((o: { tenant: string; role: string }) => [o.tenant, o.role])).toEqual([["okafor", "admin"], ["ortiz", "owner"]]);
    expect(await store.listInvites("okafor")).toEqual([]);
    expect((await store.eventPage("okafor", {}, null, 10)).events.map((e) => e.kind)).toContain("account.joined");
    expect((await store.identityEventsSince("")).filter((e) => e.provider === "github").map((e) => [e.kind, e.org])).toEqual([["signup.started", null], ["signup.completed", null], ["org.created", "ortiz"], ["invite.accepted", "okafor"]]);
  });

  it("given an invitation, when another site posts it to start a sign-in, or a page without Origin or Sec-Fetch-Site does, then no sign-in starts and nobody is sent to a provider", async () => {
    // given
    const store = openSqliteStore(":memory:");
    const app = cloudOrchestrator(store);
    const ada = await person(app, "google", "Ada Okafor");
    await ada.post("/api/signup/organization", { name: "Okafor Labs", slug: "okafor", acceptTerms: true });
    const sent = await (await ada.post("/api/orgs/okafor/invites", { emails: "ben@ortiz-builds.example.invalid", role: "member", teams: [] })).json();
    const invite = new URL(sent.invited[0].link).hash.replace("#/join/", "");

    // when
    const crossSite = await app.request("/api/auth/github/start", { method: "POST", headers: { "sec-fetch-site": "cross-site" }, body: new URLSearchParams({ invite }) });
    const otherOrigin = await app.request("/api/auth/github/start", { method: "POST", headers: { origin: "https://elsewhere.example.invalid" }, body: new URLSearchParams({ invite }) });
    const bare = await app.request("/api/auth/github/start", { method: "POST", body: new URLSearchParams({ invite }) });

    // then
    for (const answer of [crossSite, otherOrigin, bare]) {
      expect(answer.headers.get("location")).toBe("/signup?problem=invite-elsewhere");
      expect(answer.headers.getSetCookie()).toEqual([]);
    }
  });

  it("given an invitation to Ben's address, when Ada's Google account follows it, or the organization has no seat left, then nobody joins and the invitation stays", async () => {
    // given
    const store = openSqliteStore(":memory:");
    const app = cloudOrchestrator(store);
    const ada = await person(app, "google", "Ada Okafor");
    await ada.post("/api/signup/organization", { name: "Okafor Labs", slug: "okafor", acceptTerms: true });
    const sent = await (await ada.post("/api/orgs/okafor/invites", { emails: "ben@ortiz-builds.example.invalid", role: "member", teams: [] })).json();
    const token = new URL(sent.invited[0].link).hash.replace("#/join/", "");

    // when
    const wrong = await person(app, "google", "Ada Okafor", token);
    await store.setOrgQuotas("okafor", { members: 1, tasksPerMonth: null, concurrentTasks: null });
    const full = await person(app, "github", "Ben Ortiz", token);

    // then
    expect(wrong.landing).toBe("/signup?problem=invite-email");
    expect(full.landing).toBe("/signup?problem=plan-limit");
    expect((await full.get("/api/orgs/okafor/me")).status).toBe(401);
    expect((await store.listInvites("okafor")).map((i) => i.email)).toEqual(["ben@ortiz-builds.example.invalid"]);
  });

  it("given a cloud orchestrator, when an owner adds a person directly, or sets a password, or a slug the orchestrator serves from its file is signed up for, then each is refused", async () => {
    // given
    const store = openSqliteStore(":memory:");
    const app = cloudOrchestrator(store, { served: ["acme"] });
    const ada = await person(app, "google", "Ada Okafor");
    await ada.post("/api/signup/organization", { name: "Okafor Labs", slug: "okafor", acceptTerms: true });
    const { users } = await (await ada.get("/api/orgs/okafor/users")).json();

    // when
    const direct = await ada.post("/api/orgs/okafor/users", { email: "lee@example.invalid", role: "member", password: "a long enough password" });
    const password = await ada.post(`/api/orgs/okafor/users/${users[0].id}`, { password: "a long enough password" }, true, "PATCH");
    const served = await ada.post("/api/signup/organization", { name: "Acme", slug: "acme", acceptTerms: true });

    // then
    expect(direct.status).toBe(403);
    expect(password.status).toBe(403);
    expect(served.status).toBe(409);
    expect(await store.countOwners("acme")).toBe(0);
  });
});

describe("invitations to a signed-in person", () => {
  async function invited() {
    const store = openSqliteStore(":memory:");
    const app = cloudOrchestrator(store);
    const ada = await person(app, "google", "Ada Okafor");
    await ada.post("/api/signup/organization", { name: "Okafor Labs", slug: "okafor", acceptTerms: true });
    const sent = await (await ada.post("/api/orgs/okafor/invites", { emails: "ben@ortiz-builds.example.invalid", role: "member", teams: [] })).json();
    const token = new URL(sent.invited[0].link).hash.replace("#/join/", "");
    const ben = await person(app, "github", "Ben Ortiz");
    return { store, app, ada, ben, token };
  }

  it("given Ben signed in and invited, when the invitation page is read, he sees it is his, finds it among his invitations, and joins with one call, then a second call says he is already a member", async () => {
    // given
    const { ada, ben, token } = await invited();

    // when
    const readByBen = await (await ben.post("/api/join/read", { token }, false)).json();
    const readByAda = await (await ada.post("/api/join/read", { token }, false)).json();
    const before = await (await ben.get("/api/me/orgs")).json();
    const joined = await ben.post("/api/identity/join", { token });
    const again = await ben.post("/api/identity/join", { token });
    const after = await (await ben.get("/api/me/orgs")).json();

    // then
    expect([readByBen.signedIn, readByBen.emailMatches, readByBen.orgName]).toEqual([true, true, "Okafor Labs"]);
    expect(readByAda.emailMatches).toBe(false);
    expect(before).toEqual({ orgs: [], invitations: [expect.objectContaining({ orgName: "Okafor Labs", invitedBy: "Ada Okafor", role: "member", teams: [] })], joinable: [] });
    expect(joined.status).toBe(200);
    expect(await joined.json()).toEqual({ tenant: "okafor", orgName: "Okafor Labs", next: "/okafor/tasks" });
    expect([again.status, (await again.json()).code]).toEqual([404, "invite-unknown"]);
    expect(after).toEqual({ orgs: [{ tenant: "okafor", orgName: "Okafor Labs", role: "member" }], invitations: [], joinable: [] });
  });

  it("given invitations, when Ben declines his, Cem accepts or declines Ben's by its id, an expired one is accepted, or an unknown token is sent, then each answers as the contract says and nobody joins", async () => {
    // given
    const { store, app, ben, token } = await invited();
    const cem = await person(app, "google", "Ada Okafor");
    const { invitations } = await (await ben.get("/api/me/orgs")).json();
    const [tenant, id] = invitations[0].id.split(":");

    // when
    const foreignAccept = await cem.post(`/api/me/invitations/${invitations[0].id}/accept`, {});
    const foreignDecline = await cem.post(`/api/me/invitations/${invitations[0].id}`, {}, true, "DELETE");
    const invite = (await store.getInvite(tenant, id))!;
    await store.saveInvite({ ...invite, expiresAt: "2020-01-01T00:00:00.000Z" });
    const expired = await ben.post(`/api/me/invitations/${invitations[0].id}/accept`, {});
    const unknown = await ben.post("/api/identity/join", { token: `${token}x` });
    const declined = await ben.post(`/api/me/invitations/${invitations[0].id}`, {}, true, "DELETE");

    // then
    expect([foreignAccept.status, (await foreignAccept.json()).code]).toEqual([404, "invite-unknown"]);
    expect(foreignDecline.status).toBe(404);
    expect([expired.status, (await expired.json()).code]).toEqual([410, "invite-expired"]);
    expect([unknown.status, (await unknown.json()).code]).toEqual([404, "invite-unknown"]);
    expect(declined.status).toBe(204);
    expect(await store.listInvites("okafor")).toEqual([]);
    expect((await ben.get("/api/orgs/okafor/me")).status).toBe(401);
  });
});

describe("signing out of a cloud orchestrator", () => {
  it("given Ada signed in and in her organization, when she signs out from it, then her one session ends for every organization and the orchestrator no longer knows her", async () => {
    // given
    const store = openSqliteStore(":memory:");
    const app = cloudOrchestrator(store);
    const ada = await person(app, "google", "Ada Okafor");
    await ada.post("/api/signup/organization", { name: "Okafor Labs", slug: "okafor", acceptTerms: true });

    // when
    const out = await ada.post("/api/orgs/okafor/auth/logout", {});

    // then
    expect(out.status).toBe(200);
    expect(out.headers.getSetCookie().some((c) => c.startsWith("th_identity=;"))).toBe(true);
    expect((await ada.get("/api/identity")).status).toBe(401);
    expect((await ada.get("/api/orgs/okafor/me")).status).toBe(401);
  });

  it("given Ada signed in from two browsers, when one lists where she is signed in and ends the other, then that browser is signed out of every organization and this one stays", async () => {
    // given
    const store = openSqliteStore(":memory:");
    const app = cloudOrchestrator(store);
    const here = await person(app, "google", "Ada Okafor");
    await here.post("/api/signup/organization", { name: "Okafor Labs", slug: "okafor", acceptTerms: true });
    const there = await person(app, "google", "Ada Okafor");

    // when
    const listed = (await (await here.get("/api/orgs/okafor/me/sessions")).json()).sessions as { id: string; current: boolean }[];
    const ended = await here.post(`/api/orgs/okafor/me/sessions/${listed.find((s) => !s.current)!.id}`, {}, true, "DELETE");

    // then
    expect(listed.map((s) => s.current).sort()).toEqual([false, true]);
    expect(ended.status).toBe(200);
    expect((await there.get("/api/identity")).status).toBe(401);
    expect((await here.get("/api/orgs/okafor/me")).status).toBe(200);
  });
});

describe("how members of a cloud organization sign in", () => {
  it("given Ada who signs in with Google and Ben who joined with GitHub, when the members are listed, then each is shown with their provider, never a password", async () => {
    // given
    const store = openSqliteStore(":memory:");
    const app = cloudOrchestrator(store);
    const ada = await person(app, "google", "Ada Okafor");
    await ada.post("/api/signup/organization", { name: "Okafor Labs", slug: "okafor", acceptTerms: true });
    const sent = await (await ada.post("/api/orgs/okafor/invites", { emails: "ben@ortiz-builds.example.invalid", role: "member", teams: [] })).json();
    await person(app, "github", "Ben Ortiz", new URL(sent.invited[0].link).hash.replace("#/join/", ""));

    // when
    const { users } = await (await ada.get("/api/orgs/okafor/users")).json();

    // then
    expect(users.map((u: { email: string; signIn: string[] }) => [u.email, u.signIn]).sort()).toEqual([["ada@okafor-labs.example.invalid", ["google"]], ["ben@ortiz-builds.example.invalid", ["github"]]]);
  });
});

describe("what the sign-in page is told in each mode", () => {
  it("given a cloud, a local and a self-hosted orchestrator, when each is asked how people sign in, then the cloud one names its providers and the README for running it yourself, the local one says local, and the self-hosted one says it signs people in per organization", async () => {
    // given
    const store = openSqliteStore(":memory:");
    const hosted = cloudOrchestrator(store);
    const one = { store, dataDir: "unused", tenant: "acme", allowedHosts: null };

    // when
    const cloud = await (await hosted.request("/api/identity/config")).json();
    vi.stubEnv("ORCHESTRATOR_MODE", "local");
    const local = await createApp(one).request("/api/identity/config");
    vi.stubEnv("ORCHESTRATOR_MODE", "self-hosted");
    const selfHosted = await createApp(one).request("/api/identity/config");

    // then
    expect(cloud).toMatchObject({ mode: "cloud", readmeUrl: "https://pages.example.invalid/readme", signupOpen: true });
    expect([local.status, await local.json()]).toEqual([200, { mode: "local" }]);
    expect([selfHosted.status, await selfHosted.json()]).toEqual([200, { mode: "self-hosted" }]);
  });
});

describe("joining by the directory that holds one's account", () => {
  it("given Ada lets her Google Workspace join, when Noor from it, Ben from GitHub and Noor again after Ada removed her ask to join, then only Noor's first join is taken, as a member, by her own click", async () => {
    // given
    const store = openSqliteStore(":memory:");
    const app = cloudOrchestrator(store);
    const ada = await person(app, "google", "Ada Okafor");
    await ada.post("/api/signup/organization", { name: "Okafor Labs", slug: "okafor", acceptTerms: true });
    const offered = await (await ada.get("/api/orgs/okafor/directory-join")).json();
    const turnedOn = await ada.post("/api/orgs/okafor/directory-join", { on: true, role: "member" }, true, "PUT");

    // when
    const noor = await person(app, "google", "Noor Okafor");
    const beforeJoin = await (await noor.get("/api/me/orgs")).json();
    const joined = await noor.post("/api/me/joinable/okafor", {});
    const ben = await person(app, "github", "Ben Ortiz");
    const bens = await (await ben.get("/api/me/orgs")).json();
    const benJoins = await ben.post("/api/me/joinable/okafor", {});
    const noorId = (await (await noor.get("/api/orgs/okafor/me")).json()).user.id;
    await ada.post(`/api/orgs/okafor/users/${noorId}`, {}, true, "DELETE");
    const back = await person(app, "google", "Noor Okafor");
    const afterRemoval = await (await back.get("/api/me/orgs")).json();
    const rejoin = await back.post("/api/me/joinable/okafor", {});

    // then
    expect(offered).toEqual({ join: null, yours: { provider: "google", directory: "okafor-labs.example.invalid" } });
    expect(turnedOn.status).toBe(200);
    expect(noor.landing).toBe("/signup/organization");
    expect([beforeJoin.orgs, beforeJoin.joinable]).toEqual([[], [{ tenant: "okafor", orgName: "Okafor Labs", role: "member" }]]);
    expect(joined.status).toBe(200);
    expect(bens.joinable).toEqual([]);
    expect(benJoins.status).toBe(403);
    expect([afterRemoval.orgs, afterRemoval.joinable, rejoin.status]).toEqual([[], [], 403]);
    expect((await store.identityEventsSince("")).filter((e) => e.kind === "directory.joined").map((e) => e.org)).toEqual(["okafor"]);
  });

  it("given an owner signed in with GitHub, or a member, when either lets a directory join, then it is refused, and an admin role for joiners is refused too", async () => {
    // given
    const store = openSqliteStore(":memory:");
    const app = cloudOrchestrator(store);
    const ben = await person(app, "github", "Ben Ortiz");
    await ben.post("/api/signup/organization", { name: "Ortiz Builds", slug: "ortiz", acceptTerms: true });
    const ada = await person(app, "google", "Ada Okafor");
    await ada.post("/api/signup/organization", { name: "Okafor Labs", slug: "okafor", acceptTerms: true });

    // when
    const fromGitHub = await ben.post("/api/orgs/ortiz/directory-join", { on: true }, true, "PUT");
    const asAdmin = await ada.post("/api/orgs/okafor/directory-join", { on: true, role: "admin" }, true, "PUT");

    // then
    expect([fromGitHub.status, asAdmin.status]).toEqual([409, 400]);
    expect(await store.tenantsWithSetting("join.directory.google:okafor-labs.example.invalid")).toEqual([]);
  });
});

describe("adding and removing a way to sign in", () => {
  it("given Ada signed in with Google, when she adds her own GitHub account, then she lands on her account page, signs in with either into the same organizations, and the organization's log says so", async () => {
    // given
    const store = openSqliteStore(":memory:");
    const app = cloudOrchestrator(store);
    const ada = await person(app, "google", "Ada Okafor");
    await ada.post("/api/signup/organization", { name: "Okafor Labs", slug: "okafor", acceptTerms: true });

    // when
    const linked = await link(app, ada, "github", "Ada on GitHub");
    const viaGitHub = await person(app, "github", "Ada on GitHub");

    // then
    expect(linked.landing).toBe("/okafor/settings/account?linked=github");
    expect((await (await ada.get("/api/identity")).json()).logins.map((l: { provider: string }) => l.provider)).toEqual(["google", "github"]);
    expect(viaGitHub.landing).toBe("/okafor/");
    expect((await (await viaGitHub.get("/api/orgs/okafor/me")).json()).user.email).toBe("ada@okafor-labs.example.invalid");
    expect((await store.eventPage("okafor", {}, null, 20)).events.map((e) => e.kind)).toContain("account.sign-in-added");
  });

  it("given links that are not Ada's to make, when she adds a GitHub account under another address or one Ben already signs in with, or the provider sends her answer to Mia's browser, then nothing is linked", async () => {
    // given
    const store = openSqliteStore(":memory:");
    const app = cloudOrchestrator(store);
    const ada = await person(app, "google", "Ada Okafor");
    await ada.post("/api/signup/organization", { name: "Okafor Labs", slug: "okafor", acceptTerms: true });
    await person(app, "github", "Nia Private").catch(() => null);
    const mia = await person(app, "google", "Mia Kaya");
    await person(app, "github", "Ben Ortiz");

    // when
    const takenByBen = await link(app, ada, "github", "Ben Ortiz");
    const inMiasBrowser = await link(app, ada, "github", "Ada on GitHub", mia);

    // then
    expect(takenByBen.landing).toBe("/okafor/settings/account?link-problem=login-taken");
    expect(inMiasBrowser.landing).toBe("/signup?problem=browser");
    expect((await (await ada.get("/api/identity")).json()).logins.map((l: { provider: string }) => l.provider)).toEqual(["google"]);
    expect((await (await mia.get("/api/identity")).json()).logins.map((l: { provider: string }) => l.provider)).toEqual(["google"]);
  });

  it("given Ada with two ways in, when she removes one, then the last one is not removed, and a sign-in older than ten minutes changes nothing", async () => {
    // given
    const store = openSqliteStore(":memory:");
    const app = cloudOrchestrator(store);
    const ada = await person(app, "google", "Ada Okafor");
    await ada.post("/api/signup/organization", { name: "Okafor Labs", slug: "okafor", acceptTerms: true });
    await link(app, ada, "github", "Ada on GitHub");

    // when
    const removed = await ada.post("/api/identity/logins/github", {}, true, "DELETE");
    const last = await ada.post("/api/identity/logins/google", {}, true, "DELETE");
    const now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now + 11 * 60_000);
    const stale = await link(app, ada, "github", "Ada on GitHub");
    vi.restoreAllMocks();

    // then
    expect([removed.status, last.status]).toEqual([204, 409]);
    expect([stale.status, stale.body.code]).toEqual([409, "reauth"]);
    expect((await (await ada.get("/api/identity")).json()).logins.map((l: { provider: string }) => l.provider)).toEqual(["google"]);
  });
});

describe("adding an account under another address", () => {
  it("given Ada adds a GitHub account whose address is not hers here, when the provider answers, then nothing is added until she confirms it on her account page, Mia cannot read or confirm it, and the confirmation works once", async () => {
    // given
    const store = openSqliteStore(":memory:");
    const app = cloudOrchestrator(store);
    const ada = await person(app, "google", "Ada Okafor");
    await ada.post("/api/signup/organization", { name: "Okafor Labs", slug: "okafor", acceptTerms: true });
    const mia = await person(app, "google", "Mia Kaya");

    // when
    const answered = await link(app, ada, "github", "Ada's other GitHub");
    const token = new URL(answered.landing!, "http://x").searchParams.get("link-confirm")!;
    const before = (await (await ada.get("/api/identity")).json()).logins.length;
    const shown = await (await ada.get(`/api/identity/logins/confirm/${token}`)).json();
    const miaReads = await mia.get(`/api/identity/logins/confirm/${token}`);
    const miaConfirms = await mia.post(`/api/identity/logins/confirm/${token}`, {});
    const confirmed = await ada.post(`/api/identity/logins/confirm/${token}`, {});
    const again = await ada.post(`/api/identity/logins/confirm/${token}`, {});
    const viaIt = await person(app, "github", "Ada's other GitHub");

    // then
    expect(answered.landing).toMatch(/^\/okafor\/settings\/account\?link-confirm=/);
    expect(before).toBe(1);
    expect(shown).toEqual({ provider: "github", email: "ada@elsewhere.example.invalid" });
    expect([miaReads.status, miaConfirms.status, confirmed.status, again.status]).toEqual([404, 404, 200, 404]);
    expect((await (await ada.get("/api/identity")).json()).logins.map((l: { email: string }) => l.email)).toEqual(["ada@okafor-labs.example.invalid", "ada@elsewhere.example.invalid"]);
    expect(viaIt.landing).toBe("/okafor/");
  });
});
