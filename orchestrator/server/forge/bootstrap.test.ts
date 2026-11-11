import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createUser, principalOf, setupFirstOwner, startSession } from "../accounts.js";
import { createApp } from "../app.js";
import type { OrchestratorContext } from "../app.js";
import { CSRF_HEADER, sessionCookie } from "../auth.js";
import { openSqliteStore } from "../store.js";
import { createVault, readSecret } from "../vault.js";
import { hookSecretName, NOT_EMPTY } from "./bootstrap.js";
import { forgetMintedTokens } from "./oauth-github.js";
import { sealGitLabTokens, writeConnection } from "./oauth.js";
import { startStandInForge } from "./stand-in-forge.js";
import type { StandInForge } from "./stand-in-forge.js";

const TENANT = "acme";
const CODE = "setup-code-for-tests";
const PUBLIC = "http://127.0.0.1:8080";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });

const forges: StandInForge[] = [];
beforeEach(() => forgetMintedTokens());
afterEach(async () => {
  await Promise.all(forges.splice(0).map((f) => f.close()));
});

/** An org connected to a stand-in forge: GitLab through a sealed OAuth pair, GitHub through an installation on `acme-org`. */
async function connectedOrg(kind: "gitlab" | "github", over: Partial<OrchestratorContext> = {}) {
  const forge = await startStandInForge(kind);
  forges.push(forge);
  const store = openSqliteStore(":memory:");
  const apiUrl = kind === "gitlab" ? `${forge.webUrl}/api/v4` : `${forge.webUrl}/api`;
  const ctx: OrchestratorContext = {
    store,
    dataDir: join(mkdtempSync(join(tmpdir(), "forge-bootstrap-")), "data"),
    tenant: TENANT,
    allowedHosts: null,
    publicUrl: PUBLIC,
    vault: createVault(randomBytes(32)),
    addedRepos: new Map(),
    configured: new Set(),
    internalForgeHosts: new Set([forge.host]),
    forgeApps:
      kind === "gitlab"
        ? { gitlab: { kind: "gitlab", webUrl: forge.webUrl, apiUrl, clientId: "stand-in", clientSecret: "stand-in-secret" } }
        : { github: { kind: "github", webUrl: forge.webUrl, apiUrl, appId: "1", slug: "teamhandbook-orchestrator", clientId: "Iv1.stand-in", clientSecret: "stand-in-secret", privateKey } },
    ...over,
  };
  const owner = await principalOf(store, await setupFirstOwner(store, TENANT, CODE, { code: CODE, email: "ada@example.invalid", password: "correct horse battery" }));
  const member = await principalOf(store, await createUser(store, TENANT, new Set(["Payments"]), { email: "max@example.invalid", role: "member", teams: ["Payments"] }, owner));
  const at = new Date().toISOString();
  if (kind === "gitlab") {
    await sealGitLabTokens(ctx, { accessToken: forge.token, refreshToken: "stand-in-refresh", expiresAt: new Date(Date.now() + 7_200_000).toISOString() }, owner.email);
    await writeConnection(ctx, "gitlab", { via: "oauth", account: "ada-gl", apiUrl, by: owner.name, byEmail: owner.email, at, problem: null });
  } else {
    await writeConnection(ctx, "github", { via: "app", account: "acme-org", organization: true, installationId: 5, apiUrl, by: owner.name, byEmail: owner.email, at, problem: null });
  }
  const session = async (id: string) => {
    const s = await startSession(store, TENANT, id);
    return { cookie: `${sessionCookie(TENANT)}=${s.token}`, [CSRF_HEADER]: s.csrf, "content-type": "application/json" };
  };
  const app = createApp(ctx);
  const post = async (path: string, body: unknown, who = owner.id) => {
    const res = await app.request(path, { method: "POST", headers: await session(who), body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { forge, ctx, owner, member, app, post, session };
}

describe("creating the team repository on GitLab", () => {
  it("given a connected org, when an owner creates the team repository, then GitLab holds the scaffold as its one first commit by them, the orchestrator reads it through the connection and a signed webhook points back", async () => {
    const { forge, ctx, post, owner } = await connectedOrg("gitlab");

    const made = await post("/api/forge/gitlab/team-repo", { name: "team-skills", team: "Payments", visibility: "private" });

    expect(made.status).toBe(200);
    expect(made.body.webhook).toBe("installed");
    const written = forge.read("ada-gl/team-skills");
    expect(written.commits).toEqual([{ subject: "chore: scaffold team skill base", author: owner.name, parents: 0 }]);
    expect(JSON.parse(written.files[".claude-plugin/marketplace.json"]!).name).toBe("team-skills");
    expect(Object.keys(written.files)).toContain(".teamhandbook.json");
    const repo = (await ctx.store.getRepo(TENANT, "team-skills"))!;
    expect(repo.head).toMatch(/^[0-9a-f]{40}$/);
    expect(ctx.addedRepos!.get("team-skills")!.connection).toBe("gitlab");
    const hook = forge.hooks.get("ada-gl/team-skills") as { url: string; token: string; push_events: boolean };
    expect(hook.url).toBe(`${PUBLIC}/api/hooks/forge/team-skills`);
    expect(hook.token).toBe(await readSecret(ctx.store, ctx.vault!, TENANT, hookSecretName("team-skills")));
    expect((await ctx.store.eventPage(TENANT, {}, null, 10)).events.map((e) => e.kind)).toContain("forge.team-repo");
  });

  it("given a team repository the orchestrator set up, when an owner removes it from the orchestrator, then its webhook comes off GitLab and its secret goes", async () => {
    const { forge, ctx, app, post, owner, session } = await connectedOrg("gitlab");
    await post("/api/forge/gitlab/team-repo", { name: "team-skills", team: "Payments" });
    expect(forge.hooks.has("ada-gl/team-skills")).toBe(true);

    const removed = await app.request("/api/repos/team-skills", { method: "DELETE", headers: await session(owner.id) });

    expect(removed.status).toBe(200);
    expect(forge.hooks.has("ada-gl/team-skills")).toBe(false);
    expect(await ctx.store.getSecret(TENANT, hookSecretName("team-skills"))).toBeNull();
    expect(await ctx.store.getSetting(TENANT, hookSecretName("team-skills"))).toBeNull();
  });

  it("given a name already taken, when the owner creates it, then it is refused and nothing is written anywhere", async () => {
    const { forge, ctx, post } = await connectedOrg("gitlab");
    forge.addRepo("ada-gl/team-skills", { withCommit: true });

    const made = await post("/api/forge/gitlab/team-repo", { name: "team-skills", team: "Payments" });

    expect(made.status).toBe(409);
    expect(String(made.body.error)).toContain("already there");
    expect(forge.read("ada-gl/team-skills").commits).toHaveLength(1);
    expect(await ctx.store.getRepo(TENANT, "team-skills")).toBeNull();
  });

  it("given an existing repository with no branch, when the owner picks it, then it gets the scaffold as its first commit", async () => {
    const { forge, post } = await connectedOrg("gitlab");
    forge.addRepo("ada-gl/handbook");

    const made = await post("/api/forge/gitlab/team-repo", { existing: "ada-gl/handbook", team: "Payments" });

    expect(made.status).toBe(200);
    expect(forge.read("ada-gl/handbook").commits.map((c) => c.parents)).toEqual([0]);
  });

  it("given an existing repository with even one commit, when the owner picks it, then it is refused as written to only through requests and stays as it was", async () => {
    const { forge, ctx, post } = await connectedOrg("gitlab");
    forge.addRepo("ada-gl/handbook", { withCommit: true });

    const made = await post("/api/forge/gitlab/team-repo", { existing: "ada-gl/handbook", team: "Payments" });

    expect(made.status).toBe(409);
    expect(made.body.error).toBe(NOT_EMPTY);
    expect(forge.read("ada-gl/handbook").commits.map((c) => c.subject)).toEqual(["someone's first commit"]);
    expect(forge.calls.some((c) => c.path.endsWith("/repository/commits"))).toBe(false);
    expect(await ctx.store.getRepo(TENANT, "handbook")).toBeNull();
  });

  it("given an existing repository with a tag and no branch, when the owner picks it, then it is refused as not empty", async () => {
    const { forge, post } = await connectedOrg("gitlab");
    forge.addRepo("ada-gl/tagged", { tagOnly: true });

    const made = await post("/api/forge/gitlab/team-repo", { existing: "ada-gl/tagged", team: "Payments" });

    expect(made.status).toBe(409);
    expect(made.body.error).toBe(NOT_EMPTY);
    expect(forge.calls.some((c) => c.path.endsWith("/repository/commits"))).toBe(false);
  });

  it("given a member, when they try to create it, then they are refused before the forge is asked anything", async () => {
    const { forge, member, post } = await connectedOrg("gitlab");
    const made = await post("/api/forge/gitlab/team-repo", { name: "team-skills", team: "Payments" }, member.id);
    expect(made.status).toBe(403);
    expect(forge.calls).toEqual([]);
  });

  it("given an orchestrator with no public address, when the repository is created, then it is set up and connected and the answer says why no webhook was set", async () => {
    const { forge, post } = await connectedOrg("gitlab", { publicUrl: undefined });
    const made = await post("/api/forge/gitlab/team-repo", { name: "team-skills", team: "Payments" });
    expect(made.status).toBe(200);
    expect(String(made.body.webhook)).toContain("ORCHESTRATOR_PUBLIC_URL");
    expect(forge.hooks.size).toBe(0);
  });
});

describe("creating the team repository on GitHub", () => {
  it("given the app on an organization, when an owner creates the team repository, then its README starts the branch and the rest of the scaffold follows on top, both by them, and it is connected", async () => {
    const { forge, ctx, post, owner } = await connectedOrg("github");

    const made = await post("/api/forge/github/team-repo", { name: "team-skills", team: "Payments", visibility: "private" });

    expect(made.status).toBe(200);
    const written = forge.read("acme-org/team-skills");
    expect(written.commits.map((c) => [c.author, c.parents])).toEqual([[owner.name, 1], [owner.name, 0]]);
    expect(written.files["README.md"]).toContain("<!-- teamhandbook:begin -->");
    expect(JSON.parse(written.files[".claude-plugin/marketplace.json"]!).name).toBe("team-skills");
    expect(forge.calls.find((c) => c.method === "PATCH")!.body).toMatchObject({ force: false });
    expect(ctx.addedRepos!.get("team-skills")!.connection).toBe("github");
    expect((forge.hooks.get("acme-org/team-skills") as { events: string[] }).events).toEqual(["push", "pull_request"]);
  });

  it("given the app on a personal account, when an owner creates the team repository, then it is refused with the steps to make an empty one and pick it, and GitHub is asked nothing", async () => {
    const { forge, ctx, post } = await connectedOrg("github");
    forge.installationAccount = "ada";
    const record = { via: "app" as const, account: "ada", organization: false, installationId: 5, apiUrl: `${forge.webUrl}/api`, by: "Ada", byEmail: "ada@example.invalid", at: new Date().toISOString(), problem: null };
    await writeConnection(ctx, "github", record);

    const made = await post("/api/forge/github/team-repo", { name: "team-skills", team: "Payments" });

    expect(made.status).toBe(409);
    expect(String(made.body.error)).toContain("add it to the app's installation, then pick it here");
    expect(forge.calls.filter((c) => !c.path.startsWith("/app/"))).toEqual([]);
    const steps = made.body.steps as { text: string; url: string | null }[];
    expect(steps.map((s) => s.url)).toEqual([`${forge.webUrl}/new?owner=ada&name=team-skills&visibility=private`, `${forge.webUrl}/settings/installations/5`, null]);
    expect(steps[2]!.text).toContain('"Use ada/team-skills as the team repository"');
  });

  it("given the app on a personal account, when the person follows the steps and picks the empty repository they made, then it becomes the team repository with the scaffold", async () => {
    const { forge, ctx, post, app, owner, session } = await connectedOrg("github");
    forge.installationAccount = "ada";
    await writeConnection(ctx, "github", { via: "app", account: "ada", organization: false, installationId: 5, apiUrl: `${forge.webUrl}/api`, by: "Ada", byEmail: "ada@example.invalid", at: new Date().toISOString(), problem: null });
    await post("/api/forge/github/team-repo", { name: "team-skills", team: "Payments" });
    const view = (await (await app.request("/api/forge/github/connection", { headers: await session(owner.id) })).json()) as { connection: { manageUrl: string } };
    expect(view.connection.manageUrl).toBe(`${forge.webUrl}/settings/installations/5`);

    forge.addRepo("ada/team-skills");
    const made = await post("/api/forge/github/team-repo", { existing: "ada/team-skills", team: "Payments" });

    expect(made.status).toBe(200);
    expect(forge.read("ada/team-skills").commits.at(-1)!.parents).toBe(0);
    expect(ctx.addedRepos!.get("team-skills")!.connection).toBe("github");
  });

  it("given an empty repository the person made and added to the installation, when they pick it, then it is scaffolded", async () => {
    const { forge, post } = await connectedOrg("github");
    forge.addRepo("acme-org/handbook");

    const made = await post("/api/forge/github/team-repo", { existing: "acme-org/handbook", team: "Payments" });

    expect(made.status).toBe(200);
    expect(forge.read("acme-org/handbook").commits).toHaveLength(2);
  });
});

describe("a GitHub repository with a tag alone", () => {
  it("given an existing repository with a tag and no branch, when the owner picks it, then it is refused as not empty", async () => {
    const { forge, post } = await connectedOrg("github");
    forge.addRepo("acme-org/tagged", { tagOnly: true });

    const made = await post("/api/forge/github/team-repo", { existing: "acme-org/tagged", team: "Payments" });

    expect(made.status).toBe(409);
    expect(forge.calls.some((c) => c.method === "PUT")).toBe(false);
  });
});

describe("connecting a listed repository through the connection", () => {
  it("given a repository with history the connection lists, when the owner connects it, then it is read with the connection's token and the listing marks it connected", async () => {
    const { forge, ctx, app, post, owner, session } = await connectedOrg("gitlab");
    forge.addRepo("ada-gl/payments-skills", { withCommit: true });

    const listed = (await (await app.request("/api/forge/gitlab/repos", { headers: await session(owner.id) })).json()) as { repos: { fullName: string; connected: string | null; empty: boolean }[] };
    expect(listed.repos).toEqual([expect.objectContaining({ fullName: "ada-gl/payments-skills", connected: null, empty: false })]);

    const connected = await post("/api/forge/gitlab/repos/connect", { fullName: "ada-gl/payments-skills", team: "Payments" });
    expect(connected.status).toBe(200);
    expect((await ctx.store.getRepo(TENANT, "payments-skills"))!.head).toMatch(/^[0-9a-f]{40}$/);
    expect(await ctx.store.getSecret(TENANT, "repo-git-token:payments-skills@" + forge.webUrl)).toBeNull();
    const again = (await (await app.request("/api/forge/gitlab/repos", { headers: await session(owner.id) })).json()) as { repos: { connected: string | null }[] };
    expect(again.repos[0]!.connected).toBe("payments-skills");
  });

  it("given the GitHub app, when the owner lists the repositories it reaches, then the token that lists them is minted for metadata alone, not the installation's every permission", async () => {
    const { forge, app, owner, session } = await connectedOrg("github");
    forge.addRepo("acme-org/payments-skills", { withCommit: true });

    const listed = (await (await app.request("/api/forge/github/repos", { headers: await session(owner.id) })).json()) as { repos: { fullName: string }[] };

    expect(listed.repos.map((r) => r.fullName)).toContain("acme-org/payments-skills");
    const mint = forge.calls.filter((c) => c.method === "POST" && /\/access_tokens$/.test(c.path)).at(-1)!;
    expect(mint.body).toMatchObject({ permissions: { metadata: "read" } });
  });

  it("given a repository the connection does not list, when its name is sent, then it is not connected", async () => {
    const { post } = await connectedOrg("gitlab");
    const connected = await post("/api/forge/gitlab/repos/connect", { fullName: "someone/else", team: "Payments" });
    expect(connected.status).toBe(404);
  });

  it("given a repository connected through the connection, when an admin tries to give it a token of its own, then it is refused", async () => {
    const { forge, app, post, owner, session } = await connectedOrg("gitlab");
    forge.addRepo("ada-gl/payments-skills", { withCommit: true });
    await post("/api/forge/gitlab/repos/connect", { fullName: "ada-gl/payments-skills", team: "Payments" });

    const res = await app.request("/api/repos/payments-skills/forge", { method: "PUT", headers: await session(owner.id), body: JSON.stringify({ kind: "gitlab", apiUrl: `${forge.webUrl}/api/v4`, project: "ada-gl/payments-skills", token: "glpat-another-token-01" }) });
    expect(res.status).toBe(409);
  });
});
