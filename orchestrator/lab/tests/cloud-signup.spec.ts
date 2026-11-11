import { createHash, randomBytes } from "node:crypto";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { browserOf, createOrganization, pick } from "../../browser-tests/cloud-browser.js";
import { Evidence } from "../evidence.js";
import { cloudOrchestrator, PUBLIC_URL } from "./cloud-orchestrator.js";
import type { CloudOrchestrator } from "./cloud-orchestrator.js";
import { lab } from "./support.js";

/** The landing page a person starts from; its sign-up button names the orchestrator's sign-up address. */
const LANDING = process.env.LAB_LANDING_URL ?? "http://127.0.0.1:3050/en/teamhandbook/orchestrator";

const at = (path: string) => `${PUBLIC_URL}${path}`;
/** What the page's own session reads at an address of the orchestrator, as the page's script would. */
const read = <T>(page: Page, path: string) =>
  page.evaluate(async (p) => {
    const res = await fetch(p);
    return { status: res.status, body: await res.json().catch(() => null) };
  }, path) as Promise<{ status: number; body: T }>;

/**
 * A token for the orchestrator's MCP server, as an MCP client gets one: registered, sent to the
 * approval page with PKCE, approved from the person's own browser session, and the code traded.
 * The orchestrator is reached at its own port; the session is the browser's cookies.
 */
async function mcpToken(origin: string, cookie: string): Promise<string> {
  const redirect = "http://127.0.0.1:9/callback";
  const client = (await (await fetch(`${origin}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Lab MCP client", redirect_uris: [redirect], grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none" }) })).json()) as { client_id: string };
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const ask = new URL(`${origin}/oauth/authorize`);
  for (const [k, v] of Object.entries({ response_type: "code", client_id: client.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state: "lab", resource: `${PUBLIC_URL}/mcp` })) ask.searchParams.set(k, v);
  const html = await (await fetch(ask, { headers: { cookie } })).text();
  const form = new URLSearchParams({ consent: /name="consent" value="([^"]+)"/.exec(html)?.[1] ?? "", org: /name="org" value="([^"]+)"/.exec(html)?.[1] ?? "", decision: "approve" });
  const back = await fetch(`${origin}/oauth/authorize`, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: form, redirect: "manual" });
  const code = new URL(back.headers.get("location") ?? "http://none.invalid/").searchParams.get("code");
  if (!code) throw new Error(`the approval gave no code: ${back.status} ${html.slice(0, 200)}`);
  const token = (await (await fetch(`${origin}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id: client.client_id, code_verifier: verifier }) })).json()) as { access_token?: string };
  if (!token.access_token) throw new Error("the code was not traded for a token");
  return token.access_token;
}

interface Memberships {
  orgs: { tenant: string; orgName: string; role: string }[];
}

/**
 * Signing up to an orchestrator in cloud mode (ORCHESTRATOR_MODE=cloud), from the landing page's
 * sign-up button to two organizations, with stand-in Google, GitHub and Microsoft. The cloud
 * orchestrator is the scenario's own on the lab's Postgres (lab/tests/cloud-orchestrator.ts), the
 * build of this commit, reached by the browser at its https address; the people are the stand-in
 * providers' (lab/cloud.ts). Each run keeps an evidence directory with the orchestrator's log, the
 * providers' and each table's row count.
 */
test.describe("signing up to a cloud orchestrator", () => {
  test.skip(!lab.postgres, "this lab has no Postgres");
  let cloud: CloudOrchestrator;
  let proof: Evidence;
  test.beforeAll(async () => {
    cloud = await cloudOrchestrator("cloud-signup");
    proof = new Evidence(lab.dir, "cloud-signup", [lab.password]);
  });
  test.afterAll(async () => {
    proof.json("rows.json", await cloud.rows());
    proof.copy("orchestrator.log", cloud.log);
    proof.copy("providers.log", cloud.providersLog);
    await cloud.stop();
  });
  test.afterEach(async ({}, testInfo) => {
    proof.decide(testInfo.status === testInfo.expectedStatus, testInfo.error?.message ?? "");
  });

  test("given the landing page's sign-up button, when a person follows it, then it leads to the orchestrator's sign-up page, which offers Google, GitHub and Microsoft and says nobody joins without an invitation", async ({ browser }) => {
    // given the address the landing page sends a person to, read off the landing page itself
    const landing = await fetch(LANDING).then((r) => r.text(), () => null);
    test.skip(landing === null, `the landing page is not served at ${LANDING}`);
    const target = [...landing!.matchAll(/href="([^"]*\/signup\?[^"]*)"/g)].map((m) => new URL(m[1]!.replace(/&amp;/g, "&")))[0];
    expect(target, "the landing page names the orchestrator's sign-up address").toBeDefined();
    expect(`${target!.pathname}${target!.search}`).toBe("/signup?from=landing");

    // when a person follows it to this orchestrator
    const { page } = await browserOf(browser);
    await page.goto(at(`${target!.pathname}${target!.search}`));

    // then
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Start with TeamHandbook Orchestrator");
    for (const [name, provider] of [["Google", "google"], ["GitHub", "github"], ["Microsoft", "microsoft"]]) {
      await expect(page.getByRole("link", { name: `Continue with ${name}` })).toHaveAttribute("href", `/api/auth/${provider}/start`);
    }
    await expect(page.getByText("nobody joins without an invitation")).toBeVisible();
  });

  test("given two people new to the orchestrator, when one signs up with Google and the other with GitHub, each creates an organization, and the first invites the second, then each owns their own organization, the second joins the first's as a member through the invitation, picks between the two, and nobody else lands in either", async ({ browser }) => {
    test.setTimeout(300_000);
    // given Ada Okafor (Google, verified) and Ben Ortiz (GitHub, verified primary address), and Cem Aydin (Microsoft) whom nobody invites
    const ada = await browserOf(browser);
    const ben = await browserOf(browser);
    const cem = await browserOf(browser);

    // when Ada signs up with Google from the landing page's address and creates Okafor Labs
    await ada.page.goto(at("/signup?from=landing"));
    await pick(ada.page, "Google", "Ada Okafor");
    await expect(ada.page).toHaveURL(/\/signup\/organization$/);
    await createOrganization(ada.page, "Okafor Labs");
    await expect(ada.page).toHaveURL(/\/okafor-labs\/welcome$/);

    // and Ben signs up with GitHub and creates Ortiz Builds
    await ben.page.goto(at("/signup"));
    await pick(ben.page, "GitHub", "Ben Ortiz");
    await createOrganization(ben.page, "Ortiz Builds");
    await expect(ben.page).toHaveURL(/\/ortiz-builds\/welcome$/);

    // then each owns their own organization and belongs to no other
    expect((await read<Memberships>(ada.page, "/api/orgs")).body.orgs.map((o) => [o.tenant, o.role])).toEqual([["okafor-labs", "owner"]]);
    expect((await read<Memberships>(ben.page, "/api/orgs")).body.orgs.map((o) => [o.tenant, o.role])).toEqual([["ortiz-builds", "owner"]]);

    // when Ada invites Ben's address to Okafor Labs and Ben follows the link while signed in with GitHub
    await ada.page.goto(at("/okafor-labs/settings/members"));
    await ada.page.getByRole("button", { name: "Invite members" }).click();
    await ada.page.getByLabel("Emails").fill("ben@ortiz-builds.example.invalid");
    await ada.page.getByRole("button", { name: "Create invitation links" }).click();
    const link = (await ada.page.getByRole("region", { name: "Links to send" }).locator("code").textContent())!;
    // The invitation's secret is in its address; the evidence masks every part of it.
    const invitation = new URL(link);
    for (const part of [invitation.pathname.split("/").pop(), invitation.search.slice(1), invitation.hash.slice(1)]) if (part) proof.add(part);
    await ben.page.goto(at(link.replace(/^https?:\/\/[^/]+/, "")));
    await expect(ben.page.getByText("Ada Okafor invited ben@ortiz-builds.example.invalid to Okafor Labs")).toBeVisible();
    await ben.page.getByRole("button", { name: "Join Okafor Labs" }).click();

    // then Ben is a member of Okafor Labs and still the owner of Ortiz Builds, and the picker names both
    await expect(ben.page).toHaveURL(/\/okafor-labs\//);
    expect((await read<Memberships>(ben.page, "/api/orgs")).body.orgs.map((o) => [o.tenant, o.role]).sort()).toEqual([["okafor-labs", "member"], ["ortiz-builds", "owner"]]);
    await ben.page.getByRole("button", { name: "Organization: Okafor Labs" }).click();
    await expect(ben.page.getByRole("link", { name: /^Ortiz Builds/ })).toBeVisible();
    await expect(ben.page.getByRole("link", { name: /^Okafor Labs/ })).toHaveAttribute("aria-current", "true");
    // and Okafor Labs holds Ada and Ben alone, Ortiz Builds Ben alone
    const people = async (page: Page, org: string) => (await read<{ users: { email: string; role: string }[] }>(page, `/api/orgs/${org}/users`)).body.users.map((u) => [u.email, u.role]).sort();
    expect(await people(ada.page, "okafor-labs")).toEqual([["ada@okafor-labs.example.invalid", "owner"], ["ben@ortiz-builds.example.invalid", "member"]]);
    expect(await people(ben.page, "ortiz-builds")).toEqual([["ben@ortiz-builds.example.invalid", "owner"]]);

    // when Cem signs in with Microsoft with no invitation
    await cem.page.goto(at("/signup"));
    await pick(cem.page, "Microsoft", "Cem Aydin");

    // then he has an identity and no organization, and neither organization is his to open
    await expect(cem.page).toHaveURL(/\/signup\/organization$/);
    expect((await read<Memberships>(cem.page, "/api/orgs")).body.orgs).toEqual([]);
    for (const org of ["okafor-labs", "ortiz-builds"]) expect((await read(cem.page, `/api/orgs/${org}/me`)).status).toBe(401);
  });

  test("given addresses a provider does not vouch for, when Gus (Google, unverified), Nia (GitHub, no verified address) and Dee (a personal Microsoft account with no email claim) sign up, then none is let into an organization by that address, and each is told what is missing", async ({ browser }) => {
    test.setTimeout(300_000);
    for (const [provider, name] of [["Google", "Gus Unverified"], ["GitHub", "Nia Private"], ["Microsoft", "Dee Personal"]] as const) {
      // given
      const { page } = await browserOf(browser);

      // when
      await page.goto(at("/signup?from=landing"));
      await pick(page, provider, name);

      // then
      await expect(page, name).toHaveURL(/\/signup\?problem=/);
      await expect(page.getByRole("alert"), name).not.toBeEmpty();
      expect((await read<Memberships>(page, "/api/orgs")).body?.orgs ?? [], name).toEqual([]);
    }
  });

  test("given two organizations on one cloud orchestrator, each with an API key and an OAuth token for the orchestrator's MCP server, when one organization's owner reaches the other's members, keys, events, usage, tasks and repositories with their session, their API key, their OAuth token and the other's key id, then every attempt is refused as if the other organization did not exist, and the event log of each names only its own", async ({ browser }) => {
    test.setTimeout(300_000);
    // given Mia's Kaya Keys and Dana's Novak Studio, each with an API key and an MCP token of its own
    const orgs = [] as { slug: string; person: string; page: Page; key: { id: string; secret: string }; token: string }[];
    for (const [person, name, slug] of [["Mia Kaya", "Kaya Keys", "kaya-keys"], ["Dana Novak", "Novak Studio", "novak-studio"]] as const) {
      const { context, page } = await browserOf(browser);
      await page.goto(at("/signup"));
      await pick(page, "Google", person);
      await createOrganization(page, name);
      await expect(page).toHaveURL(new RegExp(`/${slug}/welcome$`));
      const csrf = (await read<{ csrf: string }>(page, `/api/orgs/${slug}/me`)).body.csrf;
      const key = await page.evaluate(
        async ({ slug, csrf }) => (await (await fetch(`/api/orgs/${slug}/keys`, { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify({ name: "isolation", scopes: { repositories: "read", requests: "read", tasks: "read" }, expiresInDays: 1 }) })).json()) as { key: { id: string }; secret: string },
        { slug, csrf },
      );
      const cookie = (await context.cookies(PUBLIC_URL)).map((c) => `${c.name}=${c.value}`).join("; ");
      orgs.push({ slug, person, page, key: { id: key.key.id, secret: key.secret }, token: await mcpToken(cloud.origin, cookie) });
      proof.add(key.secret);
      proof.add(orgs.at(-1)!.token);
    }
    const [kaya, novak] = orgs as [(typeof orgs)[number], (typeof orgs)[number]];
    const paths = ["me", "users", "keys", "events", "usage", "activity/summary", "tasks", "repos"];
    const bearer = async (secret: string, path: string) => (await fetch(`${cloud.origin}${path}`, { headers: { authorization: `Bearer ${secret}` } })).status;

    // then each reaches its own, which is what makes the refusals below mean something
    expect((await read(kaya.page, `/api/orgs/${kaya.slug}/events`)).status).toBe(200);
    expect(await bearer(kaya.key.secret, `/api/orgs/${kaya.slug}/tasks`)).toBe(200);

    // when Mia reaches Novak Studio with her session, her API key and her MCP token, and revokes Dana's key by its id
    const bySession = await Promise.all(paths.map(async (p) => [p, (await read(kaya.page, `/api/orgs/${novak.slug}/${p}`)).status] as const));
    const byKey = await Promise.all(paths.map(async (p) => [p, await bearer(kaya.key.secret, `/api/orgs/${novak.slug}/${p}`)] as const));
    const byToken = await Promise.all(paths.map(async (p) => [p, await bearer(kaya.token, `/api/orgs/${novak.slug}/${p}`)] as const));
    const csrf = (await read<{ csrf: string }>(kaya.page, `/api/orgs/${kaya.slug}/me`)).body.csrf;
    const revoked = await kaya.page.evaluate(async ({ path, csrf }) => (await fetch(path, { method: "DELETE", headers: { "x-csrf-token": csrf } })).status, { path: `/api/orgs/${kaya.slug}/keys/${novak.key.id}`, csrf });

    // then nothing of Novak Studio answers her, by any of the three, and Dana's key still works
    for (const [p, status] of bySession) expect([401, 403, 404], `Mia's session on Novak Studio's ${p}`).toContain(status);
    for (const [p, status] of byKey) expect(status, `Mia's API key on Novak Studio's ${p}`).toBe(401);
    for (const [p, status] of byToken) expect(status, `Mia's MCP token on Novak Studio's ${p}`).toBe(401);
    expect(revoked, "Mia revoking Dana's key by its id").toBe(404);
    expect(await bearer(novak.key.secret, `/api/orgs/${novak.slug}/tasks`)).toBe(200);
    // and each organization's event log names its own people and key alone
    for (const [own, other] of [[kaya, novak], [novak, kaya]] as const) {
      const log = JSON.stringify((await read(own.page, `/api/orgs/${own.slug}/events`)).body);
      expect(log, `${own.slug}'s event log`).not.toContain(other.slug);
      expect(log, `${own.slug}'s event log`).not.toContain(other.person);
      expect(log, `${own.slug}'s event log`).not.toContain(other.key.id);
    }
  });
});
