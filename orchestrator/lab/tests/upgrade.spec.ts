import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { OrchestratorClient } from "../client.js";
import { seedTeamRepo } from "../repos.js";
import { orchestratorBuildAt, freshDatabase, lab, spareOrchestratorPort, startOrchestratorProcess, unique } from "./support.js";

/**
 * The orchestrator before organization roles, when a team owner was a role of its own and an admin
 * held everything: the last commit of the orchestrator branch without them.
 */
const BEFORE_ROLES = process.env.LAB_UPGRADE_FROM ?? "89b93a4";

const skill = (slug: string) => `---\nname: ${slug}\ndescription: Use when the lab checks an upgrade.\n---\n\nBody.\n`;

for (const store of ["sqlite", "postgres"] as const) {
  test(`given an install on ${store} made before organization roles, with an admin, a team's owner and a member, when the current orchestrator opens it, then the admin is its owner, the team's owner a member who still owns the team and changes its repository, and the member is unchanged`, async () => {
    test.skip(store === "postgres" && !lab.postgres, "this lab has no Postgres");
    test.setTimeout(240_000);
    // given a team repository of its own, so no other orchestrator's branches are on it
    const tenant = unique("upgrade");
    const dir = join(lab.dir, "upgrades", tenant);
    const bare = join(dir, "repos", "team-skills.git");
    seedTeamRepo(lab.path, { id: "team-skills", team: "Core", reviewers: [], labels: [], skills: [{ slug: "first-skill", description: "Use when it is the first.", body: "1. Begin.\n" }] }, bare, `file://${bare}`, join(dir, "scratch"));
    const repos = [{ id: "team-skills", team: "Core", url: `file://${bare}` }];
    const databaseUrl = store === "postgres" ? freshDatabase() : undefined;
    const common = { port: spareOrchestratorPort(2), tenant, dataDir: join(dir, "data"), store, repos, ...(databaseUrl ? { databaseUrl } : {}) };
    const people = { admin: `admin@${tenant}.example.invalid`, owner: `owner@${tenant}.example.invalid`, member: `member@${tenant}.example.invalid` };

    // and the older orchestrator sets it up
    const code = unique("setup");
    const old = await startOrchestratorProcess({ ...common, setupCode: code, build: orchestratorBuildAt(BEFORE_ROLES) });
    const admin = await OrchestratorClient.setup(old.url, code, { email: people.admin, name: "Old Admin" }, lab.password);
    await admin.ok("POST", "/api/users", { email: people.owner, name: "Old Team Owner", role: "owner", teams: ["Core"], password: lab.password });
    await admin.ok("POST", "/api/users", { email: people.member, name: "Old Member", role: "member", teams: [], password: lab.password });
    await old.stop();

    // when the current orchestrator opens the same data
    const current = await startOrchestratorProcess({ ...common, setupCode: unique("unused") });
    try {
      const me = async (email: string) => {
        const client = await OrchestratorClient.signIn(current.url, email, lab.password);
        return { client, user: (await client.ok<{ user: { role: string; ownedTeams: string[] } }>("GET", "/api/me")).user };
      };
      const [wasAdmin, wasOwner, wasMember] = [await me(people.admin), await me(people.owner), await me(people.member)];

      // then
      expect([wasAdmin.user.role, wasOwner.user.role, wasOwner.user.ownedTeams, wasMember.user.role, wasMember.user.ownedTeams]).toEqual(["owner", "member", ["Core"], "member", []]);
      const slug = unique("after-upgrade");
      const change = { kind: "skill.add", slug, content: skill(slug) };
      expect((await wasOwner.client.call("POST", "/api/repos/team-skills/changes/proposal", { change })).status).toBe(200);
      expect((await wasMember.client.call("POST", "/api/repos/team-skills/changes/proposal", { change })).status).toBe(403);
      expect((await wasAdmin.client.call("GET", "/api/users")).status).toBe(200);
    } finally {
      await current.stop();
    }
  });
}
