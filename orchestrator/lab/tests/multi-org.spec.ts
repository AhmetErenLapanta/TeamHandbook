import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { OrchestratorClient } from "../client.js";
import { seedTeamRepo } from "../repos.js";
import { labGit } from "../run.js";
import { as, freshDatabase, lab, SHAPES, spareOrchestratorPort, startOrchestratorProcess, unique } from "./support.js";

const REPO = "team-skills";

/** A team repository of its own under `dir`, shipping the one skill named. */
function teamRepo(dir: string, team: string, slug: string) {
  const bare = join(dir, "repos", `${team.toLowerCase()}.git`);
  seedTeamRepo(lab.path, { id: REPO, team, reviewers: [], labels: [], skills: [{ slug, description: `Use when the lab checks ${team}.`, body: "1. Begin.\n" }] }, bare, `file://${bare}`, join(dir, "scratch", team));
  return { bare, repo: { id: REPO, team, url: `file://${bare}` } };
}

/** The address the org's team file asks teammates to report to, from the request asking it, once the orchestrator has read the repository. */
async function usageEndpoint(owner: OrchestratorClient, bare: string): Promise<string> {
  const read = async () => (await owner.ok<{ repos: { id: string; head: string | null }[] }>("GET", "/api/repos")).repos.find((r) => r.id === REPO)?.head;
  for (let i = 0; i < 120 && !(await read()); i++) await new Promise((r) => setTimeout(r, 500));
  const { proposal, branch } = await owner.ok<{ proposal: string; branch: string }>("POST", `/api/repos/${REPO}/usage/proposal`, { action: "ask" });
  await owner.ok("POST", `/api/repos/${REPO}/usage/propose`, { action: "ask", baseSha: labGit(lab.path, ["rev-parse", "HEAD"], bare), message: proposal, branch });
  return (JSON.parse(labGit(lab.path, ["show", `${branch}:.teamhandbook.json`], bare)) as { usage: { endpoint: string } }).usage.endpoint;
}

const report = (endpoint: string, skill: string) =>
  fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events: [{ skill, hour: new Date().toISOString().slice(0, 13) }] }) }).then((r) => r.status);

async function counted(client: OrchestratorClient, skill: string): Promise<number> {
  const { usage } = await client.ok<{ usage: { skill: string; count: number }[] }>("GET", `/api/usage?repo=${REPO}`);
  return usage.find((u) => u.skill === skill)?.count ?? 0;
}

test.describe("one orchestrator serving several orgs", () => {
  test.beforeAll(async () => {
    // An orchestrator of one org answers this too, naming its org; one serving several names its default as well.
    const probe = await (await as(SHAPES[0]!.org, "member")).call("GET", "/api/orgs");
    test.skip(!("default" in probe.json), "this orchestrator serves one org only");
  });

  test("given two orgs on one orchestrator, each with a repository of the same id, when each is set up and used, then each lists its own team, a session of one is refused on the other's paths, an org not served is unknown, and skill use is counted in the org that issued the address", async () => {
    test.setTimeout(180_000);
    // given
    const dir = join(lab.dir, "multi-org", unique("two"));
    const [alpha, beta] = [unique("alpha"), unique("beta")];
    const a = teamRepo(join(dir, "alpha"), "Core", "alpha-skill");
    const b = teamRepo(join(dir, "beta"), "Ops", "beta-skill");
    const code = unique("setup");
    const served = await startOrchestratorProcess({ port: spareOrchestratorPort(2), tenant: alpha, dataDir: join(dir, "data"), store: "sqlite", setupCode: code, orgs: [{ tenant: alpha, repos: [a.repo] }, { tenant: beta, repos: [b.repo] }] });
    try {
      // when the same address sets up each org
      const email = `owner@${alpha}.example.invalid`;
      const first = await OrchestratorClient.setup(served.url, code, { email, name: "Alpha Owner" }, lab.password);
      const second = await OrchestratorClient.setup(served.url, code, { email, name: "Beta Owner" }, lab.password, beta);

      // then each org lists its own team under the shared id
      const teamOf = async (c: OrchestratorClient) => (await c.ok<{ repos: { id: string; team: string }[] }>("GET", "/api/repos")).repos.map((r) => [r.id, r.team]);
      expect(await teamOf(first)).toEqual([[REPO, "Core"]]);
      expect(await teamOf(second)).toEqual([[REPO, "Ops"]]);

      // and a session reaches its own org alone
      const betaSession = OrchestratorClient.withCookie(served.url, second.cookie);
      expect((await betaSession.call("GET", "/api/me")).status).toBe(401);
      expect((await betaSession.call("GET", `/api/orgs/${alpha}/me`)).status).toBe(401);
      expect((await betaSession.call("GET", `/api/orgs/${beta}/me`)).status).toBe(200);
      const unknown = await betaSession.call("GET", `/api/orgs/${unique("nobody")}/me`);
      expect([unknown.status, JSON.stringify(unknown.json)]).toEqual([404, expect.stringContaining("unknown-org")]);
      const listed = async (cookie: string) => (await OrchestratorClient.withCookie(served.url, cookie).ok<{ orgs: { tenant: string }[] }>("GET", "/api/orgs")).orgs.map((o) => o.tenant);
      expect(await listed(second.cookie)).toEqual([beta]);
      expect(await listed(`${first.cookie}; ${second.cookie}`)).toEqual([alpha, beta]);

      // when the second org asks its team for skill use and a teammate reports
      const endpoint = await usageEndpoint(second, b.bare);
      const own = await report(endpoint, "beta-skill");
      const theOther = await report(endpoint, "alpha-skill");

      // then the use is counted in the second org alone, and a skill only the first ships is refused there
      expect([own, theOther]).toEqual([200, 400]);
      expect(await counted(second, "beta-skill")).toBe(1);
      expect([await counted(first, "beta-skill"), await counted(first, "alpha-skill")]).toEqual([0, 0]);
    } finally {
      await served.stop();
    }
  });

  for (const store of ["sqlite", "postgres"] as const) {
    test(`given an orchestrator of one tenant on ${store} with its owner and a member, when it starts again with an orgs file whose first org is that tenant, then everything is kept at the plain paths, and only the new org is set up with the setup code`, async () => {
      test.skip(store === "postgres" && !lab.postgres, "this lab has no Postgres");
      test.setTimeout(180_000);
      // given
      const tenant = unique("single");
      const added = unique("added");
      const dir = join(lab.dir, "multi-org", tenant);
      const a = teamRepo(join(dir, "first"), "Core", "first-skill");
      const b = teamRepo(join(dir, "added"), "Ops", "added-skill");
      const databaseUrl = store === "postgres" ? freshDatabase() : undefined;
      const common = { port: spareOrchestratorPort(2), tenant, dataDir: join(dir, "data"), store, ...(databaseUrl ? { databaseUrl } : {}) };
      const people = { owner: `owner@${tenant}.example.invalid`, member: `member@${tenant}.example.invalid` };
      const code = unique("setup");
      const single = await startOrchestratorProcess({ ...common, setupCode: code, repos: [a.repo] });
      const owner = await OrchestratorClient.setup(single.url, code, { email: people.owner, name: "Single Owner" }, lab.password);
      await owner.ok("POST", "/api/users", { email: people.member, name: "Single Member", role: "member", teams: ["Core"], password: lab.password });
      await single.stop();

      // when
      const next = unique("setup");
      const multi = await startOrchestratorProcess({ ...common, setupCode: next, orgs: [{ tenant, repos: [a.repo] }, { tenant: added, repos: [b.repo] }] });
      try {
        const member = await OrchestratorClient.signIn(multi.url, people.member, lab.password);
        const again = await OrchestratorClient.signIn(multi.url, people.owner, lab.password);

        // then
        expect((await member.ok<{ user: { role: string; ownedTeams: string[] } }>("GET", "/api/me")).user).toMatchObject({ role: "member", ownedTeams: ["Core"] });
        expect((await again.ok<{ user: { role: string } }>("GET", "/api/me")).user.role).toBe("owner");
        expect((await again.call("GET", `/api/orgs/${tenant}/users`)).status).toBe(200);
        const setUp = (org: string) => fetch(`${multi.url}/api/orgs/${org}/auth/setup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: next, email: `owner@${org}.example.invalid`, name: "Second Owner", password: lab.password }) }).then((r) => r.status);
        const signIn = (org: string) => fetch(`${multi.url}/api/orgs/${org}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: people.owner, password: lab.password }) }).then((r) => r.status);
        expect([await signIn(added), await setUp(tenant), await setUp(added)]).toEqual([403, 403, 200]);
      } finally {
        await multi.stop();
      }
    });
  }
});
