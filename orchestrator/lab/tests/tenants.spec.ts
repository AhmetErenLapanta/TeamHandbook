import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { OrchestratorClient } from "../client.js";
import { userOf } from "../state.js";
import type { LabOrg } from "../state.js";
import { as, builtIn, close, expectSignedIn, fileAt, lab, openRepo, orgLabel, ownerOf, proposeUsage, signInOnPage, startTenantOrchestrator } from "./support.js";
import type { TenantOrchestrator } from "./support.js";

test.describe("each organization sees only itself", () => {
  for (const org of lab.orgs) {
    test(`given ${orgLabel(org)}, when its admin lists repositories and people, then exactly its own are there`, async () => {
      // given
      const admin = await as(org, "admin");

      // when
      const { repos } = await admin.ok<{ repos: { id: string; tenant: string }[] }>("GET", "/api/repos");
      const { users } = await admin.ok<{ users: { email: string }[] }>("GET", "/api/users");

      // then
      expect(repos.map((r) => r.id).sort()).toEqual(org.repos.map((r) => r.id).sort());
      expect(new Set(repos.map((r) => r.tenant))).toEqual(new Set([org.name]));
      // Someone who signed in through single sign-on has an account here too, and nowhere else.
      const ownPeople = new Set([...org.users.map((u) => u.email), ...org.sso.map((p) => p.email)]);
      expect(users.map((u) => u.email).filter((e) => !ownPeople.has(e))).toEqual([]);
      expect(users.map((u) => u.email)).toEqual(expect.arrayContaining(org.users.map((u) => u.email)));
    });
  }

  for (const from of lab.orgs) {
    for (const to of lab.orgs.filter((o) => o !== from)) {
      test(`given a session on ${orgLabel(from)}, when it is presented to ${orgLabel(to)}, then it is refused and its people cannot sign in there`, async () => {
        // given
        const session = await as(from, "admin");

        // when
        const stranger = OrchestratorClient.withCookie(to.url, session.cookie);

        // then
        expect((await stranger.call("GET", "/api/me")).status).toBe(401);
        expect((await stranger.call("GET", "/api/repos")).status).toBe(401);
        await expect(OrchestratorClient.signIn(to.url, userOf(from, "admin").email, lab.password)).rejects.toThrow(/answered 403: .*wrong email or password/);
      });
    }
  }

  test("given a browser signed in to one organization, when it opens another's orchestrator, then that orchestrator asks to sign in and shows none of the first one's repositories", async ({ browser }) => {
    // given
    const [first, second] = builtIn as [LabOrg, LabOrg];
    const context = await browser.newContext();
    const page = await context.newPage();
    await signInOnPage(page, first, "admin");
    await openRepo(page, first, first.repos[0]!.id);

    // when
    await page.goto(second.url);

    // then
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: first.repos[0]!.id })).toHaveCount(0);
    await context.close();
  });
});

test.describe("one browser, several organizations", () => {
  test("given a browser signed in to one organization, when it signs in to a second one on the same host, then both stay signed in, each with a cookie of its own", async ({ browser }) => {
    // given
    const [first, second] = builtIn as [LabOrg, LabOrg];
    const context = await browser.newContext();
    const firstPage = await context.newPage();
    await signInOnPage(firstPage, first, "admin");

    // when
    const secondPage = await context.newPage();
    await signInOnPage(secondPage, second, "admin");

    // then
    const sessions = (await context.cookies()).filter((c) => c.name.startsWith("th_session"));
    expect(new Set(sessions.map((c) => c.name)).size).toBe(2);
    await firstPage.reload();
    await expectSignedIn(firstPage, userOf(first, "admin").name);
    await openRepo(firstPage, first, first.repos[0]!.id);
    await secondPage.reload();
    await expectSignedIn(secondPage, userOf(second, "admin").name);
    expect((await (await firstPage.request.get(`${first.url}/api/me`)).json()).user.email).toBe(userOf(first, "admin").email);
    expect((await (await secondPage.request.get(`${second.url}/api/me`)).json()).user.email).toBe(userOf(second, "admin").email);
    await context.close();
  });
});

test.describe("two tenants in one Postgres database", () => {
  const onPostgres = lab.orgs.filter((o) => o.store === "postgres");
  test.skip(!lab.postgres || onPostgres.length === 0, "no organization of this lab is on Postgres");

  let shadow: TenantOrchestrator;
  let tenant = "";
  let url = "";

  test.beforeAll(async () => {
    shadow = await startTenantOrchestrator(1);
    ({ tenant, url } = shadow);
  });

  test.afterAll(() => shadow?.stop());

  test("given a second tenant's orchestrator on the same database, when its admin looks, then none of the Postgres organizations' repositories, people, requests or skill use are there", async () => {
    // given
    const shadow = await OrchestratorClient.signIn(url, `admin@${tenant}.example.invalid`, lab.password);
    for (const org of onPostgres) expect((await (await as(org, "admin")).ok<{ users: unknown[] }>("GET", "/api/users")).users.length).toBeGreaterThan(1);

    // when
    const { repos } = await shadow.ok<{ repos: unknown[] }>("GET", "/api/repos");
    const { users } = await shadow.ok<{ users: { email: string }[] }>("GET", "/api/users");
    const requests = await shadow.ok<{ total: number }>("GET", "/api/requests");
    const { usage } = await shadow.ok<{ usage: unknown[] }>("GET", "/api/usage?days=365");

    // then
    expect(repos).toEqual([]);
    expect(users.map((u) => u.email)).toEqual([`admin@${tenant}.example.invalid`]);
    expect(requests.total).toBe(0);
    expect(usage).toEqual([]);
    for (const org of onPostgres) {
      expect((await shadow.call("GET", `/api/repos/${org.repos[0]!.id}/inventory`)).status).toBe(404);
      await expect(OrchestratorClient.signIn(url, userOf(org, "admin").email, lab.password)).rejects.toThrow(/answered 403: .*wrong email or password/);
    }
  });

  test("given a Postgres organization's usage address, when it is sent to the other tenant's orchestrator on the same database, then that orchestrator refuses it and the organization's count does not move", async () => {
    // Ids are looked up across every tenant of the database: one this orchestrator did not issue is
    // refused like any other, and no answer names the orchestrator's own folders.
    // given: the address a merged team file names, or the one an open request would name
    const org = onPostgres[0]!;
    const repo = org.repos[0]!;
    const owner = await ownerOf(org, repo);
    const endpointAt = (ref: string) => (JSON.parse(fileAt(repo, ref, ".teamhandbook.json") ?? "{}") as { usage?: { endpoint?: string } }).usage?.endpoint;
    let endpoint = endpointAt("HEAD");
    let opened: number | null = null;
    if (!endpoint) {
      const { request } = await proposeUsage(owner, org, repo);
      opened = request!.number;
      endpoint = endpointAt(request!.branch);
    }
    const skill = (await owner.ok<{ inventory: { skills: { slug: string }[] } }>("GET", `/api/repos/${repo.id}/inventory`)).inventory.skills[0]!.slug;
    const counted = async () => (await (await as(org, "admin")).ok<{ usage: { skill: string; count: number }[] }>("GET", `/api/usage?repo=${repo.id}`)).usage.find((u) => u.skill === skill)?.count ?? 0;
    const before = await counted();

    try {
      // when
      const res = await fetch(endpoint!.replace(org.url, url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events: [{ skill, hour: new Date().toISOString().slice(0, 13) }] }) });

      // then
      expect([res.status, await res.json()]).toEqual([400, { error: "refused" }]);
      expect(await counted()).toBe(before);
    } finally {
      if (opened !== null) await close(org, repo, opened);
    }
  });

  test("given sessions on both tenants of one database, when each is presented to the other's orchestrator, then both are refused", async () => {
    // given
    const shadow = await OrchestratorClient.signIn(url, `admin@${tenant}.example.invalid`, lab.password);
    for (const org of onPostgres) {
      const own = await as(org, "admin");

      // when
      const theirsHere = OrchestratorClient.withCookie(url, own.cookie);
      const oursThere = OrchestratorClient.withCookie(org.url, shadow.cookie);

      // then
      expect((await theirsHere.call("GET", "/api/me")).status).toBe(401);
      expect((await oursThere.call("GET", "/api/me")).status).toBe(401);
    }
  });
});
