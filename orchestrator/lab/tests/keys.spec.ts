import { expect, test } from "@playwright/test";
import { OrchestratorClient } from "../client.js";
import type { LabOrg, LabRepo } from "../state.js";
import { as, close, commitOf, lab, merge, propose, SHAPES, unique } from "./support.js";

interface MadeKey {
  key: { id: string; prefix: string; lastUsedAt: string | null };
  secret: string;
}

const skillText = (slug: string) => `---\nname: ${slug}\ndescription: Use when the lab checks what an API key can do.\n---\n\nBody.\n`;

/** A service account that owns `team`, made by the organization's owner, and a key for it with `scopes`. */
async function serviceKey(org: LabOrg, team: string, scopes: Record<string, string>, days = 1): Promise<{ account: string; made: MadeKey; client: OrchestratorClient }> {
  const owner = await as(org, "admin");
  const { serviceAccount } = await owner.ok<{ serviceAccount: { id: string } }>("POST", "/api/service-accounts", { name: unique("lab-bot"), teams: [team] });
  const made = await owner.ok<MadeKey>("POST", "/api/keys", { name: unique("lab-key"), scopes, serviceAccountId: serviceAccount.id, expiresInDays: days });
  return { account: serviceAccount.id, made, client: OrchestratorClient.withKey(org.url, made.secret) };
}

test.describe("service accounts and their API keys", () => {
  for (const { shape, org, repo } of SHAPES) {
    test(`given ${org.name}'s ${repo.id}, ${shape}, and a service account that owns its team with a key that writes requests, when the key opens a change, then the request opens under the account, the key cannot merge it, and a person can`, async () => {
      // given
      const { account, made, client } = await serviceKey(org, repo.team, { repositories: "read", requests: "write" });
      const slug = unique("by-key");

      // when
      const opened = await propose(client, org, repo, { kind: "skill.add", slug, content: skillText(slug) }, `add ${slug}`);

      // then
      expect(opened.status, opened.error).toBe(200);
      try {
        expect(commitOf(repo, opened.request!.branch, "%an")).toMatch(/lab-bot/);
        const merging = await client.call<{ error: string }>("POST", `/api/repos/${repo.id}/requests/${opened.request!.number}/merge`);
        expect([merging.status, merging.json.error]).toEqual([403, "an API key cannot do this; it takes a person signed in to the orchestrator"]);
        const { keys } = await (await as(org, "admin")).ok<{ keys: MadeKey["key"][] }>("GET", `/api/keys?serviceAccount=${account}`);
        expect(keys.find((k) => k.id === made.key.id)?.lastUsedAt).not.toBeNull();
        if (repo.forge === "local") {
          await merge(org, repo, opened.request!.number);
          opened.request = undefined;
        }
      } finally {
        if (opened.request) await close(org, repo, opened.request.number);
      }
    });
  }

  // An organization with repositories of two teams at least: one team's key reaches for another team's repository.
  for (const org of lab.orgs.filter((o) => !o.extra && new Set(o.repos.map((r) => r.team)).size > 1)) {
    const [own, other] = [org.repos[0]!, org.repos.find((r) => r.team !== org.repos[0]!.team)!] as [LabRepo, LabRepo];

    test(`given ${org.name} and keys of a service account that owns ${own.team}, when they reach past their team, their scopes, their own width or expiry, the people screen, their tenant or their revocation, then each is refused`, async () => {
      // given
      // Two days, so a key it mints for one day expires before it does.
      const writer = await serviceKey(org, own.team, { repositories: "read", requests: "write", keys: "write" }, 2);
      const reader = await serviceKey(org, own.team, { repositories: "read", requests: "read" });
      const elsewhere = lab.orgs.find((o) => o !== org && !o.extra)!;
      const slug = unique("past-scope");

      // when
      const otherTeam = await propose(writer.client, org, other, { kind: "skill.add", slug, content: skillText(slug) }, `add ${slug}`);
      const readOnly = await reader.client.call<{ error: string }>("POST", `/api/repos/${own.id}/changes/proposal`, { change: { kind: "skill.add", slug, content: skillText(slug) } });
      const wider = await writer.client.call<{ error: string }>("POST", "/api/keys", { name: unique("wider"), scopes: { repositories: "read", requests: "write", tasks: "write" } });
      const outliving = await writer.client.call<{ error: string }>("POST", "/api/keys", { name: unique("outliving"), scopes: { repositories: "read" } });
      const narrower = await writer.client.call<MadeKey>("POST", "/api/keys", { name: unique("narrower"), scopes: { repositories: "read" }, expiresInDays: 1 });
      const people = await writer.client.call("POST", "/api/users", { email: `x@${org.name}.example.invalid`, name: "X", role: "owner", teams: [], password: lab.password });
      const otherTenant = await OrchestratorClient.withKey(elsewhere.url, writer.made.secret).call("GET", "/api/repos");
      await (await as(org, "admin")).ok("DELETE", `/api/keys/${reader.made.key.id}`);
      const revoked = await reader.client.call("GET", "/api/repos");

      // then
      expect(otherTeam.status).toBe(403);
      expect([readOnly.status, readOnly.json.error]).toEqual([403, "this API key has no write access to requests"]);
      expect([wider.status, wider.json.error]).toEqual([403, "a key mints only keys no wider than itself; this one reaches further on tasks"]);
      expect([outliving.status, outliving.json.error]).toEqual([403, "a key mints only keys that expire no later than itself"]);
      expect(narrower.status).toBe(200);
      expect(people.status).toBe(403);
      expect([otherTenant.status, revoked.status]).toEqual([401, 401]);
    });
  }
});
