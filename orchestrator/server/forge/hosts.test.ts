import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import type { OrchestratorContext } from "../app.js";
import type { Principal } from "../auth.js";
import { openSqliteStore } from "../store.js";
import { createVault } from "../vault.js";
import { orgForgeHosts } from "./hosts.js";
import { ORG_GITLAB_APP, writeConnection } from "./oauth.js";

const TENANT = "acme";
const AT = "2026-11-02T12:00:00.000Z";

/** An org with GitLab.com connected and a GitHub repository set up with a token of its own; no host is ever resolved. */
async function org(): Promise<OrchestratorContext> {
  const store = openSqliteStore(":memory:");
  const ctx: OrchestratorContext = {
    store,
    dataDir: join(mkdtempSync(join(tmpdir(), "forge-hosts-")), "data"),
    tenant: TENANT,
    vault: createVault(randomBytes(32)),
    addedRepos: new Map(),
    forgeApps: { gitlab: { kind: "gitlab", webUrl: "https://gitlab.com", apiUrl: "https://gitlab.com/api/v4", clientId: "client", clientSecret: "secret" } },
    resolveHost: async () => {
      throw new Error("listing hosts resolves nothing");
    },
  };
  await writeConnection(ctx, "gitlab", { via: "oauth", account: "ada-gl", apiUrl: "https://gitlab.com/api/v4", by: "Ada", byEmail: "ada@example.invalid", at: AT, problem: null });
  await store.upsertRepo({ tenant: TENANT, id: "skills", team: "Payments", name: "skills", url: "https://gitlab.com/acme/skills.git" });
  await store.setForgeConfig(TENANT, { repoId: "skills", kind: "gitlab", apiUrl: "https://gitlab.com/api/v4", project: "acme/skills" });
  ctx.addedRepos!.set("skills", { id: "skills", forge: "gitlab", kind: "skills", skillsFrom: null, gitOrigin: "https://gitlab.com", memberUrl: null, addedBy: "ada@example.invalid", addedAt: AT, connection: "gitlab" });
  await store.upsertRepo({ tenant: TENANT, id: "app", team: "Payments", name: "app", url: "https://github.com/acme/app.git" });
  await store.setForgeConfig(TENANT, { repoId: "app", kind: "github", apiUrl: "https://api.github.com", project: "acme/app" });
  return ctx;
}

describe("the forge hosts an org reaches", () => {
  it("given GitLab.com connected and a GitHub repository with its own token, when the hosts are read, then each host says how it is reached, its repositories, and where its token is made", async () => {
    const hosts = await orgForgeHosts(await org());

    expect(hosts).toEqual([
      {
        kind: "gitlab",
        webUrl: "https://gitlab.com",
        apiUrl: "https://gitlab.com/api/v4",
        connection: { via: "oauth", account: "ada-gl", by: "Ada", at: AT, repos: 1, problem: null },
        ownApplication: false,
        repos: [{ id: "skills", via: "connection" }],
        credentials: { tokenPage: "https://gitlab.com/-/user_settings/personal_access_tokens?name=TeamHandbook&scopes=api", scopes: ["api"] },
      },
      expect.objectContaining({ kind: "github", webUrl: "https://github.com", connection: null, repos: [{ id: "app", via: "token" }], credentials: expect.objectContaining({ tokenPage: "https://github.com/settings/personal-access-tokens/new" }) }),
    ]);
  });

  it("given the org's own self-managed GitLab application and no connection yet, when the hosts are read, then that GitLab is listed as the org's own", async () => {
    const ctx = await org();
    await ctx.store.deleteSetting(TENANT, "forge.connection.gitlab");
    await ctx.store.setSetting(TENANT, ORG_GITLAB_APP, JSON.stringify({ webUrl: "https://git.example.com", clientId: "own-client", by: "Ada", at: AT }));

    const gitlab = (await orgForgeHosts(ctx)).find((h) => h.webUrl === "https://git.example.com");

    expect(gitlab).toMatchObject({ kind: "gitlab", apiUrl: "https://git.example.com/api/v4", connection: null, ownApplication: true, repos: [] });
  });

  it("given a member, when the hosts are asked for, then they are refused, as forge addresses are the managers' to read", async () => {
    const ctx = await org();
    const member: Principal = { id: "u-1", name: "Max", email: "max@example.invalid", role: "member", ownedTeams: [] };
    const app = createApp(ctx, async (c, next) => {
      c.set("user", member);
      await next();
    });
    expect((await app.request("/api/forge/hosts")).status).toBe(403);
  });
});
