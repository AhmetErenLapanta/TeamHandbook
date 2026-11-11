import { expect, test } from "@playwright/test";
import { ORGS } from "../orgs.js";
import { ownerKey, userOf } from "../state.js";
import type { LabOrg, LabRepo } from "../state.js";
import { as, close, fileAt, ownerOf, runToReview, SHAPES, unique, whileChanged } from "./support.js";

interface OrchestratorEvent {
  id: string;
  kind: string;
  subject: string | null;
  repoId: string | null;
  detail: string;
  actor: { email: string };
}

interface MemberConfig {
  member: { id: string };
  repos: { repoId: string; skills: { slug: string; removedBy: { resource: string; reason: string } | null }[]; problem: string | null }[];
  tasks: { repoId: string; refusal: string | null }[];
}

const firstSkill = (org: LabOrg, repo: LabRepo) => ORGS.find((o) => o.name === org.name)!.teams.find((t) => t.id === repo.id)!.skills[0]!.slug;
const idOf = async (org: LabOrg, key: string) => (await (await as(org, key)).ok<{ user: { id: string } }>("GET", "/api/me")).user.id;
const issue = (repo: LabRepo) => (/^([A-Z][A-Z0-9]*)-\d+/.test(repo.branchExample ?? "") ? { issueUrl: `https://tracker.example.invalid/browse/${/^([A-Z][A-Z0-9]*)-/.exec(repo.branchExample!)![1]}-${100 + Math.floor(Math.random() * 900)}` } : {});

test.describe("orchestrator policies in the event log, by tag, as budgets and on a member's page", () => {
  for (const { shape, org, repo } of SHAPES) {
    test(`given ${org.name}'s ${repo.id}, ${shape}, when an admin denies tasks on it and its team's owner starts one, then saving, the refused start and removing are logged, and one entry opens by its id for managers alone`, async () => {
      // given
      const admin = await as(org, "org-admin");
      const owner = await ownerOf(org, repo);
      const name = unique("No tasks here");

      // when
      const { policy } = await admin.ok<{ policy: { id: string } }>("POST", "/api/policies", { policy: { name, audience: { kind: "workspace" }, rules: [{ kind: "repo-access", effect: "deny", repos: [repo.id] }] } });
      const refused = await owner.call<{ error?: string; code?: string }>("POST", "/api/tasks", { title: unique("Lab refused task"), description: "", repoId: repo.id, agent: "fake", ...issue(repo) });
      await admin.ok("DELETE", `/api/policies/${policy.id}`);

      // then
      expect([refused.status, refused.json.code]).toEqual([403, "repo-access"]);
      const { events } = await admin.ok<{ events: OrchestratorEvent[] }>("GET", "/api/events?kind=policy");
      const mine = events.filter((e) => e.subject === `policy:${policy.id}`).map((e) => [e.kind, e.detail]);
      expect(mine).toEqual(expect.arrayContaining([["policy.saved", `added the orchestrator policy "${name}" for the whole organization: denies tasks on ${repo.id}`], ["policy.deleted", `removed the orchestrator policy "${name}"`]]));
      const startRefused = (await admin.ok<{ events: OrchestratorEvent[] }>("GET", "/api/events?kind=task.refused")).events.find((e) => e.subject === `policy:${policy.id}`)!;
      expect(startRefused).toMatchObject({ repoId: repo.id, detail: `repo-access: a task on ${repo.id} was refused by the orchestrator policy "${name}"`, actor: { email: userOf(org, ownerKey(repo.team)).email } });
      const one = await admin.ok<{ event: OrchestratorEvent; link: string }>("GET", `/api/events/${startRefused.id}`);
      expect(one.event.id).toBe(startRefused.id);
      expect(one.link).toMatch(new RegExp(`/${org.name}/activity/audit/${startRefused.id}$`));
      expect((await (await as(org, "member")).call("GET", `/api/events/${startRefused.id}`)).status).toBe(403);
    });

    test(`given ${org.name}'s ${repo.id}, ${shape}, when its team's owner carries a tag an admin gave them, then a policy for that tag covers them alone in its preview and refuses their task, one for everyone without it does not, and a rule reaching sessions cannot name a tag`, async () => {
      test.setTimeout(120_000);
      // given
      const admin = await as(org, "org-admin");
      const owner = await ownerOf(org, repo);
      const ownerId = await idOf(org, ownerKey(repo.team));
      const tag = unique("contractors").toLowerCase().slice(0, 40);
      const tagged = { kind: "tags", ids: [tag] };
      const others = { kind: "except-tags", ids: [tag] };
      const deny = [{ kind: "repo-access", effect: "deny", repos: [repo.id] }];

      // when
      await admin.ok("PUT", `/api/members/${ownerId}/tags`, { tags: [tag] });
      try {
        const preview = await admin.ok<{ members: { id: string }[] }>("POST", "/api/policies/preview", { audience: tagged, rules: deny });
        const sessions = await admin.call<{ code?: string }>("POST", "/api/policies", { policy: { name: "Tagged skills", audience: tagged, rules: [{ kind: "skill-access", effect: "deny", resources: [`skill:${firstSkill(org, repo)}`], reason: "Lab" }] } });
        const { policy: forOthers } = await admin.ok<{ policy: { id: string } }>("POST", "/api/policies", { policy: { name: unique("Untagged"), audience: others, rules: deny } });
        const passes = await runToReview(owner, repo, unique("Lab tagged task passes"));
        await admin.ok("DELETE", `/api/policies/${forOthers.id}`);
        const { policy: forTag } = await admin.ok<{ policy: { id: string } }>("POST", "/api/policies", { policy: { name: unique("Tagged"), audience: tagged, rules: deny } });
        const refused = await owner.call<{ code?: string }>("POST", "/api/tasks", { title: unique("Lab tagged task"), description: "", repoId: repo.id, agent: "fake", ...issue(repo) });
        await admin.ok("DELETE", `/api/policies/${forTag.id}`);

        // then
        expect(preview.members.map((m) => m.id)).toEqual([ownerId]);
        expect([sessions.status, sessions.json.code]).toEqual([400, "policy-audience"]);
        expect(passes.status).toBe("needs-review");
        expect([refused.status, refused.json.code]).toEqual([403, "repo-access"]);
        if (passes.requestNumber) await close(org, repo, passes.requestNumber);
      } finally {
        await admin.ok("PUT", `/api/members/${ownerId}/tags`, { tags: [] });
      }
    });

    test(`given ${org.name}'s ${repo.id}, ${shape}, when an admin gives its team a monthly budget per member, then the team's owner reads what is left, a task without a reported cost leaves it untouched and is counted as unknown, and a member outside the team sees no budget`, async () => {
      test.setTimeout(120_000);
      // given
      const admin = await as(org, "org-admin");
      const owner = await ownerOf(org, repo);
      const name = unique("Monthly budget");
      const { policy } = await admin.ok<{ policy: { id: string } }>("POST", "/api/policies", { policy: { name, audience: { kind: "teams", ids: [repo.team] }, rules: [{ kind: "task-budget", monthlyUsd: 5, per: "member" }] } });
      type Budgets = { month: string; budgets: { policyId: string; monthlyUsd: number; spentUsd: number; leftUsd: number; reached: boolean; unknownCost: number }[] };
      try {
        const before = (await owner.ok<Budgets>("GET", "/api/policies/current-budgets")).budgets.find((b) => b.policyId === policy.id)!;

        // when
        const task = await runToReview(owner, repo, unique("Lab budgeted task"));
        const after = (await owner.ok<Budgets>("GET", "/api/policies/current-budgets")).budgets.find((b) => b.policyId === policy.id)!;
        const outside = await (await as(org, "member")).ok<Budgets>("GET", "/api/policies/current-budgets");

        // then
        expect(before).toMatchObject({ monthlyUsd: 5, spentUsd: 0, leftUsd: 5, reached: false });
        expect(after).toMatchObject({ spentUsd: 0, leftUsd: 5, reached: false, unknownCost: before.unknownCost + 1 });
        expect(outside.budgets.find((b) => b.policyId === policy.id)).toBeUndefined();
        if (task.requestNumber) await close(org, repo, task.requestNumber);
      } finally {
        await admin.ok("DELETE", `/api/policies/${policy.id}`);
      }
    });

    test(`given ${org.name}'s ${repo.id}, ${shape}, when its team's owner reads their own configuration, then it shows the team's skills, a draft rule is previewed on it without being saved, another member is refused it, and a broken team file is named`, async () => {
      test.setTimeout(120_000);
      // given
      const admin = await as(org, "org-admin");
      const owner = await ownerOf(org, repo);
      const ownerId = await idOf(org, ownerKey(repo.team));
      const skill = firstSkill(org, repo);
      const draft = { audience: { kind: "teams", ids: [repo.team] }, rules: [{ kind: "skill-access", effect: "deny", resources: [`skill:${skill}`], reason: "Previewed in the lab" }] };

      // when
      const own = await owner.ok<MemberConfig>("GET", `/api/members/${ownerId}/config`);
      const preview = await admin.ok<{ before: MemberConfig; after: MemberConfig }>("POST", `/api/members/${ownerId}/config/preview`, draft);
      const byMember = await (await as(org, "member")).call<{ error?: string }>("GET", `/api/members/${ownerId}/config`);
      const skillIn = (config: MemberConfig) => config.repos.find((r) => r.repoId === repo.id)?.skills.find((s) => s.slug === skill);

      // then
      expect(skillIn(own)?.removedBy).toBeNull();
      expect(skillIn(preview.before)?.removedBy).toBeNull();
      expect(skillIn(preview.after)?.removedBy).toMatchObject({ resource: `skill:${skill}`, reason: "Previewed in the lab" });
      expect(skillIn(await owner.ok<MemberConfig>("GET", `/api/members/${ownerId}/config`))?.removedBy).toBeNull();
      expect([byMember.status, byMember.json.error]).toEqual([403, "only an owner or an admin reads another member's configuration"]);

      // when the team file's policies cannot be read
      const team = JSON.parse(fileAt(repo, "HEAD", ".teamhandbook.json")!) as Record<string, unknown>;
      await whileChanged(org, repo, { ".teamhandbook.json": JSON.stringify({ ...team, policies: "not a list" }, null, 2) + "\n" }, async () => {
        // then
        const broken = (await owner.ok<MemberConfig>("GET", `/api/members/${ownerId}/config`)).repos.find((r) => r.repoId === repo.id);
        expect(broken?.problem).toMatch(/^the team's policies cannot be read \(.+\), so the agent is not given the team's setup$/);
      });
    });
  }
});
